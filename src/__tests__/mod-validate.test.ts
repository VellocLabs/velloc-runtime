import { describe, expect, it } from 'vitest'
import { unconfiguredFs, type RuntimeFs, type RuntimeFsEntry, type RuntimeFsStat } from '../utils/fs/runtimeFs'
import { MOD_API_SPECIFIER } from '../mods/modCompiler'
import { getPluginManifestPath } from '../pluginHost/pluginPaths'
import { PROVIDER_WIRE_FORMATS } from '../mods/provider/providerManifest'
import { REFUSING_EVENTS, RAISED_EVENTS } from '../mods/modAdmission'
import { implementedNouns } from '../mods/modNouns'
import { MOD_VALIDATE_LIMITS, validateModFolder, type ModValidateReport } from '../mods/modValidate'

const ROOT = '/work/demo'

/** A read-only tree of files; a directory exists when a file is under it. */
function treeFs(files: Record<string, string>, reads: string[] = []): RuntimeFs {
  const isDir = (path: string): boolean => Object.keys(files).some(key => key.startsWith(`${path}/`))
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  const stat = (file: boolean): RuntimeFsStat =>
    ({ size: 0, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false }) as RuntimeFsStat
  return {
    ...unconfiguredFs,
    async stat(path: string) {
      reads.push(path)
      if (files[path] !== undefined) return stat(true)
      if (isDir(path)) return stat(false)
      throw enoent(path)
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      reads.push(path)
      const names = new Set<string>()
      for (const key of Object.keys(files)) if (key.startsWith(`${path}/`)) names.add(key.slice(path.length + 1).split('/')[0]!)
      if (names.size === 0) throw enoent(path)
      return [...names].map(name => {
        const file = files[`${path}/${name}`] !== undefined
        return { name, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false }
      })
    },
    async readFile(path: string) {
      reads.push(path)
      const text = files[path]
      if (text === undefined) throw enoent(path)
      return text
    },
  } as RuntimeFs
}

function plugin(index: string, extra: Record<string, string> = {}, name = 'demo'): Record<string, string> {
  return {
    [getPluginManifestPath(ROOT)]: JSON.stringify({ name }),
    [`${ROOT}/hooks/hooks.json`]: JSON.stringify({ modules: ['./index.ts'] }),
    [`${ROOT}/hooks/index.ts`]: index,
    ...extra,
  }
}

const allow = async () => {}

async function validate(files: Record<string, string>, gate = allow): Promise<ModValidateReport> {
  return validateModFolder(ROOT, { fs: treeFs(files), gate })
}

const codes = (report: ModValidateReport, level?: string) =>
  report.findings.filter(finding => level === undefined || finding.level === level).map(finding => finding.code)

describe('validateModFolder — a good mod', () => {
  const GOOD = [
    `import { atom, read } from '${MOD_API_SPECIFIER}'`,
    `const count = atom({ plugin: 'demo', key: 'count' }, 0)`,
    'export function register(on) {',
    "  on('session.start', async ($, e, next) => {",
    "    await $.state.set({ plugin: 'demo', key: 'count' }, 1)",
    '    await read($, count)',
    '    return next(e)',
    '  })',
    "  on('tool.call', { tool: 'Bash' }, async ($, e, next) => next(e))",
    "    .catch(async () => ({ deny: 'the guard failed' }))",
    '}',
  ].join('\n')

  it('lists each hook, each $ call and the state keys, and passes', async () => {
    const report = await validate(plugin(GOOD))
    expect(report.ok).toBe(true)
    expect(report.plugin).toBe('demo')
    expect(codes(report, 'refused')).toEqual([])
    const [module] = report.modules
    expect(module!.kind).toBe('hooks')
    expect(module!.hooks.map(hook => [hook.event, hook.line, hook.hasCatch, hook.guards])).toEqual([
      ['session.start', 4, false, false],
      ['tool.call', 9, true, true],
    ])
    expect(module!.calls).toEqual(['state.get', 'state.set'])
    expect(module!.state).toEqual({
      reads: [{ plugin: 'demo', key: 'count' }],
      writes: [{ plugin: 'demo', key: 'count' }],
    })
  })

  it('answers the JSON shape the tool returns', async () => {
    const report = JSON.parse(JSON.stringify(await validate(plugin(GOOD)))) as Record<string, unknown>
    expect(Object.keys(report).sort()).toEqual(['findings', 'folder', 'modules', 'ok', 'plugin'])
    const module = (report.modules as Array<Record<string, unknown>>)[0]!
    expect(Object.keys(module).sort()).toEqual(['calls', 'engineCreate', 'files', 'hooks', 'kind', 'path', 'state'])
    expect(Object.keys((module.hooks as Array<Record<string, unknown>>)[0]!).sort()).toEqual([
      'event',
      'file',
      'form',
      'guards',
      'hasCatch',
      'line',
    ])
  })

  it('reads only inside the folder', async () => {
    const reads: string[] = []
    await validateModFolder(ROOT, { fs: treeFs(plugin(GOOD), reads), gate: allow })
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every(path => path === ROOT || path.startsWith(`${ROOT}/`))).toBe(true)
  })
})

