/**
 * The registrations a hooks module makes, read off its source without running it
 * (F-25): each `on(pattern, [matcher,] hook)` with its file and line, the hook's
 * form, whether it took a `.catch`, and the shape of an `engine.create` step. A
 * registration whose pattern is not a literal is counted, not read: the load
 * sees it.
 */

import type * as TS from 'typescript'
import type { HookRegistration } from './modTypes'
import { extensionOf } from './modCompilerSurface'

/** A matcher the source spells as plain data, or the marker for one it does not. */
export const MATCHER_NOT_LITERAL: unique symbol = Symbol('matcher-not-literal')

export type StaticHook = {
  pattern: string
  file: string
  line: number
  /** Absent: no matcher. `MATCHER_NOT_LITERAL`: one the source computes. */
  matcher?: unknown
  /** The matcher argument is not an object (null, an array, a RegExp). */
  matcherNotObject?: boolean
  streams: boolean
  hasCatch: boolean
  /** The `.catch` handler's form differs from the hook's. */
  catchFormMismatch?: boolean
}

/** What an `engine.create` step adds to `$` and keeps of what is beneath. */
export type StaticEngineStep = {
  file: string
  line: number
  /** `built`: `return { ...built, noun }` over `const built = await next(e)`
   *  (or `{ ...(await next(e)), noun }`); `none`: returns without `next`'s
   *  result, withholding everything beneath; `other`: any other shape. */
  form: 'built' | 'none' | 'other'
  adds: string[]
}

export type StaticRegistrations = {
  hooks: StaticHook[]
  /** `on(...)` calls whose pattern is not a string literal, by place. */
  unread: Array<{ file: string; line: number }>
  engineSteps: StaticEngineStep[]
}

function scriptKindOf(ts: typeof TS, path: string): TS.ScriptKind {
  switch (extensionOf(path)) {
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}

const isAsyncGenerator = (ts: typeof TS, fn: TS.Node): boolean =>
  (ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) &&
  fn.asteriskToken !== undefined &&
  (ts.getCombinedModifierFlags(fn as TS.Declaration) & ts.ModifierFlags.Async) !== 0

/** The plain data a literal spells, or `MATCHER_NOT_LITERAL`. */
function literalValue(ts: typeof TS, node: TS.Expression): unknown {
  if (ts.isParenthesizedExpression(node)) return literalValue(ts, node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(element => literalValue(ts, element))
    return items.includes(MATCHER_NOT_LITERAL) ? MATCHER_NOT_LITERAL : items
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return MATCHER_NOT_LITERAL
      const name = property.name
      if (!(ts.isIdentifier(name) || ts.isStringLiteral(name))) return MATCHER_NOT_LITERAL
      const value = literalValue(ts, property.initializer)
      if (value === MATCHER_NOT_LITERAL) return MATCHER_NOT_LITERAL
      out[name.text] = value
    }
    return out
  }
  return MATCHER_NOT_LITERAL
}

/** The registrations of `files` (the compile graph, entry first). A file that
 *  does not parse contributes nothing: the compiler reports it. */
