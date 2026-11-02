import { describe, expect, it, vi } from 'vitest'
import { LocalReviewService, type ReviewServiceOptions } from './service'
import type { ReviewModelRequest } from './runner'
import type { ScopeManifest } from './scope'
import type { ReviewPreferences } from './contracts'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { Message } from '../runtime/RuntimeTypes'

const coverage = { angles: [], limitations: [], complete: true }
const manifest = (empty = false): ScopeManifest => ({
  scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: '/repo' }, revision: { base: 'a'.repeat(40), head: 'b'.repeat(40), workingCopyDigest: 'c'.repeat(64) }, pathFilter: [] },
  files: empty ? [] : [{ path: 'src/a.ts', status: 'included', patch: '-old\n+new', anchors: [] }],
  anchors: [], status: empty ? 'empty' : 'reviewable', complete: true, notices: [], baseSource: 'upstream', semantics: 'working-copy',
})
async function invoke(request: ReviewModelRequest, name: string, input: Record<string, unknown>) {
  const tool = request.tools.find(t => t.name === name)!
  const row = { type: 'assistant', message: { content: [{ type: 'tool_use', id: crypto.randomUUID(), name, input }] } } as Message
  return tool.call(input, {} as ToolCallContext, vi.fn() as unknown as PermissionDecider, row)
}
function fixture(overrides: Partial<ReviewServiceOptions> = {}) {
  const persisted = new Map<string, string>()
  let preferences: ReviewPreferences = {}
  const savePreferences = vi.fn(async (next: ReviewPreferences) => { preferences = next })
  const runModel = vi.fn(async (request: ReviewModelRequest) => {
    await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
    return { text: JSON.stringify({ candidates: [], coverage }), interrupted: false }
  })
  const resolveScope = vi.fn(async () => ({ manifest: manifest(), trustedGuidance: '', read: async () => '' }))
  const options: ReviewServiceOptions = {
    conversationKey: 'session', modelId: 'unknown', capabilities: { agentAvailable: true, agentPermitted: true, remainingDepth: 3, outputToolAvailable: true },
    preferences: { load: async () => preferences, save: savePreferences },
    storage: { listRunIds: async () => [...persisted.keys()], load: async id => persisted.get(id) ?? null, save: async (id, data) => { persisted.set(id, data) } },
    sanitizeExcerpt: text => text, resolveScope, runModel, ...overrides,
  }
  return { service: new LocalReviewService(options), options, runModel, resolveScope, savePreferences }
}

describe('local review acceptance boundaries', () => {
  it.each(['ultra', '--post', '--no-post', '--max-findings 0', '--unknown', 'low a b'])('rejects %s before repository, preferences, or model effects', async args => {
    const f = fixture()
    await expect(f.service.startUser(args)).rejects.toThrow()
    expect(f.runModel).not.toHaveBeenCalled()
    expect(f.resolveScope).not.toHaveBeenCalled()
    expect(f.savePreferences).not.toHaveBeenCalled()
  })
  it('preload has no effects and a model cannot manufacture action grants', async () => {
    const f = fixture()
    expect(f.service.preload().command).toBe('code-review')
    await expect(f.service.startModel('high --fix')).rejects.toThrow('action-not-authorized')
    await expect(f.service.startModel('--comment')).rejects.toThrow('action-not-authorized')
    expect(f.runModel).not.toHaveBeenCalled()
    expect(f.resolveScope).not.toHaveBeenCalled()
    expect(f.savePreferences).not.toHaveBeenCalled()
  })
  it('does not invoke the model for empty scope and saves only explicit user preferences', async () => {
    const f = fixture({ resolveScope: async () => ({ manifest: manifest(true), trustedGuidance: '', read: async () => '' }) })
    const { runId } = await f.service.startUser('high --max-findings 12')
    const report = await f.service.wait(runId)
    expect(report.run.progress.status).toBe('finished')
    expect(f.runModel).not.toHaveBeenCalled()
    expect(f.savePreferences).toHaveBeenCalledWith({ level: 'high', maxFindings: 12 })
    await f.service.startModel('low')
    expect(f.savePreferences).toHaveBeenCalledOnce()
  })
  it('runs quick review with only scoped read and ledger tools and commits one report', async () => {
    const f = fixture()
    const { runId } = await f.service.startUser('low')
    const report = await f.service.wait(runId)
    expect(report.run.progress.status).toBe('finished')
    expect(report.run.reportRevision).toBe(1)
    expect(f.runModel).toHaveBeenCalledOnce()
    const request = f.runModel.mock.calls[0][0]
    expect(request.tools.map(t => t.name)).toEqual(['ReviewRead', 'ReviewLedger'])
    expect(report.run.progress.spawnedTasks).toBe(0)
  })
  it('does not let a coordinator claim that independent tasks ran', async () => {
    const allAngles = ['lines', 'removed', 'calls', 'reuse', 'simplification', 'efficiency', 'root-cause', 'guidance', 'language', 'wrappers']
    const f = fixture({ runModel: async request => {
      const claimed = { ...coverage, angles: allAngles }
      await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage: claimed })
      return { text: JSON.stringify({ candidates: [], coverage: claimed }), interrupted: false }
    } })
    const { runId } = await f.service.startUser('max')
    const report = await f.service.wait(runId)
    expect(report.run.progress.status).toBe('partial')
    expect(report.run.progress.spawnedTasks).toBe(0)
    expect(report.coverage.complete).toBe(false)
  })
  it('retains a local report when comment has no change request target', async () => {
    const f = fixture()
    const { runId } = await f.service.startUser('low --comment')
    const report = await f.service.wait(runId)
    expect(report.structured).toBe(true)
    expect(report.run.progress.status).toBe('finished')
    expect(report.coverage.limitations).toContain('publication-target-required')
    expect(report.actions.some(a => a.kind === 'publication' && a.state === 'succeeded')).toBe(false)
  })
  it('restores persisted reports without issuing new model calls', async () => {
    const f = fixture()
    const { runId } = await f.service.startUser('low')
    await f.service.wait(runId)
    const resumed = new LocalReviewService(f.options)
    await resumed.restore([runId])
    expect((await resumed.snapshots()).reports[0].run.id).toBe(runId)
    expect(f.runModel).toHaveBeenCalledOnce()
  })
})


