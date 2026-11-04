import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../browser/webview/MultiSessionShell.tsx', import.meta.url), 'utf8')

/**
 * How a shell-scope name is bound. `defaults` holds every default on the path from the whole parameter or
 * declaration down to the name (a whole-parameter default and each enclosing destructuring default); any
 * of them can become its value.
 */
type Binding =
  | { kind: 'parameter'; defaults: ts.Expression[] }
  | { kind: 'function' }
  | { kind: 'const'; declaration: ts.VariableDeclaration; defaults: ts.Expression[] }
  | { kind: 'other' }

type Analysed = {
  file: ts.SourceFile
  shell: ts.FunctionDeclaration
  /** Names bound in the shell's own scope (not inside nested functions), by how they are bound. */
  local: Map<string, Binding>
  /** Shell-scope names whose identity never changes: `useRef` objects, state setters, reducer dispatch. */
  stable: Set<string>
  /** Declarations, for the declared-before-read check. */
  declaredAt: Map<string, ts.Node>
  /**
   * Shell-scope names mutated in the render after their declaration, directly or through a `const` alias.
   * Stable names are never included.
   */
  mutated: Set<string>
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
    ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression
  return current
}

const isFunctionNode = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node)

/** Anything that creates a function value in place: arrows, function expressions and declarations, methods, classes. */
const createsFunction = (node: ts.Node): boolean =>
  isFunctionNode(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isClassExpression(node) ||
  ts.isClassDeclaration(node)

const analysed = new Map<string, Analysed>()

/** One parse and binding table per source text. */
function analyse(text: string): Analysed {
  const cached = analysed.get(text)
  if (cached) return cached
  const { file, shell } = shellOf(text)
  const local = new Map<string, Binding>()
  const stable = new Set<string>()
  const declaredAt = new Map<string, ts.Node>()
  const withDefault = (defaults: ts.Expression[], value: ts.Expression | undefined) =>
    value ? [...defaults, value] : defaults
  const bindParameter = (name: ts.BindingName, defaults: ts.Expression[]) => {
    if (ts.isIdentifier(name)) {
      local.set(name.text, { kind: 'parameter', defaults })
      return
    }
    for (const child of name.elements) {
      if (ts.isBindingElement(child)) bindParameter(child.name, withDefault(defaults, child.initializer))
    }
  }
  for (const parameter of shell.parameters) bindParameter(parameter.name, withDefault([], parameter.initializer))
  const hookValues: [string, ts.CallExpression][] = []
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      local.set(node.name.text, { kind: 'function' })
      declaredAt.set(node.name.text, node)
      return
    }
    if (createsFunction(node)) return
    if (ts.isVariableDeclaration(node)) {
      const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isVariableStatement(node.parent.parent)
      const bind = (name: ts.BindingName, defaults: ts.Expression[]) => {
        if (ts.isIdentifier(name)) {
          local.set(name.text, isConst ? { kind: 'const', declaration: node, defaults } : { kind: 'other' })
          declaredAt.set(name.text, node)
          return
        }
        for (const child of name.elements) {
          if (ts.isBindingElement(child)) bind(child.name, withDefault(defaults, child.initializer))
        }
      }
      bind(node.name, [])
      const init = node.initializer ? unwrap(node.initializer) : null
      const call = init && ts.isCallExpression(init) ? init : null
      const hook = call ? hookName(call) : ''
      if (call && hook === 'useRef' && ts.isIdentifier(node.name)) hookValues.push([node.name.text, call])
      if (call && (hook === 'useState' || hook === 'useReducer') && ts.isArrayBindingPattern(node.name)) {
        const second = node.name.elements[1]
        if (second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) {
          hookValues.push([second.name.text, call])
        }
      }
    }
    if ((ts.isCatchClause(node) && node.variableDeclaration) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const declared = ts.isCatchClause(node) ? node.variableDeclaration!.name
        : ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0]?.name : undefined
      const mark = (name: ts.Node | undefined) => {
        if (!name) return
        if (ts.isIdentifier(name)) local.set(name.text, { kind: 'other' })
        else ts.forEachChild(name, mark)
      }
      mark(declared)
    }
    ts.forEachChild(node, walk)
  }
  if (shell.body) ts.forEachChild(shell.body, walk)
  for (const [name, call] of hookValues) {
    if (isTrustedHookCall(local, call)) stable.add(name)
  }
  const mutated = new Set<string>()
  const markMutated = (target: ts.Expression, hidden: Set<string>) => {
    let root = unwrap(target)
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression)
    if (ts.isIdentifier(root) && !hidden.has(root.text) && local.has(root.text) && !stable.has(root.text)) {
      mutated.add(root.text)
    }
  }
  const findMutations = (node: ts.Node, hidden: Set<string>) => {
    if (createsFunction(node)) {
      if (!isConsumedArgument(node)) return
      hidden = new Set([...hidden, ...callbackBindings(node)])
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      markMutated(node.left, hidden)
    }
    if (ts.isDeleteExpression(node)) markMutated(node.expression, hidden)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: receiver, name } = node.expression
      if (MUTATING_METHODS.has(name.text)) markMutated(receiver, hidden)
      if (ts.isIdentifier(receiver) && receiver.text === 'Object' && MUTATING_OBJECT_FUNCTIONS.has(name.text) &&
        node.arguments[0]) markMutated(node.arguments[0], hidden)
    }
    ts.forEachChild(node, child => findMutations(child, hidden))
  }
  if (shell.body) ts.forEachChild(shell.body, child => findMutations(child, new Set()))
  for (let grew = true; grew;) {
    grew = false
    for (const [name, binding] of local) {
      if (binding.kind !== 'const' || !mutated.has(name)) continue
      const sources = [binding.declaration.initializer, ...binding.defaults]
      for (const root of sources.flatMap(source => (source ? aliasRoots(source) : []))) {
        if (local.has(root) && !stable.has(root) && !mutated.has(root)) {
          mutated.add(root)
          grew = true
        }
      }
    }
  }
  const result = { file, shell, local, stable, declaredAt, mutated }
  analysed.set(text, result)
  return result
}

