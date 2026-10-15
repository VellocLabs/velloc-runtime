/**
 * The SCAN (F-25): what a hooks module uses, read off its source with a real parse
 * over the module's graph: `on(...)` event literals, `$.noun.method(...)` calls,
 * `$.env` names, `$.state` addresses. What it cannot see is not reported; the
 * refusal at the call stays the fallback. It refuses nothing itself.
 */

import type * as TS from 'typescript'
import { extensionOf } from './modCompilerSurface'

export type ScannedStateName = { plugin: string; key: string }

/** `PluginRegisterUses`, as the declaration spells it. */
export type ModUses = {
  events: readonly string[]
  calls: readonly string[]
  env?: { reads: readonly string[]; writes: readonly string[] }
  state?: { reads: readonly ScannedStateName[]; writes: readonly ScannedStateName[] }
}

export const EMPTY_USES: ModUses = Object.freeze({ events: Object.freeze([]), calls: Object.freeze([]) })

/** The names the `claude-code` module exports that reach `$.state`. */
const STATE_HELPERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read: ['state.get'],
  update: ['state.get', 'state.set'],
})

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

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function uniqueStateNames(values: Iterable<ScannedStateName>): ScannedStateName[] {
  const seen = new Map<string, ScannedStateName>()
  for (const value of values) seen.set(`${value.plugin}\u0000${value.key}`, value)
  return [...seen.values()].sort((a, b) => (a.plugin + '\u0000' + a.key).localeCompare(b.plugin + '\u0000' + b.key))
}

/**
 * The names each scope of `file` declares, by scope node: an identifier
 * resolves to the declaration of its innermost enclosing scope that has one.
 * Lexical only (no checker): `var` is function-scoped, `let`/`const`/classes
 * and function declarations block-scoped, a parameter its function's.
 */
