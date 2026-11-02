import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../browser/webview/MultiSessionShell.tsx', import.meta.url), 'utf8')

/** Parses `text` and returns its `MultiSessionShell` function, or throws when there is none. */
function shellOf(text: string): { file: ts.SourceFile; shell: ts.FunctionDeclaration } {
  const parsed = ts.createSourceFile('shell.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found = parsed.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'MultiSessionShell',
  )
  if (!found) throw new Error('no MultiSessionShell function')
  return { file: parsed, shell: found }
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)) current = current.expression
  return current
}

const isFunctionNode = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node)

/** Names bound in the shell's own scope, and those whose identity never changes (refs, setters, dispatch). */
function shellBindings(shell: ts.FunctionDeclaration, file: ts.SourceFile): { local: Set<string>; stable: Set<string> } {
  const local = new Set<string>()
  const stable = new Set<string>()
  const bind = (name: ts.Node) => {
    if (ts.isIdentifier(name)) local.add(name.text)
    else ts.forEachChild(name, bind)
  }
  for (const parameter of shell.parameters) bind(parameter.name)
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      bind(node.name)
      const init = node.initializer ? unwrap(node.initializer) : null
      const hook = init && ts.isCallExpression(init) ? init.expression.getText(file) : ''
      if (hook === 'useRef' && ts.isIdentifier(node.name)) stable.add(node.name.text)
      if ((hook === 'useState' || hook === 'useReducer') && ts.isArrayBindingPattern(node.name)) {
        const second = node.name.elements[1]
        if (second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) stable.add(second.name.text)
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) local.add(node.name.text)
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(shell, walk)
  return { local, stable }
}

/** Every `useMemo` call in the shell, with its callback and dependency list. */
function shellMemos(shell: ts.FunctionDeclaration, file: ts.SourceFile) {
  const memos: { call: ts.CallExpression; callback: ts.Expression | undefined; deps: ts.Expression | undefined; line: number }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useMemo') {
      memos.push({
        call: node,
        callback: node.arguments[0],
        deps: node.arguments[1],
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(shell)
  return memos
}

/** The expressions a memo callback can return: its expression body, or its own `return`s. */
function returnedExpressions(callback: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(callback.body)) return [callback.body]
  const found: ts.Expression[] = []
  const visit = (node: ts.Node) => {
    if (isFunctionNode(node) || ts.isFunctionDeclaration(node)) return
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(callback.body, visit)
  return found
}

/** Whether `expression` evaluates to a function written inside the memo callback. */
function returnsInlineFunction(expression: ts.Expression, callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const value = unwrap(expression)
  if (isFunctionNode(value)) return true
  if (ts.isConditionalExpression(value)) {
    return returnsInlineFunction(value.whenTrue, callback) || returnsInlineFunction(value.whenFalse, callback)
  }
  if (ts.isBinaryExpression(value) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.QuestionQuestionToken].includes(value.operatorToken.kind)) {
    return returnsInlineFunction(value.left, callback) || returnsInlineFunction(value.right, callback)
  }
  if (ts.isCallExpression(value) && isFunctionNode(unwrap(value.expression))) {
    const invoked = unwrap(value.expression) as ts.ArrowFunction | ts.FunctionExpression
    return returnedExpressions(invoked).some(inner => returnsInlineFunction(inner, invoked))
  }
  if (ts.isIdentifier(value) && ts.isBlock(callback.body)) {
    let inline = false
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === value.text) inline = true
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === value.text &&
        node.initializer && isFunctionNode(unwrap(node.initializer))) inline = true
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(callback.body, visit)
    return inline
  }
  return false
}

