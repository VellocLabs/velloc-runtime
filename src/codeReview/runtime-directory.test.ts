import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { Message } from '../runtime/RuntimeTypes'
import type { GitStreamSpawner } from './git-adapter'
import type { ReviewModelRequest } from './runner'
import { getOrCreateReviewService } from './runtime'

const mocks = vi.hoisted(() => ({ gate: vi.fn(), model: vi.fn() }))
vi.mock('../engine/turnInterpreter', () => ({ runTurnLoop: vi.fn() }))
vi.mock('../permissions/filesystemPermission', () => ({ vetFileRead: async () => ({ behavior: 'allow' }) }))
vi.mock('../permissions/untrustedReadBoundary', () => ({ assertUntrustedReadAllowed: async () => ({ ok: true }) }))
vi.mock('../toolkit/run/toolPermissionGate', () => ({
  buildFilePermissionContext: (context: unknown) => context,
  decideToolPermission: mocks.gate,
  requestQueuedToolUseConfirm: async () => ({ behavior: 'deny' }),
  resolveHeadlessPermissionDecision: async () => ({ behavior: 'deny' }),
}))
vi.mock('../memory/instructionFiles', () => ({ gatherInstructionDocs: async () => [], getNestedInstructionFilesForPath: async () => [], getConditionalRulesForPath: async () => [], formatMemoryFilesForPrompt: () => '' }))
vi.mock('./runner', async importOriginal => {
  const original = await importOriginal<typeof import('./runner')>()
  return { ...original, createReviewModelRunner: () => (request: ReviewModelRequest) => mocks.model(request) }
})

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const blob = 'c'.repeat(40)
const root = 'D:/review-fixture'
const nested = `${root}/nested`
const clean = (path: string) => path.replace(/\\/g, '/')
const missing = () => Object.assign(new Error('ENOENT: missing'), { name: 'NotFoundError' })

function fixture() {
  const files = new Map<string, string>([[`${root}/a.ts`, 'export const a = 2\n'], [`${nested}/a.ts`, 'export const a = 3\n']])
  const directories = new Set([root, `${root}/.git`, nested, `${nested}/.git`, `${root}/plain`, 'D:/outside', 'D:/outside/.git'])
  const links = new Map([[`${root}/escape`, 'D:/outside']])
  const atomic = vi.fn(async (path: string, content: string) => { files.set(clean(path), content) })
  const fs = {
    realpath: vi.fn(async (path: string) => {
      const value = links.get(clean(path)) ?? clean(path)
      if (!directories.has(value) && !files.has(value) && !value.startsWith('D:/review-storage')) throw missing()
      return value
    }),
    readFile: vi.fn(async (path: string) => { const value = files.get(clean(path)); if (value === undefined) throw missing(); return value }),
    readFileBytes: vi.fn(async (path: string) => { const value = files.get(clean(path)); if (value === undefined) throw missing(); return new TextEncoder().encode(value) }),
    stat: vi.fn(async (path: string) => {
      const directory = directories.has(clean(path))
      if (!directory && !files.has(clean(path))) throw missing()
      return { size: files.get(clean(path))?.length ?? 0, mtimeMs: 1, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false }
    }),
    readdir: vi.fn(async () => []), mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}),
  } as unknown as RuntimeFs
  const spawn = vi.fn<GitStreamSpawner>(async (spec, handlers) => {
    let output = '', exitCode = 0
    if (spec.args.includes('rev-parse')) output = spec.args.at(-1)?.includes('@{upstream}') ? base : head
    else if (spec.args.includes('rev-list')) output = `${head} ${base}\n`
    else if (spec.args.includes('hash-object')) output = base
    else if (spec.args.includes('symbolic-ref')) exitCode = 1
    else if (spec.args.includes('merge-base')) output = base
    else if (spec.args.includes('ls-tree')) output = `100644 blob ${blob}\ta.ts\0`
    else if (spec.args.includes('ls-files')) output = spec.args.includes('--stage') ? `100644 ${blob} 0\ta.ts\0` : 'a.ts\0'
    else if (spec.args.includes('config') && spec.args.includes('core.filemode')) output = 'false\n'
    else if (spec.args.includes('cat-file')) output = 'export const a = 1\n'
    else if (spec.args.includes('diff')) output = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    else throw new Error(`Unexpected native call: ${spec.args.join(' ')}`)
    handlers.onOutput?.('stdout', new TextEncoder().encode(output))
    handlers.onExit?.({ exitCode, timedOut: false, killed: false, durationMs: 1 })
    return { streamId: 'fixture', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
  })
  const context = {
    options: { runtimeConfig: {}, projectRoot: root, cwd: root, homeDir: 'D:/review-home', sessionStoragePath: 'D:/review-storage', sessionId: crypto.randomUUID(), mainLoopModel: 'model', mainLoopProviderId: 'provider', tools: [], fsOperations: fs,
      reviewRuntime: { spawnArgv: spawn, atomicWrite: atomic, promptContextProvider: { gatherSystemPromptSources: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }) } } },
    readAppState: () => ({ permissionRules: { mode: 'default', denyRuleBook: {} } }), cancelSource: new AbortController(), fileReadLedger: new Map(), messages: [],
  } as unknown as ToolCallContext
  const permission = vi.fn(async () => ({ behavior: 'allow' as const }))
  return { context, permission, files, spawn }
}

