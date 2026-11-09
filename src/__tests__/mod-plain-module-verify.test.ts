/**
 * The mods verifier covers every hooks module (F-25): a plain `.js` / `.mjs` module
 * that the compiler does not need to transform is still read for import(), static
 * imports, code generation and the network before it loads, so a form the text
 * check misses (a newline or comment between `import` and `(`) is refused.
 */
import { describe, expect, it } from 'vitest'
import { compileModModule, loadTypeScript, needsCompiler, verifyCompiledModule } from '../mods/modCompiler'
import { ModuleRefused, prepareModule } from '../mods/modPrepare'

const ENTRY = '/plugins/plain/hooks/register.mjs'
const ROOT = '/plugins/plain'

function fsOf(files: Record<string, string>) {
  return {
    readFile: async (path: string) => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
  }
}

/** Prepare `text` as the entry with the compiler the runtimes are given. */
function prepare(text: string) {
  const fs = fsOf({ [ENTRY]: text })
  return prepareModule(
    { plugin: 'plain', path: ENTRY, root: ROOT },
    {
      readModule: path => fs.readFile(path),
      compile: ref =>
        compileModModule({ entry: ref.path, root: ref.root!, fs }).then(result => ({
          source: result.source,
          files: result.files,
          uses: result.uses,
        })),
      report: () => undefined,
    },
    () => null,
  )
}

const REGISTER = 'export function register(on) {}\n'

const HIDDEN_IMPORTS: Array<[string, string]> = [
  ['a newline', "const run = () => import\n('data:text/javascript,1')"],
  ['an empty block comment', "const run = () => import/**/('data:text/javascript,1')"],
  ['a spaced block comment', "const run = () => import /* x */ ('data:text/javascript,1')"],
  ['a line comment', "const run = () => import // x\n('data:text/javascript,1')"],
]

describe('a plain module is verified, not only a compiled one', () => {
  it.each(HIDDEN_IMPORTS)('import() split by %s is refused at prepare', async (_, line) => {
    await expect(prepare(`${REGISTER}${line}\n`)).rejects.toBeInstanceOf(ModuleRefused)
    await expect(prepare(`${REGISTER}${line}\n`)).rejects.toThrow(/import\(\)/)
  })

  it('the text check without a compiler sends each of those forms to the compiler', () => {
    for (const [, line] of HIDDEN_IMPORTS) expect(needsCompiler(ENTRY, `${REGISTER}${line}`)).toBe(true)
  })

  it('a static import or re-export split over lines is refused, with its line', async () => {
    await expect(prepare(`${REGISTER}import\n'data:text/javascript,1'\n`)).rejects.toThrow(`${ENTRY}:2: "data:`)
    await expect(prepare(`${REGISTER}export *\nfrom 'data:text/javascript,1'\n`)).rejects.toThrow(`${ENTRY}:2: "data:`)
  })

  it('the verifier itself refuses any import or re-export in the text it reads', async () => {
    const ts = await loadTypeScript()
    const where = (line: number) => ({ file: ENTRY, line })
    expect(() => verifyCompiledModule(ts, `${REGISTER}import\n'data:text/javascript,1'\n`, where)).toThrow(
      `${ENTRY}:2: a hooks module may not import here`,
    )
    expect(() => verifyCompiledModule(ts, `${REGISTER}export * from 'data:text/javascript,1'\n`, where)).toThrow(
      `${ENTRY}:2: a hooks module may not import here`,
    )
    expect(() => verifyCompiledModule(ts, `${REGISTER}export { register as main }\n`, where)).not.toThrow()
  })

  it('code generation and the network are refused in a plain module as in a compiled one', async () => {
    await expect(prepare(`${REGISTER}const f = new Function('return 1')\n`)).rejects.toThrow(/code generation/)
    await expect(prepare(`${REGISTER}const f = Function('return 1')\n`)).rejects.toThrow(/code generation/)
    await expect(prepare(`${REGISTER}eval('1')\n`)).rejects.toThrow(/eval is not available/)
    await expect(prepare(`${REGISTER}fetch('https://example.test')\n`)).rejects.toThrow(/fetch is not available/)
    await expect(prepare(`${REGISTER}new Worker('w.js')\n`)).rejects.toThrow(/Worker is not available/)
    await expect(prepare(`${REGISTER}WebAssembly.compile(new Uint8Array())\n`)).rejects.toThrow(/WebAssembly is not available/)
  })

  it('a clean plain module loads as written: its own text, the scan read off it', async () => {
    const text = `const ready = await Promise.resolve(1)\nexport function register(on) {\n  on('prompt.submit', ($, e, next) => next(e))\n}\n`
    const prepared = await prepare(text)
    expect(prepared.source).toBe(text)
    expect(prepared.uses).toBeDefined()
    // A property named like a forbidden identifier is a noun on $, not the network.
    await expect(prepare(`${REGISTER}const get = $ => $.http.fetch('x')\n`)).resolves.toMatchObject({})
  })
})
