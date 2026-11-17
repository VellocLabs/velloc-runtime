/**
 * Writing the mod API declaration beside a dev mod (F-25): into
 * `<plugin>/<manifest dir>/types/` only, never through a link, never over a
 * file it did not write, and the plugin's own `tsconfig.json` only when it
 * has none.
 */
import { describe, expect, it } from 'vitest'
import { createDevModTypesWriter, manifestDirName, writeDevModTypes } from '../mods/devModTypes'
import { GENERATED_MARKER } from '../mods/modApiDeclaration'
import { emitModTypes, modTypesConfigPath, type ModTypesFs } from '../mods/modTypesEmit'

const FOLDER = '/home/.velloc/dev-mods/s1'
const PLUGIN = `${FOLDER}/panel`
const MANIFEST = manifestDirName()
const TYPES = `${PLUGIN}/${MANIFEST}/types`
const join = (base: string, ...segments: string[]) => [base, ...segments].join('/')

/** Directories, files and links; a link is followed by every operation
 *  but `realpath` reports where it leads. */
function world() {
  const dirs = new Set<string>(['/', '/home', '/home/.velloc', '/home/.velloc/dev-mods', FOLDER, '/elsewhere'])
  const files = new Map<string, string>()
  const links = new Map<string, string>()
  const resolve = (path: string): string => {
    const parts = path.split('/').filter(Boolean)
    let at = ''
    for (const part of parts) {
      at = `${at}/${part}`
      for (let hops = 0; links.has(at) && hops < 8; hops++) at = links.get(at)!
    }
    return at || '/'
  }
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
  const fs: ModTypesFs = {
    stat: async path => {
      const at = resolve(path)
      if (!dirs.has(at) && !files.has(at)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' })
      return { isFile: () => files.has(at), isDirectory: () => dirs.has(at) } as never
    },
    mkdir: async path => {
      const at = resolve(path)
      if (!dirs.has(parentOf(at))) throw new Error(`no parent for ${at}`)
      dirs.add(at)
    },
    readFile: async path => {
      const text = files.get(resolve(path))
      if (text === undefined) throw new Error('missing')
      return text
    },
    writeFile: async (path, data) => {
      const at = resolve(path)
      if (!dirs.has(parentOf(at))) throw new Error(`no parent for ${at}`)
      files.set(at, String(data))
    },
    realpath: async path => resolve(path),
  }
  return { fs, dirs, files, links }
}

const sample = {
  'api.d.ts': `// ${GENERATED_MARKER}\ndeclare module "x" {}\n`,
  '.gitignore': `# ${GENERATED_MARKER}\n*\n`,
}
const target = { folder: FOLDER, pluginDir: PLUGIN, manifestDir: MANIFEST, join }

describe('emitModTypes', () => {
  it('writes the types folder and a one-line tsconfig the first time, nothing when unchanged', async () => {
    const w = world()
    w.dirs.add(PLUGIN)
    const first = await emitModTypes(w.fs, target, sample)
    expect(first.refused).toBeUndefined()
    expect(first.written.sort()).toEqual([`${PLUGIN}/tsconfig.json`, `${TYPES}/.gitignore`, `${TYPES}/api.d.ts`].sort())
    expect(w.files.get(`${TYPES}/.gitignore`)).toBe(sample['.gitignore'])
    expect(JSON.parse(w.files.get(`${PLUGIN}/tsconfig.json`)!)).toEqual({ extends: modTypesConfigPath(MANIFEST) })
    const again = await emitModTypes(w.fs, target, sample)
    expect(again).toEqual({ written: [], conflicts: [] })
  })

  it('replaces its own file when the declaration changes', async () => {
    const w = world()
    w.dirs.add(PLUGIN)
    await emitModTypes(w.fs, target, sample)
    const next = { ...sample, 'api.d.ts': `// ${GENERATED_MARKER}\ndeclare module "y" {}\n` }
    expect((await emitModTypes(w.fs, target, next)).written).toEqual([`${TYPES}/api.d.ts`])
    expect(w.files.get(`${TYPES}/api.d.ts`)).toBe(next['api.d.ts'])
  })

  it('leaves a file it did not write, and the plugin\'s own tsconfig, as they are', async () => {
    const w = world()
    for (const dir of [PLUGIN, `${PLUGIN}/${MANIFEST}`, TYPES]) w.dirs.add(dir)
    w.files.set(`${TYPES}/api.d.ts`, '// my own notes\n')
    w.files.set(`${PLUGIN}/tsconfig.json`, '{ "compilerOptions": {} }')
    const outcome = await emitModTypes(w.fs, target, sample)
    expect(outcome.conflicts).toEqual([`${TYPES}/api.d.ts`])
    expect(outcome.written).toEqual([`${TYPES}/.gitignore`])
    expect(w.files.get(`${TYPES}/api.d.ts`)).toBe('// my own notes\n')
    expect(w.files.get(`${PLUGIN}/tsconfig.json`)).toBe('{ "compilerOptions": {} }')
  })

  it('refuses a types folder that is a link, writing nothing anywhere', async () => {
    const w = world()
    for (const dir of [PLUGIN, `${PLUGIN}/${MANIFEST}`]) w.dirs.add(dir)
    w.links.set(TYPES, '/elsewhere')
    const outcome = await emitModTypes(w.fs, target, sample)
    expect(outcome.refused).toBe(`${TYPES} is a link`)
    expect([...w.files.keys()]).toEqual([])
  })

  it('refuses a link anywhere above it: the plugin or the manifest directory', async () => {
    for (const linked of [PLUGIN, `${PLUGIN}/${MANIFEST}`]) {
      const w = world()
      w.dirs.add('/elsewhere/real')
      if (linked !== PLUGIN) w.dirs.add(PLUGIN)
      w.links.set(linked, '/elsewhere/real')
      const outcome = await emitModTypes(w.fs, target, sample)
      expect(outcome.refused).toBe(`${linked} is a link`)
      expect([...w.files.keys()]).toEqual([])
    }
  })

  it('treats a file that is a link, dangling or not, as someone else\'s', async () => {
    const w = world()
    for (const dir of [PLUGIN, `${PLUGIN}/${MANIFEST}`, TYPES]) w.dirs.add(dir)
    w.links.set(`${TYPES}/api.d.ts`, '/elsewhere/api.d.ts')
    w.links.set(`${PLUGIN}/tsconfig.json`, '/elsewhere/tsconfig.json')
    const outcome = await emitModTypes(w.fs, target, sample)
    expect(outcome.conflicts).toEqual([`${TYPES}/api.d.ts`])
    expect([...w.files.keys()].filter(path => path.startsWith('/elsewhere'))).toEqual([])
    expect(w.files.has(`${PLUGIN}/tsconfig.json`)).toBe(false)
  })

  it('refuses a directory outside the dev mods folder, or nested deeper than one plugin', async () => {
    const w = world()
    for (const pluginDir of ['/elsewhere/panel', `${FOLDER}/panel/inner`, FOLDER]) {
      const outcome = await emitModTypes(w.fs, { ...target, pluginDir }, sample)
      expect(outcome.refused).toBe(`${pluginDir} is not a plugin of the dev mods folder`)
    }
    expect([...w.files.keys()]).toEqual([])
  })

  it('writes nothing on a host that cannot resolve real paths', async () => {
    const w = world()
    w.dirs.add(PLUGIN)
    const { realpath: _realpath, ...fs } = w.fs
    expect((await emitModTypes(fs, target, sample)).refused).toBe('this host cannot resolve real paths')
    expect([...w.files.keys()]).toEqual([])
  })
})

describe('writeDevModTypes', () => {
  it('writes the declaration into each plugin and reports each refusal', async () => {
    const w = world()
    w.dirs.add(PLUGIN)
    w.dirs.add(`${FOLDER}/linked-target`)
    w.links.set(`${FOLDER}/other`, '/elsewhere')
    const reports: string[] = []
    await writeDevModTypes({
      fs: w.fs,
      folder: FOLDER,
      plugins: [
        { name: 'panel', path: PLUGIN },
        { name: 'other', path: `${FOLDER}/other` },
      ],
      tools: [{ name: 'Bash', argsSchema: { type: 'object', properties: { command: { type: 'string' } } } }],
      join,
      report: line => reports.push(line),
    })
    expect(w.files.get(`${TYPES}/builtin-tools.d.ts`)).toContain('"Bash"')
    expect(w.files.has(`${TYPES}/api.d.ts`)).toBe(true)
    expect(reports).toEqual([`dev mods: other: types not written: ${FOLDER}/other is a link`])
  })
})

describe('createDevModTypesWriter', () => {
  const bash = { name: 'Bash', argsSchema: { type: 'object', properties: { command: { type: 'string' } } } }
  const notes = { name: 'mcp__notes__search', argsSchema: { type: 'object', properties: { q: { type: 'string' } } }, fromMcpServer: true }

  it('writes beside the caller, again only when the session tools change', async () => {
    const w = world()
    w.dirs.add(PLUGIN)
    let tools: Array<typeof bash | typeof notes> = [bash]
    const writes: string[] = []
    const fs: ModTypesFs = { ...w.fs, writeFile: async (path, data, opts) => { writes.push(path); await w.fs.writeFile(path, data, opts) } }
    const writer = createDevModTypesWriter({ fs, folder: FOLDER, tools: () => tools, join, report: () => {} })
    writer.refresh()
    await writer.idle()
    expect(writes).toEqual([])
    writer.loaded([{ name: 'panel', path: PLUGIN }])
    expect(writes).toEqual([])
    await writer.idle()
    expect(w.files.get(`${TYPES}/mcp-tools.d.ts`)).not.toContain('mcp__notes__search')
    writes.length = 0
    writer.refresh()
    await writer.idle()
    expect(writes).toEqual([])
    tools = [bash, notes]
    writer.refresh()
    await writer.idle()
    expect(w.files.get(`${TYPES}/mcp-tools.d.ts`)).toContain('mcp__notes__search')
  })

  it('starts nothing once its scope has ended', async () => {
    const w = world()
    w.dirs.add(PLUGIN)
    const scope = new AbortController()
    const writer = createDevModTypesWriter({ fs: w.fs, folder: FOLDER, tools: () => [bash], join, report: () => {}, signal: scope.signal })
    scope.abort()
    writer.loaded([{ name: 'panel', path: PLUGIN }])
    await writer.idle()
    expect([...w.files.keys()]).toEqual([])
  })
})
