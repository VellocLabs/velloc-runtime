/**
 * The mod-authoring skill (F-25): registered for code and agent sessions, its
 * body names the session's dev mods folder and carries every example; each
 * example passes the validator, `tsc` against the emitted types folder (test
 * files included), and its own tests in a mod worker.
 */
import path from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { MOD_EXAMPLES, type ModExample } from '../skillLibrary/builtin/modAuthoring/modExamples'
import { MOD_AUTHORING_SKILL_NAME, modAuthoringPrompt } from '../skillLibrary/builtin/modAuthoring/modAuthoringSkill'
import { installStockSkills } from '../skillLibrary/builtin/catalog'
import { getBundledSkillModelInvocation } from '../skillLibrary/builtinSkills'
import { buildModApiFiles } from '../mods/modApiDeclaration'
import { modApiTables } from '../mods/devModTypes'
import { MOD_TYPES_DIR } from '../mods/modTypesEmit'
import { validateModFolder } from '../mods/modValidate'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { runModTests, type ModTestFs, type ModTestWorker } from '../mods/testKit/modTestRunner'
import { allBundledTools } from '../toolkit/toolRegistry'
import { PLUGIN_MANIFEST_DIR_NAME } from '../pluginHost/pluginDirs'
import { unconfiguredFs, type RuntimeFs, type RuntimeFsEntry, type RuntimeFsStat } from '../utils/fs/runtimeFs'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { SHELL_TOOL_ID } from '../prompting/processToolNames'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'

const ROOT = 'D:/dev-mods/s1'

/** An example's files, absolute, under ROOT. */
const filesOf = (example: ModExample): Map<string, string> =>
  new Map(Object.entries(example.files).map(([rel, text]) => [`${ROOT}/${example.name}/${rel}`, text]))

function memoryFs(files: Map<string, string>): RuntimeFs & ModTestFs {
  const norm = (raw: string) => raw.replace(/\\/g, '/')
  const isDir = (dir: string) => [...files.keys()].some(key => key.startsWith(`${dir}/`))
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  return {
    ...unconfiguredFs,
    async stat(raw: string) {
      const path = norm(raw)
      if (!files.has(path) && !isDir(path)) throw missing(path)
      const file = files.has(path)
      return { size: 0, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false } as RuntimeFsStat
    },
    async readFile(raw: string) {
      const text = files.get(norm(raw))
      if (text === undefined) throw missing(norm(raw))
      return text
    },
    async readdir(raw: string) {
      const prefix = `${norm(raw)}/`
      const names = new Map<string, boolean>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const [head, ...rest] = key.slice(prefix.length).split('/')
        names.set(head!, rest.length > 0 || names.get(head!) === true)
      }
      if (names.size === 0) throw missing(norm(raw))
      return [...names].map(([name, dir]): RuntimeFsEntry => ({ name, isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false }))
    },
  } as RuntimeFs & ModTestFs
}

/** The type errors of an example: its sources and tests against the types
 *  folder written for the session's real tools, under its tsconfig. */