/** Methods and `Object.*` functions that change their receiver or first argument in place. */
const MUTATING_METHODS = new Set(['push', 'unshift', 'splice', 'pop', 'shift', 'fill', 'copyWithin', 'reverse',
  'sort', 'set', 'add', 'delete', 'clear'])
const MUTATING_OBJECT_FUNCTIONS = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'])

/**
 * Names whose own value `expression` may be, so that mutating the result mutates them: a name, a property
 * or element read of one, either branch of a conditional, and either side of `??`, `||` or `&&`.
 */
function aliasRoots(expression: ts.Expression): string[] {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) return [value.text]
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return aliasRoots(value.expression)
  if (ts.isConditionalExpression(value)) return [...aliasRoots(value.whenTrue), ...aliasRoots(value.whenFalse)]
  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken) return [...aliasRoots(value.left), ...aliasRoots(value.right)]
    if (operator === ts.SyntaxKind.CommaToken) return aliasRoots(value.right)
  }
  return []
}

/** The hook a call names, written bare (`useMemo`) or through a namespace (`React.useMemo`). */
function hookName(call: ts.CallExpression): string {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ''
}

/**
 * Whether `call` is a hook whose value the guards trust: `useX(...)` called directly, or through a name
 * that is not bound in the shell (`React.useX(...)`). `value.useX(...)` on a shell value is not a hook.
 */
