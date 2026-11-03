import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { Message } from '../runtime/RuntimeTypes'
import type { GitStreamSpawner } from './git-adapter'
import type { ReviewHttpRequest } from './platform-adapter'
import type { ReviewModelRequest } from './runner'
import { getOrCreateReviewService } from './runtime'

const mocks = vi.hoisted(() => ({
  formatGuidance: vi.fn(), guidance: vi.fn(), nestedGuidance: vi.fn(), vet: vi.fn(), boundary: vi.fn(), gate: vi.fn(), confirm: vi.fn(), model: vi.fn(), runnerContexts: [] as unknown[], edit: vi.fn(),
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
vi.mock('../memory/instructionFiles', () => ({ gatherInstructionDocs: mocks.guidance, getNestedInstructionFilesForPath: mocks.nestedGuidance, getConditionalRulesForPath: async () => [], formatMemoryFilesForPrompt: mocks.formatGuidance }))
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
  mocks.formatGuidance.mockReturnValue('')
  mocks.guidance.mockResolvedValue([])
  mocks.nestedGuidance.mockResolvedValue([])
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

describe('review execution admission', () => {
  it('creates the guarded report directory before native restoration reads', async () => {
    const h = fixture()
    let created = false
    const reportDir = `D:/review-storage/${h.context.options.sessionId}/code-review`
    vi.mocked(h.fs.mkdir).mockImplementation(async path => { if (clean(path) === reportDir) created = true })
    vi.mocked(h.fs.readdir).mockImplementation(async path => {
      if (clean(path) === reportDir && !created) throw new Error('FS_ERROR: Path is not a directory')
      return []
    })
    const service = await getOrCreateReviewService(h.context, h.permission)
    expect(created).toBe(true)
    const { runId } = await service.startUser('low')
    expect((await service.wait(runId)).run.progress.status).toBe('finished')
  })

  it('retries transient initialization failure for a live owner without caching a disposed service', async () => {
    const { getReviewSession } = await import('./review-channel')
    const h = fixture()
    const owner = new AbortController()
    h.context.options.runtimeScopeSignal = owner.signal
    vi.mocked(h.fs.readdir).mockRejectedValueOnce(new Error('transient-storage-unavailable'))
    await expect(getOrCreateReviewService(h.context, h.permission)).rejects.toThrow('transient-storage-unavailable')
    expect(getReviewSession(h.context.options.sessionId)).toBeUndefined()
    const [service, same] = await Promise.all([
      getOrCreateReviewService(h.context, h.permission), getOrCreateReviewService(h.context, h.permission),
    ])
    expect(same).toBe(service)
    expect(h.fs.readdir).toHaveBeenCalledTimes(2)
    expect(getReviewSession(h.context.options.sessionId)).toBeDefined()
    const { runId } = await service.startUser('low')
    expect((await service.wait(runId)).run.progress.status).toBe('finished')
    owner.abort()
  })

  it('does not reinitialize a cache whose owner aborted during initialization', async () => {
    const { getReviewSession } = await import('./review-channel')
    const h = fixture()
    const owner = new AbortController()
    h.context.options.runtimeScopeSignal = owner.signal
    vi.mocked(h.fs.readdir).mockImplementationOnce(async () => { owner.abort(); throw new Error('transient-storage-unavailable') })
    await expect(getOrCreateReviewService(h.context, h.permission)).rejects.toThrow('transient-storage-unavailable')
    const service = await getOrCreateReviewService(h.context, h.permission)
    await expect(service.startUser('low')).rejects.toThrow('review-cancelled')
    expect(h.fs.readdir).toHaveBeenCalledTimes(1)
    expect(getReviewSession(h.context.options.sessionId)).toBeUndefined()
  })

  it.each(['test', 'typecheck', 'dev', 'instructions', 'denied-read', 'denied-execution', 'denied-startup'])('rejects %s inputs changed during the last validation read approval', async scenario => {
    const name = scenario === 'denied-startup' ? 'dev' : ['instructions', 'denied-read', 'denied-execution'].includes(scenario) ? 'test' : scenario
    const h = fixture()
    h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { [name]: name === 'dev' ? 'vite' : 'vitest run' } }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low')
    await service.wait(runId)
    let approved = false, packageReads = 0, changed = false
    const originalRead = vi.mocked(h.fs.readFileBytes).getMockImplementation()!
    vi.mocked(h.fs.readFileBytes).mockImplementation(async (...args) => {
      const result = await originalRead(...args)
      if (approved && clean(args[0]) === `${root}/package.json`) packageReads++
      return result
    })
    mocks.vet.mockImplementation(async (_tool, input) => ({ behavior: scenario === 'denied-read' && changed && clean(input.file_path) === `${root}/package.json` ? 'deny' : clean(input.file_path) === `${root}/go.mod` ? 'ask' : 'allow' }))
    mocks.confirm.mockImplementation(async request => {
      if (approved && packageReads >= 2 && request.tool.name === 'Read' && clean(request.input.file_path) === `${root}/go.mod`) {
        changed = true
        if (scenario === 'denied-read' || scenario === 'denied-execution' || scenario === 'denied-startup') return { behavior: 'allow' }
        if (scenario === 'instructions') mocks.guidance.mockResolvedValue([{ path: `${root}/AGENTS.md`, type: 'Project', content: 'Changed execution instructions' }])
        else h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { [name]: 'node unapproved-script.js' } }))
      }
      if (request.tool.name === 'ReviewVerification') approved = true
      return { behavior: 'allow' }
    })
    const originalGate = mocks.gate.getMockImplementation()!
    mocks.gate.mockImplementation(async (...args) => (scenario === 'denied-execution' || scenario === 'denied-startup') && changed && args[0].name === 'ReviewVerification'
      ? { decision: 'deny' } : originalGate(...args))
    const originalSpawn = h.spawn.getMockImplementation()!
    const executed: string[] = []
    h.spawn.mockImplementation(async (spec, events) => {
      if (spec.file === 'git') return originalSpawn(spec, name === 'dev' ? { ...events, onOutput: (stream, bytes) => events.onOutput?.(stream, new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll('a.ts', 'app.tsx'))) } : events)
      executed.push(JSON.parse(h.files.get(`${root}/package.json`)!).scripts[name])
      if (name !== 'dev') events.onExit?.({ exitCode: 0, killed: false, timedOut: false, durationMs: 1 })
      return { streamId: 'observed', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
    })
    mocks.model.mockResolvedValue({ text: '{}', interrupted: false })
    if (name === 'dev') {
      h.files.set(`${root}/app.tsx`, 'new\n')
      mocks.formatGuidance.mockReturnValue('npm run dev at http://localhost:3000/')
      mocks.model.mockImplementation(async request => {
        const tool = request.tools.find((tool: { name: string }) => tool.name === 'ReviewStartDevelopment')!
        await tool.call({}, { cancelSource: new AbortController() } as ToolCallContext, h.permission, {} as Message)
        return { text: '{}', interrupted: false }
      })
    }
    await service.requestVerification(runId).catch(() => {})
    expect(changed).toBe(true)
    expect(executed).toEqual([])
    expect(mocks.confirm.mock.calls.filter(([request]) => request.tool.name === 'ReviewVerification')).toHaveLength(1)
  })

  it.each(['test', 'typecheck'])('rejects changed %s scripts after approval and requires fresh approval', async name => {
    const h = fixture()
    const manifest = (script: string) => JSON.stringify({ scripts: { [name]: script } })
    h.files.set(`${root}/package.json`, manifest('vitest run'))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low')
    await service.wait(runId)
    const original = h.spawn.getMockImplementation()!
    const scripts: string[] = []
    h.spawn.mockImplementation(async (spec, events) => {
      if (spec.file === 'git') return original(spec, events)
      scripts.push(JSON.parse(h.files.get(`${root}/package.json`)!).scripts[name])
      events.onExit?.({ exitCode: 0, killed: false, timedOut: false, durationMs: 1 })
      return { streamId: 'check', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
    })
    mocks.model.mockResolvedValue({ text: '{}', interrupted: false })
    mocks.confirm.mockImplementation(async () => {
      h.files.set(`${root}/package.json`, manifest('node unapproved-script.js'))
      return { behavior: 'allow' }
    })
    await service.requestVerification(runId).catch(() => {})
    expect(scripts).toEqual([])
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ script: 'vitest run' }) }))
    mocks.confirm.mockResolvedValue({ behavior: 'allow' })
    await service.requestVerification(runId).catch(() => {})
    expect(scripts).toEqual(['node unapproved-script.js'])
    expect(mocks.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ input: expect.objectContaining({ script: 'node unapproved-script.js' }) }))
  })

  it.each(['manifest', 'instructions'])('rechecks %s at spawn admission after approval capture', async changed => {
    const h = fixture()
    h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { test: 'vitest run' } }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low')
    await service.wait(runId)
    const original = vi.mocked(h.fs.readFileBytes).getMockImplementation()!
    let approved = false
    mocks.confirm.mockImplementation(async () => { approved = true; return { behavior: 'allow' } })
    vi.mocked(h.fs.readFileBytes).mockImplementation(async (...args) => {
      const result = await original(...args)
      if (approved && clean(args[0]) === `${root}/a.ts`) {
        approved = false
        if (changed === 'manifest') h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { test: 'node unapproved-script.js' } }))
        else mocks.guidance.mockResolvedValue([{ path: `${root}/AGENTS.md`, type: 'Project', content: 'Changed verification instructions' }])
      }
      return result
    })
    mocks.model.mockResolvedValue({ text: '{}', interrupted: false })
    await service.requestVerification(runId).catch(() => {})
    expect(h.spawn.mock.calls.every(([spec]) => spec.file === 'git')).toBe(true)
  })

  it.each(['manifest-approval', 'instructions-approval', 'manifest-admission'])('rejects changed startup inputs: %s', async changed => {
    const h = fixture()
    h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { dev: 'vite' } }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low')
    await service.wait(runId)
    mocks.formatGuidance.mockReturnValue('npm run dev at http://localhost:3000/')
    const original = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (spec, events) => {
      return original(spec, { ...events, onOutput: (stream, bytes) => events.onOutput?.(stream, new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll('a.ts', 'app.tsx'))) })
    })
    h.files.set(`${root}/app.tsx`, 'new\n')
    let approved = false
    const assertGrant = service.store.assertActionAuthorized.bind(service.store)
    vi.spyOn(service.store, 'assertActionAuthorized').mockImplementation(async (...args) => {
      const grant = await assertGrant(...args)
      if (approved && changed === 'manifest-admission') h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { dev: 'node unapproved-script.js' } }))
      return grant
    })
    mocks.confirm.mockImplementation(async request => {
      if (request.input.command?.purpose === 'startup') {
        approved = true
        if (changed === 'manifest-approval') h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { dev: 'node unapproved-script.js' } }))
        else if (changed === 'instructions-approval') mocks.formatGuidance.mockReturnValue('Changed startup instructions')
      }
      return { behavior: 'allow' }
    })
    let attempted = false
    mocks.model.mockImplementation(async request => {
      const tool = request.tools.find((tool: { name: string }) => tool.name === 'ReviewStartDevelopment')
      expect(tool).toBeDefined()
      attempted = true
      await expect(tool.call({}, { cancelSource: new AbortController() } as ToolCallContext, h.permission, {} as Message)).rejects.toThrow('snapshot-changed')
      return { text: '{}', interrupted: false }
    })
    await service.requestVerification(runId).catch(() => {})
    expect(attempted).toBe(true)
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ command: expect.objectContaining({ purpose: 'startup', script: 'vite' }) }) }))
    expect(h.spawn.mock.calls.every(([spec]) => spec.file === 'git')).toBe(true)
  })

  it.each(['start', 'cold-repair', 'cold-verify', 'cold-publish'])('closes pending scope preparation on owner disposal: %s', async action => {
    const h = fixture()
    const owner = new AbortController()
    h.context.options.runtimeScopeSignal = owner.signal
    let service = await getOrCreateReviewService(h.context, h.permission)
    let runId = ''
    if (action !== 'start') {
      runId = (await service.startUser('low')).runId
      await service.wait(runId)
      const cold = { ...h.context, options: { ...h.context.options, runtimeConfig: {} } } as ToolCallContext
      service = await getOrCreateReviewService(cold, h.permission)
      await service.restore([runId])
    }
    let resume!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    mocks.guidance.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { resume = resolve }); return [] })
    mocks.model.mockClear()
    const pending = action === 'start' ? service.startUser('low') : action === 'cold-repair' ? service.requestRepair(runId, []) : action === 'cold-verify' ? service.requestVerification(runId) : service.requestPublication(runId)
    const result = pending.then(value => ({ value }), error => ({ error }))
    await started
    owner.abort()
    resume()
    expect(await result).toMatchObject({ error: expect.objectContaining({ message: 'review-cancelled' }) })
    expect(mocks.model).not.toHaveBeenCalled()
    await expect(service.startUser('low')).rejects.toThrow('review-cancelled')
    await expect(service.startModel('low')).rejects.toThrow('review-cancelled')
    await expect(service.rerun(runId)).rejects.toThrow('review-cancelled')
    await expect(service.requestVerification(runId)).rejects.toThrow('review-cancelled')
    await expect(service.requestRepair(runId, [])).rejects.toThrow('review-cancelled')
    await expect(service.requestPublication(runId)).rejects.toThrow('review-cancelled')
  })

  it.each(['already-aborted', 'during-init'])('does not initialize an ownerless service: %s', async timing => {
    const h = fixture()
    const owner = new AbortController()
    h.context.options.runtimeScopeSignal = owner.signal
    if (timing === 'already-aborted') owner.abort()
    else vi.mocked(h.fs.realpath!).mockImplementationOnce(async path => { owner.abort(); return clean(path) })
    await expect(getOrCreateReviewService(h.context, h.permission)).rejects.toThrow('review-cancelled')
    expect(h.spawn).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
    expect(h.atomic).not.toHaveBeenCalled()
  })
})

