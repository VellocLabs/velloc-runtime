import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../browser/webview/MultiSessionShell.tsx', import.meta.url), 'utf8')

type Analysed = {
  file: ts.SourceFile
  shell: ts.FunctionDeclaration
  /** Names bound in the shell's own scope; nested functions' bindings are not. */
  local: Map<string, ts.Node>
  /** Shell-scope names whose identity never changes: `useRef` objects, state setters, reducer dispatch. */
  stable: Set<string>
  /** Shell-scope names bound to a function written in the render (an arrow, function expression or declaration). */
  renderFunctions: Set<string>
}

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

/** Anything that creates a function value in place: arrows, function expressions and declarations, methods, classes. */
const createsFunction = (node: ts.Node): boolean =>
  isFunctionNode(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isClassExpression(node) ||
  ts.isClassDeclaration(node)

function analyse(text: string): Analysed {
  const { file, shell } = shellOf(text)
  const local = new Map<string, ts.Node>()
  const stable = new Set<string>()
  const renderFunctions = new Set<string>()
  const bind = (name: ts.Node, declaration: ts.Node) => {
    if (ts.isIdentifier(name)) local.set(name.text, declaration)
    else ts.forEachChild(name, child => bind(child, declaration))
  }
  for (const parameter of shell.parameters) bind(parameter.name, parameter)
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      local.set(node.name.text, node)
      renderFunctions.add(node.name.text)
      return
    }
    if (createsFunction(node)) return
    if (ts.isVariableDeclaration(node)) {
      bind(node.name, node)
      const init = node.initializer ? unwrap(node.initializer) : null
      if (init && ts.isIdentifier(node.name) && createsFunction(init)) renderFunctions.add(node.name.text)
      const hook = init && ts.isCallExpression(init) ? hookName(init) : ''
      if (hook === 'useRef' && ts.isIdentifier(node.name)) stable.add(node.name.text)
      if ((hook === 'useState' || hook === 'useReducer') && ts.isArrayBindingPattern(node.name)) {
        const second = node.name.elements[1]
        if (second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) stable.add(second.name.text)
      }
    }
    ts.forEachChild(node, walk)
  }
  if (shell.body) ts.forEachChild(shell.body, walk)
  return { file, shell, local, stable, renderFunctions }
}

/** The hook a call names, written bare (`useMemo`) or through a namespace (`React.useMemo`). */
function hookName(call: ts.CallExpression): string {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ''
}

const lineOf = (s: Analysed, node: ts.Node) => s.file.getLineAndCharacterOfPosition(node.getStart(s.file)).line + 1

function forEachInShell(s: Analysed, visit: (node: ts.Node) => void) {
  const walk = (node: ts.Node) => {
    visit(node)
    ts.forEachChild(node, walk)
  }
  walk(s.shell)
}

/** The values a memo callback can produce: its expression body, or the `return`s of its block body. */
function memoResults(callback: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(callback.body)) return [callback.body]
  const found: ts.Expression[] = []
  const visit = (node: ts.Node) => {
    if (createsFunction(node)) return
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(callback.body, visit)
  return found
}

/**
 * The one factory predicate both guards share: a call to a module-level function (not bound in the
 * shell) whose name starts with `create`.
 */
function factoryCallOf(s: Analysed, expression: ts.Expression): ts.CallExpression | null {
  const value = unwrap(expression)
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return null
  const name = value.expression.text
  return name.startsWith('create') && !s.local.has(name) ? value : null
}

type Memo = {
  call: ts.CallExpression
  callback: ts.ArrowFunction | ts.FunctionExpression | null
  deps: Set<string>
  /** The factory calls it returns, when every value it can produce is one; else empty (a value memo). */
  factories: ts.CallExpression[]
}

function shellMemos(s: Analysed): Memo[] {
  const memos: Memo[] = []
  forEachInShell(s, node => {
    if (!ts.isCallExpression(node) || hookName(node) !== 'useMemo') return
    const first = node.arguments[0]
    const callback = first && isFunctionNode(first) ? first : null
    const depsNode = node.arguments[1]
    const deps = new Set(depsNode && ts.isArrayLiteralExpression(depsNode)
      ? depsNode.elements.map(dep => dep.getText(s.file)) : [])
    const results = callback ? memoResults(callback) : []
    const calls = results.map(result => factoryCallOf(s, result))
    const factories = calls.length > 0 && calls.every(call => call !== null) ? calls as ts.CallExpression[] : []
    memos.push({ call: node, callback, deps, factories })
  })
  return memos
}

/** Bindings declared inside `callback` itself. */
function callbackBindings(callback: ts.Node): Set<string> {
  const names = new Set<string>()
  const bind = (name: ts.Node) => {
    if (ts.isIdentifier(name)) names.add(name.text)
    else ts.forEachChild(name, bind)
  }
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) bind(node.name)
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text)
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(callback, walk)
  return names
}