function typeErrors(example: ModExample): string[] {
  const folder = `/mods/${example.name}`
  const types = `${folder}/${PLUGIN_MANIFEST_DIR_NAME}/${MOD_TYPES_DIR}`
  const emitted = buildModApiFiles(modApiTables([...allBundledTools('nexus'), SHELL]))
  const virtual = new Map(Object.entries(example.files).map(([rel, text]) => [`${folder}/${rel}`, text]))
  for (const [name, text] of Object.entries(emitted)) virtual.set(`${types}/${name}`, text)
  const config = ts.parseConfigFileTextToJson('tsconfig.json', emitted['tsconfig.json']!)
  const { options } = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, types)
  const host = ts.createCompilerHost(options)
  const read = host.readFile.bind(host)
  const exists = host.fileExists.bind(host)
  const source = host.getSourceFile.bind(host)
  // Resolution may qualify a rooted path with the drive; the map has none.
  const held = (name: string) => virtual.get(name.replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''))
  host.readFile = name => held(name) ?? read(name)
  host.fileExists = name => held(name) !== undefined || exists(name)
  host.directoryExists = dir => {
    const prefix = `${dir.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/$/, '')}/`
    return [...virtual.keys()].some(key => key.startsWith(prefix)) || ts.sys.directoryExists(dir)
  }
  host.getSourceFile = (name, version, ...rest) => {
    const text = held(name)
    return text !== undefined ? ts.createSourceFile(name, text, version) : source(name, version, ...rest)
  }
  const roots = [...virtual.keys()].filter(name => /\.(d\.)?ts$/.test(name))
  return ts
    .getPreEmitDiagnostics(ts.createProgram(roots, options, host))
    .map(d => `${d.file ? path.basename(d.file.fileName) : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
}

/** The host's shell tool, as the bridge lists it: the bundled pool has no host tools. */
const SHELL = {
  name: SHELL_TOOL_ID,
  argsSchema: {
    type: 'object',
    properties: { command: { type: 'string' }, timeout: { type: 'number' }, description: { type: 'string' } },
    required: ['command'],
  },
}

const open: MessagePort[] = []
afterEach(() => {
  for (const port of open.splice(0)) port.close()
})

const openWorker = async (): Promise<ModTestWorker> => {
  const channel = new MessageChannel()
  open.push(channel.port1, channel.port2)
  installModWorkerHost(channel.port2)
  return { port: channel.port1, closed: new Promise(() => {}), close: () => {} }
}

describe('the mod-authoring skill', () => {
  it('is a bundled skill the model may use in code and agent sessions', () => {
    installStockSkills()
    expect(getBundledSkillModelInvocation(MOD_AUTHORING_SKILL_NAME)).toEqual(['code', 'agent'])
  })

  it("names the session's dev mods folder and carries every example in full", () => {
    const context = { options: { sessionId: 'abc', homeDir: 'C:\\Users\\me' } } as unknown as ToolCallContext
    const text = modAuthoringPrompt('a pane of open todos', context)
    expect(text).toContain(`C:/Users/me/${RUNTIME_DIR_NAME}/dev-mods/abc/<mod-name>/`)
    for (const example of MOD_EXAMPLES) {
      for (const source of Object.values(example.files)) expect(text).toContain(source.trimEnd())
    }
    expect(text.endsWith('## The mod to write\n\na pane of open todos\n')).toBe(true)
  })

  it('the type check is real: an unserved event and an unknown kit call are errors', () => {
    const pane = MOD_EXAMPLES[0]!
    const broken: ModExample = {
      ...pane,
      files: {
        ...pane.files,
        'hooks/index.ts': pane.files['hooks/index.ts']!.replace("on('session.start'", "on('session.nope'"),
        'hooks/index.test.ts': pane.files['hooks/index.test.ts']!.replace('p.calls(', 'p.callz('),
      },
    }
    const errors = typeErrors(broken).join('\n')
    expect(errors).toMatch(/index\.ts: No overload[\s\S]*"session\.nope"/)
    expect(errors).toMatch(/index\.test\.ts: .*callz/)
  }, 60_000)

  it('has four examples: a pane, a band, a tool.call guard and a command', () => {
    expect(MOD_EXAMPLES.map(example => example.name)).toEqual(['notes-pane', 'turn-counter', 'push-guard', 'stamp-command'])
  })
})

describe.each(MOD_EXAMPLES.map(example => [example.name, example] as const))('example %s', (_name, example) => {
  const folder = `${ROOT}/${example.name}`

  it('passes the validator with no refusal, error or warning', async () => {
    const report = await validateModFolder(folder, { fs: memoryFs(filesOf(example)), gate: async () => {} })
    expect(report.findings.filter(finding => finding.level !== 'note')).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.plugin).toBe(example.name)
  })

  it('type-checks, its tests included', () => {
    expect(typeErrors(example)).toEqual([])
  }, 60_000)

  it('passes its own tests in a mod worker', async () => {
    const report = await runModTests({ folder, fs: memoryFs(filesOf(example)), openWorker })
    expect(report.files.map(file => file.error)).toEqual([undefined])
    expect(report.files[0]!.tests.filter(test => !test.ok)).toEqual([])
    expect(report.passed).toBeGreaterThan(0)
  })
})