describe('review output and cancellation', () => {
  it('uses the registered panel output tool and a single shared ledger', async () => {
    const f = fixture({ output: 'panel', runModel: async request => {
      await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
      await invoke(request, 'ReviewOutput', { operation: 'record', candidates: [], coverage })
      return { text: '', interrupted: false }
    } })
    const { runId } = await f.service.startUser('low')
    const snapshot = await f.service.wait(runId)
    expect(snapshot.run.policy.presentation).toBe('panel')
    expect(snapshot.run.progress.status).toBe('finished')
    expect(snapshot.run.reportRevision).toBe(1)
  })
  it('keeps cancellation distinct from a clean empty report', async () => {
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const f = fixture({ runModel: async request => {
      started()
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { text: '', interrupted: true }
    } })
    const { runId } = await f.service.startUser('low')
    await entered
    expect(await f.service.cancel(runId)).toEqual({ accepted: true })
    const snapshot = await f.service.wait(runId)
    expect(snapshot.run.progress.status).toBe('cancelled')
    expect(snapshot.coverage.complete).toBe(false)
    expect(snapshot.diagnostics).toEqual([])
  })
})


it('records successful finder coverage and a separate sweep from actual worker runs', async () => {
  const angles = ['lines', 'removed', 'calls', 'reuse', 'simplification', 'efficiency', 'root-cause', 'guidance', 'language', 'wrappers']
  const f = fixture({ runModel: async request => {
    if (request.blocks.some(block => block.source === 'assigned-angles')) {
      const assigned = JSON.parse(request.blocks.find(block => block.source === 'assigned-angles')!.text)
      return { text: JSON.stringify({ candidates: [], coverage: { angles: assigned, limitations: [] } }), interrupted: false }
    }
    if (request.blocks.some(block => block.source === 'existing-findings')) return { text: JSON.stringify({ candidates: [], coverage: { angles: [], limitations: [] } }), interrupted: false }
    await invoke(request, 'Agent', { role: 'finder', angles })
    await invoke(request, 'Agent', { role: 'sweeper' })
    const complete = { angles, limitations: [], complete: true }
    await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage: complete })
    return { text: JSON.stringify({ candidates: [], coverage: complete }), interrupted: false }
  } })
  const { runId } = await f.service.startUser('max')
  const snapshot = await f.service.wait(runId)
  expect(snapshot.run.progress.status).toBe('finished')
  expect(snapshot.run.progress.spawnedTasks).toBe(2)
  expect(snapshot.events.filter(event => event.type === 'worker-finished')).toHaveLength(2)
  expect(snapshot.run.progress.verifiedCandidates).toBe(0)
})