describe('actual review runtime security boundaries', () => {
  it.each([true, false])('requires host approval before project guidance selects max: %s', async approved => {
    const h = fixture()
    mocks.guidance.mockResolvedValue([{ path: `${root}/AGENTS.md`, type: 'Project', content: 'Review effort: max' }])
    mocks.confirm.mockResolvedValue({ behavior: approved ? 'allow' : 'deny' })
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startModel('max')
    expect((await service.wait(runId)).run.policy.level).toBe(approved ? 'max' : 'medium')
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ path: `${root}/AGENTS.md`, level: 'max', workspace: root }) }))
    expect(h.atomic.mock.calls.some(([path]) => path.endsWith('/preferences.json'))).toBe(false)
  })
  it('does not accept automatic memory as an effort authorization source', async () => {
    const h = fixture()
    mocks.guidance.mockResolvedValue([{ path: `${root}/memory.md`, type: 'AutoMem', content: 'Review effort: max' }])
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startModel('max')
    expect((await service.wait(runId)).run.policy.level).toBe('medium')
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
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

  it('asks for review-effort approval once when a quick review widens to a tests-only change', async () => {
    const h = fixture()
    const testPath = 'src/__tests__/a.test.ts'
    h.files.set(`${root}/${testPath}`, 'export const a = 2\n')
    const original = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (spec, handlers) => original(spec, { ...handlers,
      onOutput: (stream, bytes) => handlers.onOutput?.(stream, new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll('a.ts', testPath))) }))
    mocks.guidance.mockResolvedValue([{ path: `${root}/AGENTS.md`, type: 'Project', content: 'Review effort: low' }])
    mocks.confirm.mockResolvedValueOnce({ behavior: 'allow' }).mockResolvedValue({ behavior: 'deny' })
    let manifest: { files: Array<{ path: string; status: string }> } | undefined
    mocks.model.mockImplementation(async request => {
      manifest = JSON.parse(request.blocks.find((block: { source: string }) => block.source === 'scope-manifest')!.text)
      return report(request)
    })
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low main..HEAD')
    await service.wait(runId)
    expect(mocks.confirm.mock.calls.filter(([request]) => request.tool.name === 'ReviewGuidance')).toHaveLength(1)
    expect(manifest?.files).toEqual([expect.objectContaining({ path: testPath, status: 'included' })])
  })

  it('skips binary blobs in a range review search instead of failing the search', async () => {
    const h = fixture()
    const original = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (spec, handlers) => {
      if (!spec.args.includes('cat-file')) return original(spec, handlers)
      handlers.onOutput?.('stdout', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]))
      handlers.onExit?.({ exitCode: 0, timedOut: false, killed: false, durationMs: 1 })
      return { streamId: 'blob', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
    })
    let searched: unknown, context: unknown
    mocks.model.mockImplementation(async request => {
      searched = await invoke(request, 'ReviewRead', { operation: 'search', query: 'export' })
      context = await invoke(request, 'ReviewRead', { operation: 'context', path: 'a.ts' }).catch(error => error)
      return report(request)
    })
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('high main..HEAD')
    await service.wait(runId)
    expect(searched).toEqual({ data: { matches: [], truncated: false } })
    expect(context).toMatchObject({ code: 'review-context-unavailable' })
  })

  it('reads working-copy context fresh and serves several patches, by current or pre-rename path, in one diff call', async () => {
    const h = fixture()
    let first: unknown, second: unknown, batch: unknown
    mocks.model.mockImplementation(async request => {
      first = await invoke(request, 'ReviewRead', { operation: 'context', path: 'a.ts' })
      h.files.set(`${root}/a.ts`, 'export const a = 99\n')
      second = await invoke(request, 'ReviewRead', { operation: 'context', path: 'a.ts' })
      batch = await invoke(request, 'ReviewRead', { operation: 'diff', paths: ['a.ts'] })
      return report(request)
    })
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('high')
    await service.wait(runId)
    expect(String((second as { data: unknown }).data)).toContain('99')
    expect((second as { data: unknown }).data).not.toEqual((first as { data: unknown }).data)
    expect((batch as { data: { files: Array<{ path: string }> } }).data.files.map(file => file.path)).toEqual(['a.ts'])
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
    expect(report.verifications).toHaveLength(4)
    expect(report.verifications.at(-1)).toMatchObject({ succeeded: false, missingCases: expect.arrayContaining(['main-path-not-verified', 'boundary-not-verified']) })
    for (const verification of report.verifications.slice(0, 3)) {
      expect(verification.succeeded).toBe(true)
      expect(verification.diagnosticIds).toEqual([])
      expect(verification.codeRevision).toMatch(/^workspace:/)
      expect(verification.checkedThroughSequence).toBeLessThan(verification.sequence)
      expect(verification.missingCases).toContain('test-to-diagnostic-coverage-not-established')
    }
  })

  it('records main-path and boundary coverage only from executed command observations', async () => {
    const h = fixture()
    h.files.set(`${root}/package.json`, JSON.stringify({ scripts: { test: 'vitest run' } }))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low')
    await service.wait(runId)
    mocks.gate.mockResolvedValue({ decision: 'allow' })
    const original = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (spec, events) => {
      if (spec.file === 'git') return original(spec, events)
      events.onOutput?.('stdout', new TextEncoder().encode('PASS normal input; PASS empty input rejected'))
      events.onExit?.({ exitCode: 0, killed: false, timedOut: false, durationMs: 1 })
      return { streamId: 'check', write: async () => true, closeStdin: async () => true, kill: async () => true, detach() {} }
    })
    mocks.model.mockImplementation(async request => {
      const summary = JSON.parse(request.blocks.find((block: { source: string }) => block.source === 'repair-and-validation-summary')!.text)
      const ref = summary.executions[0].ref
      await invoke(request, 'ReviewBehaviorCheck', { type: 'main-path', description: 'Normal input', evidence: [{ ref, quote: 'PASS normal input' }] })
      await invoke(request, 'ReviewBehaviorCheck', { type: 'boundary', description: 'Empty input', evidence: [{ ref, quote: 'PASS empty input rejected' }] })
      return { interrupted: false, text: '' }
    })
    await service.requestVerification(runId)
    const result = await service.store.getSnapshot(runId)
    expect(result.verifications.at(-1)).toMatchObject({ succeeded: true, missingCases: [] })
    expect(result.verifications.some(item => item.command?.includes('Normal input'))).toBe(true)
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

describe('ordinary workspace edit reassessment', () => {
  it('reassesses current evidence and updates the saved finding without a repair grant', async () => {
    const h = fixture()
    mocks.model.mockImplementation(request => report(request, true))
    const service = await getOrCreateReviewService(h.context, h.permission)
    const { runId } = await service.startUser('low')
    await service.wait(runId)
    mocks.model.mockImplementation(async request => {
      const material = JSON.parse(request.blocks.find((block: { source: string }) => block.source === 'reassessment-evidence')!.text)
      return { interrupted: false, text: JSON.stringify({ updates: material.diagnostics.map((d: { id: string }) => ({ diagnosticId: d.id, outcome: 'resolved', explanation: 'The expression now restores the required value.', mutationRefs: [material.mutations[0].ref], evidence: [{ path: 'a.ts', quote: 'export const a = 1', relevance: 'The original value contract is restored.' }] })) }) }
    })
    const { captureWorkspaceMutation, observeWorkspaceMutation } = await import('./mutation-observer')
    const before = await captureWorkspaceMutation(h.context, [`${root}/a.ts`])
    h.files.set(`${root}/a.ts`, 'export const a = 1\n')
    await observeWorkspaceMutation(h.context, 'write', before)
    await vi.waitFor(async () => expect((await service.store.getSnapshot(runId)).actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'repair', state: 'applied', verification: 'not-run' })])))
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
    if (platform === 'github') {
      const repeated = await service.startUser('low 11'); await service.wait(repeated.runId)
      await service.requestPublication(repeated.runId)
      expect(http.mock.calls.filter(([request]) => request.method === 'POST' && request.url.includes('/11/'))).toHaveLength(1)
      expect((await service.store.getSnapshot(repeated.runId)).actions.at(-1)).toMatchObject({ state: 'succeeded', externalRef: '1011' })
    }
    const third = await service.startUser('low 33'); await service.wait(third.runId)
    const originalHttp = http.getMockImplementation()!
    let uncertainPost: Record<string, unknown> | undefined
    http.mockImplementation(async (request, options) => {
      if (request.method === 'POST' && request.url.includes('/33/')) {
        uncertainPost = JSON.parse(new TextDecoder().decode(request.body))
        throw new Error('response-lost')
      }
      if (request.method === 'GET' && request.url.includes('/33/') && request.url.includes('per_page=')) {
        return { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify([{ id: 1033, ...uncertainPost }])) }
      }
      return originalHttp(request, options)
    })
    await service.requestPublication(third.runId)
    expect((await service.store.getSnapshot(third.runId)).actions.at(-1)?.state).toBe('uncertain')
    let linkedRun: string | undefined
    if (platform === 'github') {
      const repeated = await service.startUser('low 33'); await service.wait(repeated.runId)
      linkedRun = repeated.runId
      await service.requestPublication(linkedRun)
      expect(http.mock.calls.filter(([request]) => request.method === 'POST' && request.url.includes('/33/'))).toHaveLength(1)
    }
    const modelCalls = mocks.model.mock.calls.length
    await service.requestPublication(third.runId)
    if (linkedRun) {
      await service.requestPublication(linkedRun)
      expect((await service.store.getSnapshot(linkedRun)).actions.at(-1)?.state).toBe('succeeded')
    }
    expect(mocks.model.mock.calls.length).toBe(modelCalls)
    expect(http.mock.calls.filter(([request]) => request.method === 'POST' && request.url.includes('/33/'))).toHaveLength(1)
    expect((await service.store.getSnapshot(third.runId)).actions.at(-1)?.state).toBe('succeeded')
    const entry = [...h.files].find(([path, text]) => path.includes('/publication-drafts/') && text.includes(third.runId))!
    if (platform === 'github') {
      const restored = JSON.parse(entry[1]); restored.write.location.anchorKey = 'prior-runtime-anchor'; restored.binding.location.anchorKey = 'prior-runtime-anchor'
      h.files.set(entry[0], JSON.stringify(restored))
      await expect(service.requestPublication(third.runId)).resolves.toBeUndefined()
    }
    const altered = JSON.parse(entry[1]); altered.binding.head = 'f'.repeat(40)
    h.files.set(entry[0], JSON.stringify(altered))
    await expect(service.requestPublication(third.runId)).rejects.toThrow('publication-draft-mismatch')
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
