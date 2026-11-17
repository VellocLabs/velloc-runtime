/**
 * The mods compiler (F-25): a TypeScript/TSX hooks module importing its own files and `claude-code` becomes one
 * JavaScript module that loads in `ModWorkerHost`; refusals name the file and line. Run through a real `ModRuntime`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  MOD_API_SPECIFIER,
  ModCompileError,
  compileModModule,
  loadTypeScript,
  needsCompiler,
  type ModCompileResult,
} from '../mods/modCompiler'
import { refuseModuleSource } from '../mods/modAdmission'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installJsxGlobals, installModWorkerHost } from '../mods/ModWorkerHost'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

function fsOf(files: Record<string, string>) {
  const reads: string[] = []
  return {
    reads,
    readFile: async (path: string) => {
      reads.push(path)
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
  }
}

/** The real compiler, each load counted. */
function countingCompiler() {
  const counter = {
    loads: 0,
    load: () => {
      counter.loads += 1
      return loadTypeScript()
    },
  }
  return counter
}

const noCompiler = () => Promise.reject(new Error('the compiler was loaded'))

const ROOT = '/plugins/typed'

/** A slot over `files`, compiling the one plugin `typed` whose entry is `entry`. */
function world(files: Record<string, string>, entry = `${ROOT}/hooks/register.ts`) {
  const reports: string[] = []
  const fs = fsOf(files)
  let uniq = 0
  const refs: ModModuleRef[] = [{ plugin: 'typed', path: entry, root: ROOT }]
  const runtime = new ModRuntime({
    modules: refs,
    readModule: path => fs.readFile(path),
    compile: async ref =>
      // Each load gets text of its own: identical `data:` text is one cached
      // module in this realm.
      `${(await compileModModule({ entry: ref.path, root: ref.root!, fs })).source}\n// load ${++uniq}`,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 'sess-ts', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

describe('needsCompiler and refuseModuleSource', () => {
  it('a plain .js / .mjs module with no import skips the compiler; everything else goes through it', () => {
    expect(needsCompiler('/p/hooks/register.js', 'export function register(on) {}')).toBe(false)
    expect(needsCompiler('/p/hooks/register.mjs', 'export function register(on) {}')).toBe(false)
    expect(needsCompiler('/p/hooks/register.js', "import { x } from './x.js'\nexport function register() {}")).toBe(true)
    expect(needsCompiler('/p/hooks/register.js', "export { y } from './y'")).toBe(true)
    expect(needsCompiler('/p/hooks/register.js', 'const m = import("./z")')).toBe(true)
    expect(needsCompiler('/p/hooks/register.ts', 'export function register() {}')).toBe(true)
    expect(needsCompiler('/p/hooks/register.tsx', '')).toBe(true)
    // `import` as a word only: a key at the head of a line is no statement.
    expect(needsCompiler('/p/hooks/register.js', 'const row = {\n  importCount,\n  imports: 1,\n}')).toBe(false)
    expect(needsCompiler('/p/hooks/register.js', 'import x from "./x.js"')).toBe(true)
    expect(needsCompiler('/p/hooks/register.js', "import'./side.js'")).toBe(true)
    expect(needsCompiler('/p/hooks/register.js', 'import * as m from "./m.js"')).toBe(true)
  })

  it('refuses a suffix the contract does not name, and the compiler\'s work when the runtime has none', () => {
    expect(refuseModuleSource('/p/hooks/register.txt', '')).toMatch(/"\.txt" is not loaded/)
    expect(refuseModuleSource('/p/hooks/register', '')).toMatch(/is not loaded/)
    expect(refuseModuleSource('/p/hooks/register.ts', '', false)).toMatch(/needs the TypeScript \/ JSX compiler/)
    expect(refuseModuleSource('/p/hooks/register.ts', '')).toBeNull()
    expect(refuseModuleSource('/p/hooks/register.js', "import x from './x'", false)).toMatch(/one that imports/)
    expect(refuseModuleSource('/p/hooks/register.js', 'export function register() {}', false)).toBeNull()
  })
})

describe('compileModModule', () => {
  it('a multi-file TypeScript plugin compiles to one module, the entry first, its graph in discovery order', async () => {
    const fs = fsOf({
      [`${ROOT}/hooks/register.ts`]: `
        import type { Register } from 'claude-code'
        import { tag } from './util'
        import { WORDS } from '../lib/words.ts'
        export const register: Register = (on) => {
          on('prompt.submit', ($, e, next) => next({ ...e, text: tag(e.text, WORDS[0]) }))
        }
      `,
      [`${ROOT}/hooks/util.ts`]: `export function tag(text: string, word: string): string { return text + ' [' + word + ']' }`,
      [`${ROOT}/lib/words.ts`]: `export const WORDS = ['typed'] as const`,
    })
    const result = await compileModModule({ entry: `${ROOT}/hooks/register.ts`, root: ROOT, fs })
    expect(result.files).toEqual([`${ROOT}/hooks/register.ts`, `${ROOT}/hooks/util.ts`, `${ROOT}/lib/words.ts`])
    expect(result.fromCache).toBe(false)
    expect(result.source).toContain('export const register = __entry.register;')
    expect(result.source).not.toContain(MOD_API_SPECIFIER + '"] = function')
    // No ES import survives; the type import is erased.
    expect(result.source).not.toMatch(/^import /m)
    expect(result.digest).toMatch(/^[0-9a-f]{16,64}$/)
  })

  it('…and the compiled module loads and runs in the worker host', async () => {
    const { runtime, reports } = world({
      [`${ROOT}/hooks/register.ts`]: `
        import type { Register } from 'claude-code'
        import { tag } from './util'
        export const register: Register = (on) => {
          on('prompt.submit', ($, e, next) => next({ ...e, text: tag(e.text) }))
        }
      `,
      [`${ROOT}/hooks/util.ts`]: `export const tag = (text: string): string => text + ' [typed]'`,
    })
    await runtime.ready
    expect(reports).toEqual([])
    expect(runtime.status()).toMatchObject([{ state: 'loaded', events: ['prompt.submit'] }])
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ entered: true, text: 'hi [typed]' })
  })

  it('resolves as TypeScript does: ./x.js names x.ts, ./x.jsx names x.tsx, and . / .. name a directory\'s index', async () => {
    // The shape the external diff mod takes: every directory an
    // index re-exporting its parts under .js / .jsx, and itself as `default`.
    const { runtime, reports } = world({
      [`${ROOT}/hooks/register.ts`]: `
        import Parts from './parts'
        export function register(on) {
          on('prompt.submit', ($, e, next) => next({ ...e, text: Parts.tag(e.text) + Parts.mark() }))
        }
      `,
      [`${ROOT}/hooks/parts/index.ts`]: `
        export * from './tag.js'
        export * from './mark.jsx'
        export * as default from '.'
      `,
      [`${ROOT}/hooks/parts/tag.ts`]: `
        import { suffix } from './nested/suffix.js'
        export const tag = (text: string): string => text + suffix()
      `,
      [`${ROOT}/hooks/parts/nested/suffix.ts`]: `
        // A cycle back through the index, read at call time as ESM binds it.
        import { BASE } from '..'
        export const suffix = (): string => ' [' + BASE + ']'
      `,
      [`${ROOT}/hooks/parts/mark.tsx`]: `
        export const BASE = 'typed'
        export const mark = (): string => (<b>!</b>).type
      `,
    })
    await runtime.ready
    expect(reports).toEqual([])
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ entered: true, text: 'hi [typed]b' })
  })

  it('a .js specifier names x.js itself first, and only then the source it is emitted from', async () => {
    const files = {
      [`${ROOT}/hooks/register.ts`]: `import { which } from './which.js'\nexport function register(on) { on('prompt.submit', ($, e, next) => next({ ...e, text: which })) }`,
      [`${ROOT}/hooks/which.js`]: `export const which = 'js'`,
      [`${ROOT}/hooks/which.ts`]: `export const which = 'ts'`,
    }
    const { runtime } = world(files)
    await runtime.ready
    await expect(runtime.promptSubmit('hi')).resolves.toMatchObject({ text: 'js' })
    await expect(
      compileModModule({ entry: `${ROOT}/hooks/register.ts`, root: ROOT, fs: fsOf({ [`${ROOT}/hooks/register.ts`]: `import './gone.js'` }) }),
    ).rejects.toThrow('"./gone.js" names no file of the plugin')
  })

  it('TSX compiles against the globals h and Fragment, which the worker provides as plain data', async () => {
    installJsxGlobals()
    const { runtime, reports } = world(
      {
        [`${ROOT}/hooks/register.tsx`]: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const Box = 'Box'
              const tree = <Box gap={1}><>{'a'}{null}{['b', 'c']}</></Box>
              await $.ui.log(JSON.stringify(tree))
              return next(e)
            })
          }
        `,
      },
      `${ROOT}/hooks/register.tsx`,
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      // `<>…</>` is "a column Box around the children".
      'typed: {"type":"Box","props":{"gap":1},"children":[{"type":"Box","props":{"flexDirection":"column"},"children":["a","b","c"]}]}',
    ])
  })

  it('claude-code at run time is the state helpers over $.state: atom, read, update, derive, memberOf', async () => {
    const { runtime, reports } = world({
      [`${ROOT}/hooks/register.ts`]: `
        import { atom, derive, memberOf, read, update, type Register } from 'claude-code'
        const count = atom({ plugin: 'typed', key: 'count' } as const, 0)
        const isOpen = atom({ plugin: 'typed', key: 'isOpen' } as const, false)
        const doubled = derive([count], (n: number) => n * 2)
        export const register: Register = (on) => {
          on('prompt.submit', async ($, e, next) => {
            const before = await read($, count)
            await update($, count, n => n + 1)
            await update($, count, n => n + 1)
            const after = await read($, count)
            const twice = await read($, doubled)
            const member = memberOf(isOpen, { requestId: 'pane-1' })
            await update($, member, () => true)
            const open = await read($, member)
            const plain = await read($, { plugin: 'typed', key: 'count' } as const)
            await $.ui.log(JSON.stringify({ before, after, twice, open, memberRef: member.ref, plain }))
            return next(e)
          })
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'typed: {"before":0,"after":2,"twice":4,"open":true,"memberRef":{"plugin":"typed","key":"isOpen","id":"pane-1"},"plain":2}',
    ])
    expect(runtime.state.get({ plugin: 'typed', key: 'count' })).toEqual({ value: 2, version: 2 })
  })

  it('a shaped atom reads as absent under another tag', async () => {
    const { runtime, reports } = world({
      [`${ROOT}/hooks/register.ts`]: `
        import { atom, read, update } from 'claude-code'
        const v1 = atom({ plugin: 'typed', key: 'cfg' } as const, { a: 1 }, { shape: 'v1' })
        const v2 = atom({ plugin: 'typed', key: 'cfg' } as const, { b: 2 }, { shape: 'v2' })
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await update($, v1, () => ({ a: 10 }))
            await $.ui.log(JSON.stringify([await read($, v1), await read($, v2)]))
            return next(e)
          })
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['typed: [{"a":10},{"b":2}]'])
  })

  describe('refusals, by name, with the file and line', () => {
    const compile = (files: Record<string, string>, entry = `${ROOT}/hooks/register.ts`) =>
      compileModModule({ entry, root: ROOT, fs: fsOf(files) })

    it('a bare import that is not claude-code', async () => {
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `\nimport lodash from 'lodash'\nexport function register() {}` }))
        .rejects.toThrow(`${ROOT}/hooks/register.ts:2: "lodash" cannot be imported: a hooks module imports its own files (./…) and "claude-code", nothing else`)
    })

    it('a file outside the plugin, and one that does not exist', async () => {
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `import x from '../../other/x'\nexport function register() {}` }))
        .rejects.toThrow(`${ROOT}/hooks/register.ts:1: "../../other/x" is outside the plugin (${ROOT})`)
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `import x from './missing'\nexport function register() {}` }))
        .rejects.toThrow(`${ROOT}/hooks/register.ts:1: "./missing" names no file of the plugin`)
    })

    it('claude-code/testing, and a dynamic import()', async () => {
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `import { test } from 'claude-code/testing'\nexport function register() {}` }))
        .rejects.toThrow(/register\.ts:1: "claude-code\/testing" is the plugin test kit/)
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `export function register() {}\nconst later = () => import('./x')` }))
        .rejects.toThrow(`${ROOT}/hooks/register.ts:2: a module holding import() does not load`)
    })

    it('a syntax error names its line', async () => {
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `export function register(on) {\n  on('x', ($, e, next) => \n}` }))
        .rejects.toBeInstanceOf(ModCompileError)
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `export function register(on) {\n  on('x', ($, e, next) => \n}` }))
        .rejects.toThrow(/register\.ts:\d+: /)
    })

    it('the verifier: a network, worker or code-generation primitive in the output, named at its source line, but not a noun of that name', async () => {
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `export function register(on) {\n  on('x', async () => {\n    await fetch('https://x')\n  })\n}` }))
        .rejects.toThrow(/register\.ts:3: fetch is not available to a hooks module/)
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `export function register() { new Worker('x') }` }))
        .rejects.toThrow(/register\.ts:1: Worker is not available/)
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `export function register() { return new Function('return 1') }` }))
        .rejects.toThrow(/new Function\(\) is code generation/)
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `export function register() { return eval('1') }` }))
        .rejects.toThrow(/eval is not available/)
      // `Function(code)` without `new` generates code just the same.
      await expect(compile({ [`${ROOT}/hooks/register.ts`]: `export function register() { return Function('return 1')() }` }))
        .rejects.toThrow(/new Function\(\) is code generation/)
      // `$.http.fetch` is a noun; `{ fetch: 1 }` a property; both fine.
      const ok = await compile({
        [`${ROOT}/hooks/register.ts`]: `export function register(on) { on('x', async ($) => { const r = { fetch: 1 }; await $.http.fetch('u'); return r.fetch }) }`,
      })
      expect(ok.source).toContain('$.http.fetch')
    })

    it('an entry with a suffix the contract does not name, or outside the root', async () => {
      await expect(compile({ [`${ROOT}/hooks/register.txt`]: '' }, `${ROOT}/hooks/register.txt`)).rejects.toThrow(/".txt" is not loaded/)
      await expect(compile({ ['/elsewhere/register.ts']: '' }, '/elsewhere/register.ts')).rejects.toThrow(/outside the plugin/)
    })

    it('a refused module is reported by the runtime as refused, with the compiler\'s words', async () => {
      const { runtime, reports } = world({ [`${ROOT}/hooks/register.ts`]: `import x from 'left-pad'\nexport function register() {}` })
      await runtime.ready
      expect(runtime.status()).toMatchObject([{ state: 'refused' }])
      expect(reports[0]).toMatch(/typed: the hooks module was refused — it did not compile — .*register\.ts:1: "left-pad" cannot be imported/)
    })
  })

  describe('a previous compile', () => {
    const ENTRY = `${ROOT}/hooks/register.ts`
    const DEP = `${ROOT}/hooks/dep.ts`
    const DEP_JS = `${ROOT}/hooks/dep.js`
    const graph = (): Record<string, string> => ({
      [ENTRY]: `import { v } from './dep.js'\nexport function register(on) { on('prompt.submit', ($, e, next) => $.ui.toast(v).then(() => next(e))) }`,
      [DEP]: `export const v: string = 'one'`,
    })

    it('of unchanged files is answered as it was, and TypeScript is never loaded', async () => {
      const files = graph()
      const first = await compileModModule({ entry: ENTRY, root: ROOT, fs: fsOf(files) })
      expect(first.fromCache).toBe(false)
      expect(first.files).toEqual([ENTRY, DEP])
      expect(first.missing, 'the emitted name the resolution tried first').toEqual([DEP_JS])
      const fs = fsOf(files)
      const second = await compileModModule({ entry: ENTRY, root: ROOT, fs, previous: first, loadTypeScript: noCompiler })
      expect(second.fromCache).toBe(true)
      expect({ ...second, fromCache: false }).toEqual(first)
      expect(new Set(fs.reads), 'the listed files and the missed name, nothing else').toEqual(new Set([ENTRY, DEP, DEP_JS]))

      // A miss reads each listed file once: discovery takes the texts it read.
      const edited = { ...files, [ENTRY]: `${files[ENTRY]}\n// saved` }
      const missFs = fsOf(edited)
      const missed = await compileModModule({ entry: ENTRY, root: ROOT, fs: missFs, previous: first })
      expect(missed.fromCache).toBe(false)
      expect(missFs.reads.filter(path => path === DEP)).toEqual([DEP])

      // The runtime hands the entry's text: only the imports are read.
      const withText = fsOf(files)
      const third = await compileModModule({
        entry: ENTRY,
        root: ROOT,
        fs: withText,
        entrySource: files[ENTRY],
        previous: first,
        loadTypeScript: noCompiler,
      })
      expect(third.fromCache).toBe(true)
      expect(withText.reads).not.toContain(ENTRY)
    })

    it('of a plain module is answered without TypeScript too', async () => {
      const entry = `${ROOT}/hooks/register.js`
      const files = { [entry]: `export function register(on) { on('session.start', ($, e, next) => next(e)) }` }
      const first = await compileModModule({ entry, root: ROOT, fs: fsOf(files) })
      expect(first).toMatchObject({ source: files[entry], files: [entry], missing: [], fromCache: false })
      const second = await compileModModule({ entry, root: ROOT, fs: fsOf(files), previous: first, loadTypeScript: noCompiler })
      expect(second).toMatchObject({ source: files[entry], uses: first.uses, digest: first.digest, fromCache: true })
    })

    const changes: Array<[string, (files: Record<string, string>, first: ModCompileResult) => ModCompileResult]> = [
      ['the entry changed', (files, first) => ((files[ENTRY] = `${files[ENTRY]}\n// saved`), first)],
      ['an imported file changed', (files, first) => ((files[DEP] = `export const v: string = 'two'`), first)],
      ['an imported file is gone', (files, first) => (delete files[DEP], first)],
      ['a name the resolution missed now exists', (files, first) => ((files[DEP_JS] = `export const v = 'js'`), first)],
      ['another compiler wrote it', (_files, first) => ({ ...first, compiler: 'typescript 0.0.1' })],
      ['its digest does not match', (_files, first) => ({ ...first, digest: '0'.repeat(64) })],
      ['it lists another entry', (_files, first) => ({ ...first, files: [DEP, ENTRY] })],
    ]
    it.each(changes)('falls back to a full compile when %s', async (_name, change) => {
      const files = graph()
      const first = await compileModModule({ entry: ENTRY, root: ROOT, fs: fsOf(files) })
      const previous = change(files, first)
      const compiler = countingCompiler()
      const outcome = await compileModModule({ entry: ENTRY, root: ROOT, fs: fsOf(files), previous, loadTypeScript: compiler.load }).then(
        result => result,
        (error: unknown) => error,
      )
      expect(compiler.loads).toBe(1)
      if (outcome instanceof ModCompileError) {
        expect(outcome.message, 'a gone import is refused afresh').toMatch(/names no file/)
        return
      }
      const result = outcome as ModCompileResult
      expect(result.fromCache).toBe(false)
      expect(result, 'what a compile with no record answers').toEqual(await compileModModule({ entry: ENTRY, root: ROOT, fs: fsOf(files) }))
      if (files[DEP_JS] !== undefined) expect(result.files).toEqual([ENTRY, DEP_JS])
    })

    it('naming a file outside the plugin never reads it, and compiles afresh', async () => {
      const files = graph()
      const first = await compileModModule({ entry: ENTRY, root: ROOT, fs: fsOf(files) })
      for (const outside of ['/etc/secret.ts', `${ROOT}/hooks/../../other/secret.ts`]) {
        for (const previous of [
          { ...first, files: [ENTRY, outside] },
          { ...first, missing: [outside] },
        ]) {
          const fs = fsOf({ ...files, [outside]: 'export const x = 1' })
          const compiler = countingCompiler()
          const result = await compileModModule({ entry: ENTRY, root: ROOT, fs, previous, loadTypeScript: compiler.load })
          expect(fs.reads).not.toContain(outside)
          expect(compiler.loads).toBe(1)
          expect(result.fromCache).toBe(false)
          expect(result.source).toBe(first.source)
        }
      }
    })
  })
})
