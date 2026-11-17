/**
 * Security: the mod COMPILER (F-25). TypeScript's `transpileModule` per file plus a
 * linker produce one self-contained ES module, imported as a `data:` URL. Refused,
 * with file and line: an unlisted bare import, a file outside the plugin, a missing
 * file, the test kit, any `import()`, a syntax error; and on the output, module-level
 * network or worker primitives, code generation, or an import the linker did not
 * produce. The hardened worker refuses these at run time too.
 */

import type * as TS from 'typescript'
import typescriptPackage from 'typescript/package.json' with { type: 'json' }
import { MODS_ABI } from './modAdmission'
import { scanModuleUses, type ModUses } from './modScan'

export { MOD_MODULE_EXTENSIONS, extensionOf, needsCompiler } from './modCompilerSurface'
import { MOD_MODULE_EXTENSIONS, extensionOf, needsCompiler } from './modCompilerSurface'
import { sourceLinesOfMappings, sourceLocationOf, type ModLineMap } from './modLineMap'

/** What a resolution tries, in order, for a specifier with no suffix. */
const RESOLUTION_SUFFIXES: readonly string[] = Object.freeze([
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.mjs',
  '.jsx',
  '.cts',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.mjs',
])

/** A JavaScript suffix a TypeScript source is imported under, and the
 *  sources it may name ("moduleResolution": "nodenext": `./x.js` is `x.ts`
 *  when no `x.js` exists). Tried after the specifier as written. */
const SOURCE_FOR_EMITTED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
})

/** Whether `specifier` names one of the plugin's own files: `./…`, `../…`,
 *  or a directory's index as `.` / `..`. */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
}

/** The bare specifier the runtime serves. */
export const MOD_API_SPECIFIER = 'claude-code'

/** Identifiers the verifier refuses at module level in the output: the
 *  network, workers, code generation, compiled code. */
export const VERIFIER_FORBIDDEN_IDENTIFIERS: readonly string[] = Object.freeze([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
  'eval',
  'WebAssembly',
])

export type ModCompileFs = {
  readFile(path: string, options: { encoding: string }): Promise<string>
}

/** What identifies a compile's inputs beyond the files it read. */
export type ModCompileGraph = {
  /** `typescript <version>` of the compile. */
  compiler: string
  /** The paths the resolution tried and found no file at. */
  missing: readonly string[]
  /** SHA-256 over the ABI, `compiler`, each file's path and text, and `missing`. */
  digest: string
  /** The output's lines back to source lines; absent when the output is the
   *  entry's own text (its lines are the source's). */
  lines?: ModLineMap
}

/** An earlier compile of the same entry, as the build store kept it. */
export type ModCompileRecord = ModCompileGraph & {
  files: readonly string[]
  source: string
  uses: ModUses
}

export type ModCompileOptions = {
  /** The hooks module, absolute. */
  entry: string
  /** The plugin's directory, absolute: nothing outside it is read. */
  root: string
  fs: ModCompileFs
  /** The last compile of this entry (F-25). Answered as it is, with no
   *  compiler loaded, when `compiler` is this build's, every file it lists
   *  inside `root` reads the same text, and every `missing` path still reads
   *  nothing (the inputs a discovery would see); else a full compile. */
  previous?: ModCompileRecord | null
  /** The compiler, loaded lazily. Defaults to `import('typescript')`. */
  loadTypeScript?: () => Promise<typeof TS>
  /** The entry's text as the runtime read it: what is verified is what
   *  loads, and a built-in that is not on disk compiles too. Read through
   *  `fs` when absent. */
  entrySource?: string
  /** A read error that is a refusal, not an absence: it ends the compile as
   *  thrown instead of counting the candidate as missing. */
  readRefused?: (error: unknown) => boolean
}

export type ModCompileResult = ModCompileGraph & {
  /** One self-contained ES module. */
  source: string
  /** Every file of the graph, the entry first, the rest in discovery order. */
  files: string[]
  /** What `source` uses: scanned over the graph's source, or `previous`'s
   *  own scan of the same files. */
  uses: ModUses
  /** Answered from `previous`, the compiler not loaded. */
  fromCache: boolean
}

