import { describe, it, expect, vi } from 'vitest'
import { LocalReviewService, type ReviewServiceOptions } from './service'
import type { ReviewModelRequest } from './runner'
import type { ReviewPreferences } from './contracts'
import type { ScopeManifest } from './scope'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'

function setup(options: { empty?: boolean; args?: Partial<ReviewServiceOptions> } = {}) {
  const storage = new Map<string, string>()
  let prefs: ReviewPreferences = {}
  const save = vi.fn(async (next: ReviewPreferences) => { prefs = next })
  const manifest: ScopeManifest = { scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: '/repo' }, revision: { base: 'a', head: 'b', workingCopyDigest: 'w' }, pathFilter: [] },
    files: [], anchors: [], status: options.empty ? 'empty' : 'reviewable', complete: true, notices: [], baseSource: 'main', semantics: 'working-copy' }
  const invoke = async (request: ReviewModelRequest, name: string, input: Record<string, unknown>) => {
    const tool = request.tools.find(t => t.name === name)!
    return tool.call(input, {} as ToolCallContext, () => ({ behavior: 'allow' }), { uuid: crypto.randomUUID() } as Message)
  }
  const runModel = vi.fn(async (request: ReviewModelRequest) => {
    expect(request.tools.map(t => t.name)).not.toContain('Bash')
    expect(request.tools.map(t => t.name)).not.toContain('Read')
    const plan = JSON.parse(request.blocks.find(b => b.source === 'resolved-policy')!.text)
    const coverage = { angles: plan.angles, limitations: [], complete: true }
    await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
    return { text: JSON.stringify({ candidates: [], coverage }), interrupted: false }
  })
  const resolveScope = vi.fn(async () => ({ manifest, trustedGuidance: 'Preserve safety.', read: vi.fn() }))
  const service = new LocalReviewService({ conversationKey: 'session', modelId: 'unknown',
    capabilities: { agentAvailable: true, agentPermitted: true, remainingDepth: 2, outputToolAvailable: true },
    preferences: { load: async () => prefs, save }, storage: { listRunIds: async () => [...storage.keys()], load: async id => storage.get(id) ?? null, save: async (id, value) => { storage.set(id, value) } },
    sanitizeExcerpt: text => text, resolveScope, runModel, ...options.args })
  return { service, save, runModel, resolveScope, storage, invoke }
}
describe('local review runtime gateway', () => {
  it('permanently disposes live model and tool admission without format retries', async () => {
    const h = setup()
    let request!: ReviewModelRequest
    let resume!: () => void
    h.runModel.mockImplementation(async value => {
      request = value
      await new Promise<void>(resolve => { resume = resolve })
      return { text: 'invalid json', interrupted: false }
    })
    const { runId } = await h.service.startUser('low')
    await vi.waitFor(() => expect(request).toBeDefined())
    h.service.dispose()
    h.service.dispose()
    expect(request.signal.aborted).toBe(true)
    await expect(h.invoke(request, 'ReviewRead', { operation: 'diff' })).rejects.toThrow('review-cancelled')
    resume()
    expect((await h.service.wait(runId)).run.progress.status).toBe('cancelled')
    expect(h.runModel).toHaveBeenCalledTimes(1)
    await expect(h.service.startUser('low')).rejects.toThrow('review-cancelled')
    await expect(h.service.rerun(runId)).rejects.toThrow('review-cancelled')
  })

  it.each(['verify', 'publish'] as const)('aborts live %s follow-ups and rejects later actions', async action => {
    let signal!: AbortSignal
    let resume!: () => void
    const adapter = vi.fn(async (_snapshot, ...args) => {
      signal = args.find(value => value instanceof AbortSignal)!
      await new Promise<void>(resolve => { resume = resolve })
    })
    const h = setup({ args: action === 'verify' ? { verify: adapter } : { publish: adapter } })
    const { runId } = await h.service.startUser('low')
    await h.service.wait(runId)
    const pending = action === 'verify' ? h.service.requestVerification(runId) : h.service.requestPublication(runId)
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
    h.service.dispose()
    expect(signal.aborted).toBe(true)
    resume()
    await expect(pending).rejects.toThrow('review-cancelled')
    await expect(h.service.requestVerification(runId)).rejects.toThrow()
    await expect(h.service.requestPublication(runId)).rejects.toThrow('review-cancelled')
  })

  it('tracks scope controllers before the first await and aborts caller-cancelled preparation', async () => {
    const owner = new AbortController()
    const h = setup({ args: { ownerSignal: owner.signal } })
    let entered!: () => void
    let resume!: () => void
    let signal!: AbortSignal
    const ready = new Promise<void>(resolve => { entered = resolve })
    const access = await h.resolveScope()
    h.resolveScope.mockImplementation(async (...args: unknown[]) => {
      signal = args[2] as AbortSignal
      entered()
      await new Promise<void>(resolve => { resume = resolve })
      return access
    })
    const pending = h.service.startUser('low')
    const failed = expect(pending).rejects.toThrow('review-cancelled')
    await ready
    owner.abort()
    expect(signal.aborted).toBe(true)
    resume()
    await failed
    expect(h.runModel).not.toHaveBeenCalled()
    expect(h.storage.size).toBe(0)
  })
  it('rejects malformed and removed arguments before scope, model or preference writes', async () => {
    const h = setup()
    for (const raw of ['/ultrareview', 'ultra', '--post', '--max-findings=0']) await expect(h.service.startUser(raw)).rejects.toThrow()
    expect(h.resolveScope).not.toHaveBeenCalled(); expect(h.runModel).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })
  it('preload is inert and model actions cannot authorize writes', async () => {
    const h = setup()
    expect(h.service.preload().aliases).toEqual(['review'])
    await expect(h.service.startModel('--fix')).rejects.toThrow('action-not-authorized')
    await expect(h.service.startModel('--comment')).rejects.toThrow('action-not-authorized')
    expect(h.resolveScope).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })
  it('does not call the model for an empty range and persists user preferences only', async () => {
    const h = setup({ empty: true })
    const { runId } = await h.service.startUser('high --max-findings 12')
    expect((await h.service.wait(runId)).run.progress.status).toBe('finished')
    expect(h.runModel).not.toHaveBeenCalled(); expect(h.save).toHaveBeenCalledWith({ level: 'high', maxFindings: 12 })
    await h.service.startModel('low'); expect(h.save).toHaveBeenCalledTimes(1)
  })
  it('runs isolated read-only review with ledger-backed final output', async () => {
    const h = setup()
    const { runId } = await h.service.startUser('medium')
    const report = await h.service.wait(runId)
    expect(report.structured).toBe(true); expect(report.run.progress.status).toBe('finished')
    expect(report.run.policy.execution).toBe('isolated'); expect(report.run.progress.spawnedTasks).toBe(0)
    expect(h.storage.has(runId)).toBe(true)
  })
  it('does not let model-requested max authorize a team run', async () => {
    const h = setup()
    const { runId } = await h.service.startModel('max')
    const report = await h.service.wait(runId)
    expect(report.run.policy.level).not.toBe('max'); expect(h.save).not.toHaveBeenCalled()
  })
  it('uses host-approved guidance without storing a user preference', async () => {
    const h = setup({ empty: true })
    const original = await h.resolveScope()
    h.resolveScope.mockResolvedValue({ ...original, authorizedGuidance: { level: 'max', trusted: true, appliesToProject: true } } as typeof original)
    const { runId } = await h.service.startModel('max')
    expect((await h.service.wait(runId)).run.policy.level).toBe('max')
    expect(h.save).not.toHaveBeenCalled()
  })
  it('rebuilds filtered scope when approved guidance changes the effort', async () => {
    const h = setup({ empty: true, args: { sessionLevel: 'low' } })
    const original = await h.resolveScope()
    h.resolveScope.mockClear()
    h.resolveScope.mockResolvedValue({ ...original, authorizedGuidance: { level: 'max', trusted: true, appliesToProject: true } } as typeof original)
    const { runId } = await h.service.startUser('')
    expect((await h.service.wait(runId)).run.policy.level).toBe('max')
    expect(h.resolveScope).toHaveBeenCalledTimes(2)
    expect(h.resolveScope).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ skipTestsAndFixtures: false }), expect.anything(), { guidance: { level: 'max', trusted: true, appliesToProject: true } })
  })
  it('keeps an explicit user level above guidance', async () => {
    const h = setup({ empty: true, args: { guidance: { level: 'max', trusted: true, appliesToProject: true } } })
    const { runId } = await h.service.startUser('low')
    expect((await h.service.wait(runId)).run.policy.level).toBe('low')
  })
  it('does not accept claimed team coverage without actual worker receipts', async () => {
    const h = setup()
    const { runId } = await h.service.startUser('max')
    const report = await h.service.wait(runId)
    expect(report.run.progress.status).toBe('partial'); expect(report.run.progress.spawnedTasks).toBe(0)
    expect(report.coverage.limitations).toContain('independent-worker-coverage-incomplete')
  })
  it('keeps local review successful when comment has no change-request target', async () => {
    const h = setup()
    const { runId } = await h.service.startUser('--comment')
    const report = await h.service.wait(runId)
    expect(report.run.progress.status).toBe('finished'); expect(report.coverage.limitations).toContain('publication-target-required')
  })
  it('treats the user rereview action as explicit effort selection without repeating writes', async () => {
    const h = setup({ empty: true })
    const { runId } = await h.service.startUser('max --fix')
    await h.service.wait(runId)
    const rerun = await h.service.rerun(runId)
    expect((await h.service.wait(rerun.runId)).run.policy.level).toBe('max')
    expect(h.resolveScope).toHaveBeenLastCalledWith(expect.objectContaining({ fix: false, comment: false }), expect.anything(), expect.anything())
  })
  it('keeps -C on a rerun, from the live run and from the stored target', async () => {
    const stored = new Map<string, { target?: string; literal?: true; directory?: string }>()
    const presentations: Array<{ target?: string }> = []
    const h = setup({ empty: true, args: {
      saveTarget: async (id, target, literal, directory) => { stored.set(id, { target, literal, directory }) },
      loadTarget: async id => stored.get(id)?.target, loadTargetLiteral: async id => stored.get(id)?.literal, loadDirectory: async id => stored.get(id)?.directory,
      savePresentation: async (_id, value) => { presentations.push(value) },
    } })
    const { runId } = await h.service.startUser('low -C "nested repo" main..topic')
    await h.service.wait(runId)
    expect(stored.get(runId)).toEqual({ target: 'main..topic', literal: undefined, directory: 'nested repo' })
    expect(presentations.at(-1)?.target).toBe('nested repo main..topic')
    const live = await h.service.rerun(runId)
    await h.service.wait(live.runId)
    expect(h.resolveScope).toHaveBeenLastCalledWith(expect.objectContaining({ directory: 'nested repo', target: 'main..topic' }), expect.anything(), expect.anything())
    ;(h.service as unknown as { live: Map<string, unknown> }).live.delete(runId)
    const restored = await h.service.rerun(runId)
    await h.service.wait(restored.runId)
    expect(h.resolveScope).toHaveBeenLastCalledWith(expect.objectContaining({ directory: 'nested repo', target: 'main..topic' }), expect.anything(), expect.anything())
  })
  it('restores interrupted reports without another model request', async () => {
    const h = setup()
    const { runId } = await h.service.startUser('low')
    await h.service.wait(runId)
    await h.service.restore([runId])
    expect(h.runModel).toHaveBeenCalledTimes(1)
    expect((await h.service.snapshots()).reports).toHaveLength(1)
  })
  it('sizes the default time budget so a ten-angle team run outlives ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = setup({ args: { capabilities: { agentAvailable: false, agentPermitted: false, remainingDepth: 0, outputToolAvailable: true } } })
      let budget = 0
      h.runModel.mockImplementation(async (request: ReviewModelRequest) => {
        budget = JSON.parse(request.blocks.find(b => b.source === 'budget')!.text).maxDurationMs
        await new Promise(resolve => setTimeout(resolve, 11 * 60_000))
        const plan = JSON.parse(request.blocks.find(b => b.source === 'resolved-policy')!.text)
        const coverage = { angles: plan.angles, limitations: [], complete: true }
        await h.invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
        return { text: JSON.stringify({ candidates: [], coverage }), interrupted: false }
      })
      const { runId } = await h.service.startUser('max')
      await vi.waitFor(() => expect(budget).toBeGreaterThan(0))
      await vi.advanceTimersByTimeAsync(11 * 60_000)
      const report = await h.service.wait(runId)
      expect(budget).toBeGreaterThan(600_000)
      expect(report.coverage.limitations).not.toContain('review-budget-exhausted')
      expect(report.coverage.angles).toHaveLength(10)
    } finally { vi.useRealTimers() }
  })
  it('keeps and reports the angles a run finished before its budget ran out', async () => {
    const h = setup({ args: { maxDurationMs: 50 } })
    h.runModel.mockImplementation(async (request: ReviewModelRequest) => {
      await h.invoke(request, 'ReviewLedger', { operation: 'coverage', coverage: { angles: ['lines', 'removed'], limitations: [], complete: false } })
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { text: '', interrupted: true }
    })
    const { runId } = await h.service.startUser('medium')
    const report = await h.service.wait(runId)
    expect(report.run.progress.status).toBe('partial')
    expect(report.coverage.limitations).toContain('review-budget-exhausted')
    expect(report.coverage.angles).toEqual(['lines', 'removed'])
    expect(report.structured).toBe(true)
  })
  it('accepts whole-file reads longer than 100,000 characters as evidence sources', async () => {
    const content = 'export const line = 1\n'.repeat(12_000)
    expect(content.length).toBeGreaterThan(200_000)
    let read: unknown
    const h = setup({ args: { resolveScope: vi.fn(async () => ({ manifest: { scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: '/repo' }, revision: { base: 'a', head: 'b', workingCopyDigest: 'w' }, pathFilter: [] },
      files: [], anchors: [], status: 'reviewable', complete: true, notices: [], baseSource: 'main', semantics: 'working-copy' } as ScopeManifest, trustedGuidance: '', read: vi.fn(async () => content) })) } })
    h.runModel.mockImplementation(async (request: ReviewModelRequest) => {
      read = await h.invoke(request, 'ReviewRead', { operation: 'context', path: 'src/large.tsx' })
      const plan = JSON.parse(request.blocks.find(b => b.source === 'resolved-policy')!.text)
      const coverage = { angles: plan.angles, limitations: [], complete: true }
      await h.invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
      return { text: JSON.stringify({ candidates: [], coverage }), interrupted: false }
    })
    const { runId } = await h.service.startUser('medium')
    const report = await h.service.wait(runId)
    expect(read).toEqual({ data: { source: 'r1', startLine: 1, text: content } })
    expect(report.run.progress.status).toBe('finished')
  })
  it('reviews test and fixture files at low when they are the only changes, with a notice', async () => {
    const manifestFor = (skip: boolean): ScopeManifest => ({ scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: '/repo' }, revision: { base: 'a', head: 'b', workingCopyDigest: 'w' }, pathFilter: [] },
      files: [{ path: 'src/__tests__/a.test.ts', status: skip ? 'skipped' : 'included', patch: skip ? '' : '-old\n+new', anchors: [] }],
      anchors: [], status: skip ? 'partial' : 'reviewable', complete: !skip, notices: [], baseSource: 'main', semantics: 'working-copy' })
    const resolveScope = vi.fn(async (_args, plan: { skipTestsAndFixtures: boolean }) => ({ manifest: manifestFor(plan.skipTestsAndFixtures), trustedGuidance: '', read: vi.fn() }))
    const h = setup({ args: { resolveScope } })
    const { runId } = await h.service.startUser('low')
    const report = await h.service.wait(runId)
    const scope = JSON.parse(h.runModel.mock.calls[0]![0].blocks.find(b => b.source === 'scope-manifest')!.text)
    expect(scope.files[0]).toMatchObject({ path: 'src/__tests__/a.test.ts', status: 'included' })
    const plan = JSON.parse(h.runModel.mock.calls[0]![0].blocks.find(b => b.source === 'resolved-policy')!.text)
    expect(plan.skipTestsAndFixtures).toBe(false)
    expect(plan.notices).toContainEqual({ code: 'tests-fixtures-reviewed' })
    expect(h.service.presentation(runId)?.notices).toContainEqual({ code: 'tests-fixtures-reviewed' })
    expect(report.coverage.limitations).toContain('tests-fixtures-reviewed')
    expect(report.run.progress.status).toBe('finished')
  })
  it('finishes a low review whose test files the policy skipped beside reviewed code', async () => {
    const manifest: ScopeManifest = { scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: '/repo' }, revision: { base: 'a', head: 'b', workingCopyDigest: 'w' }, pathFilter: [] },
      files: [{ path: 'src/a.ts', status: 'included', patch: '-old\n+new', anchors: [] }, { path: 'src/__tests__/a.test.ts', status: 'skipped', patch: '', anchors: [] }],
      anchors: [], status: 'reviewable', complete: true, notices: [], baseSource: 'main', semantics: 'working-copy' }
    const h = setup({ args: { resolveScope: vi.fn(async () => ({ manifest, trustedGuidance: '', read: vi.fn() })) } })
    const { runId } = await h.service.startUser('low')
    const report = await h.service.wait(runId)
    const scope = JSON.parse(h.runModel.mock.calls[0]![0].blocks.find(b => b.source === 'scope-manifest')!.text)
    expect(scope.files.map((file: { path: string; status: string }) => [file.path, file.status])).toEqual([['src/a.ts', 'included'], ['src/__tests__/a.test.ts', 'skipped']])
    expect(report.run.progress.status).toBe('finished')
    expect(report.coverage.limitations).toContain('tests-fixtures-skipped')
    expect(report.coverage.limitations).not.toContain('scope-incomplete')
  })
  it('finishes a local run that covered every angle although nothing was independently verified', async () => {
    const h = setup()
    const { runId } = await h.service.startUser('high')
    const report = await h.service.wait(runId)
    expect(JSON.parse(h.runModel.mock.calls[0]![0].blocks.find(b => b.source === 'resolved-policy')!.text).independentVerification).toBe(false)
    expect(report.run.progress.verifiedCandidates).toBe(0)
    expect(report.run.progress.status).toBe('finished')
  })
  it.each([
    ['src/__tests__/x.ts', false],
    ['docs/notes.md', false],
    ['src/a.ts', true],
  ] as const)('starts automatic verification for %s only when runtime code changed: %s', async (path, expected) => {
    const verify = vi.fn(async () => {})
    const manifest: ScopeManifest = { scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: '/repo' }, revision: { base: 'a', head: 'b', workingCopyDigest: 'w' }, pathFilter: [] },
      files: [{ path, status: 'included', patch: '-old\n+new', anchors: [] }], anchors: [], status: 'reviewable', complete: true, notices: [], baseSource: 'main', semantics: 'working-copy' }
    const h = setup({ args: { output: 'panel', automaticVerificationPermitted: true, verify, resolveScope: vi.fn(async () => ({ manifest, trustedGuidance: '', read: vi.fn() })) } })
    const { runId } = await h.service.startUser('low')
    await h.service.wait(runId)
    expect(verify).toHaveBeenCalledTimes(expected ? 1 : 0)
  })
  it('reuses the first guidance decision when a tests-only change is resolved again', async () => {
    const manifestFor = (skip: boolean): ScopeManifest => ({ scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: '/repo' }, revision: { base: 'a', head: 'b', workingCopyDigest: 'w' }, pathFilter: [] },
      files: [{ path: 'src/__tests__/a.test.ts', status: skip ? 'skipped' : 'included', patch: skip ? '' : '-old\n+new', anchors: [] }],
      anchors: [], status: skip ? 'partial' : 'reviewable', complete: !skip, notices: [], baseSource: 'main', semantics: 'working-copy' })
    const approval = { level: 'low' as const, trusted: true, appliesToProject: true }
    const resolveScope = vi.fn(async (_args, plan: { skipTestsAndFixtures: boolean }, _signal, approved?: { guidance: unknown }) => ({
      manifest: manifestFor(plan.skipTestsAndFixtures), trustedGuidance: '', read: vi.fn(), authorizedGuidance: approved ? approved.guidance as typeof approval : approval }))
    const h = setup({ args: { resolveScope } })
    const { runId } = await h.service.startUser('low')
    expect((await h.service.wait(runId)).run.progress.status).toBe('finished')
    expect(resolveScope).toHaveBeenCalledTimes(2)
    expect(resolveScope.mock.calls[0]![3]).toBeUndefined()
    expect(resolveScope.mock.calls[1]![3]).toEqual({ guidance: approval })
  })
})
