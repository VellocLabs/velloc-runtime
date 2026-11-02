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
    expect(h.resolveScope).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ skipTestsAndFixtures: false }), expect.anything())
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
  it('restores interrupted reports without another model request', async () => {
    const h = setup()
    const { runId } = await h.service.startUser('low')
    await h.service.wait(runId)
    await h.service.restore([runId])
    expect(h.runModel).toHaveBeenCalledTimes(1)
    expect((await h.service.snapshots()).reports).toHaveLength(1)
  })
})
