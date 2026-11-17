/**
 * `ModTest` and `/plugins test` (F-25): the folder's tests read through the
 * session's read gate and run in a mod worker; the tool answers text, the
 * command renders catalog-keyed parts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { unconfiguredFs, type RuntimeFs, type RuntimeFsEntry } from '../utils/fs/runtimeFs'
import { ModTestTool, MOD_TEST_TOOL_NAME, runFolderTestsForSession } from '../toolkit/builtin/modTest'
import { getToolsForPreset } from '../toolkit/toolRegistry'
import { TOOL_GROUPS } from '../toolkit/builtin/toolGroups'
import { modTestReportParts } from '../input/modTestCommand'
import { renderPartsEnglish } from '../input/systemMessageParts'
import { MOD_API_SPECIFIER, MOD_TEST_KIT_SPECIFIER } from '../mods/modCompiler'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import type { ModTestReport } from '../mods/testKit/modTestRunner'
import type { ToolCallContext } from '../toolkit/toolCallContext'

const CWD = 'D:/work'
const FILES: Record<string, string> = {
  'D:/work/demo/hooks/register.ts': [
    `import type {} from '${MOD_API_SPECIFIER}'`,
    'export function register(on: any) {',
    "  on('prompt.submit', ($: any, e: any, next: any) => next({ ...e, text: e.text + '!' }))",
    '}',
  ].join('\n'),
  'D:/work/demo/hooks/register.test.ts': [
    `import { test, expect, loadPlugin } from '${MOD_TEST_KIT_SPECIFIER}'`,
    "import { register } from './register'",
    "test('adds a bang', async () => {",
    "  expect(await loadPlugin(register).fire('prompt.submit', { text: 'hi' })).toEqual({ text: 'hi!' })",
    '})',
  ].join('\n'),
}

function treeFs(reads: string[]): RuntimeFs {
  const entry = (name: string, dir: boolean): RuntimeFsEntry => ({
    name,
    isFile: () => !dir,
    isDirectory: () => dir,
    isSymbolicLink: () => false,
  })
  return {
    ...unconfiguredFs,
    async readFile(raw: string) {
      const path = raw.replace(/\\/g, '/')
      reads.push(path)
      const text = FILES[path]
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
    async readdir(raw: string) {
      const prefix = `${raw.replace(/\\/g, '/')}/`
      reads.push(raw)
      const names = new Map<string, boolean>()
      for (const path of Object.keys(FILES)) {
        if (!path.startsWith(prefix)) continue
        const [head, ...rest] = path.slice(prefix.length).split('/')
        names.set(head!, rest.length > 0)
      }
      return [...names].map(([name, dir]) => entry(name, dir))
    },
  } as RuntimeFs
}

function contextWith(deny: string[], reads: string[] = []): ToolCallContext {
  return {
    options: { cwd: CWD, projectRoot: CWD, sessionId: 'session-1', fsOperations: treeFs(reads) },
    readAppState: () => ({
      permissionRules: { mode: 'default', ruleLists: { allow: [], deny, ask: [] }, extraWorkspaceRoots: [] },
    }),
  } as unknown as ToolCallContext
}

const open: MessagePort[] = []
afterEach(() => {
  for (const port of open.splice(0)) port.close()
})

const openWorker = async (): Promise<ModWorkerHandle> => {
  const channel = new MessageChannel()
  open.push(channel.port1, channel.port2)
  installModWorkerHost(channel.port2)
  return { port: channel.port1, closed: new Promise(() => {}), close: () => {} }
}

describe('ModTest tool', () => {
  it('is a bundled read-only tool of the mods group', () => {
    expect(getToolsForPreset('nexus')).toContain(MOD_TEST_TOOL_NAME)
    expect(TOOL_GROUPS.mods).toContain(MOD_TEST_TOOL_NAME)
    expect(ModTestTool.readsOnly({ folder: 'x' })).toBe(true)
  })

  it('asks the Read permission of the folder: a deny rule denies the call', async () => {
    expect((await ModTestTool.selfVerdict!({ folder: 'demo' }, contextWith(['Read(demo)']))).behavior).toBe('deny')
    expect((await ModTestTool.selfVerdict!({ folder: 'demo' }, contextWith([]))).behavior).toBe('allow')
  })

  it('runs the folder, resolved against the cwd, through the session fs', async () => {
    const report = await runFolderTestsForSession('demo', contextWith([]), false, openWorker)
    expect(report.folder).toBe('D:/work/demo')
    expect(report.files.map(file => file.file)).toEqual(['D:/work/demo/hooks/register.test.ts'])
    expect(report).toMatchObject({ passed: 1, failed: 0 })
  })

  it('does not read a file a deny rule covers inside the folder', async () => {
    const reads: string[] = []
    const report = await runFolderTestsForSession('demo', contextWith(['Read(demo/hooks/register.ts)'], reads), false, openWorker)
    expect(reads).not.toContain('D:/work/demo/hooks/register.ts')
    expect(report.files[0]!.error).toBeDefined()
    expect(report.failed).toBe(1)
  })
})

describe('/plugins test output', () => {
  it('names each file, each case, a failure with its place, and the totals', () => {
    const report: ModTestReport = {
      folder: 'D:/work/demo',
      files: [
        {
          file: 'D:/work/demo/hooks/register.test.ts',
          tests: [
            { name: 'adds a bang', ok: true },
            { name: 'drops it', ok: false, message: 'expected 1 to be 2', at: { file: 'D:/work/demo/hooks/register.test.ts', line: 9 } },
          ],
        },
        { file: 'D:/work/demo/hooks/net.test.ts', error: 'fetch is not available', errorKind: 'compile', tests: [] },
        { file: 'D:/work/demo/hooks/slow.test.ts', error: '60000', errorKind: 'timeout', tests: [] },
      ],
      passed: 1,
      failed: 3,
    }
    const text = renderPartsEnglish(modTestReportParts(report))
    expect(text).toContain('### Tests of D:/work/demo')
    expect(text).toContain('#### `hooks/register.test.ts`')
    expect(text).toContain('- ✓ adds a bang')
    expect(text).toContain('- ✗ drops it `hooks/register.test.ts:9`: expected 1 to be 2')
    expect(text).toContain('- ✗ It did not compile: fetch is not available')
    expect(text).toContain('- ✗ The tests ran past 60000 ms.')
    expect(text).toContain('Not passed: 3 failed, 1 passed.')
    expect(renderPartsEnglish(modTestReportParts({ folder: 'D:/x', files: [], passed: 0, failed: 0 }))).toContain('No test files')
  })
})