function isTrustedHookCall(local: Map<string, Binding>, call: ts.CallExpression): boolean {
  if (!/^use[A-Z]/.test(hookName(call))) return false
  const callee = call.expression
  if (ts.isIdentifier(callee)) return true
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
    !local.has(callee.expression.text)
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
 * The factory predicate of the memo guards: a call to a module-level function (not bound in the shell)
 * whose name starts with `create`. The outside-a-memo check and the floor use `isFactoryName` instead.
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
 * Callbacks a memo or a render value may create in place: the first argument of these array methods,
 * which call it during the expression and keep no reference, and the `mintSessionId` option of
 * `resolveBootSession`, which it calls once. Any other function created in place is refused.
 */
const CONSUMING_METHODS = new Set(['filter', 'map', 'flatMap', 'find', 'findIndex', 'findLast', 'some', 'every',
  'reduce', 'forEach', 'sort', 'toSorted'])
const CONSUMING_OPTIONS: Record<string, string> = { resolveBootSession: 'mintSessionId' }

/** Whether `fn` is a callback that is consumed in place (see `CONSUMING_METHODS`). */
function isConsumedArgument(fn: ts.Node): boolean {
  const parent = fn.parent
  if (ts.isCallExpression(parent)) {
    return parent.arguments[0] === fn && ts.isPropertyAccessExpression(parent.expression) &&
      CONSUMING_METHODS.has(parent.expression.name.text)
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === fn && ts.isIdentifier(parent.name) &&
    ts.isObjectLiteralExpression(parent.parent) && ts.isCallExpression(parent.parent.parent)) {
    const call = parent.parent.parent
    return call.arguments[0] === parent.parent && ts.isIdentifier(call.expression) &&
      CONSUMING_OPTIONS[call.expression.text] === parent.name.text
  }
  return false
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

const isReference = (node: ts.Identifier): boolean => {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent)) && parent.name === node) return false
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) || ts.isClassExpression(parent) || ts.isClassDeclaration(parent)) &&
    parent.name === node) return false
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false
  if (ts.isJsxAttribute(parent) && parent.name === node) return false
  let ancestor: ts.Node | undefined = parent
  while (ancestor && !ts.isSourceFile(ancestor)) {
    if (ts.isTypeNode(ancestor) || ts.isTypeAliasDeclaration(ancestor) || ts.isInterfaceDeclaration(ancestor)) return false
    if (ts.isExpression(ancestor) || ts.isStatement(ancestor)) break
    ancestor = ancestor.parent
  }
  return true
}

const isLiteral = (node: ts.Expression) =>
  ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node) ||
  node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
  node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword

/**
 * Why the shell-scope name `name` could hold something that keeps a render's scope alive, or null when
 * it cannot. Allowlist: a prop; a hook's value; a `const` whose initializer is built only from the shapes
 * `closureRisk` accepts. For a prop or a `const`, every default on its path must pass too. A render-level
 * function declaration, a `let`, `var`, loop or catch binding, and anything else are refused.
 */
function bindingRisk(s: Analysed, name: string, seen: Set<string> = new Set()): string | null {
  const binding = s.local.get(name)
  if (!binding) return null
  if (binding.kind === 'function') return 'a function declared in the render'
  if (binding.kind === 'other') return 'not a const binding'
  if (binding.kind === 'const' && s.mutated.has(name)) return 'mutated in the render after its declaration'
  if (seen.has(name)) return null
  seen.add(name)
  for (const value of binding.defaults) {
    const risk = closureRisk(s, value, seen)
    if (risk) return risk
  }
  if (binding.kind === 'parameter') return null
  if (!binding.declaration.initializer) return 'no initializer'
  return closureRisk(s, binding.declaration.initializer, seen)
}

/**
 * Why `expression`, evaluated in the render, could produce or hold a function created in the render,
 * or null when it cannot. The safe shapes: literals and templates; module-level names; shell names
 * whose binding is safe; property and element reads of a safe value; unary, binary, conditional and
 * type operators on safe operands; array and object literals of safe parts (no methods or accessors);
 * hook calls; other calls and `new` whose callee and arguments are safe, where the only function
 * allowed in place is a consumed callback (`consumedCallbackRisk`). Every other shape is refused.
 */
