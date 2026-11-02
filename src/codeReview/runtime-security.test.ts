import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { Message } from '../runtime/RuntimeTypes'
import type { GitStreamSpawner } from './git-adapter'
import type { ReviewHttpRequest } from './platform-adapter'
import type { ReviewModelRequest } from './runner'
import { getOrCreateReviewService } from './runtime'

const mocks = vi.hoisted(() => ({
  vet: vi.fn(), boundary: vi.fn(), gate: vi.fn(), confirm: vi.fn(), model: vi.fn(), runnerContexts: [] as unknown[], edit: vi.fn(),
}))
vi.mock('../engine/turnInterpreter', () => ({ runTurnLoop: vi.fn() }))
vi.mock('../permissions/filesystemPermission', () => ({ vetFileRead: mocks.vet }))
vi.mock('../permissions/untrustedReadBoundary', () => ({ assertUntrustedReadAllowed: mocks.boundary }))
vi.mock('../toolkit/run/toolPermissionGate', () => ({
  buildFilePermissionContext: (context: unknown) => context,
  decideToolPermission: mocks.gate,
  requestQueuedToolUseConfirm: mocks.confirm,
  resolveHeadlessPermissionDecision: async () => ({ behavior: 'deny' }),
}))
vi.mock('../memory/instructionFiles', () => ({ gatherInstructionDocs: async () => [], getNestedInstructionFilesForPath: async () => [], getConditionalRulesForPath: async () => [], formatMemoryFilesForPrompt: () => '' }))
vi.mock('./runner', async importOriginal => {
  const original = await importOriginal<typeof import('./runner')>()
  return { ...original, createReviewModelRunner: (input: { context: unknown }) => {
    mocks.runnerContexts.push(input.context)
    return (request: ReviewModelRequest) => mocks.model(request, input.context)
  } }
})
vi.mock('../toolkit/builtin/superEdit', () => ({ SuperEditTool: { name: 'SuperEdit', call: (...args: unknown[]) => mocks.edit(...args) } }))

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const blob = 'c'.repeat(40)
const root = 'D:/review-fixture'
const clean = (path: string) => path.replace(/\\/g, '/')
const missing = () => Object.assign(new Error('ENOENT: missing'), { name: 'NotFoundError' })