describe('validateModFolder — what the loader refuses', () => {
  it('an event this engine does not raise', async () => {
    const report = await validate(plugin("export function register(on) { on('turn.nowhere', async ($, e, next) => next(e)) }"))
    expect(report.ok).toBe(false)
    expect(codes(report, 'refused')).toEqual(['unraised-event'])
    expect(report.findings[0]!.message).toContain('turn.nowhere')
  })

  it('a call on an engine noun this engine does not implement', async () => {
    expect(implementedNouns()).not.toContain('ui.nowhere')
    const report = await validate(plugin("export function register(on) { on('session.start', async ($, e, next) => { await $.ui.nowhere(); return next(e) }) }"))
    expect(codes(report, 'refused')).toEqual(['unsupported-call'])
    expect(report.findings[0]!.message).toContain('$.ui.nowhere')
  })

  it('a hook of the wrong form on a streaming event', async () => {
    const report = await validate(plugin("export function register(on) { on('turn.step', async ($, e, next) => next(e)) }"))
    expect(codes(report, 'refused')).toEqual(['unraised-event'])
    expect(report.findings[0]!.message).toContain('async generator')
  })

  it('a bare import, with its file and line', async () => {
    const report = await validate(plugin("// one\nimport x from 'lodash'\nexport function register(on) {}"))
    const finding = report.findings.find(f => f.code === 'compile')!
    expect(finding.level).toBe('refused')
    expect(finding.file).toBe(`${ROOT}/hooks/index.ts`)
    expect(finding.line).toBe(2)
  })

  it('a syntax error', async () => {
    const report = await validate(plugin('export function register(on) {\n  on(\n'))
    expect(codes(report, 'refused')).toContain('compile')
  })

  it('a .catch on engine.create, and a .catch of the other form', async () => {
    const report = await validate(
      plugin(
        [
          'export function register(on) {',
          "  on('engine.create', async ($, e, next) => { const built = await next(e); return { ...built } }).catch(async () => undefined)",
          "  on('turn.step', async function* ($, e, next) { yield* next(e) }).catch(async () => undefined)",
          '}',
        ].join('\n'),
      ),
    )
    expect(codes(report, 'refused')).toEqual(['catch', 'catch'])
  })

  it('a provider module that hooks a session event', async () => {
    const files = {
      [getPluginManifestPath(ROOT)]: JSON.stringify({
        name: 'demo',
        providers: {
          zen: {
            providerApi: 1,
            displayName: 'Zen',
            defaultBaseUrl: 'https://example.com/v1',
            domains: ['example.com'],
            format: PROVIDER_WIRE_FORMATS[0],
            credentials: { methods: ['apiKey'] },
            module: './providers/zen.ts',
          },
        },
      }),
      [`${ROOT}/providers/zen.ts`]: "export function register(on) { on('session.start', async ($, e, next) => next(e)) }",
    }
    const report = await validate(files)
    expect(report.modules[0]!.kind).toBe('provider')
    expect(codes(report, 'refused')).toEqual(['admission'])
  })

  it('a hooks.json module path outside the plugin', async () => {
    const report = await validate({
      [getPluginManifestPath(ROOT)]: JSON.stringify({ name: 'demo' }),
      [`${ROOT}/hooks/hooks.json`]: JSON.stringify({ modules: ['/abs/index.ts'] }),
    })
    expect(codes(report, 'refused')).toEqual(['manifest'])
  })

  it('a folder that is not there', async () => {
    const report = await validate({})
    expect(report.ok).toBe(false)
    expect(codes(report)).toEqual(['not-a-folder'])
  })
})