function closureRisk(s: Analysed, node: ts.Expression, seen: Set<string> = new Set()): string | null {
  const value = unwrap(node)
  if (isLiteral(value)) return null
  if (ts.isIdentifier(value)) {
    const risk = bindingRisk(s, value.text, seen)
    return risk ? `${value.text}: ${risk}` : null
  }
  if (createsFunction(value)) return 'a function created in the render'
  if (ts.isTemplateExpression(value)) {
    for (const span of value.templateSpans) {
      const risk = closureRisk(s, span.expression, seen)
      if (risk) return risk
    }
    return null
  }
  if (ts.isPropertyAccessExpression(value)) return closureRisk(s, value.expression, seen)
  if (ts.isElementAccessExpression(value)) {
    return closureRisk(s, value.expression, seen) ?? closureRisk(s, value.argumentExpression, seen)
  }
  if (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) return closureRisk(s, value.operand, seen)
  if (ts.isTypeOfExpression(value) || ts.isVoidExpression(value) || ts.isAwaitExpression(value)) {
    return closureRisk(s, value.expression, seen)
  }
  if (ts.isBinaryExpression(value)) return closureRisk(s, value.left, seen) ?? closureRisk(s, value.right, seen)
  if (ts.isConditionalExpression(value)) {
    return closureRisk(s, value.condition, seen) ?? closureRisk(s, value.whenTrue, seen) ??
      closureRisk(s, value.whenFalse, seen)
  }
  if (ts.isArrayLiteralExpression(value)) {
    for (const element of value.elements) {
      const risk = ts.isOmittedExpression(element) ? null
        : closureRisk(s, ts.isSpreadElement(element) ? element.expression : element, seen)
      if (risk) return risk
    }
    return null
  }
  if (ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      let risk: string | null
      if (ts.isPropertyAssignment(property)) {
        risk = (ts.isComputedPropertyName(property.name) ? closureRisk(s, property.name.expression, seen) : null) ??
          closureRisk(s, property.initializer, seen)
      } else if (ts.isShorthandPropertyAssignment(property)) {
        risk = closureRisk(s, property.name, seen)
      } else if (ts.isSpreadAssignment(property)) {
        risk = closureRisk(s, property.expression, seen)
      } else {
        risk = 'a method or accessor created in the render'
      }
      if (risk) return risk
    }
    return null
  }
  if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
    if (ts.isCallExpression(value) && isTrustedHookCall(s.local, value)) return null
    const calleeRisk = closureRisk(s, value.expression, seen)
    if (calleeRisk) return calleeRisk
    for (const argument of value.arguments ?? []) {
      const risk = createsFunction(unwrap(argument)) ? consumedCallbackRisk(s, unwrap(argument), seen)
        : closureRisk(s, ts.isSpreadElement(argument) ? argument.expression : argument, seen)
      if (risk) return risk
    }
    return null
  }
  return `cannot be decided (${ts.SyntaxKind[value.kind]})`
}

/**
 * A function written as a call argument is safe only when it is consumed during the call and kept by
 * nothing: the first argument of an array method in `CONSUMING_METHODS`, with an expression body that
 * is itself safe (its own parameters are elements of the array and safe by that).
 */
function consumedCallbackRisk(s: Analysed, fn: ts.Expression, seen: Set<string>): string | null {
  if (!isConsumedArgument(fn) || !ts.isArrowFunction(fn) || ts.isBlock(fn.body)) return 'a function created in the render'
  const params = new Set<string>()
  const bind = (name: ts.Node) => {
    if (ts.isIdentifier(name)) params.add(name.text)
    else ts.forEachChild(name, bind)
  }
  fn.parameters.forEach(parameter => bind(parameter.name))
  const shadowed: [string, Binding | undefined][] = [...params].map(name => [name, s.local.get(name)])
  for (const name of params) s.local.set(name, { kind: 'parameter', defaults: [] })
  try {
    return closureRisk(s, fn.body, seen)
  } finally {
    for (const [name, binding] of shadowed) {
      if (binding) s.local.set(name, binding)
      else s.local.delete(name)
    }
  }
}