function fixture() {
  const files = new Map<string, string>([[`${root}/a.ts`, 'export const a = 2\n'], [`${root}/b.ts`, 'export const b = 2\n']])
  const writes = vi.fn(async (path: string, data: string | Uint8Array) => { files.set(clean(path), typeof data === 'string' ? data : new TextDecoder().decode(data)) })
  const atomic = vi.fn(async (path: string, content: string) => { JSON.parse(content); files.set(clean(path), content) })
  const fs = {
    realpath: vi.fn(async (path: string) => clean(path)),
    readFile: vi.fn(async (path: string) => { const value = files.get(clean(path)); if (value === undefined) throw missing(); return value }),
    readFileBytes: vi.fn(async (path: string) => { const value = files.get(clean(path)); if (value === undefined) throw missing(); return new TextEncoder().encode(value) }),
    stat: vi.fn(async (path: string) => {
      const directory = [root, `${root}/.git`].includes(clean(path))
      if (!directory && !files.has(clean(path))) throw missing()
      return { size: files.get(clean(path))?.length ?? 0, mtimeMs: 1, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false }
    }),
    readdir: vi.fn(async () => []), mkdir: vi.fn(async () => {}), writeFile: writes,
  } as unknown as RuntimeFs
  const spawn = vi.fn<GitStreamSpawner>(async (spec, handlers) => {
    let output = '', exitCode = 0
    if (spec.args.includes('rev-parse')) output = spec.args.at(-1)?.includes('@{upstream}') ? base : head
    else if (spec.args.includes('rev-list')) output = `${head} ${base}\n`
    else if (spec.args.includes('hash-object')) output = base
    else if (spec.args.includes('symbolic-ref')) exitCode = 1
    else if (spec.args.includes('merge-base')) output = base
    else if (spec.args.includes('ls-tree')) output = `100644 blob ${blob}\ta.ts\0` + `100644 blob ${blob}\tb.ts\0`
    else if (spec.args.includes('ls-files')) output = spec.args.includes('--stage') ? `100644 ${blob} 0\ta.ts\0` + `100644 ${blob} 0\tb.ts\0` : 'a.ts\0b.ts\0'
    else if (spec.args.includes('config') && spec.args.includes('core.filemode')) output = 'false\n'
    else if (spec.args.includes('cat-file')) output = 'export const value = 1\n'
    else if (spec.args.includes('diff')) output = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    else throw new Error(`Unexpected native call: ${spec.args.join(' ')}`)
    handlers.onOutput?.('stdout', new TextEncoder().encode(output))
    handlers.onExit?.({ exitCode, timedOut: false, killed: false, durationMs: 1 })
    return { streamId: 'fixture', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
  })
  const permission = vi.fn(async () => ({ behavior: 'allow' as const }))
  const controller = new AbortController()
  const context = {
    options: { runtimeConfig: {}, projectRoot: root, cwd: root, homeDir: 'D:/review-home', sessionStoragePath: 'D:/review-storage', sessionId: crypto.randomUUID(), mainLoopModel: 'model-first', mainLoopProviderId: 'provider-first', tools: [], fsOperations: fs,
      reviewRuntime: { spawnArgv: spawn, atomicWrite: atomic, promptContextProvider: { gatherSystemPromptSources: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }) } } },
    readAppState: () => ({ permissionRules: { mode: 'default', denyRuleBook: {} } }), cancelSource: controller, fileReadLedger: new Map(), messages: [],
  } as unknown as ToolCallContext
  return { context, permission, fs, files, writes, atomic, spawn }
}

async function invoke(request: ReviewModelRequest, name: string, input: Record<string, unknown>) {
  const tool = request.tools.find(tool => tool.name === name)!
  return tool.call(input, { options: {} } as ToolCallContext, () => ({ behavior: 'allow' }), { uuid: crypto.randomUUID() } as Message)
}

async function report(request: ReviewModelRequest, withCandidates = false) {
  const manifest = JSON.parse(request.blocks.find(block => block.source === 'scope-manifest')!.text)
  const plan = JSON.parse(request.blocks.find(block => block.source === 'resolved-policy')!.text)
  const candidates = withCandidates ? manifest.files.map((file: { path: string; anchors: Array<{ anchorKey: string; side: string; span: { start: number } }> }) => {
    const anchor = file.anchors.find(anchor => anchor.side === 'working-copy')!
    return { location: { anchorKey: anchor.anchorKey, path: file.path, line: anchor.span.start }, statement: { headline: 'Incorrect value', details: `Changed value in ${file.path}`, scenario: 'Caller receives an incorrect value' }, kind: 'correctness', impact: 'major', support: [{ path: file.path, quote: '2', relevance: 'Changed value' }], assessment: { disposition: 'plausible', reason: 'Supported by the changed expression' }, angle: 'lines' }
  }) : []
  if (candidates.length) await invoke(request, 'ReviewLedger', { operation: 'append-candidates', candidates })
  const coverage = { angles: plan.angles, limitations: [], complete: true }
  await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
  return { text: JSON.stringify({ candidates, coverage }), interrupted: false }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.runnerContexts.length = 0
  mocks.gate.mockResolvedValue({ decision: 'ask' })
  mocks.confirm.mockResolvedValue({ behavior: 'deny' })
  mocks.vet.mockResolvedValue({ behavior: 'allow' })
  mocks.boundary.mockResolvedValue({ ok: true })
  mocks.model.mockImplementation(request => report(request))
  mocks.edit.mockImplementation(async (input: { path: string }, context: ToolCallContext) => {
    await context.options.fsOperations!.writeFile(input.path, 'edited')
    return { data: 'edited' }
  })
})