it('counts independent verification only after a separate verifier finishes', async () => {
  let issue: Record<string, unknown>
  const angles = ['lines', 'removed', 'calls', 'reuse', 'simplification', 'efficiency', 'root-cause', 'guidance', 'language', 'wrappers']
  const f = fixture({ resolveScope: async () => {
    const value = manifest()
    value.anchors = [{ anchorKey: 'temporary', path: 'src/a.ts', revision: value.scope.revision.workingCopyDigest!, side: 'working-copy', span: { start: 1, end: 2 } }]
    value.files[0].anchors = value.anchors
    return { manifest: value, trustedGuidance: '', read: async () => '' }
  }, runModel: async request => {
    if (request.blocks.some(block => block.source === 'assigned-angles')) {
      const scope = JSON.parse(request.blocks.find(block => block.source === 'scope-manifest')!.text)
      issue = { location: { anchorKey: scope.anchors[0].anchorKey, path: 'src/a.ts', line: 1, endLine: 1 }, statement: { headline: 'Missing guard', details: 'An absent value is dereferenced.', scenario: 'The null path throws.' }, kind: 'correctness', impact: 'major', support: [{ path: 'src/a.ts', quote: 'value.member', relevance: 'Dereference without a guard.' }], assessment: { disposition: 'plausible', reason: 'The code permits this path.' }, angle: 'lines' }
      return { text: JSON.stringify({ candidates: [issue], coverage: { angles, limitations: [] } }), interrupted: false }
    }
    if (request.blocks.some(block => block.source === 'candidate')) return { text: JSON.stringify({ disposition: 'proven', reason: 'The caller passes null.', support: [{ path: 'src/a.ts', quote: 'value.member', relevance: 'Reachable null dereference.' }], missingEvidence: [] }), interrupted: false }
    if (request.blocks.some(block => block.source === 'existing-findings')) return { text: JSON.stringify({ candidates: [], coverage: { angles: [], limitations: [] } }), interrupted: false }
    const found = await invoke(request, 'Agent', { role: 'finder', angles })
    const ledger = (found.data as { ledger: { candidates: unknown[] } }).ledger
    expect(ledger.candidates).toHaveLength(1)
    const runId = JSON.parse(request.blocks.find(block => block.source === 'run-summary')!.text).runId
    const candidateId = (await f.service.store.getSnapshot(runId)).retainedIds[0]
    await invoke(request, 'Agent', { role: 'verifier', candidateId })
    await invoke(request, 'Agent', { role: 'sweeper' })
    await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage: { angles, limitations: [], complete: true } })
    const { operation: _, ...result } = await f.service.store.expectedRecord(runId)
    return { text: JSON.stringify(result), interrupted: false }
  } })
  const { runId } = await f.service.startUser('max')
  const snapshot = await f.service.wait(runId)
  expect(snapshot.run.progress.status).toBe('finished')
  expect(snapshot.run.progress.spawnedTasks).toBe(3)
  expect(snapshot.run.progress.verifiedCandidates).toBe(1)
  expect(snapshot.assessments.at(-1)?.disposition).toBe('proven')
})


it('preserves unstructured output after one format-only correction fails', async () => {
  const model = vi.fn(async () => ({ text: 'not JSON', interrupted: false }))
  const f = fixture({ runModel: model })
  const { runId } = await f.service.startUser('low')
  const snapshot = await f.service.wait(runId)
  expect(model).toHaveBeenCalledTimes(2)
  expect(snapshot.run.progress.status).toBe('partial')
  expect(snapshot.structured).toBe(false)
  expect((await f.service.store.getRawResults(runId)).length).toBeGreaterThan(0)
})


it('keeps a completed local report when publication is blocked', async () => {
  const f = fixture({ resolveScope: async () => {
    const value = manifest()
    value.scope.kind = 'change-request'
    value.scope.repository = { platform: 'github', projectKey: 'owner/repo' }
    value.scope.request = { number: 1, headRevision: value.scope.revision.head }
    return { manifest: value, trustedGuidance: '', read: async () => '' }
  }, publish: async () => { throw new Error('publication-not-authorized') } })
  const { runId } = await f.service.startUser('low --comment')
  const snapshot = await f.service.wait(runId)
  expect(snapshot.structured).toBe(true)
  expect(snapshot.coverage.complete).toBe(true)
  expect(snapshot.run.progress.status).toBe('finished')
  expect(snapshot.actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'publication', state: 'blocked' })]))
})


it('rejects overlapping follow-up actions without replacing their cancellation signal', async () => {
  let entered!: () => void
  const running = new Promise<void>(resolve => { entered = resolve })
  let cancelled = false
  const f = fixture({ verify: async (_snapshot, signal) => {
    entered()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
  } })
  const { runId } = await f.service.startUser('low')
  await f.service.wait(runId)
  const action = f.service.requestVerification(runId)
  await running
  await expect(f.service.requestVerification(runId)).rejects.toThrow('review-action-in-progress')
  expect(await f.service.cancel(runId)).toEqual({ accepted: true })
  await action
  expect(cancelled).toBe(true)
})