/** A compile as a loader answers it: the graph nested for the build store. */
export const builtModuleOf = ({ source, files, uses, compiler, missing, digest, lines }: ModCompileResult) => ({
  source,
  files,
  uses,
  graph: { compiler, missing, digest, ...(lines ? { lines } : {}) },
})

/** The source line of each line of one file's transpiled text. */
function sourceLinesOfMap(mapText: string | undefined): number[] {
  if (!mapText) return []
  try {
    const mappings = (JSON.parse(mapText) as { mappings?: unknown }).mappings
    return typeof mappings === 'string' ? sourceLinesOfMappings(mappings) : []
  } catch {
    return []
  }
}

/** A refusal: `file` and `line` (1-based) where it is known. */
export class ModCompileError extends Error {
  readonly file?: string
  readonly line?: number
  /** A line of the COMPILED module, when the source line is not known (the
   *  verifier reads the output; a transpiled file's lines do not match its
   *  source's). */
  readonly compiledLine?: number
  constructor(message: string, where: { file?: string; line?: number; compiledLine?: number } = {}) {
    super(
      where.file
        ? `${where.file}${where.line ? `:${where.line}` : where.compiledLine ? ` (compiled line ${where.compiledLine})` : ''}: ${message}`
        : where.compiledLine
          ? `compiled line ${where.compiledLine}: ${message}`
          : message,
    )
    this.name = 'ModCompileError'
    if (where.file) this.file = where.file
    if (where.line) this.line = where.line
    if (where.compiledLine) this.compiledLine = where.compiledLine
  }
}

function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const absolute = slashed.startsWith('/')
  const drive = /^[A-Za-z]:/.exec(slashed)?.[0] ?? ''
  const rest = drive ? slashed.slice(drive.length) : slashed
  const out: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(segment)
  }
  if (drive) return `${drive}/${out.join('/')}`
  return (absolute ? '/' : '') + out.join('/')
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? (at === 0 ? '/' : '') : path.slice(0, at)
}

function isInside(root: string, path: string): boolean {
  const r = normalize(root).toLowerCase().replace(/\/+$/, '')
  const p = normalize(path).toLowerCase()
  return p === r || p.startsWith(`${r}/`)
}

/** The `claude-code` module at run time: the five state helpers over
 *  `$.state`. CommonJS, as the linker takes every module. */
export const MOD_API_RUNTIME_SOURCE = `"use strict";
const SHAPE = "__velloc_shape";
const isAtom = (x) => x !== null && typeof x === "object" && "ref" in x && "initial" in x;
const isDerived = (x) => x !== null && typeof x === "object" && Array.isArray(x.sources) && typeof x.compute === "function";
const addressOf = (x) => (isAtom(x) ? x.ref : x);
const unshape = (atom, stored) => {
  if (stored === undefined) return atom.initial;
  if (atom.shape === undefined) return stored;
  return stored !== null && typeof stored === "object" && stored[SHAPE] === atom.shape ? stored.value : atom.initial;
};
const shape = (atom, value) => (atom.shape === undefined ? value : { [SHAPE]: atom.shape, value });
exports.atom = (ref, initial, options) => {
  if (ref === null || typeof ref !== "object" || typeof ref.plugin !== "string" || typeof ref.key !== "string") {
    throw new TypeError("atom(ref, initial): ref is { plugin, key }");
  }
  const address = { plugin: ref.plugin, key: ref.key };
  if (typeof ref.id === "string") address.id = ref.id;
  const description = { ref: Object.freeze(address), initial };
  if (options && typeof options.shape === "string") description.shape = options.shape;
  return Object.freeze(description);
};
exports.derive = (sources, compute) => {
  if (!Array.isArray(sources) || typeof compute !== "function") {
    throw new TypeError("derive(sources, fn): sources is a list, fn a function");
  }
  return Object.freeze({ sources: Object.freeze([...sources]), compute });
};
exports.memberOf = (family, e) => {
  if (e === null || typeof e !== "object" || typeof e.requestId !== "string") {
    throw new TypeError("memberOf(family, e): e.requestId names the member");
  }
  if (isAtom(family)) {
    const member = { ...family, ref: Object.freeze({ ...family.ref, id: e.requestId }) };
    return Object.freeze(member);
  }
  return Object.freeze({ ...family, id: e.requestId });
};
const derivedCache = new WeakMap();
exports.read = async ($, source) => {
  if (isDerived(source)) {
    const reads = await Promise.all(source.sources.map((s) => $.state.get(addressOf(s))));
    const versions = reads.map((r) => r.version).join(",");
    const cached = derivedCache.get(source);
    if (cached && cached.versions === versions) return cached.value;
    const values = source.sources.map((s, i) => (isAtom(s) ? unshape(s, reads[i].value) : reads[i].value));
    const value = source.compute(...values);
    derivedCache.set(source, { versions, value });
    return value;
  }
  const held = await $.state.get(addressOf(source));
  return isAtom(source) ? unshape(source, held.value) : held.value;
};
exports.update = async ($, target, change) => {
  if (typeof change !== "function") throw new TypeError("update($, target, fn): fn is a function");
  const address = addressOf(target);
  for (;;) {
    const held = await $.state.get(address);
    const current = isAtom(target) ? unshape(target, held.value) : held.value;
    const next = change(current);
    const stored = isAtom(target) ? shape(target, next) : next;
    const written = await $.state.set(address, stored, { ifVersion: held.version });
    if (written.isSet) return next;
  }
};
`