async function report(request: ReviewModelRequest) {
  const plan = JSON.parse(request.blocks.find(block => block.source === 'resolved-policy')!.text)
  const coverage = { angles: plan.angles, limitations: [], complete: true }
  const ledger = request.tools.find(tool => tool.name === 'ReviewLedger')!
  await ledger.call({ operation: 'coverage', coverage }, { options: {} } as ToolCallContext, () => ({ behavior: 'allow' }), { uuid: crypto.randomUUID() } as Message)
  return { text: JSON.stringify({ candidates: [], coverage }), interrupted: false }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.gate.mockResolvedValue({ decision: 'allow' })
  mocks.model.mockImplementation(report)
})

describe('code review -C <dir>', () => {
  it('reviews the repository in the named folder and records the folder for the run', async () => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    const snapshot = await service.wait((await service.startUser('low -C nested main..topic')).runId)
    expect(snapshot.run.scope).toMatchObject({ kind: 'range', workspaceKey: nested })
    const cwds = new Set(h.spawn.mock.calls.map(([spec]) => clean(spec.cwd)))
    expect(cwds).toEqual(new Set([nested]))
    const stored = [...h.files].find(([path]) => path.endsWith(`targets/${snapshot.run.id}.json`))
    expect(JSON.parse(stored![1])).toEqual({ target: 'main..topic', directory: 'nested' })
  })

  it('reviews the session root without -C, and both roots side by side in one session', async () => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    const first = await service.wait((await service.startUser('low')).runId)
    const second = await service.wait((await service.startUser('low -C nested')).runId)
    expect(first.run.scope.workspaceKey).toBe(root)
    expect(second.run.scope.workspaceKey).toBe(nested)
    expect(h.spawn.mock.calls.some(([spec]) => clean(spec.cwd) === root)).toBe(true)
    expect(h.spawn.mock.calls.some(([spec]) => clean(spec.cwd) === nested)).toBe(true)
  })

  it.each([
    ['a parent folder', '../outside'],
    ['an absolute path', 'D:/outside'],
    ['a link that resolves outside the session root', 'escape'],
    ['a missing folder', 'gone'],
    ['a folder without a repository', 'plain'],
  ])('refuses %s before running git', async (_label, directory) => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    const outcome = await service.startUser(`low -C "${directory}"`).then(({ runId }) => service.wait(runId)).then(() => 'ran', error => String(error))
    expect(outcome).toContain('invalid-root')
    expect(h.spawn).not.toHaveBeenCalled()
  })
})