function scopeIndex(ts: typeof TS, file: TS.SourceFile): Map<TS.Node, Map<string, TS.Identifier>> {
  const scopes = new Map<TS.Node, Map<string, TS.Identifier>>()
  const isBlockScope = (node: TS.Node): boolean =>
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCaseBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isFunctionLike(node)
  const up = (from: TS.Node, accept: (node: TS.Node) => boolean): TS.Node | undefined => {
    let node: TS.Node | undefined = from.parent
    while (node && !accept(node)) node = node.parent
    return node
  }
  const scopeOf = (name: TS.Identifier): TS.Node | undefined => {
    let root: TS.Node = name.parent
    while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent
    if (ts.isParameter(root)) return root.parent
    if (ts.isVariableDeclaration(root)) {
      if (ts.isCatchClause(root.parent)) return root.parent
      const list = root.parent
      const blockScoped = (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
      return blockScoped ? up(list, isBlockScope) : up(list, node => ts.isFunctionLike(node) || ts.isSourceFile(node))
    }
    if (ts.isFunctionDeclaration(root) || ts.isClassDeclaration(root)) return up(root, isBlockScope)
    if (ts.isFunctionExpression(root) || ts.isClassExpression(root)) return root
    if (ts.isImportClause(root) || ts.isImportSpecifier(root) || ts.isNamespaceImport(root)) return file
    return undefined
  }
  const declares = (name: TS.Identifier): boolean => {
    const parent = name.parent
    if (ts.isBindingElement(parent)) return parent.name === name
    return (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassExpression(parent) ||
        ts.isImportClause(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent)) &&
      (parent as { name?: TS.Node }).name === name
    )
  }
  const visit = (node: TS.Node): void => {
    if (ts.isIdentifier(node) && node.parent && declares(node)) {
      const scope = scopeOf(node)
      if (scope) {
        const names = scopes.get(scope) ?? new Map<string, TS.Identifier>()
        if (!names.has(node.text)) names.set(node.text, node)
        scopes.set(scope, names)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return scopes
}

/**
 * Scan the module's files. `files` is the graph, the entry first; a file
 * that does not parse contributes nothing (the compiler is the one that
 * refuses it, with the line).
 */
export function scanModuleUses(ts: typeof TS, files: ReadonlyArray<{ path: string; text: string }>): ModUses {
  const events: string[] = []
  const calls = new Set<string>()
  const envReads = new Set<string>()
  const envWrites = new Set<string>()
  const stateReads: ScannedStateName[] = []
  const stateWrites: ScannedStateName[] = []
  let sawEnv = false
  let sawState = false

  for (const { path, text } of files) {
    let file: TS.SourceFile
    try {
      file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, scriptKindOf(ts, path))
    } catch {
      continue
    }

    // ── what the module imported from `claude-code` ──
    const helperAliases = new Map<string, string>() // local name → export name
    // `const counter = atom({ plugin, key }, …)` — the atom's address, by name.
    const atoms = new Map<string, ScannedStateName>()
    let atomLocal = 'atom'

    // ── the bindings that mean `$`, and the bindings that mean a noun ──
    // By declaration, not by name: another variable of the same name in
    // another scope is not `$`.
    const scopes = scopeIndex(ts, file)
    const dollarBindings = new Set<TS.Identifier>()
    const nounBindings = new Map<TS.Identifier, string>() // binding → noun
    let onName: string | undefined

    /** The declaration `id` refers to, or undefined (a global). */
    const declarationOf = (id: TS.Identifier): TS.Identifier | undefined => {
      let node: TS.Node | undefined = id.parent
      while (node) {
        const found = scopes.get(node)?.get(id.text)
        if (found) return found
        node = node.parent
      }
      return undefined
    }
    /** `id` means `$`: it refers to a binding of `$`, or is an undeclared `$`. */
    const isDollar = (id: TS.Identifier): boolean => {
      const declaration = declarationOf(id)
      return declaration ? dollarBindings.has(declaration) : id.text === '$'
    }
    const nounOfName = (id: TS.Identifier): string | undefined => {
      const declaration = declarationOf(id)
      return declaration ? nounBindings.get(declaration) : undefined
    }

    const isStringLiteral = (node: TS.Node | undefined): node is TS.StringLiteral | TS.NoSubstitutionTemplateLiteral =>
      node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))

    const stateNameOf = (node: TS.Node | undefined): ScannedStateName | undefined => {
      if (!node) return undefined
      if (ts.isIdentifier(node)) return atoms.get(node.text)
      if (!ts.isObjectLiteralExpression(node)) return undefined
      let plugin: string | undefined
      let key: string | undefined
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const name = ts.isIdentifier(property.name) || isStringLiteral(property.name) ? property.name.text : undefined
        if (name === 'plugin' && isStringLiteral(property.initializer)) plugin = property.initializer.text
        if (name === 'key' && isStringLiteral(property.initializer)) key = property.initializer.text
      }
      return plugin !== undefined && key !== undefined ? { plugin, key } : undefined
    }

    /** `X.noun.method` with `X` meaning `$`, or `alias.method` with `alias`
     *  meaning a noun: the `noun.method` it spells, or undefined. */
    const callNameOf = (callee: TS.Expression): { noun: string; method: string } | undefined => {
      if (!ts.isPropertyAccessExpression(callee)) return undefined
      const method = callee.name.text
      const owner = callee.expression
      if (ts.isPropertyAccessExpression(owner) && ts.isIdentifier(owner.expression) && isDollar(owner.expression)) {
        return { noun: owner.name.text, method }
      }
      if (ts.isIdentifier(owner)) {
        const noun = nounOfName(owner)
        if (noun !== undefined) return { noun, method }
      }
      return undefined
    }

    /** A binding of `$` (a hook's first parameter, `const x = $`): names it. */
    const bindDollar = (name: TS.BindingName): void => {
      if (ts.isIdentifier(name)) {
        dollarBindings.add(name)
        return
      }
      if (ts.isObjectBindingPattern(name)) {
        for (const element of name.elements) {
          if (!ts.isIdentifier(element.name)) continue
          const property = element.propertyName
          const noun = property === undefined ? element.name.text : ts.isIdentifier(property) || isStringLiteral(property) ? property.text : undefined
          if (noun !== undefined) nounBindings.set(element.name, noun)
        }
      }
    }

    const firstParameterOf = (fn: TS.Node): TS.ParameterDeclaration | undefined =>
      ts.isFunctionLike(fn) ? fn.parameters[0] : undefined

    // Pass 1: the declarations the rest reads — the imports, `register`'s
    // first parameter, the atoms, the aliases of `$`.
    const declare = (node: TS.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'claude-code') {
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const exported = element.propertyName?.text ?? element.name.text
            helperAliases.set(element.name.text, exported)
            if (exported === 'atom') atomLocal = element.name.text
          }
        }
      }
      // `export function register(on, options)` / `export const register = (on) => …`
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'register') {
        const first = firstParameterOf(node)
        if (first && ts.isIdentifier(first.name)) onName = first.name.text
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (node.name.text === 'register' && node.initializer && ts.isFunctionLike(node.initializer)) {
          const first = firstParameterOf(node.initializer)
          if (first && ts.isIdentifier(first.name)) onName = first.name.text
        }
        if (node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === atomLocal) {
          const address = stateNameOf(node.initializer.arguments[0])
          if (address) atoms.set(node.name.text, address)
        }
      }
      ts.forEachChild(node, declare)
    }
    declare(file)
    onName ??= 'on'

    // Pass 2: the hooks' first parameters mean `$`.
    const bindHookParameters = (node: TS.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === onName) {
        const hook = node.arguments[node.arguments.length - 1]
        const first = hook ? firstParameterOf(hook) : undefined
        if (first) bindDollar(first.name)
      }
      // `on("x", …).catch(($, e, next) => …)`
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'catch' &&
        ts.isCallExpression(node.expression.expression) &&
        ts.isIdentifier(node.expression.expression.expression) &&
        node.expression.expression.expression.text === onName
      ) {
        const handler = node.arguments[0]
        const first = handler ? firstParameterOf(handler) : undefined
        if (first) bindDollar(first.name)
      }
      // A function whose first parameter is literally `$`, anywhere: a helper
      // the hook hands `$` to.
      if (ts.isFunctionLike(node)) {
        const first = node.parameters[0]
        if (first && ts.isIdentifier(first.name) && first.name.text === '$') bindDollar(first.name)
        else if (first && ts.isObjectBindingPattern(first.name) && node.parent && ts.isCallExpression(node.parent) && ts.isIdentifier(node.parent.expression) && node.parent.expression.text === onName) {
          bindDollar(first.name)
        }
      }
      ts.forEachChild(node, bindHookParameters)
    }
    bindHookParameters(file)

    // `const api = $`, `const { fs } = $`, `const { state: st } = $`
    const bindAliases = (node: TS.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && isDollar(node.initializer)) {
        bindDollar(node.name)
      }
      ts.forEachChild(node, bindAliases)
    }
    bindAliases(file)

    // Pass 3: the uses.
    const collect = (node: TS.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        // on("event", …)
        if (ts.isIdentifier(callee) && callee.text === onName) {
          const pattern = node.arguments[0]
          if (isStringLiteral(pattern) && !events.includes(pattern.text)) events.push(pattern.text)
        }
        // read($, atom) / update($, atom, fn) from claude-code
        if (ts.isIdentifier(callee) && helperAliases.has(callee.text)) {
          const helper = helperAliases.get(callee.text)!
          const reach = STATE_HELPERS[helper]
          if (reach) {
            for (const name of reach) calls.add(name)
            sawState = true
            const address = stateNameOf(node.arguments[1])
            if (address) {
              stateReads.push(address)
              if (helper === 'update') stateWrites.push(address)
            }
          }
        }
        const named = callNameOf(callee)
        if (named) {
          calls.add(`${named.noun}.${named.method}`)
          if (named.noun === 'env' && (named.method === 'get' || named.method === 'set')) {
            sawEnv = true
            const name = node.arguments[0]
            if (isStringLiteral(name)) (named.method === 'get' ? envReads : envWrites).add(name.text)
          }
          if (named.noun === 'state' && (named.method === 'get' || named.method === 'set')) {
            sawState = true
            const address = stateNameOf(node.arguments[0])
            if (address) (named.method === 'get' ? stateReads : stateWrites).push(address)
          }
        }
      }
      ts.forEachChild(node, collect)
    }
    collect(file)
  }

  return {
    events,
    calls: sortedUnique(calls),
    ...(sawEnv ? { env: { reads: sortedUnique(envReads), writes: sortedUnique(envWrites) } } : {}),
    ...(sawState ? { state: { reads: uniqueStateNames(stateReads), writes: uniqueStateNames(stateWrites) } } : {}),
  }
}