describe('actual review runtime security boundaries', () => {
  it.each(['deny', 'ask'] as const)('blocks native Git and preference writes when repository authorization is %s', async behavior => {
    const h = fixture()
    mocks.vet.mockResolvedValue({ behavior })
    h.permission.mockResolvedValue({ behavior: 'deny' } as never)
    const service = await getOrCreateReviewService(h.context, h.permission)
    await expect(service.startUser('high')).rejects.toThrow('review-read-not-authorized')
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.atomic).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
  })

  it('enforces untrusted read containment before spawning Git', async () => {
    const h = fixture()
    mocks.boundary.mockResolvedValue({ ok: false, reason: 'outside read root' })
    const service = await getOrCreateReviewService(h.context, h.permission)
    await expect(service.startUser('low')).rejects.toThrow('review-read-not-authorized')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('authorizes changed historical paths before sending a range to the model', async () => {
    const h = fixture()
    mocks.vet.mockImplementation(async (_tool, input) => ({ behavior: clean(input.file_path) === `${root}/a.ts` ? 'deny' : 'allow' }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    await expect(service.startUser('high main..HEAD')).rejects.toThrow('review-read-not-authorized')
    expect(h.spawn).toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
    expect(h.atomic).not.toHaveBeenCalled()
  })

  it('uses hardened native argv, preserves literal refs, and atomically persists reports and preferences', async () => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low feature/a;$()&..HEAD')
    expect((await service.wait(runId)).structured).toBe(true)
    expect(h.spawn.mock.calls.some(([spec]) => spec.args.includes('feature/a;$()&^{commit}'))).toBe(true)
    for (const [spec] of h.spawn.mock.calls) {
      expect(spec.file).toBe('git')
      expect(spec.args).toEqual(expect.arrayContaining(['--no-pager', 'core.fsmonitor=false', 'core.hooksPath=/dev/null', 'credential.helper=', 'protocol.allow=never']))
      expect(spec.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_WORK_TREE: root })
      if (spec.args.includes('diff')) expect(spec.args).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--']))
    }
    expect(h.atomic.mock.calls.some(([path]) => path.endsWith(`${runId}.json`))).toBe(true)
    expect(h.atomic.mock.calls.some(([path]) => clean(path).endsWith('code-review/preferences.json'))).toBe(true)
    expect(h.writes).not.toHaveBeenCalled()
  })

  it('refuses to fall back to non-atomic report writes', async () => {
    const h = fixture()
    h.context.options.reviewRuntime!.atomicWrite = undefined
    const service = await getOrCreateReviewService(h.context, h.permission)
    await expect(service.startModel('low')).rejects.toThrow('review-storage-unavailable')
    expect(h.writes).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
  })

  it('uses the current turn permission context rather than the first cached context', async () => {
    const h = fixture()
    await getOrCreateReviewService(h.context, h.permission)
    const current = { ...h.context, options: { ...h.context.options, mainLoopModel: 'model-second', mainLoopProviderId: 'provider-second' }, readAppState: () => ({ permissionRules: { mode: 'plan', denyRuleBook: {} } }) } as unknown as ToolCallContext
    mocks.vet.mockImplementation(async (_tool, _input, permissionContext) => ({ behavior: permissionContext.readAppState().permissionRules.mode === 'plan' ? 'deny' : 'allow' }))
    const service = await getOrCreateReviewService(current, h.permission)
    const attempted = service.startUser('low')
    await attempted.then(({ runId }) => service.wait(runId), () => undefined)
    await expect(attempted).rejects.toThrow('review-read-not-authorized')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('uses the current turn model and provider after service caching', async () => {
    const h = fixture()
    await getOrCreateReviewService(h.context, h.permission)
    const current = { ...h.context, options: { ...h.context.options, mainLoopModel: 'model-second', mainLoopProviderId: 'provider-second' } } as ToolCallContext
    const service = await getOrCreateReviewService(current, h.permission)
    const { runId } = await service.startUser('low')
    await service.wait(runId)
    expect(mocks.model.mock.calls[0]?.[1].options).toMatchObject({ mainLoopModel: 'model-second', mainLoopProviderId: 'provider-second' })
  })

  it('denies an unselected diagnostic path before any actual mutation', async () => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    mocks.model.mockImplementation(request => report(request, true))
    const { runId } = await service.startUser('medium')
    const snapshot = await service.wait(runId)
    expect(snapshot.retainedIds).toHaveLength(2)
    const selected = snapshot.diagnostics.find(diagnostic => diagnostic.anchor.path === 'a.ts')!
    mocks.model.mockImplementation(async request => {
      await invoke(request, 'SuperEdit', { path: `${root}/b.ts` })
      return { text: '', interrupted: false }
    })
    await expect(service.requestRepair(runId, [selected.id])).rejects.toThrow('edit-outside-review-grant')
    expect(h.writes).not.toHaveBeenCalled()
    expect(h.files.get(`${root}/b.ts`)).toBe('export const b = 2\n')
  })

  it('permits a selected path only through the real repair wrapper and records its execution', async () => {
    const h = fixture()
    const service = await getOrCreateReviewService(h.context, h.permission)
    mocks.model.mockImplementation(request => report(request, true))
    const { runId } = await service.startUser('medium')
    const snapshot = await service.wait(runId)
    const selected = snapshot.diagnostics.find(diagnostic => diagnostic.anchor.path === 'a.ts')!
    mocks.model.mockImplementation(async request => {
      const result = await invoke(request, 'SuperEdit', { path: `${root}/a.ts` })
      const receipt = JSON.parse(result.data as string)
      expect(receipt.executionRefs).toHaveLength(1)
      await invoke(request, 'ReviewActionLog', { updates: [{ diagnosticId: selected.id, observation: 'edited', explanation: 'Authorized selected-file edit', executionRefs: receipt.executionRefs }] })
      return { text: '', interrupted: false }
    })
    await service.requestRepair(runId, [selected.id])
    expect(h.writes).toHaveBeenCalledTimes(1)
    expect((await service.store.getSnapshot(runId)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'repair', state: 'applied', diagnosticIds: [selected.id] })]))
  })
})