describe('validateModFolder — what loads but is reported', () => {
  it('a guard without a .catch is a warning; the mod passes', async () => {
    const report = await validate(plugin("export function register(on) { on('tool.call', async ($, e, next) => next(e)) }"))
    expect(report.ok).toBe(true)
    expect(codes(report, 'warning')).toEqual(['guard-without-catch'])
    expect(report.findings[0]!.line).toBe(1)
  })

  it('a glob over a refusing event is a guard too', async () => {
    const report = await validate(plugin("export function register(on) { on('tool.*', async ($, e, next) => next(e)) }"))
    expect(report.modules[0]!.hooks[0]!.guards).toBe(true)
  })

  it('engine.create in the one form names the nouns it adds', async () => {
    const report = await validate(
      plugin(
        [
          'export function register(on) {',
          "  on('engine.create', async ($, e, next) => {",
          '    const built = await next(e)',
          '    return { ...built, voice: { say: async (text) => text } }',
          '  })',
          "  on('session.start', async ($, e, next) => { await $.voice.say('hi'); return next(e) })",
          '}',
        ].join('\n'),
      ),
    )
    expect(report.ok).toBe(true)
    expect(report.modules[0]!.engineCreate).toEqual([{ file: `${ROOT}/hooks/index.ts`, line: 2, form: 'built', adds: ['voice'] }])
    expect(codes(report)).not.toContain('plugin-noun')
  })

  it('engine.create in another form is an error', async () => {
    const report = await validate(
      plugin("export function register(on) { on('engine.create', async ($, e, next) => { const { fs, ...rest } = await next(e); return rest }) }"),
    )
    expect(report.ok).toBe(false)
    expect(codes(report, 'error')).toEqual(['engine-create-form'])
  })

  it('a call on another plugin\'s noun is a warning', async () => {
    const report = await validate(plugin("export function register(on) { on('session.start', async ($, e, next) => { await $.voice.say('hi'); return next(e) }) }"))
    expect(codes(report, 'warning')).toEqual(['plugin-noun'])
  })

  it('a $.state write to another plugin\'s key is an error', async () => {
    const report = await validate(
      plugin("export function register(on) { on('session.start', async ($, e, next) => { await $.state.set({ plugin: 'other', key: 'k' }, 1); return next(e) }) }"),
    )
    expect(codes(report, 'error')).toEqual(['state-owner'])
  })

  it('a path the gate refuses is not read, and is reported', async () => {
    const reads: string[] = []
    const secret = `${ROOT}/hooks/index.ts`
    const report = await validateModFolder(ROOT, {
      fs: treeFs(plugin("export function register(on) {}"), reads),
      gate: async path => {
        if (path === secret) throw new Error('denied by a rule')
      },
    })
    expect(reads).not.toContain(secret)
    expect(report.ok).toBe(false)
    expect(report.findings.find(f => f.code === 'not-readable')).toMatchObject({ file: secret, message: 'not read: denied by a rule' })
  })
})