export function readRegistrations(ts: typeof TS, files: ReadonlyArray<{ path: string; text: string }>): StaticRegistrations {
  const out: StaticRegistrations = { hooks: [], unread: [], engineSteps: [] }
  for (const { path, text } of files) {
    let file: TS.SourceFile
    try {
      file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, scriptKindOf(ts, path))
    } catch {
      continue
    }
    const lineOf = (node: TS.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    const functions = new Map<string, TS.Node>()
    let onName = 'on'
    const declare = (node: TS.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        functions.set(node.name.text, node)
        if (node.name.text === 'register' && node.parameters[0] && ts.isIdentifier(node.parameters[0].name)) {
          onName = node.parameters[0].name.text
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isFunctionLike(node.initializer)) {
        functions.set(node.name.text, node.initializer)
        const first = node.initializer.parameters[0]
        if (node.name.text === 'register' && first && ts.isIdentifier(first.name)) onName = first.name.text
      }
      ts.forEachChild(node, declare)
    }
    declare(file)
    const resolveFunction = (node: TS.Node | undefined): TS.Node | undefined =>
      node && ts.isIdentifier(node) ? functions.get(node.text) : node

    const visit = (node: TS.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === onName) {
        const [first, second, third] = node.arguments
        if (!first || !(ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          out.unread.push({ file: path, line: lineOf(node) })
        } else {
          const hasMatcher = node.arguments.length >= 3
          const hook = resolveFunction(hasMatcher ? third : second)
          const streams = hook !== undefined && isAsyncGenerator(ts, hook)
          const entry: StaticHook = { pattern: first.text, file: path, line: lineOf(node), streams, hasCatch: false }
          if (hasMatcher && second) {
            const value = literalValue(ts, second)
            if (value === null || Array.isArray(value) || ts.isRegularExpressionLiteral(second)) entry.matcherNotObject = true
            else entry.matcher = value
          }
          const parent = node.parent
          if (
            parent &&
            ts.isPropertyAccessExpression(parent) &&
            parent.name.text === 'catch' &&
            parent.parent &&
            ts.isCallExpression(parent.parent)
          ) {
            entry.hasCatch = true
            const handler = resolveFunction(parent.parent.arguments[0])
            if (handler && isAsyncGenerator(ts, handler) !== streams) entry.catchFormMismatch = true
          }
          out.hooks.push(entry)
          if (first.text === 'engine.create' && hook && ts.isFunctionLike(hook)) {
            out.engineSteps.push({ file: path, line: lineOf(node), ...engineStepShape(ts, hook) })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return out
}

/** The one recognised `engine.create` shape, else `other`. */
function engineStepShape(ts: typeof TS, hook: TS.SignatureDeclaration): { form: StaticEngineStep['form']; adds: string[] } {
  const nextParam = hook.parameters[2]
  const nextName = nextParam && ts.isIdentifier(nextParam.name) ? nextParam.name.text : undefined
  const isNextResult = (node: TS.Expression): boolean => {
    let inner: TS.Expression = node
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression
    return (
      ts.isAwaitExpression(inner) &&
      ts.isCallExpression(inner.expression) &&
      ts.isIdentifier(inner.expression.expression) &&
      inner.expression.expression.text === nextName
    )
  }
  const body = (hook as { body?: TS.Node }).body
  if (!body || nextName === undefined) return { form: 'other', adds: [] }
  const builtNames = new Set<string>()
  const returned: TS.Expression[] = []
  if (ts.isBlock(body)) {
    const walk = (node: TS.Node): void => {
      if (ts.isFunctionLike(node)) return
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isNextResult(node.initializer)) {
        builtNames.add(node.name.text)
      }
      if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression)
      ts.forEachChild(node, walk)
    }
    body.forEachChild(walk)
  } else {
    returned.push(body as TS.Expression)
  }
  if (returned.length !== 1) return { form: 'other', adds: [] }
  let value = returned[0]!
  while (ts.isParenthesizedExpression(value)) value = value.expression
  if (!ts.isObjectLiteralExpression(value)) return { form: 'other', adds: [] }
  let spreadsBuilt = false
  const adds: string[] = []
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = property.expression
      if ((ts.isIdentifier(spread) && builtNames.has(spread.text)) || isNextResult(spread)) {
        if (spreadsBuilt) return { form: 'other', adds: [] }
        spreadsBuilt = true
        continue
      }
      return { form: 'other', adds: [] }
    }
    const name = property.name
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
      name &&
      (ts.isIdentifier(name) || ts.isStringLiteral(name))
    ) {
      adds.push(name.text)
      continue
    }
    return { form: 'other', adds: [] }
  }
  return { form: spreadsBuilt ? 'built' : 'none', adds }
}

/** The registrations as the admission table reads them; patterns only. */
export function asHookRegistrations(hooks: readonly StaticHook[]): HookRegistration[] {
  return hooks.map((hook, index) => ({
    hookId: `h${index + 1}`,
    pattern: hook.pattern,
    ...(hook.matcher !== undefined && hook.matcher !== MATCHER_NOT_LITERAL ? { matcher: hook.matcher } : {}),
    hasCatch: hook.hasCatch,
    ...(hook.streams ? { streams: true } : {}),
  }))
}