describe('review runtime refreshed boundaries', () => {
  it.each(['deny', 'ask'] as const)('authorizes an external linked gitdir before spawning (%s)', async behavior => {
    const h = fixture()
    h.files.set(`${root}/.git`, 'gitdir: D:/external/worktrees/linked\n')
    const stat = vi.mocked(h.fs.stat).getMockImplementation()!
    vi.mocked(h.fs.stat).mockImplementation(async path => clean(path) === `${root}/.git` ? { size: 40, mtimeMs: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false, isCharacterDevice: () => false, isBlockDevice: () => false } : stat(path))
    mocks.vet.mockImplementation(async (_tool, input) => ({ behavior: clean(input.file_path) === 'D:/external/worktrees/linked' ? behavior : 'allow' }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    await expect(service.startUser('low')).rejects.toThrow('review-read-not-authorized')
    expect(h.spawn).not.toHaveBeenCalled()
  })
  it('authorizes the resolved commondir separately', async () => {
    const h = fixture()
    h.files.set(`${root}/.git/commondir`, 'D:/external/common')
    mocks.vet.mockImplementation(async (_tool, input) => ({ behavior: clean(input.file_path) === 'D:/external/common' ? 'deny' : 'allow' }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    await expect(service.startUser('low')).rejects.toThrow('review-read-not-authorized')
    expect(h.spawn).not.toHaveBeenCalled()
  })
  it('allows an external commondir only after its approval succeeds', async () => {
    const h = fixture(); h.files.set(`${root}/.git/commondir`, 'D:/external/common')
    mocks.vet.mockImplementation(async (_tool, input) => ({ behavior: clean(input.file_path) === 'D:/external/common' ? 'ask' : 'allow' }))
    mocks.confirm.mockResolvedValue({ behavior: 'allow' })
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low'); await service.wait(runId)
    expect(mocks.confirm).toHaveBeenCalled()
    expect(h.spawn.mock.calls[0][0].env.GIT_COMMON_DIR).toBe('D:/external/common')
  })
  it.each(['./notes..txt', '-- notes..txt', '"notes..txt"', '-- ultra', '-- 123'])('preserves literal path target %s', async target => {
    const h = fixture()
    const path = target.includes('ultra') ? 'ultra' : target.includes('123') ? '123' : 'notes..txt'
    h.files.set(`${root}/${path}`, 'explicit\n')
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser(`low ${target}`)
    const snapshot = await service.wait(runId)
    expect(snapshot.run.scope.kind).toBe('paths'); expect(snapshot.run.scope.pathFilter).toEqual([path])
  })
  it('requires application storage rather than falling back to the reviewed workspace', async () => {
    const h = fixture(); h.context.options.sessionStoragePath = undefined; h.context.options.sessionStorageBase = undefined
    await expect(getOrCreateReviewService(h.context, h.permission)).rejects.toThrow('review-storage-unavailable')
    expect(h.atomic).not.toHaveBeenCalled()
  })
  it('uses the session router base for own reports and shared preferences', async () => {
    const h = fixture(); h.context.options.sessionStorageBase = 'D:/nested-session-base'
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('high'); await service.wait(runId)
    expect(h.atomic.mock.calls.some(([path]) => clean(path) === `D:/nested-session-base/${h.context.options.sessionId}/code-review/${runId}.json`)).toBe(true)
    expect(h.atomic.mock.calls.some(([path]) => clean(path) === 'D:/review-storage/code-review/preferences.json')).toBe(true)
  })
  it('refuses storage directories redirected by a junction', async () => {
    const h = fixture()
    vi.mocked(h.fs.realpath!).mockImplementation(async path => clean(path) === 'D:/review-storage/code-review' ? `${root}/attacker` : clean(path))
    await expect(getOrCreateReviewService(h.context, h.permission)).rejects.toThrow('review-storage-not-authorized')
    expect(h.atomic).not.toHaveBeenCalled()
  })
  it('rechecks a report destination immediately before writing', async () => {
    const h = fixture(); const service = await getOrCreateReviewService(h.context, h.permission)
    vi.mocked(h.fs.realpath!).mockImplementation(async path => clean(path).endsWith('/code-review/preferences.json') ? 'D:/external/secret.json' : clean(path))
    await expect(service.startUser('high')).rejects.toThrow('review-storage-not-authorized')
    expect(h.atomic).not.toHaveBeenCalled()
  })
  it('refreshes Agent availability after caching and blocks a revoked in-flight worker', async () => {
    const h = fixture()
    const agent = { name: 'Agent', offeredNow: () => true, selfVerdict: async () => ({ behavior: 'allow' }) } as unknown as ToolCallContext['options']['tools'][number]
    h.context.options.tools = [agent]
    const service = await getOrCreateReviewService(h.context, h.permission)
    let sawAgent = false
    mocks.model.mockImplementation(async request => {
      sawAgent = request.tools.some((tool: { name: string }) => tool.name === 'Agent')
      h.context.options.tools = []
      await expect(invoke(request, 'Agent', { role: 'finder', angles: ['lines'] })).rejects.toThrow('review-worker-not-authorized')
      return report(request)
    })
    const first = await service.startUser('max'); await service.wait(first.runId)
    expect(sawAgent).toBe(true)
    mocks.model.mockImplementation(async request => { expect(request.tools.some((t: { name: string }) => t.name === 'Agent')).toBe(false); return report(request) })
    const second = await service.startUser('max'); await service.wait(second.runId)
  })
  it.each(['not-offered', 'denied', 'depth'] as const)('recomputes Agent capability for %s', async reason => {
    const h = fixture()
    const agent = { name: 'Agent', offeredNow: () => true } as unknown as ToolCallContext['options']['tools'][number]
    h.context.options.tools = [agent]
    await getOrCreateReviewService(h.context, h.permission)
    if (reason === 'not-offered') agent.offeredNow = () => false
    if (reason === 'denied') h.context.readAppState = (() => ({ permissionRules: { mode: 'default', denyRuleBook: { session: ['Agent'] } } })) as ToolCallContext['readAppState']
    if (reason === 'depth') h.context.turnChain = { chainId: 'nested', depth: 3 }
    const service = await getOrCreateReviewService(h.context, h.permission)
    mocks.model.mockImplementation(async request => { expect(request.tools.some((tool: { name: string }) => tool.name === 'Agent')).toBe(false); return report(request) })
    const { runId } = await service.startUser('max'); await service.wait(runId)
  })
  it('honors the original Agent permission gate at worker admission', async () => {
    const h = fixture()
    const agent = { name: 'Agent', offeredNow: () => true } as unknown as ToolCallContext['options']['tools'][number]
    h.context.options.tools = [agent]
    mocks.gate.mockImplementation(async tool => ({ decision: tool === agent ? 'deny' : 'allow' }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    mocks.model.mockImplementation(async request => {
      await expect(invoke(request, 'Agent', { role: 'finder', angles: ['lines'] })).rejects.toThrow('review-worker-not-authorized')
      return report(request)
    })
    const { runId } = await service.startUser('max'); const result = await service.wait(runId)
    expect(result.run.progress.spawnedTasks).toBe(0)
  })
  it('kills a verification process whose handle arrives after timeout', async () => {
    const h = fixture(); h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { test: 'test-command' } }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low'); await service.wait(runId)
    mocks.gate.mockResolvedValue({ decision: 'allow' })
    let resolveSpawn!: (value: Awaited<ReturnType<GitStreamSpawner>>) => void
    let started!: () => void
    const spawnStarted = new Promise<void>(resolve => { started = resolve })
    const original = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (spec, events) => {
      if (spec.file !== 'npm') return original(spec, events)
      started(); return new Promise(resolve => { resolveSpawn = resolve })
    })
    vi.useFakeTimers()
    try {
      const running = service.requestVerification(runId)
      const rejected = expect(running).rejects.toThrow('verification-timed-out')
      await spawnStarted
      await vi.advanceTimersByTimeAsync(120_001); await rejected
      const kill = vi.fn(async () => true), detach = vi.fn(), closeStdin = vi.fn(async () => true)
      resolveSpawn({ streamId: 'late', kill, detach, closeStdin, write: async () => true })
      await vi.advanceTimersByTimeAsync(0)
      const verification = (await service.store.getSnapshot(runId)).verifications.at(-1)!
      expect(verification.succeeded).toBe(false)
      expect(verification.evidence[0]?.relevance).toContain("timed-out")
      expect(kill).toHaveBeenCalledOnce(); expect(detach).toHaveBeenCalledOnce(); expect(closeStdin).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})

describe('integrated bounded project verification', () => {
  it('discovers npm and Python checks and persists versioned receipts without claiming diagnostic verification', async () => {
    const h = fixture()
    h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }))
    h.files.set(`${root}/pyproject.toml`, '[tool.pytest.ini_options]\naddopts = "-q"')
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low')
    await service.wait(runId)
    mocks.gate.mockResolvedValue({ decision: 'allow' })
    const original = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (spec, events) => {
      if (spec.file === 'git') return original(spec, events)
      events.onOutput?.('stdout', new TextEncoder().encode('completed checks'))
      events.onExit?.({ exitCode: 0, killed: false, timedOut: false, durationMs: 1 })
      return { streamId: 'check', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
    })
    await service.requestVerification(runId)
    expect(h.spawn.mock.calls.filter(([spec]) => spec.file !== 'git').map(([spec]) => [spec.file, spec.args])).toEqual([
      ['npm', ['--ignore-scripts', 'run', 'test']], ['npm', ['--ignore-scripts', 'run', 'typecheck']], ['python', ['-m', 'pytest']],
    ])
    const report = await service.store.getSnapshot(runId)
    expect(report.verifications).toHaveLength(3)
    for (const verification of report.verifications) {
      expect(verification.succeeded).toBe(true)
      expect(verification.diagnosticIds).toEqual([])
      expect(verification.codeRevision).toMatch(/^workspace:/)
      expect(verification.checkedThroughSequence).toBeLessThan(verification.sequence)
      expect(verification.missingCases).toContain('test-to-diagnostic-coverage-not-established')
    }
  })

  it('records blocked verification and never spawns a command after authorization denial', async () => {
    const h = fixture()
    h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { test: 'vitest run' } }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low'); await service.wait(runId)
    await expect(service.requestVerification(runId)).rejects.toThrow('verification-failed')
    expect(h.spawn.mock.calls.every(([spec]) => spec.file === 'git')).toBe(true)
    expect((await service.store.getSnapshot(runId)).verifications[0]).toMatchObject({ succeeded: false, diagnosticIds: [] })
  })
})

describe('publication request routing', () => {
  it.each(['github', 'gitlab'] as const)('keeps two %s requests with identical base/head bound to their own reports', async platform => {
    const h = fixture()
    h.context.options.sessionStoragePath = `D:/routing-${crypto.randomUUID()}`
    const host = platform === 'github' ? 'github.com' : 'gitlab.com'
    const original = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (spec, events) => {
      if (!spec.args.includes('--get-regexp')) return original(spec, events)
      events.onOutput?.('stdout', new TextEncoder().encode(`remote.origin.url https://${host}/owner/repo.git\n`))
      events.onExit?.({ exitCode: 0, timedOut: false, killed: false, durationMs: 1 })
      return { streamId: 'remote', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
    })
    const http = vi.fn<ReviewHttpRequest>(async request => {
      const number = Number(request.url.match(/\/(?:pulls|merge_requests)\/(\d+)/)?.[1])
      let body: unknown
      if (request.method === 'POST') body = { id: number + 1000 }
      else if (request.url.includes('/compare/')) body = { merge_base_commit: { sha: base } }
      else if (request.headers?.Accept === 'application/vnd.github.diff') body = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n'
      else if (request.url.endsWith('/changes')) body = { overflow: false, changes: [{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n' }] }
      else body = platform === 'github'
        ? { number, changed_files: 1, base: { sha: base, repo: { html_url: 'https://github.com/owner/repo' } }, head: { sha: head } }
        : { iid: number, web_url: `https://gitlab.com/owner/repo/-/merge_requests/${number}`, diff_refs: { base_sha: base, head_sha: head, start_sha: base } }
      return { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)) }
    })
    h.context.options.reviewRuntime!.httpRequest = http
    h.context.options.reviewRuntime!.platformSecret = async origin => ({ origin, name: 'provider:review-token' })
    mocks.gate.mockResolvedValue({ decision: 'allow' })
    mocks.model.mockImplementation(async request => {
      const manifest = JSON.parse(request.blocks.find((b: { source: string }) => b.source === 'scope-manifest')!.text)
      const plan = JSON.parse(request.blocks.find((b: { source: string }) => b.source === 'resolved-policy')!.text)
      const anchor = manifest.files[0].anchors.find((a: { side: string }) => a.side === 'after')
      const candidates = [{ location: { anchorKey: anchor.anchorKey, path: 'a.ts', line: 1 }, statement: { headline: 'Incorrect value', details: 'Changed value returned to caller', scenario: 'Caller receives an incorrect value' }, kind: 'correctness', impact: 'major', support: [{ path: 'a.ts', quote: '2', relevance: 'Changed expression' }], assessment: { disposition: 'plausible', reason: 'Supported by diff' }, angle: 'lines' }]
      await invoke(request, 'ReviewLedger', { operation: 'append-candidates', candidates })
      const coverage = { angles: plan.angles, limitations: [], complete: true }
      await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
      return { text: JSON.stringify({ candidates, coverage }), interrupted: false }
    })
    const service = await getOrCreateReviewService(h.context, h.permission)
    const first = await service.startUser('low 11'); const firstReport = await service.wait(first.runId)
    const second = await service.startUser('low 22'); const secondReport = await service.wait(second.runId)
    expect(firstReport.retainedIds).toHaveLength(1); expect(secondReport.retainedIds).toHaveLength(1)
    expect(firstReport.run.scope.revision).toEqual(secondReport.run.scope.revision)
    await service.requestPublication(first.runId)
    await service.requestPublication(second.runId)
    const posts = http.mock.calls.filter(([request]) => request.method === 'POST').map(([request]) => request)
    const prefix = platform === 'github' ? 'https://api.github.com/repos/owner/repo/pulls/' : 'https://gitlab.com/api/v4/projects/owner%2Frepo/merge_requests/'
    const suffix = platform === 'github' ? '/comments' : '/notes'
    expect(posts.map(request => request.url)).toEqual([`${prefix}11${suffix}`, `${prefix}22${suffix}`])
    if (platform === 'github') for (const post of posts) expect(JSON.parse(new TextDecoder().decode(post.body))).toMatchObject({ commit_id: head, path: 'a.ts', line: 1, side: 'RIGHT' })
    expect((await service.store.getSnapshot(first.runId)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'publication', state: 'succeeded', externalRef: '1011' })]))
    expect((await service.store.getSnapshot(second.runId)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'publication', state: 'succeeded', externalRef: '1022' })]))
  })
})