/**
 * Functions a value memo may create in place: callbacks handed straight to these, which call them
 * during the memo and keep no reference. Anything else that creates a function inside a value memo is
 * a violation.
 */
const CONSUMING_METHODS = new Set(['filter', 'map', 'flatMap', 'find', 'findIndex', 'findLast', 'some', 'every',
  'reduce', 'forEach', 'sort', 'toSorted'])
const CONSUMING_FUNCTIONS = new Set(['resolveBootSession'])

/** Whether `fn` is an argument of a consuming call, directly or as a property of an object argument. */
function isConsumedArgument(fn: ts.Node): boolean {
  const inObject = ts.isPropertyAssignment(fn.parent) && fn.parent.initializer === fn &&
    ts.isObjectLiteralExpression(fn.parent.parent)
  const argument = inObject ? fn.parent.parent : fn
  const call = argument.parent
  if (!ts.isCallExpression(call) || !call.arguments.includes(argument as ts.Expression)) return false
  const callee = call.expression
  if (ts.isPropertyAccessExpression(callee)) return CONSUMING_METHODS.has(callee.name.text)
  return ts.isIdentifier(callee) && CONSUMING_FUNCTIONS.has(callee.text)
}

const isFactoryName = (name: string) => name.startsWith('createShell')

/** No `useCallback` (bare or `React.useCallback`) anywhere in the shell. Each entry is `line: reason`. */
function callbackHookViolations(text: string): string[] {
  const s = analyse(text)
  const found: string[] = []
  forEachInShell(s, node => {
    if (ts.isCallExpression(node) && hookName(node) === 'useCallback') found.push(`${lineOf(s, node)}: useCallback`)
  })
  return found
}

/**
 * Ways a render's scope can outlive the render through a memo. A memo must return exactly a factory
 * call, or a value that creates no function and refers to no render-scope function. A factory's inputs
 * must create no function and name no render-scope function. Every `createShell*` call must be a memo's
 * result. Each entry is `line: reason`.
 */
function memoClosureViolations(text: string): string[] {
  const s = analyse(text)
  const found: string[] = []
  const factoryCalls = new Set<ts.CallExpression>()
  for (const memo of shellMemos(s)) {
    if (!memo.callback) {
      found.push(`${lineOf(s, memo.call)}: memo callback is not a function written in place`)
      continue
    }
    if (memo.factories.length > 0) {
      for (const call of memo.factories) {
        factoryCalls.add(call)
        const factory = (call.expression as ts.Identifier).text
        const visit = (node: ts.Node) => {
          if (createsFunction(node)) {
            found.push(`${lineOf(s, node)}: inline function passed to ${factory}`)
            return
          }
          if (ts.isIdentifier(node) && s.renderFunctions.has(node.text) && !isPropertyName(node)) {
            found.push(`${lineOf(s, node)}: render-scope function ${node.text} passed to ${factory}`)
          }
          ts.forEachChild(node, visit)
        }
        call.arguments.forEach(visit)
      }
      if (ts.isBlock(memo.callback.body)) {
        const body = memo.callback.body
        const visit = (node: ts.Node) => {
          if (createsFunction(node)) found.push(`${lineOf(s, node)}: function created in a factory memo`)
          else ts.forEachChild(node, visit)
        }
        ts.forEachChild(body, visit)
      }
      continue
    }
    const callback = memo.callback
    const visit = (node: ts.Node) => {
      if (node !== callback && createsFunction(node)) {
        if (!isConsumedArgument(node)) found.push(`${lineOf(s, node)}: function created in a value memo`)
      } else if (ts.isIdentifier(node) && s.renderFunctions.has(node.text) && !isPropertyName(node) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        found.push(`${lineOf(s, node)}: render-scope function ${node.text} in a value memo`)
      }
      ts.forEachChild(node, visit)
    }
    visit(callback)
  }
  forEachInShell(s, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && isFactoryName(node.expression.text) &&
      !factoryCalls.has(node)) {
      found.push(`${lineOf(s, node)}: ${node.expression.text} called outside a memo result`)
    }
  })
  return found.sort((x, y) => parseInt(x) - parseInt(y))
}