type GraphModule = {
  /** Absolute path, or `claude-code` for the shim. */
  id: string
  text: string
  /** Specifier → module id, for this module's `require`. */
  links: Map<string, string>
  /** 1-based line of each import, for a refusal. */
  importLines: Map<string, number>
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

function lineOf(ts: typeof TS, file: TS.SourceFile, node: TS.Node): number {
  return ts.getLineAndCharacterOfPosition(file, node.getStart(file)).line + 1
}

/** Throws the first error among a transpile's diagnostics, with its line. */
function refuseSyntaxError(ts: typeof TS, path: string, diagnostics: readonly TS.Diagnostic[] | undefined): void {
  const error = diagnostics?.find(d => d.category === ts.DiagnosticCategory.Error)
  if (!error) return
  const line =
    error.file && error.start !== undefined ? ts.getLineAndCharacterOfPosition(error.file, error.start).line + 1 : undefined
  throw new ModCompileError(ts.flattenDiagnosticMessageText(error.messageText, '\n'), {
    file: path,
    ...(line !== undefined ? { line } : {}),
  })
}

/** Every specifier a module imports or re-exports from, with its line; a
 *  dynamic `import()` is refused here. */
function specifiersOf(ts: typeof TS, path: string, text: string): Array<{ specifier: string; line: number }> {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, scriptKindOf(ts, path))
  const found: Array<{ specifier: string; line: number }> = []
  const visit = (node: TS.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // A type-only import is erased by the transpiler: nothing to link.
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly
      if (!typeOnly) found.push({ specifier: node.moduleSpecifier.text, line: lineOf(ts, file, node) })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new ModCompileError('a module holding import() does not load', { file: path, line: lineOf(ts, file, node) })
    } else if (ts.isImportEqualsDeclaration(node)) {
      throw new ModCompileError('`import x = require(...)` is not an ES module import', {
        file: path,
        line: lineOf(ts, file, node),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

async function resolveRelative(
  specifier: string,
  importer: string,
  root: string,
  fs: ModCompileFs,
  texts: Map<string, string>,
  missing: Set<string>,
  readRefused?: (error: unknown) => boolean,
): Promise<{ path: string; text: string } | null> {
  const base = normalize(`${dirname(importer)}/${specifier}`)
  const written = extensionOf(base)
  const sources = (SOURCE_FOR_EMITTED[written] ?? []).map(ext => `${base.slice(0, -written.length)}${ext}`)
  const candidates = RESOLUTION_SUFFIXES.flatMap(suffix =>
    suffix === '' ? [base, ...sources] : [`${base}${suffix}`],
  )
  for (const candidate of candidates) {
    if (candidate === base && !MOD_MODULE_EXTENSIONS.includes(extensionOf(candidate))) continue
    if (!isInside(root, candidate)) return null
    const known = texts.get(candidate)
    if (known !== undefined) return { path: candidate, text: known }
    try {
      const text = await fs.readFile(candidate, { encoding: 'utf-8' })
      texts.set(candidate, text)
      return { path: candidate, text }
    } catch (error) {
      if (readRefused?.(error)) throw error
      missing.add(candidate)
    }
  }
  return null
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (subtle) {
    const hash = await subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
  }
  // No WebCrypto (an odd test realm): FNV-1a 64, good enough for a cache key.
  let h = 0xcbf29ce484222325n
  for (const b of bytes) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

/** The compiler identity a digest covers. */
const compilerOf = (version: string) => `typescript ${version}`

function graphDigest(
  compiler: string,
  files: ReadonlyArray<readonly [string, string]>,
  missing: readonly string[],
): Promise<string> {
  return sha256Hex(JSON.stringify([MODS_ABI, compiler, files, missing]))
}

/**
 * `previous` when its inputs are unchanged, else null. Security: reads only
 * normalized paths inside `root`; `source` and `uses` are the pair the
 * verifier and the scan produced together from those inputs.
 */
async function reuseEarlierCompile(
  previous: ModCompileRecord,
  entry: string,
  root: string,
  entryText: string,
  fs: ModCompileFs,
  seen: Map<string, string>,
): Promise<ModCompileResult | null> {
  const compiler = compilerOf(typescriptPackage.version)
  const { files, missing } = previous
  if (previous.compiler !== compiler || files[0] !== entry) return null
  const listed = new Set(files)
  if (listed.size !== files.length || missing.some(path => listed.has(path))) return null
  if (![...files, ...missing].every(path => path === normalize(path) && isInside(root, path))) return null
  const read = (path: string) => fs.readFile(path, { encoding: 'utf-8' }).then(String)
  const [texts, appeared] = await Promise.all([
    Promise.all(files.slice(1).map(path => read(path).catch(() => null))),
    Promise.all(missing.map(path => read(path).then(() => true, () => false))),
  ])
  files.slice(1).forEach((path, i) => {
    if (texts[i] !== null) seen.set(path, texts[i]!)
  })
  if (texts.some(text => text === null) || appeared.some(Boolean)) return null
  const pairs = files.map((path, i) => [path, i === 0 ? entryText : texts[i - 1]!] as const)
  const digest = await graphDigest(compiler, pairs, missing)
  if (digest !== previous.digest) return null
  return {
    source: previous.source,
    files: [...files],
    uses: previous.uses,
    compiler,
    missing: [...missing],
    digest,
    ...(previous.lines ? { lines: previous.lines } : {}),
    fromCache: true,
  }
}

/** The compiler, loaded lazily: a session with no TypeScript mod pays nothing. */
export const loadTypeScript = (): Promise<typeof TS> =>
  import('typescript').then(module => (module as unknown as { default?: typeof TS }).default ?? (module as unknown as typeof TS))
const defaultLoadTypeScript = loadTypeScript

/** Compile the hooks module at `entry` and its import graph to one module. */
export async function compileModModule(options: ModCompileOptions): Promise<ModCompileResult> {
  const { fs } = options
  const root = normalize(options.root)
  const entry = normalize(options.entry)
  if (!MOD_MODULE_EXTENSIONS.includes(extensionOf(entry))) {
    throw new ModCompileError(
      `a hooks module is named .ts, .tsx, .jsx, .js, .mjs, .cjs, .mts or .cts; "${extensionOf(entry) || entry}" is not loaded`,
      { file: entry },
    )
  }
  if (!isInside(root, entry)) {
    throw new ModCompileError(`the hooks module is outside the plugin (${root})`, { file: entry })
  }

  // ── discover ──
  const texts = new Map<string, string>()
  try {
    texts.set(entry, options.entrySource ?? (await fs.readFile(entry, { encoding: 'utf-8' })))
  } catch (error) {
    throw new ModCompileError(
      `the hooks module could not be read (${error instanceof Error ? error.message : String(error)})`,
      { file: entry },
    )
  }
  if (options.previous) {
    // A miss leaves the texts it read in `texts`: discovery reads them once.
    const reused = await reuseEarlierCompile(options.previous, entry, root, texts.get(entry)!, fs, texts).catch(() => null)
    if (reused) return reused
  }
  const ts = await (options.loadTypeScript ?? defaultLoadTypeScript)()
  const compiler = compilerOf(ts.version)
  const missing = new Set<string>()
  // A plain module whose tree holds no import loads as written, but only once
  // it parses and its own syntax tree passes the verifier: the text check
  // never decides alone.
  const entryText = texts.get(entry)!
  if (!needsCompiler(entry, entryText) && specifiersOf(ts, entry, entryText).length === 0) {
    const parsed = ts.transpileModule(entryText, {
      fileName: entry,
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    refuseSyntaxError(ts, entry, parsed.diagnostics)
    verifyCompiledModule(ts, entryText, line => ({ file: entry, line }))
    return {
      source: entryText,
      files: [entry],
      uses: scanModuleUses(ts, [{ path: entry, text: entryText }]),
      compiler,
      missing: [],
      digest: await graphDigest(compiler, [[entry, entryText]], []),
      fromCache: false,
    }
  }
  const modules = new Map<string, GraphModule>()
  const order: string[] = []
  let usesShim = false
  const queue = [entry]
  while (queue.length > 0) {
    const path = queue.shift()!
    if (modules.has(path)) continue
    const text = texts.get(path)!
    const module: GraphModule = { id: path, text, links: new Map(), importLines: new Map() }
    modules.set(path, module)
    order.push(path)
    for (const { specifier, line } of specifiersOf(ts, path, text)) {
      module.importLines.set(specifier, line)
      if (specifier === MOD_API_SPECIFIER) {
        usesShim = true
        module.links.set(specifier, MOD_API_SPECIFIER)
        continue
      }
      if (specifier === `${MOD_API_SPECIFIER}/testing`) {
        throw new ModCompileError(
          `"${specifier}" is the plugin test kit, not a module a hooks module loads`,
          { file: path, line },
        )
      }
      if (!isRelativeSpecifier(specifier)) {
        throw new ModCompileError(
          `"${specifier}" cannot be imported: a hooks module imports its own files (./…) and "${MOD_API_SPECIFIER}", nothing else`,
          { file: path, line },
        )
      }
      const candidate = normalize(`${dirname(path)}/${specifier}`)
      if (!isInside(root, candidate)) {
        throw new ModCompileError(`"${specifier}" is outside the plugin (${root})`, { file: path, line })
      }
      const resolved = await resolveRelative(specifier, path, root, fs, texts, missing, options.readRefused)
      if (!resolved) {
        throw new ModCompileError(`"${specifier}" names no file of the plugin`, { file: path, line })
      }
      module.links.set(specifier, resolved.path)
      queue.push(resolved.path)
    }
  }

  // ── the scan: over the source ──
  const uses = scanModuleUses(
    ts,
    order.map(path => ({ path, text: texts.get(path)! })),
  )

  // ── compile ──
  const compiled = new Map<string, string>()
  const sourceLines = new Map<string, number[]>()
  for (const path of order) {
    const result = ts.transpileModule(texts.get(path)!, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        jsxFactory: 'h',
        jsxFragmentFactory: 'Fragment',
        isolatedModules: true,
        esModuleInterop: false,
        sourceMap: true,
        inlineSourceMap: false,
        removeComments: false,
      },
    })
    refuseSyntaxError(ts, path, result.diagnostics)
    compiled.set(path, result.outputText.replace(/\n\/\/# sourceMappingURL=[^\n]*\n?$/, '\n'))
    sourceLines.set(path, sourceLinesOfMap(result.sourceMapText))
  }

  // ── link ──
  const lines: string[] = []
  lines.push(`// Compiled by the Velloc mods compiler (${MODS_ABI}, ${compiler}).`)
  lines.push(`// Entry: ${entry}`)
  lines.push('const __modules = Object.create(null);')
  lines.push('const __links = Object.create(null);')
  lines.push('const __cache = Object.create(null);')
  lines.push('function __load(id) {')
  lines.push('  if (id in __cache) return __cache[id].exports;')
  lines.push('  const module = { exports: {} };')
  lines.push('  __cache[id] = module;')
  lines.push('  const require = (specifier) => {')
  lines.push('    const target = __links[id][specifier];')
  lines.push('    if (target === undefined) throw new Error("cannot import " + JSON.stringify(specifier) + " from " + id);')
  lines.push('    return __load(target);')
  lines.push('  };')
  lines.push('  __modules[id](module.exports, require, module);')
  lines.push('  return module.exports;')
  lines.push('}')
  const moduleStarts = new Map<string, number>()
  // An entry may hold many lines (a file's text): count lines, not entries.
  let counted = 0
  let outputLines = 0
  const define = (id: string, text: string, links: Map<string, string>): void => {
    lines.push(`__links[${JSON.stringify(id)}] = ${JSON.stringify(Object.fromEntries(links))};`)
    lines.push(`__modules[${JSON.stringify(id)}] = function (exports, require, module) {`)
    for (; counted < lines.length; counted += 1) outputLines += lines[counted]!.split('\n').length
    moduleStarts.set(id, outputLines + 1)
    lines.push(text.replace(/\n$/, ''))
    lines.push('};')
  }
  if (usesShim) define(MOD_API_SPECIFIER, MOD_API_RUNTIME_SOURCE, new Map())
  for (const path of order) define(path, compiled.get(path)!, modules.get(path)!.links)
  lines.push(`const __entry = __load(${JSON.stringify(entry)});`)
  lines.push('export const register = __entry.register;')
  lines.push('export default __entry.default;')
  const source = `${lines.join('\n')}\n`

  const lineMap: ModLineMap = {
    files: order.map(path => {
      const count = compiled.get(path)!.replace(/\n$/, '').split('\n').length
      const lines = (sourceLines.get(path) ?? []).slice(0, count)
      while (lines.length < count) lines.push(0)
      return { path, start: moduleStarts.get(path)!, lines }
    }),
  }

  // ── verify ──
  verifyCompiledModule(ts, source, line => {
    const at = sourceLocationOf(lineMap, line)
    if (at) return at
    // A line the map does not know: the file it belongs to, and the line
    // within the COMPILED file.
    let owner: string | undefined
    let ownerStart = 0
    for (const [id, start] of moduleStarts) {
      if (start <= line && start >= ownerStart) {
        owner = id
        ownerStart = start
      }
    }
    return owner && owner !== MOD_API_SPECIFIER
      ? { file: owner, compiledLine: line - ownerStart + 1 }
      : { compiledLine: line }
  })

  const misses = [...missing]
  const digest = await graphDigest(compiler, order.map(path => [path, texts.get(path)!] as const), misses)
  return { source, files: order, uses, compiler, missing: misses, digest, lines: lineMap, fromCache: false }
}

/**
 * The verifier, over the compiled output or a plain module's own text: no
 * import or re-export of any kind (the linker produced none; a plain module
 * holding one needed the compiler), no `import()`, and no use of a forbidden identifier —
 * a free identifier, not a property named like one (`$.http.fetch` is a
 * noun; `fetch(...)` is the network).
 */
export function verifyCompiledModule(
  ts: typeof TS,
  source: string,
  where: (line: number) => { file?: string; line?: number; compiledLine?: number },
): void {
  const file = ts.createSourceFile('compiled.mjs', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const forbidden = new Set(VERIFIER_FORBIDDEN_IDENTIFIERS)
  const refuse = (message: string, node: TS.Node): never => {
    throw new ModCompileError(message, where(lineOf(ts, file, node)))
  }
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      refuse('a hooks module may not import here', node)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      refuse('import() is not allowed in a hooks module', node)
    }
    // `Function(code)` without `new` builds code exactly as `new Function(code)` does.
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    ) {
      refuse('new Function() is code generation, which a hooks module may not do', node)
    }
    if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      const parent = node.parent
      const isPropertyName =
        (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (parent && ts.isPropertyAssignment(parent) && parent.name === node) ||
        (parent && ts.isPropertySignature(parent)) ||
        (parent && ts.isMethodDeclaration(parent) && parent.name === node) ||
        (parent && ts.isShorthandPropertyAssignment(parent) && false)
      // (`require` is not on the list: the linker defines it as a local, so a
      // module's `require("fs")` reaches the module table and nothing else.)
      if (!isPropertyName && !(ts.isBindingElement(parent!) && parent!.propertyName === node)) {
        refuse(
          `${node.text} is not available to a hooks module (no network, no workers, no code generation); everything it may reach is on $`,
          node,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}