/** Shell-scope names `callback` reads, excluding names it binds itself and property names. */
function capturedNames(s: Analysed, callback: ts.Node): ts.Identifier[] {
  const inner = callbackBindings(callback)
  const found: ts.Identifier[] = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && s.local.has(node.text) && !inner.has(node.text) && isReference(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(callback, visit)
  return found
}

/**
 * Ways a render's scope can outlive the render through a memo, decided by allowlist:
 * - a memo's callback is an arrow or function expression written in place;
 * - every shell-scope name it reads has a safe binding (`bindingRisk`);
 * - it creates no function, except a consumed callback in a value memo;
 * - a factory memo returns exactly factory calls, and every `createShell*` call is a memo's result.
 * Each entry is `line: reason`.
 */
function memoClosureViolations(text: string): string[] {
  const s = analyse(text)
  const found = new Set<string>()
  const add = (node: ts.Node, reason: string) => found.add(`${lineOf(s, node)}: ${reason}`)
  const factoryCalls = new Set<ts.CallExpression>()
  for (const memo of shellMemos(s)) {
    if (!memo.callback) {
      add(memo.call, 'memo callback is not a function written in place')
      continue
    }
    const callback = memo.callback
    const isFactoryMemo = memo.factories.length > 0
    memo.factories.forEach(call => factoryCalls.add(call))
    for (const name of capturedNames(s, callback)) {
      const risk = bindingRisk(s, name.text)
      if (risk) add(name, `captures ${name.text}: ${risk}`)
    }
    const visit = (node: ts.Node) => {
      if (node !== callback && createsFunction(node)) {
        if (isFactoryMemo) add(node, 'function created in a factory memo')
        else if (!isConsumedArgument(node)) add(node, 'function created in a value memo')
      }
      ts.forEachChild(node, visit)
    }
    visit(callback)
  }
  forEachInShell(s, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && isFactoryName(node.expression.text) &&
      !factoryCalls.has(node)) {
      add(node, `${node.expression.text} called outside a memo result`)
    }
  })
  return [...found].sort((x, y) => parseInt(x) - parseInt(y))
}

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
        const declaration = root ? s.declaredAt.get(root.text) : undefined
        if (root && declaration && declaration.end > memo.call.getStart(s.file)) {
          late.push(`${lineOf(s, memo.call)} ${(call.expression as ts.Identifier).text}: ${root.text}`)
        }
      }
    }
  }
  return late
}

/** How many memos return factory calls, and how many `createShell*` calls the shell makes at all. */
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

const FACTORY_FLOOR = 100

/** The floor that keeps the guards from passing on nothing after a rename. Each entry names a shortfall. */
function factoryFloorViolations(text: string): string[] {
  const { factoryMemos, shellFactoryCalls } = factoryCounts(text)
  const found: string[] = []
  if (factoryMemos < FACTORY_FLOOR) found.push(`factory memos: ${factoryMemos} (at least ${FACTORY_FLOOR})`)
  if (shellFactoryCalls < FACTORY_FLOOR) found.push(`createShell calls: ${shellFactoryCalls} (at least ${FACTORY_FLOOR})`)
  return found
}

const { file, shell } = shellOf(source)
const names = new Set(['subAgentRowsSeenRef', 'subAgentRowsForSession'])
const declarations: string[] = []
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(file))) {
    declarations.push(`const ${node.getText(file)};`)
  }
  ts.forEachChild(node, collect)
}
collect(shell)
const factories = file.statements.filter(node => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'createShellSubAgentRowsForSession'
).map(node => node.getText(file)).join('\n')