const isPropertyName = (node: ts.Identifier) =>
  (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
  (ts.isPropertyAssignment(node.parent) && node.parent.name === node)

const isLiteral = (node: ts.Expression) =>
  ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
  node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
  node.kind === ts.SyntaxKind.NullKeyword

/** The identifier a name or property chain (`a`, `a.b`, `a!.b`) starts from; null for anything else. */
function rootName(node: ts.Expression): ts.Identifier | null {
  const value = unwrap(node)
  if (ts.isIdentifier(value)) return value
  if (ts.isPropertyAccessExpression(value)) return rootName(value.expression)
  return null
}

/**
 * Inputs of every factory memo that could be stale. An input must be a literal, a module-level name, or
 * a shell name or property chain listed in the memo's dependencies; a ref, a state setter or a reducer
 * dispatch may be left out. Anything else, a name bound inside the memo callback, or an expression
 * (`a ?? b`, a call) is reported: hoist it to a named shell local. Each entry is `line factory: input`.
 */
function factoryDependencyGaps(text: string): string[] {
  const s = analyse(text)
  const gaps: string[] = []
  for (const memo of shellMemos(s)) {
    if (!memo.callback) continue
    const inside = callbackBindings(memo.callback)
    for (const call of memo.factories) {
      const factory = (call.expression as ts.Identifier).text
      for (const argument of call.arguments) {
        const input = unwrap(argument)
        const text = input.getText(s.file)
        const report = (why: string) => gaps.push(`${lineOf(s, memo.call)} ${factory}: ${text}${why}`)
        if (isLiteral(input)) continue
        const root = rootName(input)
        if (!root) {
          report(' (not a name; hoist it)')
          continue
        }
        if (inside.has(root.text)) {
          report(' (bound in the memo; hoist it)')
          continue
        }
        if (!s.local.has(root.text)) continue
        if (memo.deps.has(text) || (ts.isIdentifier(input) && s.stable.has(text))) continue
        report('')
      }
    }
  }
  return gaps
}

/** Shell names a factory memo reads before they are declared. Each entry is `line factory: input`. */
function lateFactoryInputs(text: string): string[] {
  const s = analyse(text)
  const late: string[] = []
  for (const memo of shellMemos(s)) {
    for (const call of memo.factories) {
      for (const argument of call.arguments) {
        const root = rootName(argument)
        const declaration = root ? s.local.get(root.text) : undefined
        if (root && declaration && !ts.isParameter(declaration) && declaration.end > memo.call.getStart(s.file)) {
          late.push(`${lineOf(s, memo.call)} ${(call.expression as ts.Identifier).text}: ${root.text}`)
        }
      }
    }
  }
  return late
}

/** How many memos return `createShell*` factory calls, and how many such calls the shell makes at all. */
function factoryCounts(text: string): { factoryMemos: number; shellFactoryCalls: number } {
  const s = analyse(text)
  const factoryMemos = shellMemos(s).filter(memo => memo.factories.length > 0).length
  let shellFactoryCalls = 0
  forEachInShell(s, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && isFactoryName(node.expression.text)) {
      shellFactoryCalls += 1
    }
  })
  return { factoryMemos, shellFactoryCalls }
}