/**
 * The nouns the engine's declaration puts on `$` (`CoreEngineInterface`):
 * a call under one of these that this engine does not implement is refused
 * at load; a call under any other name is a plugin's noun, checked once the
 * `engine.create` fold has run.
 */
export const ENGINE_NOUNS: readonly string[] = Object.freeze([
  'plugin',
  'ui',
  'model',
  'audio',
  'mcp',
  'session',
  'turn',
  'prompt',
  'tool',
  'command',
  'config',
  'telemetry',
  'agent',
  'fs',
  'store',
  'state',
  'clock',
  'http',
  'process',
  'env',
  'settings',
])

/** `$` calls the WORKER answers without the runtime: not events, not nouns
 *  the runtime's table lists, and never refused. */
export const WORKER_SERVED_CALLS: readonly string[] = Object.freeze(['ui.resolve'])

/**
 * The calls among `uses.calls` on an engine noun this engine does not
 * implement — "an unsupported noun is refused at load, not at the call".
 * `implemented` is `modNouns.implementedNouns()`.
 */
export function unsupportedEngineCalls(uses: ModUses, implemented: readonly string[]): string[] {
  const known = new Set([...implemented, ...WORKER_SERVED_CALLS])
  return uses.calls.filter(call => {
    const noun = call.slice(0, call.indexOf('.'))
    return ENGINE_NOUNS.includes(noun) && !known.has(call)
  })
}

/** The calls among `uses.calls` under a noun no engine declaration names —
 *  a plugin's noun — with the noun. */
export function pluginNounCalls(uses: ModUses): Array<{ noun: string; call: string }> {
  return uses.calls
    .map(call => ({ noun: call.slice(0, call.indexOf('.')), call }))
    .filter(entry => entry.noun !== '' && !ENGINE_NOUNS.includes(entry.noun))
}