describe('validateModFolder — the source as the loader reads it', () => {
  it('a generator hook imported from another file of the module is a generator', async () => {
    const report = await validate(
      plugin("import { step } from './step'\nexport function register(on) { on('turn.step', step) }", {
        [`${ROOT}/hooks/step.ts`]: 'export async function* step($, e, next) { yield* next(e) }',
      }),
    )
    expect(codes(report, 'refused')).toEqual([])
    expect(report.modules[0]!.hooks[0]!.form).toBe('generator')
  })

  it('a hook it cannot resolve is a note, never a refusal of its form', async () => {
    const report = await validate(plugin("export function register(on) { on('turn.step', makeStep()) }\nfunction makeStep() { return null }"))
    expect(codes(report, 'refused')).toEqual([])
    expect(codes(report, 'note')).toContain('hook-form-unknown')
  })

  it('a matcher that is a string is refused, as the loader refuses it', async () => {
    const report = await validate(plugin("export function register(on) { on('tool.call', 'Bash', async ($, e, next) => next(e)).catch(async () => undefined) }"))
    expect(codes(report, 'refused')).toEqual(['matcher'])
  })

  it('an engine.create step that passes next(e) through adds nothing and passes', async () => {
    const report = await validate(plugin("export function register(on) { on('engine.create', async ($, e, next) => next(e)) }"))
    expect(report.ok).toBe(true)
    expect(report.modules[0]!.engineCreate).toEqual([{ file: `${ROOT}/hooks/index.ts`, line: 1, form: 'built', adds: [] }])
  })

  it('an import the gate refuses is reported as not read, not as a missing file', async () => {
    const report = await validateModFolder(ROOT, {
      fs: treeFs(
        plugin("import { x } from './lib/x'\nexport function register(on) { on('session.start', async ($, e, next) => { x(); return next(e) }) }", {
          [`${ROOT}/hooks/lib/x.ts`]: 'export const x = () => 1',
        }),
      ),
      gate: async path => {
        if (path.startsWith(`${ROOT}/hooks/lib/`)) throw new Error('denied by a rule')
      },
    })
    expect(codes(report)).toEqual(['not-readable'])
    expect(report.findings[0]).toMatchObject({ level: 'error', file: `${ROOT}/hooks/lib/x.ts` })
    expect(report.findings[0]!.message).toContain('denied by a rule')
  })

  it('a refused file two modules reach is reported, whichever reads it first', async () => {
    const files = {
      [getPluginManifestPath(ROOT)]: JSON.stringify({ name: 'demo' }),
      [`${ROOT}/hooks/hooks.json`]: JSON.stringify({ modules: ['./index.ts', './lib/b.ts'] }),
      [`${ROOT}/hooks/index.ts`]: "import { b } from './lib/b'\nexport function register(on) { b }",
      [`${ROOT}/hooks/lib/b.ts`]: 'export const b = 1\nexport function register(on) {}',
    }
    const report = await validateModFolder(ROOT, {
      fs: treeFs(files),
      gate: async path => {
        if (path.startsWith(`${ROOT}/hooks/lib/`)) throw new Error('denied by a rule')
      },
    })
    expect(codes(report)).toEqual(['not-readable'])
    expect(report.findings[0]!.file).toBe(`${ROOT}/hooks/lib/b.ts`)
  })

  it('an imported hook is the function of the file its import names', async () => {
    const report = await validate(
      plugin("import { step } from './a'\nexport function register(on) { on('turn.step', step) }", {
        [`${ROOT}/hooks/a.ts`]: 'export async function* step($, e, next) { yield* next(e) }',
        [`${ROOT}/hooks/b.ts`]: 'export function step() {}',
      }),
    )
    expect(report.modules[0]!.hooks[0]!.form).toBe('generator')
  })

  it('a file over the size limit is not read', async () => {
    const fs = treeFs(plugin('export function register(on) {}'))
    const big = `${ROOT}/hooks/index.ts`
    const contents: string[] = []
    const sized = {
      ...fs,
      async stat(path: string) {
        const stat = await fs.stat(path)
        return path === big ? { ...stat, size: MOD_VALIDATE_LIMITS.fileBytes + 1 } : stat
      },
      async readFile(path: string, options?: unknown) {
        contents.push(path)
        return fs.readFile(path, options as never)
      },
    } as RuntimeFs
    const report = await validateModFolder(ROOT, { fs: sized, gate: allow })
    expect(codes(report)).toEqual(['too-large'])
    expect(contents).not.toContain(big)
  })

  it('reads each file of the graph once', async () => {
    const fs = treeFs(plugin("import { x } from './x'\nexport function register(on) { x }", { [`${ROOT}/hooks/x.ts`]: 'export const x = 1' }))
    const contents: string[] = []
    const counting = {
      ...fs,
      async readFile(path: string, options?: unknown) {
        contents.push(path)
        return fs.readFile(path, options as never)
      },
    } as RuntimeFs
    await validateModFolder(ROOT, { fs: counting, gate: allow })
    expect(contents.filter(path => path === `${ROOT}/hooks/x.ts`)).toHaveLength(1)
  })
})

describe('REFUSING_EVENTS', () => {
  it('names only events this engine raises', () => {
    for (const event of REFUSING_EVENTS) expect(RAISED_EVENTS).toContain(event)
  })
})