/** Every inline arrow or function expression passed, at any depth, as an argument of `call`. */
function inlineFunctionArguments(call: ts.CallExpression): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (isFunctionNode(node)) {
      found.push(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  for (const argument of call.arguments) visit(argument)
  return found
}

const isShellFactoryCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.startsWith('createShell')

/**
 * Memos in the shell that would keep a render's scope alive: one returning a function written inline
 * (directly, through a conditional, an immediately invoked function or a local name), and any inline
 * function handed to a `createShell*` factory. Each entry is `line: reason`.
 */
function memoClosureViolations(text: string): string[] {
  const { file: parsed, shell: root } = shellOf(text)
  const violations: string[] = []
  for (const memo of shellMemos(root, parsed)) {
    const callback = memo.callback
    if (!callback || !isFunctionNode(callback)) continue
    if (returnedExpressions(callback).some(expression => returnsInlineFunction(expression, callback))) {
      violations.push(`${memo.line}: returns an inline function`)
    }
  }
  const visit = (node: ts.Node) => {
    if (isShellFactoryCall(node)) {
      for (const inline of inlineFunctionArguments(node)) {
        const line = parsed.getLineAndCharacterOfPosition(inline.getStart(parsed)).line + 1
        violations.push(`${line}: inline function passed to ${(node.expression as ts.Identifier).text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return violations
}

/**
 * Inputs of a memoized factory call (`useMemo(() => create…(inputs), deps)`, the factory a module-level
 * function) that are neither in that memo's dependency list nor a ref, a state setter or a reducer
 * dispatch: each one would be a stale closure. Each entry is `line factory: input`.
 */
function factoryDependencyGaps(text: string): string[] {
  const { file: parsed, shell: root } = shellOf(text)
  const { local, stable } = shellBindings(root, parsed)
  const gaps: string[] = []
  for (const memo of shellMemos(root, parsed)) {
    const callback = memo.callback
    if (!callback || !ts.isArrowFunction(callback) || ts.isBlock(callback.body)) continue
    const body = unwrap(callback.body)
    if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression)) continue
    const factory = body.expression.text
    if (!factory.startsWith('create') || local.has(factory)) continue
    const deps = new Set(
      memo.deps && ts.isArrayLiteralExpression(memo.deps) ? memo.deps.elements.map(dep => dep.getText(parsed)) : [],
    )
    for (const argument of body.arguments) {
      const input = argument.getText(parsed)
      const root = input.split(/[.?[(]/)[0]!
      if (deps.has(input) || stable.has(input) || !local.has(root)) continue
      gaps.push(`${memo.line} ${factory}: ${input}`)
    }
  }
  return gaps
}
const file = ts.createSourceFile('shell.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const shell = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'MultiSessionShell')!
const names = new Set(['subAgentRowsSeenRef', 'subAgentRowsForSession', 'handleConfirmDeleteProject'])
const declarations: string[] = []
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(file))) {
    declarations.push(`const ${node.getText(file)};`)
  }
  ts.forEachChild(node, collect)
}
collect(shell)
const factories = file.statements.filter(node => ts.isFunctionDeclaration(node) && (
  node.name?.text === 'createShellSubAgentRowsForSession' || node.name?.text === 'createShellHandleConfirmDeleteProject'
)).map(node => node.getText(file)).join('\n')

function runProduction(minify: boolean) {
  const program = `
    import React, { useCallback, useMemo, useRef } from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { Window } from 'happy-dom';
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    const normalizeProjectPath = path => path.toLowerCase();
    const removed = [];
    const removeProject = path => removed.push(path);
    const deleted = [];
    const handleDeleteThread = id => deleted.push(id);
    const setProjectDeleteTarget = () => {};
    const filterSubAgentRowsBySession = (rows, id) => rows.filter(row => row.sessionId === id);
    const subAgentsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ${factories}
    let current;
    function Shell({ sessions, subAgentRows, payload, activeSessionId }) {
      ${declarations.join('\n')}
      const renderThread = () => ({ payload, rows: subAgentRowsForSession, remove: handleConfirmDeleteProject });
      current = { rows: subAgentRowsForSession, remove: handleConfirmDeleteProject, renderThread };
      return null;
    }
    const root = createRoot(document.createElement('div'));
    const refs = [];
    let sessions = [{sessionId:'active', projectRoot:'D:/project'}, {sessionId:'other', projectRoot:'d:/project'}];
    let rows = [{sessionId:'active', value:0}];
    let previous, stableRows = true, stableDelete = true, freshRows = true;
    for (let i = 0; i < 1000; i++) {
      if (i % 2 === 0) rows = [{sessionId:'active', value:i}];
      else sessions = sessions.map(session => ({...session}));
      const payload = { iteration:i, data:new Array(100).fill(i) };
      refs.push(new WeakRef(payload));
      flushSync(() => root.render(React.createElement(Shell, {sessions, subAgentRows:rows, payload, activeSessionId:'active'})));
      if (previous) {
        if (i % 2) stableRows &&= previous.rows === current.rows;
        else stableDelete &&= previous.remove === current.remove;
      }
      freshRows &&= current.rows('active')[0].value === i - i % 2;
      previous = current;
    }
    current.remove('D:/project');
    await new Promise(resolve => setTimeout(resolve, 20));
    for (let i = 0; i < 4; i++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
    console.log(JSON.stringify({alive:refs.filter(ref=>ref.deref()).length, latest:current.renderThread().payload.iteration, stableRows, stableDelete, freshRows, deleted, removed}));
    root.unmount();
    process.exit(0);
  `
  const compiled = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const executable = minify ? transformSync(compiled, { minify: true, format: 'esm', target: 'es2022' }).code : compiled
  return JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', executable], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 30_000,
  }).trim())
}

describe('shell callback lifetime', () => {
  it.each([false, true])('releases obsolete render payloads while preserving memo identity and action semantics (minified: %s)', minify => {
    const result = runProduction(minify)
    expect(result.alive).toBeLessThanOrEqual(10)
    expect(result).toMatchObject({ latest: 999, stableRows: true, stableDelete: true, freshRows: true,
      deleted: ['other', 'active'], removed: ['D:/project'] })
  })

  it('initializes every local factory input before reading it', () => {
    const positions = new Map<string, number>()
    function bindings(node: ts.Node) {
      if (ts.isVariableDeclaration(node)) {
        function bind(name: ts.Node) {
          if (ts.isIdentifier(name)) positions.set(name.text, node.end)
          else ts.forEachChild(name, bind)
        }
        bind(node.name)
      }
      ts.forEachChild(node, bindings)
    }
    bindings(shell)
    const late: string[] = []
    function inputs(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.startsWith('createShell')) {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && (positions.get(arg.text) ?? 0) > node.pos) late.push(arg.text)
        }
      }
      ts.forEachChild(node, inputs)
    }
    inputs(shell)
    expect(late).toEqual([])
  })

  it('creates memoized callbacks outside the shell render scope', () => {
    const violations: number[] = []
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'useCallback') {
        violations.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
      }
      ts.forEachChild(node, visit)
    }
    visit(shell)
    expect(violations).toEqual([])
  })

  it('no memo in the shell returns an inline function or hands one to a factory', () => {
    expect(memoClosureViolations(source)).toEqual([])
  })

  it('every memoized factory input is in its dependency list, or never changes identity', () => {
    expect(factoryDependencyGaps(source)).toEqual([])
  })
})

describe('shell closure guards catch what they are for', () => {
  const shellWith = (body: string) => `
    function createShellOpen(setOpen: (v: boolean) => void, id: string, onDone: () => void) {
      return () => { setOpen(true); onDone(); void id }
    }
    export function MultiSessionShell({ sessionId }: { sessionId: string }) {
      const [open, setOpen] = useState(false)
      const [, dispatch] = useReducer((s: number) => s, 0)
      const seenRef = useRef(0)
      const label = open ? 'open' : 'closed'
      ${body}
      return null
    }`

  it('accepts factory memos, value memos and inline functions consumed inside the memo', () => {
    const text = shellWith(`
      const onOpen = useMemo(() => createShellOpen(setOpen, sessionId, onDone), [sessionId, onDone])
      const sorted = useMemo(() => [label].filter(item => item !== ''), [label])
      const total = useMemo(() => { const add = (a: number) => a + 1; return add(seenRef.current) }, [])
      void dispatch`)
    expect(memoClosureViolations(text)).toEqual([])
    expect(factoryDependencyGaps(text)).toEqual([])
  })

  it('rejects a memo that returns an inline function, in each form', () => {
    const text = shellWith(`
      const direct = useMemo(() => (value: string) => value + label, [label])
      const branch = useMemo(() => (open ? () => label : null), [open, label])
      const named = useMemo(() => { const handler = () => label; return handler }, [label])
      const declared = useMemo(() => { function handler() { return label } return handler }, [label])
      const invoked = useMemo(() => (() => () => label)(), [label])`)
    expect(memoClosureViolations(text).map(entry => entry.split(': ')[1])).toEqual([
      'returns an inline function',
      'returns an inline function',
      'returns an inline function',
      'returns an inline function',
      'returns an inline function',
    ])
  })

  it('rejects an inline function passed to a shell factory, directly or nested', () => {
    const text = shellWith(`
      const a = useMemo(() => createShellOpen(setOpen, sessionId, () => label), [sessionId, label])
      const b = useMemo(() => createShellOpen(setOpen, sessionId, [function () { return label }][0]!), [sessionId, label])`)
    expect(memoClosureViolations(text).map(entry => entry.split(': ')[1])).toEqual([
      'inline function passed to createShellOpen',
      'inline function passed to createShellOpen',
    ])
  })

  it('reports a factory input missing from its dependency list, but not refs, setters or dispatch', () => {
    const text = shellWith(`
      const onDone = () => {}
      const onOpen = useMemo(() => createShellOpen(setOpen, sessionId, onDone), [sessionId])
      const onLabel = useMemo(() => createShellOpen(setOpen, label, onDone), [onDone])
      const onRef = useMemo(() => createShellCount(seenRef, dispatch, open), [open])`)
    expect(factoryDependencyGaps(text).map(entry => entry.replace(/^\d+ /, ''))).toEqual([
      'createShellOpen: onDone',
      'createShellOpen: label',
    ])
  })
})