it.each([false, true])('preserves actual edit evidence when reconciliation is absent, adapter failure=%s', async failAfterWrite => {
  const h = fixture()
  const service = await getOrCreateReviewService(h.context, h.permission)
  mocks.model.mockImplementation(request => report(request, true))
  const { runId } = await service.startUser('medium')
  const snapshot = await service.wait(runId)
  const selected = snapshot.diagnostics.find(diagnostic => diagnostic.anchor.path === 'a.ts')!
  if (failAfterWrite) mocks.edit.mockImplementation(async (input: { path: string }, context: ToolCallContext) => {
    await context.options.fsOperations!.writeFile(input.path, 'edited')
    throw new Error('later-operation-failed')
  })
  mocks.model.mockImplementation(async request => {
    await invoke(request, 'SuperEdit', { path: `${root}/a.ts` })
    return { text: 'Done', interrupted: false }
  })
  const repair = service.requestRepair(runId, [selected.id])
  if (failAfterWrite) await expect(repair).rejects.toThrow('later-operation-failed')
  else await repair
  const after = await service.store.getSnapshot(runId)
  expect(after.actions.filter(action => action.diagnosticIds.includes(selected.id)).at(-1)).toMatchObject({ kind: 'repair', state: 'applied', verification: 'not-run' })
})


it('locates a retained working-copy finding only while its snapshot still matches', async () => {
  const { getReviewSession } = await import('./review-channel')
  const h = fixture()
  const service = await getOrCreateReviewService(h.context, h.permission)
  mocks.model.mockImplementation(request => report(request, true))
  const { runId } = await service.startUser('low ./a.ts')
  const snapshot = await service.wait(runId)
  const diagnostic = snapshot.diagnostics[0]
  expect(diagnostic).toBeDefined()
  const facade = getReviewSession(h.context.options.sessionId)!
  const location = await facade.locate!(runId, diagnostic.id)
  expect({ ...location, path: clean(location.path) }).toEqual({ path: root + '/a.ts', line: 1 })
  h.files.set(root + '/a.ts', 'new concurrent content')
  await expect(facade.locate!(runId, diagnostic.id)).rejects.toThrow('snapshot-changed')
})