function runProduction(minify: boolean) {
  const program = `
    import React, { useCallback, useMemo, useRef } from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { Window } from 'happy-dom';
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    const filterSubAgentRowsBySession = (rows, id) => rows.filter(row => row.sessionId === id);
    const subAgentsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ${factories}
    let current;
    function Shell({ sessions, subAgentRows, payload, activeSessionId }) {
      ${declarations.join('\n')}
      const renderThread = () => ({ payload, rows: subAgentRowsForSession });
      current = { rows: subAgentRowsForSession, renderThread };
      return null;
    }
    const root = createRoot(document.createElement('div'));
    const refs = [];
    let sessions = [{sessionId:'active', projectRoot:'D:/project'}, {sessionId:'other', projectRoot:'d:/project'}];
    let rows = [{sessionId:'active', value:0}];
    let previous, stableRows = true, freshRows = true;
    for (let i = 0; i < 1000; i++) {
      if (i % 2 === 0) rows = [{sessionId:'active', value:i}];
      else sessions = sessions.map(session => ({...session}));
      const payload = { iteration:i, data:new Array(100).fill(i) };
      refs.push(new WeakRef(payload));
      flushSync(() => root.render(React.createElement(Shell, {sessions, subAgentRows:rows, payload, activeSessionId:'active'})));
      if (previous && i % 2) stableRows &&= previous.rows === current.rows;
      freshRows &&= current.rows('active')[0].value === i - i % 2;
      previous = current;
    }
    for (let i = 0; i < 4; i++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
    console.log(JSON.stringify({alive:refs.filter(ref=>ref.deref()).length, latest:current.renderThread().payload.iteration, stableRows, freshRows}));
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
    expect(result).toMatchObject({ latest: 999, stableRows: true, freshRows: true })
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

  it('the guards see the shell: at least 100 factory memos and at least 100 createShell calls', () => {
    expect(factoryFloorViolations(source)).toEqual([])
  })
})

describe('shell closure guards catch what they are for', () => {
  const shellWith = (body: string) => `
    function createShellOpen(setOpen: (v: boolean) => void, id: unknown, onDone: unknown) {
      return () => { setOpen(true); void onDone; void id }
    }
    export function MultiSessionShell({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
      const [open, setOpen] = useState(false)
      const [, dispatch] = useReducer((s: number) => s, 0)
      const seenRef = useRef(0)
      const label = open ? 'open' : 'closed'
      const items = [label, sessionId]
      const onDone = () => {}
      ${body}
      return null
    }`
  const reasons = (entries: string[]) => entries.map(entry => entry.replace(/^\d+:? ?/, ''))

  it('accepts the safe shapes: factory memos, value memos, props, hook values and consumed callbacks', () => {
    const text = shellWith(`
      const lengths = items.map(item => item.length)
      const first = items.find(item => item !== '') ?? null
      const counted = useWorkspaceState(state => state.count)
      const config = { label, size: lengths.length, nested: [first, \`\${label}!\`] }
      const onOpen = useMemo(() => createShellOpen(setOpen, config, onClose), [config, onClose])
      const onOpen2 = useMemo(() => { return createShellOpen(setOpen, 'fixed', seenRef) }, [])
      const sorted = useMemo(() => items.filter(item => item !== '').map(item => item.length), [items])
      const handlers = useMemo(() => ({ open: onOpen, count: seenRef.current, counted }), [onOpen, counted])
      const boot = React.useMemo(() => resolveBootSession({ mintSessionId: () => sessionId }), [sessionId])
      void dispatch; void onOpen2; void sorted; void handlers; void boot`)
    expect(memoClosureViolations(text)).toEqual([])
    expect(callbackHookViolations(text)).toEqual([])
    expect(factoryDependencyGaps(text)).toEqual([])
    expect(lateFactoryInputs(text)).toEqual([])
  })

  // One shape each; every case must be rejected on its own, with the reason given.
  const rejected: [string, string, string][] = [
    ['a render function returned by name', 'const x = useMemo(() => onDone, [onDone])', 'captures onDone'],
    ['an inline function returned', 'const x = useMemo(() => () => label, [label])', 'function created in a value memo'],
    ['an inline function through a conditional', 'const x = useMemo(() => (open ? () => label : null), [open, label])', 'function created in a value memo'],
    ['an inline function bound inside the memo', 'const x = useMemo(() => { const h = () => label; return h }, [label])', 'function created in a value memo'],
    ['a function declared inside the memo', 'const x = useMemo(() => { function h() { return label } return h }, [label])', 'function created in a value memo'],
    ['an immediately invoked function returning one', 'const x = useMemo(() => (() => () => label)(), [label])', 'function created in a value memo'],
    ['an object holding an inline closure', 'const x = useMemo(() => ({ go: () => label }), [label])', 'function created in a value memo'],
    ['an object method', 'const x = useMemo(() => ({ go() { return label } }), [label])', 'function created in a value memo'],
    ['an object accessor', 'const x = useMemo(() => ({ get go() { return label } }), [label])', 'function created in a value memo'],
    ['a class expression', 'const x = useMemo(() => class { v = label }, [label])', 'function created in a value memo'],
    ['a wrapper call around an inline function', 'const x = useMemo(() => wrap(() => label), [label])', 'function created in a value memo'],
    ['a render function in an array', 'const x = useMemo(() => [onDone], [onDone])', 'captures onDone'],
    ['a render function bound', 'const x = useMemo(() => onDone.bind(null), [onDone])', 'captures onDone'],
    ['a render function called', 'const x = useMemo(() => onDone(), [onDone])', 'captures onDone'],
    ['React.useMemo', 'const x = React.useMemo(() => () => label, [label])', 'function created in a value memo'],
    ['a memo callback not written in place', 'const x = useMemo(makeValue, [])', 'memo callback is not a function written in place'],
    ['a render-level function declaration', 'function handle() { return label }\nconst x = useMemo(() => handle, [])', 'captures handle: a function declared in the render'],
    ['a render closure assigned through a conditional', 'const f = open ? () => label : undefined\nconst x = useMemo(() => f, [f])', 'captures f'],
    ['a render closure assigned through ??', 'const f = seenRef.current ?? (() => label)\nconst x = useMemo(() => f, [f])', 'captures f'],
    ['a render closure assigned through a wrapper call', 'const f = wrap(() => label)\nconst x = useMemo(() => f, [f])', 'captures f'],
    ['a render object holding a function', 'const holder = { onDone }\nconst x = useMemo(() => holder, [holder])', 'captures holder'],
    ['a render object with a method', 'const holder = { go() { return label } }\nconst x = useMemo(() => holder, [holder])', 'captures holder'],
    ['a render value of JSX', 'const node = <b onClick={() => label} />\nconst x = useMemo(() => node, [node])', 'captures node'],
    ['a let binding', 'let f = label\nconst x = useMemo(() => f, [f])', 'captures f'],
    ['a render value given a function by push', 'const kept: unknown[] = []\nkept.push(onDone)\nconst x = useMemo(() => kept, [kept])', 'captures kept: mutated in the render after its declaration'],
    ['a render value given a function by property assignment', 'const holder: Record<string, unknown> = {}\nholder.go = () => label\nconst x = useMemo(() => createShellOpen(setOpen, sessionId, holder), [sessionId, holder])', 'captures holder: mutated in the render after its declaration'],
    ['a render value given a function by Object.assign', 'const holder = {}\nObject.assign(holder, { go: onDone })\nconst x = useMemo(() => holder, [holder])', 'captures holder: mutated in the render after its declaration'],
    ['a render value given functions inside a consumed callback', 'const kept: unknown[] = []\nitems.forEach(item => kept.push(() => item))\nconst x = useMemo(() => kept, [kept])', 'captures kept: mutated in the render after its declaration'],
    ['a render value given a function through an alias', 'const kept: unknown[] = []\nconst alias = kept\nalias.push(onDone)\nconst x = useMemo(() => kept, [kept])', 'captures kept: mutated in the render after its declaration'],
    ['a hook-named method on a render value', 'const f = onDone.useValue()\nconst x = useMemo(() => f, [f])', 'captures f: onDone: a function created in the render'],
    ['a block-bodied consumed callback in a render value', 'const fs = items.map(item => { return () => item })\nconst x = useMemo(() => fs, [fs])', 'captures fs'],
    ['a callback in a non-first argument', 'const x = useMemo(() => items.reduce((a: string) => a, () => label), [items, label])', 'function created in a value memo'],
    ['an unlisted resolveBootSession option', 'const x = useMemo(() => resolveBootSession({ other: () => label }), [label])', 'function created in a value memo'],
    ['an inline function passed to a factory', 'const x = useMemo(() => createShellOpen(setOpen, sessionId, () => label), [sessionId, label])', 'function created in a factory memo'],
    ['an inline function nested in a factory argument', 'const x = useMemo(() => createShellOpen(setOpen, sessionId, [() => label][0]), [sessionId, label])', 'function created in a factory memo'],
    ['a render function passed to a factory', 'const x = useMemo(() => createShellOpen(setOpen, sessionId, onDone), [sessionId, onDone])', 'captures onDone'],
    ['a render closure via a conditional passed to a factory', 'const f = open ? () => label : undefined\nconst x = useMemo(() => createShellOpen(setOpen, sessionId, f), [sessionId, f])', 'captures f'],
    ['a render object holding a function passed to a factory', 'const holder = { onDone }\nconst x = useMemo(() => createShellOpen(setOpen, sessionId, holder), [sessionId, holder])', 'captures holder'],
    ['a function created in a block-bodied factory memo', 'const x = useMemo(() => { const h = () => label; return createShellOpen(setOpen, sessionId, h) }, [sessionId])', 'function created in a factory memo'],
    ['a factory called bare in the render', 'const x = createShellOpen(setOpen, sessionId, label)', 'createShellOpen called outside a memo result'],
    ['a factory call nested inside a value memo', 'const x = useMemo(() => [createShellOpen(setOpen, sessionId, label)], [sessionId, label])', 'createShellOpen called outside a memo result'],
  ]
  it.each(rejected)('rejects %s', (_name, body, reason) => {
    expect(reasons(memoClosureViolations(shellWith(body))).some(entry => entry.startsWith(reason)),
      reasons(memoClosureViolations(shellWith(body))).join(' | ') || 'nothing reported').toBe(true)
  })

  const staleInputs: [string, string, string][] = [
    ['a name missing from the dependencies', 'const x = useMemo(() => createShellOpen(setOpen, sessionId, label), [label])', 'createShellOpen: sessionId'],
    ['a block-bodied factory memo', 'const x = useMemo(() => { return createShellOpen(setOpen, label, sessionId) }, [sessionId])', 'createShellOpen: label'],
    ['a non-name input', 'const x = useMemo(() => createShellOpen(setOpen, sessionId ?? label, label), [sessionId, label])', 'createShellOpen: sessionId ?? label (not a name; hoist it)'],
    ['a name bound inside the memo', 'const x = useMemo(() => { const id = label; return createShellOpen(setOpen, id, label) }, [label])', 'createShellOpen: id (bound in the memo; hoist it)'],
    ['an unlisted property chain', 'const x = useMemo(() => createShellOpen(setOpen, seenRef.current, label), [label])', 'createShellOpen: seenRef.current'],
    ['React.useMemo', 'const x = React.useMemo(() => createShellOpen(setOpen, label, sessionId), [sessionId])', 'createShellOpen: label'],
    ['a hook-named method on a render value, not taken as a ref', 'const r = onDone.useRef()\nconst x = useMemo(() => createShellOpen(setOpen, r, label), [label])', 'createShellOpen: r'],
  ]
  it.each(staleInputs)('reports a stale factory input: %s', (_name, body, reason) => {
    expect(reasons(factoryDependencyGaps(shellWith(body)))).toContain(reason)
  })

  it.each([
    ['a destructuring default', '{ onClose = () => undefined }: { onClose?: () => void }'],
    ['a whole-parameter default', 'onClose: () => void = () => undefined'],
    ['a whole-parameter default around a pattern', '{ onClose }: { onClose: () => void } = { onClose: () => undefined }'],
    ['a nested-pattern default', '{ actions: { onClose } = { onClose: () => undefined } }: { actions?: { onClose: () => void } }'],
  ])('rejects a shell parameter whose default creates a function: %s', (_name, parameter) => {
    const text = `
      export function MultiSessionShell(${parameter}) {
        const x = useMemo(() => onClose, [onClose])
        return null
      }`
    expect(reasons(memoClosureViolations(text))).toEqual(['captures onClose: a function created in the render'])
  })

  it('ends on shell parameters whose defaults name each other', () => {
    const text = `
      export function MultiSessionShell({ a = b, b = a }: { a?: string; b?: string }) {
        const x = useMemo(() => [a, b], [a, b])
        return null
      }`
    expect(memoClosureViolations(text)).toEqual([])
  })

  it('does not report refs, setters, dispatch, literals or module-level names as stale', () => {
    expect(factoryDependencyGaps(shellWith(
      'const x = useMemo(() => createShellCount(seenRef, dispatch, setOpen, "x", 3, MODULE_LEVEL), [])')))
      .toEqual([])
  })

  it.each([
    ['bare', 'const a = useCallback(() => label, [label])'],
    ['namespaced', 'const a = React.useCallback(() => label, [label])'],
  ])('reports useCallback (%s)', (_name, body) => {
    expect(reasons(callbackHookViolations(shellWith(body)))).toEqual(['useCallback'])
  })

  it('reports a factory memo input declared after the memo', () => {
    const text = shellWith(`
      const early = useMemo(() => createShellOpen(setOpen, later, label), [later])
      const later = label + '!'`)
    expect(reasons(lateFactoryInputs(text))).toEqual(['createShellOpen: later'])
  })

  it('fails the floor when the shell has too few factory memos or createShell calls', () => {
    expect(factoryFloorViolations(shellWith(
      'const a = useMemo(() => createShellOpen(setOpen, sessionId, label), [sessionId, label])'))).toEqual([
      'factory memos: 1 (at least 100)',
      'createShell calls: 1 (at least 100)',
    ])
  })
})