const { file, shell } = shellOf(source)
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

  it('creates memoized callbacks outside the shell render scope', () => {
    expect(callbackHookViolations(source)).toEqual([])
  })

  it('no memo in the shell can keep a render scope alive', () => {
    expect(memoClosureViolations(source)).toEqual([])
  })

  it('every factory memo input is in its dependency list, or never changes identity', () => {
    expect(factoryDependencyGaps(source)).toEqual([])
  })

  it('initializes every factory memo input before the memo reads it', () => {
    expect(lateFactoryInputs(source)).toEqual([])
  })

  it('the guards see the shell: at least 100 factory memos, and every createShell call is one', () => {
    const counts = factoryCounts(source)
    expect(counts.factoryMemos).toBeGreaterThanOrEqual(100)
    expect(counts.shellFactoryCalls).toBeLessThanOrEqual(counts.factoryMemos)
    expect(counts.shellFactoryCalls).toBeGreaterThanOrEqual(100)
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
      const onDone = () => {}
      ${body}
      return null
    }`
  const reasons = (entries: string[]) => entries.map(entry => entry.replace(/^\d+:? ?/, ''))

  it('accepts factory memos (expression or block body), value memos and consumed callbacks', () => {
    const text = shellWith(`
      const onOpen = useMemo(() => createShellOpen(setOpen, sessionId, onOpen2), [sessionId, onOpen2])
      const onOpen2 = useMemo(() => { return createShellOpen(setOpen, 'fixed', seenRef as never) }, [])
      const sorted = useMemo(() => [label].filter(item => item !== '').map(item => item.length), [label])
      const handlers = useMemo(() => ({ open: onOpen, count: seenRef.current }), [onOpen])
      const boot = React.useMemo(() => resolveBootSession({ mint: () => sessionId }), [sessionId])
      void dispatch`)
    expect(memoClosureViolations(text)).toEqual([])
    expect(callbackHookViolations(text)).toEqual([])
  })

  it('rejects every way a memo can return or hold a function created in the render', () => {
    const text = shellWith(`
      const direct = useMemo(() => (value: string) => value + label, [label])
      const branch = useMemo(() => (open ? () => label : null), [open, label])
      const named = useMemo(() => { const handler = () => label; return handler }, [label])
      const declared = useMemo(() => { function handler() { return label } return handler }, [label])
      const invoked = useMemo(() => (() => () => label)(), [label])
      const byName = useMemo(() => onDone, [onDone])
      const inObject = useMemo(() => ({ go: () => label }), [label])
      const method = useMemo(() => ({ go() { return label } }), [label])
      const namespaced = React.useMemo(() => () => label, [label])
      const wrapped = useMemo(() => wrap(() => label), [label])
      const kept = useMemo(() => [onDone], [onDone])`)
    expect(reasons(memoClosureViolations(text))).toEqual([
      'function created in a value memo',
      'function created in a value memo',
      'function created in a value memo',
      'function created in a value memo',
      'function created in a value memo',
      'function created in a value memo',
      'render-scope function onDone in a value memo',
      'function created in a value memo',
      'function created in a value memo',
      'function created in a value memo',
      'function created in a value memo',
      'render-scope function onDone in a value memo',
    ])
  })

  it('rejects functions handed to a factory, and a factory called outside a memo result', () => {
    const text = shellWith(`
      const a = useMemo(() => createShellOpen(setOpen, sessionId, () => label), [sessionId, label])
      const b = useMemo(() => createShellOpen(setOpen, sessionId, [function () { return label }][0]!), [sessionId, label])
      const c = useMemo(() => createShellOpen(setOpen, sessionId, onDone), [sessionId, onDone])
      const d = useMemo(() => { const local = () => label; return createShellOpen(setOpen, sessionId, local) }, [sessionId])
      const bare = createShellOpen(setOpen, sessionId, onDone)
      const later = useMemo(() => [createShellOpen(setOpen, sessionId, c)], [sessionId, c])`)
    expect(reasons(memoClosureViolations(text))).toEqual([
      'inline function passed to createShellOpen',
      'inline function passed to createShellOpen',
      'render-scope function onDone passed to createShellOpen',
      'function created in a factory memo',
      'createShellOpen called outside a memo result',
      'createShellOpen called outside a memo result',
    ])
  })

  it('reports factory inputs that could be stale, in every shape, but not refs, setters, dispatch or constants', () => {
    const text = shellWith(`
      const missing = useMemo(() => createShellOpen(setOpen, sessionId, missing2), [missing2])
      const missing2 = useMemo(() => { return createShellOpen(setOpen, label, missing) }, [missing])
      const expression = useMemo(() => createShellOpen(setOpen, sessionId ?? label, missing), [sessionId, label, missing])
      const hoistable = useMemo(() => { const id = label; return createShellOpen(setOpen, id, missing) }, [label, missing])
      const refValue = useMemo(() => createShellOpen(setOpen, seenRef.current, missing), [missing])
      const namespaced = React.useMemo(() => createShellOpen(setOpen, label, missing), [missing])
      const fine = useMemo(() => createShellCount(seenRef, dispatch, setOpen, 'x', 3, MODULE_LEVEL), [])`)
    expect(reasons(factoryDependencyGaps(text))).toEqual([
      'createShellOpen: sessionId',
      'createShellOpen: label',
      'createShellOpen: sessionId ?? label (not a name; hoist it)',
      'createShellOpen: id (bound in the memo; hoist it)',
      'createShellOpen: seenRef.current',
      'createShellOpen: label',
    ])
  })

  it('reports useCallback, bare or namespaced', () => {
    const text = shellWith(`
      const a = useCallback(() => label, [label])
      const b = React.useCallback(() => label, [label])`)
    expect(reasons(callbackHookViolations(text))).toEqual(['useCallback', 'useCallback'])
  })

  it('reports a factory memo input declared after the memo', () => {
    const text = shellWith(`
      const early = useMemo(() => createShellOpen(setOpen, later, onDone), [later])
      const later = label + '!'
      const ok = useMemo(() => createShellOpen(setOpen, later, onDone), [later])`)
    expect(reasons(lateFactoryInputs(text))).toEqual(['createShellOpen: later'])
  })

  it('counts factory memos and shell factory calls, so a rename cannot make the guards vacuous', () => {
    const text = shellWith(`
      const a = useMemo(() => createShellOpen(setOpen, sessionId, onDone), [sessionId])
      const b = useMemo(() => { return createShellOpen(setOpen, label, onDone) }, [label])
      const c = useMemo(() => createConfiguredThing(label), [label])`)
    expect(factoryCounts(text)).toEqual({ factoryMemos: 3, shellFactoryCalls: 2 })
  })
})
