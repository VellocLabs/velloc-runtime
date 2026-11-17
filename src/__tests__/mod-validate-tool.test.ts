import { describe, expect, it } from 'vitest'
import { unconfiguredFs, type RuntimeFs, type RuntimeFsStat } from '../utils/fs/runtimeFs'
import { ModValidateTool, MOD_VALIDATE_TOOL_NAME } from '../toolkit/builtin/modValidate'
import { getToolsForPreset } from '../toolkit/toolRegistry'
import { TOOL_GROUPS } from '../toolkit/builtin/toolGroups'
import { modValidateReportParts } from '../input/modValidateCommand'
import { renderPartsEnglish } from '../input/systemMessageParts'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'
import type { ModValidateReport } from '../mods/modValidate'
import { getPluginManifestPath } from '../pluginHost/pluginPaths'

const CWD = 'D:/work'
const FILES: Record<string, string> = {
  [getPluginManifestPath('D:/work/demo').split('\\').join('/')]: JSON.stringify({ name: 'demo' }),
  'D:/work/demo/hooks/hooks.json': JSON.stringify({ modules: ['./index.ts'] }),
  'D:/work/demo/hooks/index.ts': "export function register(on) { on('tool.call', async ($, e, next) => next(e)) }",
}

function treeFs(reads: string[]): RuntimeFs {
  const stat = (file: boolean): RuntimeFsStat =>
    ({ size: 0, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false }) as RuntimeFsStat
  return {
    ...unconfiguredFs,
    async stat(raw: string) {
      const path = raw.replace(/\\/g, '/')
      reads.push(path)
      if (FILES[path] !== undefined) return stat(true)
      if (Object.keys(FILES).some(key => key.startsWith(`${path}/`))) return stat(false)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    async readFile(raw: string) {
      const path = raw.replace(/\\/g, '/')
      reads.push(path)
      const text = FILES[path]
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
  } as RuntimeFs
}

function contextWith(deny: string[], reads: string[] = [], ask: string[] = []): ToolCallContext {
  return {
    options: { cwd: CWD, projectRoot: CWD, sessionId: 'session-1', fsOperations: treeFs(reads) },
    readAppState: () => ({
      permissionRules: { mode: 'default', ruleLists: { allow: [], deny, ask }, extraWorkspaceRoots: [] },
    }),
  } as unknown as ToolCallContext
}

const call = async (context: ToolCallContext): Promise<ModValidateReport> => {
  const outcome = await ModValidateTool.call({ folder: 'demo' }, context, (async () => ({ behavior: 'allow' })) as never, {} as Message)
  return JSON.parse(outcome.data) as ModValidateReport
}

describe('ModValidate tool', () => {
  it('is a bundled tool of the mods group, read-only', () => {
    expect(getToolsForPreset('nexus')).toContain(MOD_VALIDATE_TOOL_NAME)
    expect(TOOL_GROUPS.mods).toEqual([MOD_VALIDATE_TOOL_NAME])
    expect(ModValidateTool.readsOnly({ folder: 'x' })).toBe(true)
  })

  it('answers the report as JSON, the folder resolved against the cwd', async () => {
    const report = await call(contextWith([]))
    expect(report.folder).toBe('D:/work/demo')
    expect(report.plugin).toBe('demo')
    expect(report.modules[0]!.hooks[0]!.event).toBe('tool.call')
  })

  it('asks the Read permission for the folder: a deny rule denies the call', async () => {
    const verdict = await ModValidateTool.selfVerdict({ folder: 'demo' }, contextWith(['Read(demo)']))
    expect(verdict.behavior).toBe('deny')
    const allowed = await ModValidateTool.selfVerdict({ folder: 'demo' }, contextWith([]))
    expect(allowed.behavior).toBe('allow')
  })

  it('an ask on the folder asks, and the allowed call reads the folder', async () => {
    const context = contextWith([], [], ['Read(demo)'])
    expect((await ModValidateTool.selfVerdict({ folder: 'demo' }, context)).behavior).toBe('ask')
    const report = await call(context)
    expect(report.ok).toBe(true)
    expect(report.modules).toHaveLength(1)
  })

  it('an ask narrower than the allowed one still refuses its path', async () => {
    const reads: string[] = []
    const report = await call(contextWith([], reads, ['Read(demo/hooks/**)', 'Read(demo)']))
    expect(reads).not.toContain('D:/work/demo/hooks/index.ts')
    expect(report.findings.map(finding => finding.code)).toContain('not-readable')
  })

  it('answers JSON without the catalog entries of its findings', async () => {
    const outcome = await ModValidateTool.call({ folder: 'demo' }, contextWith([]), (async () => ({ behavior: 'allow' })) as never, {} as Message)
    expect(outcome.data).toContain('guard-without-catch')
    expect(outcome.data).not.toContain('"detail"')
  })

  it('does not read a file a deny rule covers inside the folder', async () => {
    const reads: string[] = []
    const report = await call(contextWith(['Read(demo/hooks/**)'], reads))
    expect(reads).not.toContain('D:/work/demo/hooks/index.ts')
    expect(report.ok).toBe(false)
    expect(report.findings.map(finding => finding.code)).toContain('not-readable')
  })
})

describe('/plugins validate output', () => {
  it('names the result, each hook with its place and marks, and each finding', () => {
    const report: ModValidateReport = {
      folder: 'D:/work/demo',
      plugin: 'demo',
      ok: false,
      modules: [
        {
          path: 'D:/work/demo/hooks/index.ts',
          kind: 'hooks',
          files: ['D:/work/demo/hooks/index.ts'],
          hooks: [{ event: 'tool.call', file: 'D:/work/demo/hooks/index.ts', line: 3, form: 'function', hasCatch: true, guards: true }],
          calls: ['state.get'],
          engineCreate: [],
        },
      ],
      findings: [
        { level: 'refused', code: 'compile', message: 'syntax error', file: 'D:/work/demo/hooks/index.ts', line: 7 },
        {
          level: 'warning',
          code: 'guard-without-catch',
          message: 'in English',
          detail: { key: 'slash.out.modValidate.finding.guardWithoutCatch', params: { event: 'tool.call' } },
          file: 'D:/work/demo/hooks/index.ts',
          line: 3,
        },
      ],
    }
    const text = renderPartsEnglish(modValidateReportParts(report))
    expect(text).toContain('### Validation of demo: D:/work/demo')
    expect(text).toContain('Not passed: 1 refused, 0 errors.')
    expect(text).toContain('- `tool.call` hooks/index.ts:3 · can refuse the action · has .catch')
    expect(text).toContain('- `$.state.get`')
    expect(text).toContain('- Refused `hooks/index.ts:7`: syntax error')
    expect(text).toContain('- Warning `hooks/index.ts:3`: its hook on tool.call can refuse an action, and has no .catch')
  })
})
