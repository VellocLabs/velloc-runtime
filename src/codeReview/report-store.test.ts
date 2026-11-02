import { describe, expect, it } from 'vitest'
import { ReviewReportStore, type ReportCandidateInput, type ReportPolicy, type ReportStorageAdapter } from './report-store'
import { presentReviewJson, presentReviewTerminal, projectReviewReport } from './presenter'
import { createReviewTools } from './tools'
import type { Message } from '../runtime/RuntimeTypes'

function fixture() {
  const data = new Map<string, string>()
  let next = 0
  const adapter: ReportStorageAdapter = {
    listRunIds: async () => [...data.keys()],
    load: async id => data.get(id) ?? null,
    save: async (id, value) => { data.set(id, value) },
  }
  const options = { id: () => `host-${++next}`, now: () => 100, sanitizeExcerpt: (text: string) => text.replaceAll('secret-value', '[redacted]') }
  const store = new ReviewReportStore(adapter, options)
  async function run(policy: Partial<ReportPolicy> = {}, remote = false) {
    const id = await store.createRun({ conversationKey: 'conversation',
      scope: { kind: remote ? 'change-request' : 'workspace', workspaceKey: 'workspace',
        repository: { projectKey: 'project', ...(remote ? { platform: 'github' as const } : {}) },
        revision: { base: 'base', head: 'head', workingCopyDigest: 'work' }, pathFilter: [],
        ...(remote ? { request: { number: 12, headRevision: 'head' } } : {}) },
      policy: { level: 'high', recipe: 'local-eight', recipeRevision: 1, execution: 'inline', presentation: 'terminal', reportLimit: 'unlimited', ...policy },
      expectedAngles: ['lines'],
    })
    const anchorKey = await store.registerAnchor(id, { path: 'src/a.ts', revision: 'head', side: 'after', span: { start: 1, end: 200 } })
    await store.start(id)
    return { id, anchorKey }
  }
  return { data, store, adapter, options, run }
}
function candidate(anchorKey: string, line = 1, details = 'A concrete missing guard'): ReportCandidateInput {
  return { location: { anchorKey, path: 'src/a.ts', line },
    statement: { headline: `Issue ${line}`, details, scenario: 'A missing input reaches the handler' },
    kind: 'correctness', impact: 'major', support: [{ path: 'src/a.ts', quote: 'read(value)', relevance: 'No guard' }],
    assessment: { disposition: 'plausible', reason: 'Reachable input' }, angle: 'lines' }
}
async function populate(store: ReviewReportStore, id: string, anchorKey: string, count = 1) {
  for (let start = 0; start < count; start += 32) {
    await store.submitLedger(id, `batch-${start}`, { operation: 'append-candidates',
      candidates: Array.from({ length: Math.min(32, count - start) }, (_, i) => candidate(anchorKey, start + i + 1, `Mechanism ${start + i}`)) })
  }
  await store.submitLedger(id, 'coverage', { operation: 'coverage', coverage: { angles: ['lines'], limitations: [], complete: true } })
  await store.submitRecord(id, 'record', await store.expectedRecord(id))
}

describe('review report store', () => {
  it('rejects forged anchors, paths, spans, ids, lifecycle fields and oversized batches atomically', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    const valid = candidate(anchorKey)
    const cases = [
      { ...valid, id: 'model-id' }, { ...valid, state: 'finished' },
      { ...valid, location: { ...valid.location, anchorKey: 'forged' } },
      { ...valid, location: { ...valid.location, path: '../private' } },
      { ...valid, location: { ...valid.location, line: 0 } },
      { ...valid, location: { ...valid.location, line: 201 } },
      { ...valid, location: { ...valid.location, endLine: 0 } },
      { ...valid, support: [{ path: 'private.txt', quote: 'x', relevance: 'y' }] },
    ]
    for (const [index, item] of cases.entries()) {
      await expect(store.submitLedger(id, `invalid-${index}`, { operation: 'append-candidates', candidates: [valid, item] })).rejects.toThrow()
    }
    await expect(store.submitLedger(id, 'too-many', { operation: 'append-candidates', candidates: Array(33).fill(valid) })).rejects.toThrow()
    expect((await store.getSnapshot(id)).diagnostics).toHaveLength(0)
    expect(await store.getRawResults(id)).toHaveLength(9)
    await expect(store.registerAnchor(id, { path: 'src/a.ts', revision: 'forged', side: 'after' })).rejects.toThrow('anchor-revision-mismatch')
  })

  it('serializes concurrent writes, returns immutable snapshots, and deduplicates tool calls', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    const input = { operation: 'append-candidates', candidates: [candidate(anchorKey)] }
    const results = await Promise.all(Array.from({ length: 12 }, () => store.submitLedger(id, 'same-call', input)))
    expect(results.every(result => result.accepted[0].diagnosticId === results[0].accepted[0].diagnosticId)).toBe(true)
    expect((await store.getSnapshot(id)).diagnostics).toHaveLength(1)
    await expect(store.submitLedger(id, 'same-call', { ...input, candidates: [] })).rejects.toThrow('tool-call-conflict')
    const snapshot = await store.getSnapshot(id)
    expect(Object.isFrozen(snapshot.run.scope)).toBe(true)
    expect(() => snapshot.diagnostics.pop()).toThrow()
    await store.finish(id, 'cancelled')
    await expect(store.submitLedger(id, 'late-call', input)).rejects.toThrow('run-not-active')
    expect(await store.submitLedger(id, 'same-call', input)).toEqual(results[0])
    expect((await store.getSnapshot(id)).run.progress.status).toBe('cancelled')
    expect((await store.getRawResults(id)).at(-1)?.code).toBe('run-not-active')
  })

  it('deduplicates overlapping root mechanisms, preserves distinct mechanisms and revisions', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    const before = await store.registerAnchor(id, { path: 'src/a.ts', revision: 'base', side: 'before', span: { start: 1, end: 10 } })
    const original = candidate(anchorKey)
    original.location.endLine = 3
    const duplicate = candidate(anchorKey, 2)
    duplicate.support = [{ quote: 'second proof', relevance: 'More evidence' }]
    const result = await store.submitLedger(id, 'batch', { operation: 'append-candidates', candidates: [original, duplicate, candidate(anchorKey, 2, 'Another mechanism'), candidate(before)] })
    expect(result.accepted[0].diagnosticId).toBe(result.accepted[1].diagnosticId)
    const snapshot = await store.getSnapshot(id)
    expect(snapshot.diagnostics).toHaveLength(3)
    expect(snapshot.diagnostics[0].evidenceKeys).toHaveLength(2)
    expect(snapshot.diagnostics[2].anchor.side).toBe('before')
  })

  it.each([
    ['terminal', 'local-eight', 'unlimited', 40], ['json', 'local-eight', 38, 38],
    ['panel', 'local-eight', 'unlimited', 32], ['terminal', 'careful-pass', 'unlimited', 32],
    ['terminal', 'local-eight', 3, 3],
  ] as const)('applies %s %s limit %s only after the complete ledger', async (presentation, recipe, reportLimit, retained) => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run({ presentation, recipe, reportLimit })
    await populate(store, id, anchorKey, 40)
    const snapshot = await store.getSnapshot(id)
    expect(snapshot.diagnostics).toHaveLength(40)
    expect(snapshot.retainedIds).toHaveLength(retained)
    expect(snapshot.run.progress.omittedByLimit).toBe(40 - retained)
    expect(JSON.parse(presentReviewJson(snapshot)).report).toHaveLength(retained)
    const terminal = presentReviewTerminal(snapshot, {
      summary: (_, n) => `count=${n}`, status: r => r.progress.status, classification: d => d.classification.impact,
      assessment: a => a.disposition, action: a => a.state, omitted: n => `omitted=${n}`,
      limitations: items => items.join(','), scenario: value => value,
    })
    expect(terminal).toContain(`${retained}. major`)
  })

  it('ranks correctness before cleanup and applies assessments before truncation', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run({ reportLimit: 1 })
    const cleanup = { ...candidate(anchorKey, 1, 'Cleanup'), kind: 'simplicity', impact: 'critical' }
    const result = await store.submitLedger(id, 'add', { operation: 'append-candidates', candidates: [cleanup, candidate(anchorKey, 2, 'Bug')] })
    expect((await store.getSnapshot(id)).retainedIds).toEqual([result.accepted[1].diagnosticId])
    await store.submitLedger(id, 'assess', { operation: 'assess', assessments: [{ candidateId: result.accepted[1].diagnosticId, disposition: 'dismissed', reason: 'Guard is present', support: [{ quote: 'if (value)', relevance: 'Guard' }] }] })
    expect((await store.getSnapshot(id)).retainedIds).toEqual([result.accepted[0].diagnosticId])
    await expect(store.submitLedger(id, 'forged', { operation: 'assess', assessments: [{ candidateId: 'not-this-run', disposition: 'proven', reason: 'trust me', support: [] }] })).rejects.toThrow()
  })

  it('requires exact retained candidates and coverage, captures malformed output without finishing', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    const expected = await store.expectedRecord(id)
    await expect(store.submitRecord(id, 'omit', { ...expected, candidates: [] })).rejects.toThrow('ledger-mismatch')
    await expect(store.submitRecord(id, 'contradict', { ...expected, candidates: [{ ...expected.candidates[0], impact: 'critical' }] })).rejects.toThrow('ledger-mismatch')
    await expect(store.submitFinalJson(id, 'malformed', 'secret-value{')).rejects.toThrow('malformed-json')
    expect((await store.getRawResults(id)).at(-1)?.raw).toBe('[redacted]{')
    expect((await store.getSnapshot(id)).run.progress.status).toBe('active')
    expect((await store.getSnapshot(id)).run.reportRevision).toBe(1)
    const { operation: _, ...json } = expected
    await store.submitFinalJson(id, 'corrected', JSON.stringify(json))
    expect((await store.getSnapshot(id)).run.reportRevision).toBe(2)
  })

  it('never projects incomplete empty reports as clean and restores interrupted runs without replay', async () => {
    const { store, run, adapter, options } = fixture()
    const { id } = await run()
    await store.submitRecord(id, 'empty', await store.expectedRecord(id))
    expect(projectReviewReport(await store.getSnapshot(id)).summary).toBe('partial-empty')
    const restored = new ReviewReportStore(adapter, options)
    const snapshot = await restored.getSnapshot(id)
    expect(snapshot.run.progress.status).toBe('partial')
    expect(snapshot.coverage.complete).toBe(false)
    expect(snapshot.coverage.limitations).toContain('interrupted-run')
    expect(snapshot.structured).toBe(true)
    await expect(restored.submitRecord(id, 'late', await restored.expectedRecord(id))).rejects.toThrow('run-not-active')
  })

  it('validates repair refs and grant scope and does not reuse verification older than the edit', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    const diagnosticId = (await store.getSnapshot(id)).retainedIds[0]
    const update = (executionRefs: string[], observation = 'edited') => ({ operation: 'reconcile', updates: [{ diagnosticId, observation, explanation: 'Handled', executionRefs }] })
    await expect(store.reconcile(id, 'forged', update(['invented']))).rejects.toThrow('invalid-execution-ref')
    await expect(store.recordExecution(id, { ref: 'unauthorized', kind: 'edit', diagnosticIds: [diagnosticId], paths: ['src/a.ts'], succeeded: true })).rejects.toThrow('action-not-authorized')
    const grantId = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [diagnosticId], paths: ['src/a.ts'], expiresAt: 200 })
    await expect(store.recordExecution(id, { ref: 'wrong-path', kind: 'edit', diagnosticIds: [diagnosticId], paths: ['src/b.ts'], grantId, succeeded: true })).rejects.toThrow('edit-outside-grant')
    const verifyGrant = await store.grantAction(id, { kind: 'verification', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [diagnosticId], expiresAt: 200 })
    await store.recordExecution(id, { ref: 'old-test', kind: 'verification', diagnosticIds: [diagnosticId], paths: [], grantId: verifyGrant, succeeded: true })
    await store.recordExecution(id, { ref: 'edit', kind: 'edit', diagnosticIds: [diagnosticId], paths: ['src/a.ts'], grantId, succeeded: true })
    await store.reconcile(id, 'repair', update(['old-test', 'edit']))
    expect((await store.getSnapshot(id)).actions.at(-1)).toMatchObject({ state: 'applied', verification: 'not-run' })
    await store.recordExecution(id, { ref: 'new-test', kind: 'verification', diagnosticIds: [diagnosticId], paths: [], grantId: verifyGrant, succeeded: false })
    await store.reconcile(id, 'repair-tested', update(['edit', 'new-test']))
    expect((await store.getSnapshot(id)).actions.at(-1)).toMatchObject({ state: 'applied', verification: 'failed' })
  })

  it('requires new host evidence for not-needed and keeps the original report facts', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    const diagnosticId = (await store.getSnapshot(id)).retainedIds[0]
    const update = (refs: string[]) => ({ operation: 'reconcile', updates: [{ diagnosticId, observation: 'not-needed', explanation: 'Existing guard is sufficient', executionRefs: refs }] })
    await expect(store.reconcile(id, 'no-proof', update([]))).rejects.toThrow('new-evidence-required')
    await store.recordExecution(id, { ref: 'proof', kind: 'evidence', diagnosticIds: [diagnosticId], paths: ['src/a.ts'], succeeded: true, evidence: [{ quote: 'if (!value) return', relevance: 'Actual caller guards input' }] })
    await store.reconcile(id, 'with-proof', update(['proof']))
    const snapshot = await store.getSnapshot(id)
    expect(snapshot.actions.at(-1)?.state).toBe('unnecessary')
    expect(snapshot.assessments).toHaveLength(2)
    expect(snapshot.retainedIds).toContain(diagnosticId)
    expect(snapshot.diagnostics[0].claim.explanation).toBe('Mechanism 0')
    await expect(store.reconcile(id, 'reused-proof', update(['proof']))).rejects.toThrow('new-evidence-required')
  })

  it('persists publication reservations before sending and restores pending as uncertain', async () => {
    const { store, run, adapter, options } = fixture()
    const { id, anchorKey } = await run({}, true)
    await populate(store, id, anchorKey)
    const diagnosticIds = (await store.getSnapshot(id)).retainedIds
    const grantId = await store.grantAction(id, { kind: 'publication', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, expiresAt: 200 })
    const request = { grantId, diagnosticIds, remoteHead: 'head', kind: 'inline' as const, normalizedContent: 'The missing guard fails.' }
    await expect(store.beginPublication(id, { ...request, remoteHead: 'changed' })).rejects.toThrow('stale-publication-head')
    const results = await Promise.all([store.beginPublication(id, request), store.beginPublication(id, request)])
    expect(results.filter(result => result.shouldSend)).toHaveLength(1)
    expect(results[0].operation.id).toBe(results[1].operation.id)
    const restored = new ReviewReportStore(adapter, options)
    expect((await restored.getPublications(id))[0].state).toBe('uncertain')
    expect((await restored.getSnapshot(id)).actions.at(-1)?.state).toBe('uncertain')
    await expect(restored.beginPublication(id, request)).rejects.toThrow('action-not-authorized')
    await restored.settlePublication(id, results[0].operation.id, { state: 'succeeded', externalRef: 'remote-42' })
    expect((await restored.getSnapshot(id)).actions.at(-1)?.state).toBe('succeeded')
    await expect(restored.settlePublication(id, results[0].operation.id, { state: 'failed' })).rejects.toThrow('publication-already-succeeded')
  })

  it('allows explicitly authorized zero-finding summaries without invented diagnostic ids', async () => {
    const { store, run } = fixture()
    const { id } = await run({}, true)
    await store.submitRecord(id, 'empty', await store.expectedRecord(id))
    const grantId = await store.grantAction(id, { kind: 'publication', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [], expiresAt: 200 })
    const result = await store.beginPublication(id, { grantId, diagnosticIds: [], remoteHead: 'head', kind: 'summary', normalizedContent: 'Partial review; inspected portions have no findings.' })
    expect(result.shouldSend).toBe(true)
    expect((await store.getSnapshot(id)).actions[0].diagnosticIds).toEqual([])
    await expect(store.settlePublication(id, result.operation.id, { state: 'applied' as 'succeeded' })).rejects.toThrow('invalid-enum')
  })

  it('keeps publication operations run-owned and requires query-confirmed retries', async () => {
    const { store, run } = fixture()
    const first = await run({}, true)
    const second = await run({}, true)
    await populate(store, first.id, first.anchorKey)
    await populate(store, second.id, second.anchorKey)
    const requests = await Promise.all([first, second].map(async ({ id }) => {
      const diagnosticIds = (await store.getSnapshot(id)).retainedIds
      const grantId = await store.grantAction(id, { kind: 'publication', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, expiresAt: 200 })
      return { id, request: { grantId, diagnosticIds, remoteHead: 'head', kind: 'inline' as const, normalizedContent: 'Same issue' } }
    }))
    const results = await Promise.all(requests.map(item => store.beginPublication(item.id, item.request)))
    expect(results.filter(item => item.shouldSend)).toHaveLength(2)
    expect(results[0].operation.id).not.toBe(results[1].operation.id)
    await expect(store.settlePublication(requests[1].id, results[0].operation.id, { state: 'succeeded', externalRef: 'remote-42' })).rejects.toThrow('unknown-publication')
    await store.settlePublication(requests[1].id, results[1].operation.id, { state: 'succeeded', externalRef: 'remote-42' })
    expect((await store.getSnapshot(requests[1].id)).actions.at(-1)).toMatchObject({ state: 'succeeded', externalRef: 'remote-42' })
    const owner = 0
    const operationId = results[owner].operation.id
    await store.settlePublication(requests[owner].id, operationId, { state: 'uncertain' })
    await expect(store.retryPublication(requests[owner].id, operationId, requests[owner].request.grantId, 'head', false)).rejects.toThrow('publication-retry-not-safe')
    expect((await store.retryPublication(requests[owner].id, operationId, requests[owner].request.grantId, 'head', true)).state).toBe('pending')
  })

  it('scrubs candidate excerpts in all durable representations', async () => {
    const { store, run, data } = fixture()
    const { id, anchorKey } = await run()
    const input = candidate(anchorKey)
    input.support[0].quote = 'secret-value'
    await store.submitLedger(id, 'redacted', { operation: 'append-candidates', candidates: [input] })
    expect(data.get(id)).not.toContain('secret-value')
    expect((await store.expectedRecord(id)).candidates[0].support[0].quote).toBe('[redacted]')
  })

  it('orders equal-severity findings by path and line rather than assessment confidence', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run({ reportLimit: 1 })
    const early = candidate(anchorKey, 1, 'First mechanism')
    early.assessment.disposition = 'unchecked'
    const later = candidate(anchorKey, 8, 'Later mechanism')
    later.assessment.disposition = 'proven'
    const result = await store.submitLedger(id, 'rank', { operation: 'append-candidates', candidates: [later, early] })
    expect((await store.getSnapshot(id)).retainedIds).toEqual([result.accepted[1].diagnosticId])
  })

  it('allows a fresh authorized repair epoch after completion without reopening review writes', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    const diagnosticId = (await store.getSnapshot(id)).retainedIds[0]
    await store.finish(id, 'finished')
    const update = { operation: 'reconcile', updates: [{ diagnosticId, observation: 'edited', explanation: 'Applied guarded edit', executionRefs: ['followup-edit'] }] }
    await expect(store.reconcile(id, 'late', update)).rejects.toThrow('run-not-active')
    await expect(store.beginActionPhase(id, 'forged')).rejects.toThrow('action-not-authorized')
    const grantId = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [diagnosticId], paths: ['src/a.ts'], expiresAt: 200 })
    const epoch = await store.beginActionPhase(id, grantId)
    await expect(store.beginActionPhase(id, grantId)).rejects.toThrow('action-phase-already-active')
    await expect(store.submitRecord(id, 'late-record', await store.expectedRecord(id))).rejects.toThrow('invalid-action-epoch')
    await expect(store.submitLedger(id, 'late-ledger', { operation: 'append-candidates', candidates: [candidate(anchorKey)] })).rejects.toThrow('invalid-action-epoch')
    await expect(store.reconcile(id, 'missing-epoch', update)).rejects.toThrow('invalid-action-epoch')
    const edit = { ref: 'followup-edit', kind: 'edit' as const, diagnosticIds: [diagnosticId], paths: ['src/a.ts'], grantId, succeeded: true }
    await expect(store.recordExecution(id, edit)).rejects.toThrow('invalid-action-epoch')
    await store.recordExecution(id, { ...edit, actionEpoch: epoch })
    const result = await store.reconcile(id, 'late', update, epoch)
    expect((await store.getSnapshot(id)).actions.at(-1)?.state).toBe('applied')
    await expect(store.endActionPhase(id, 'wrong-epoch')).rejects.toThrow('invalid-action-epoch')
    await store.endActionPhase(id, epoch)
    expect((await store.getSnapshot(id)).run.progress.status).toBe('finished')
    expect(await store.reconcile(id, 'late', update, epoch)).toEqual(result)
    await expect(store.reconcile(id, 'new-late', update, epoch)).rejects.toThrow('run-not-active')
    await expect(store.beginActionPhase(id, grantId)).rejects.toThrow('action-not-authorized')
    const newGrant = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [diagnosticId], paths: ['src/a.ts'], expiresAt: 200 })
    const newEpoch = await store.beginActionPhase(id, newGrant)
    await expect(store.reconcile(id, 'stale-epoch', update, epoch)).rejects.toThrow('invalid-action-epoch')
    await expect(store.reconcile(id, 'old-execution', update, newEpoch)).rejects.toThrow('invalid-execution-ref')
    await store.endActionPhase(id, newEpoch)
  })

  it('restricts repair epochs to granted diagnostics and rejects expired grants', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey, 2)
    await store.finish(id, 'finished')
    const [first, second] = (await store.getSnapshot(id)).retainedIds
    const grantId = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [first], paths: ['src/a.ts'], expiresAt: 200 })
    const epoch = await store.beginActionPhase(id, grantId)
    const update = (diagnosticId: string) => ({ operation: 'reconcile', updates: [{ diagnosticId, observation: 'left-open', explanation: 'Outside this repair', executionRefs: [] }] })
    await expect(store.reconcile(id, 'outside-scope', update(second), epoch)).rejects.toThrow('action-not-authorized')
    await store.reconcile(id, 'in-scope', update(first), epoch)
    await store.endActionPhase(id, epoch)
    await expect(store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [first], expiresAt: 99 })).rejects.toThrow('invalid-grant')
  })

  it('does not restore a repair epoch or grants after restart', async () => {
    const { store, run, adapter, options } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    await store.finish(id, 'finished')
    const diagnosticIds = (await store.getSnapshot(id)).retainedIds
    const grantId = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, paths: ['src/a.ts'], expiresAt: 200 })
    const epoch = await store.beginActionPhase(id, grantId)
    const restored = new ReviewReportStore(adapter, options)
    expect((await restored.getSnapshot(id)).run.progress.status).toBe('partial')
    await expect(restored.beginActionPhase(id, grantId)).rejects.toThrow('action-not-authorized')
    await expect(restored.reconcile(id, 'old-task', { operation: 'reconcile', updates: [] }, epoch)).rejects.toThrow('run-not-active')
    await expect(restored.recordExecution(id, { ref: 'late-edit', kind: 'edit', diagnosticIds, paths: ['src/a.ts'], grantId, actionEpoch: epoch, succeeded: true })).rejects.toThrow('run-not-active')
  })

  it('publishes immutable snapshots after durable changes, not repeated calls or failed saves', async () => {
    const { store, run, adapter } = fixture()
    const snapshots: unknown[] = []
    const unsubscribe = store.subscribe(snapshot => { snapshots.push(snapshot); expect(Object.isFrozen(snapshot.run)).toBe(true) })
    store.subscribe(() => { throw new Error('observer-error') })
    const { id, anchorKey } = await run()
    const before = snapshots.length
    const input = { operation: 'append-candidates', candidates: [candidate(anchorKey)] }
    await store.submitLedger(id, 'once', input)
    expect(snapshots.length).toBe(before + 1)
    await store.submitLedger(id, 'once', input)
    expect(snapshots.length).toBe(before + 1)
    const save = adapter.save
    adapter.save = async () => { throw new Error('disk-full') }
    await expect(store.setStage(id, 'assess')).rejects.toThrow('disk-full')
    expect(snapshots.length).toBe(before + 1)
    adapter.save = save
    unsubscribe()
    await store.setStage(id, 'assess')
    expect(snapshots.length).toBe(before + 1)
  })

  it('counts independent verifier receipts only, not model assessments or runtime tests', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    const snapshot = await store.getSnapshot(id)
    const diagnosticId = snapshot.retainedIds[0]
    expect(snapshot.run.progress.verifiedCandidates).toBe(0)
    const grantId = await store.grantAction(id, { kind: 'verification', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [diagnosticId], expiresAt: 200 })
    await store.recordExecution(id, { ref: 'test-command', kind: 'verification', diagnosticIds: [diagnosticId], paths: [], grantId, succeeded: true })
    expect((await store.getSnapshot(id)).run.progress.verifiedCandidates).toBe(0)
    const receipt = { ref: 'verifier-completion', diagnosticId, assessmentId: snapshot.assessments[0].id, finderTaskKey: 'finder-task', verifierTaskKey: 'verifier-task' }
    await expect(store.noteIndependentVerification(id, { ...receipt, verifierTaskKey: 'finder-task' })).rejects.toThrow('verifier-not-independent')
    await store.noteIndependentVerification(id, receipt)
    await store.noteIndependentVerification(id, receipt)
    expect((await store.getSnapshot(id)).run.progress.verifiedCandidates).toBe(1)
    expect((await store.getSnapshot(id)).assessments[0].sourceTaskKey).toBe('verifier-task')
  })

  it('authorizes adapter calls before mutation and rejects wrong scope, expired grants and inactive repairs', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    const diagnosticIds = (await store.getSnapshot(id)).retainedIds
    const grantId = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, paths: ['src/a.ts'], expiresAt: 200 })
    const grant = await store.assertActionAuthorized(id, grantId, 'repair', diagnosticIds, ['src/a.ts'])
    expect(Object.isFrozen(grant)).toBe(true)
    expect(Object.isFrozen(grant.paths)).toBe(true)
    await expect(store.assertActionAuthorized(id, grantId, 'publication', diagnosticIds)).rejects.toThrow('action-not-authorized')
    await expect(store.assertActionAuthorized(id, grantId, 'repair', ['forged'], ['src/a.ts'])).rejects.toThrow('unknown-diagnostic')
    await expect(store.assertActionAuthorized(id, grantId, 'repair', diagnosticIds, ['src/b.ts'])).rejects.toThrow('action-outside-grant')
    await expect(store.assertActionAuthorized(id, grantId, 'repair', diagnosticIds)).rejects.toThrow('repair-scope-required')
    await store.finish(id, 'finished')
    await expect(store.assertActionAuthorized(id, grantId, 'repair', diagnosticIds, ['src/a.ts'])).rejects.toThrow('run-not-active')
    const epoch = await store.beginActionPhase(id, grantId)
    expect((await store.assertActionAuthorized(id, grantId, 'repair', diagnosticIds, ['src/a.ts'])).id).toBe(grantId)
    const otherGrant = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, paths: ['src/a.ts'], expiresAt: 200 })
    await expect(store.assertActionAuthorized(id, otherGrant, 'repair', diagnosticIds, ['src/a.ts'])).rejects.toThrow('action-grant-mismatch')
    await store.endActionPhase(id, epoch)
    expect((await store.getSnapshot(id)).actions).toHaveLength(0)
  })

  it('checks grant expiry again before invoking an adapter', async () => {
    let now = 100
    let id = 0
    const data = new Map<string, string>()
    const store = new ReviewReportStore({ listRunIds: async () => [...data.keys()], load: async key => data.get(key) ?? null, save: async (key, value) => { data.set(key, value) } },
      { now: () => now, id: () => `host-${++id}`, sanitizeExcerpt: value => value })
    const runId = await store.createRun({ conversationKey: 'conversation', scope: { kind: 'workspace', workspaceKey: 'workspace', repository: { projectKey: 'project' }, revision: { base: 'base', head: 'head' }, pathFilter: [] },
      policy: { level: 'high', recipe: 'local-eight', recipeRevision: 1, execution: 'inline', presentation: 'terminal', reportLimit: 8 } })
    const anchorKey = await store.registerAnchor(runId, { path: 'src/a.ts', revision: 'head', side: 'after', span: { start: 1, end: 2 } })
    await store.start(runId)
    await populate(store, runId, anchorKey)
    const diagnosticIds = (await store.getSnapshot(runId)).retainedIds
    const grantId = await store.grantAction(runId, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, paths: ['src/a.ts'], expiresAt: 200 })
    now = 200
    await expect(store.assertActionAuthorized(runId, grantId, 'repair', diagnosticIds, ['src/a.ts'])).rejects.toThrow('action-not-authorized')
  })

  it('records blocked, failed and skipped host outcomes without allowing forged success states', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    const diagnosticIds = (await store.getSnapshot(id)).retainedIds
    for (const state of ['blocked', 'failed', 'skipped'] as const) {
      expect(await store.recordActionReceipt(id, { kind: 'repair', state, diagnosticIds, reason: 'Host adapter unavailable' })).toMatchObject({ kind: 'repair', state, verification: 'not-run' })
    }
    for (const state of ['applied', 'unnecessary', 'succeeded', 'uncertain']) {
      await expect(store.recordActionReceipt(id, { kind: 'repair', state: state as 'blocked', diagnosticIds, reason: 'Untrusted success' })).rejects.toThrow('invalid-enum')
    }
    await expect(store.recordActionReceipt(id, { kind: 'publication', state: 'skipped', diagnosticIds, reason: 'Invalid state' })).rejects.toThrow('invalid-enum')
    await expect(store.recordActionReceipt(id, { kind: 'repair', state: 'blocked', diagnosticIds: ['forged'], reason: 'Wrong run' })).rejects.toThrow('unknown-diagnostic')
    expect((await store.getSnapshot(id)).actions).toHaveLength(3)
    expect((await store.getSnapshot(id)).structured).toBe(true)
  })

  it('accepts unchanged guidance evidence only after host registration and keeps read provenance', async () => {
    const { store, run, data, adapter, options } = fixture()
    const { id, anchorKey } = await run()
    const input = candidate(anchorKey)
    input.support = [{ path: 'AGENTS.md', quote: 'Guard every input', relevance: 'Required project rule' }]
    const ledger = { operation: 'append-candidates', candidates: [input] }
    await expect(store.submitLedger(id, 'unauthorized-guidance', ledger)).rejects.toThrow('unsupported-evidence-path')
    await store.registerEvidenceSource(id, { path: 'AGENTS.md', revision: 'guidance-revision', toolCallKey: 'host-read-guidance', excerpt: 'Guard every input. secret-value' })
    await store.submitLedger(id, 'authorized-guidance', ledger)
    const evidence = (await store.getSnapshot(id)).evidence[0]
    expect(evidence.source).toEqual({ path: 'AGENTS.md', revision: 'guidance-revision', toolCallKey: 'host-read-guidance' })
    expect(data.get(id)).not.toContain('secret-value')
    const forged = { ...input, location: { anchorKey, path: 'AGENTS.md', line: 1 } }
    await expect(store.submitLedger(id, 'forged-guidance-anchor', { operation: 'append-candidates', candidates: [forged] })).rejects.toThrow('invalid-anchor')
    const other = await run()
    await expect(store.submitLedger(other.id, 'other-run-guidance', { operation: 'append-candidates', candidates: [{ ...input, location: { ...input.location, anchorKey: other.anchorKey } }] })).rejects.toThrow('unsupported-evidence-path')
    const restored = new ReviewReportStore(adapter, options)
    expect((await restored.getSnapshot(id)).evidence[0].source).toEqual(evidence.source)
  })

  it('resolves other-file evidence to its own side and rejects ambiguous revisions', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await store.registerAnchor(id, { path: 'src/caller.ts', revision: 'base', side: 'before', span: { start: 1, end: 8 } })
    const input = candidate(anchorKey)
    input.support = [{ path: 'src/caller.ts', quote: 'call(value)', relevance: 'Caller still invokes this path' }]
    await store.submitLedger(id, 'caller-before', { operation: 'append-candidates', candidates: [input] })
    expect((await store.getSnapshot(id)).evidence[0].source.revision).toBe('base')
    await store.registerAnchor(id, { path: 'src/caller.ts', revision: 'head', side: 'after', span: { start: 1, end: 8 } })
    await expect(store.submitLedger(id, 'ambiguous-caller', { operation: 'append-candidates', candidates: [input] })).rejects.toThrow('ambiguous-evidence-source')
    await store.registerEvidenceSource(id, { path: 'src/caller.ts', revision: 'head', toolCallKey: 'caller-read', excerpt: 'call(value)' })
    await store.submitLedger(id, 'resolved-caller', { operation: 'append-candidates', candidates: [input] })
    const evidence = (await store.getSnapshot(id)).evidence
    expect(evidence.map(item => item.source.revision)).toEqual(['base', 'head'])
    expect(evidence[1].source.toolCallKey).toBe('caller-read')
  })

  it('strips internal and unknown anchor fields supplied by host scope adapters', async () => {
    const { store, run } = fixture()
    const { id } = await run()
    const scopeAnchor = { anchorKey: 'internal-key', internalToken: 'private', path: 'src/a.ts', revision: 'head', side: 'after' as const, span: { start: 1, end: 8, internalOffset: 42 } }
    const anchorKey = await store.registerAnchor(id, scopeAnchor)
    await store.submitLedger(id, 'sanitized-anchor', { operation: 'append-candidates', candidates: [candidate(anchorKey)] })
    expect((await store.getSnapshot(id)).diagnostics[0].anchor).toEqual({ path: 'src/a.ts', revision: 'head', side: 'after', span: { start: 1, end: 1 } })
    expect(JSON.stringify((await store.getSnapshot(id)).diagnostics[0].anchor)).not.toContain('internal')
  })

  it('updates applied receipts from actual verification and invalidates results after a later edit', async () => {
    const { store, run, adapter, options } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    const diagnosticIds = (await store.getSnapshot(id)).retainedIds
    const repair = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, paths: ['src/a.ts'], expiresAt: 200 })
    const verify = await store.grantAction(id, { kind: 'verification', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, paths: ['src/a.ts'], expiresAt: 200 })
    const edit = (ref: string) => store.recordExecution(id, { ref, kind: 'edit', diagnosticIds, paths: ['src/a.ts'], grantId: repair, succeeded: true })
    await edit('edit-one')
    await store.reconcile(id, 'applied', { operation: 'reconcile', updates: [{ diagnosticId: diagnosticIds[0], observation: 'edited', explanation: 'Applied edit', executionRefs: ['edit-one'] }] })
    const checkedThroughSequence = (await store.getSnapshot(id)).events.at(-1)!.sequence
    await store.recordExecution(id, { ref: 'verify-one', kind: 'verification', diagnosticIds, paths: ['src/a.ts'], grantId: verify, succeeded: true,
      command: 'npm test', codeRevision: 'edited-code-one', missingCases: ['Manual UI checks'], checkedThroughSequence })
    let snapshot = await store.getSnapshot(id)
    expect(snapshot.actions.at(-1)?.verification).toBe('passed')
    expect(snapshot.verifications[0]).toMatchObject({ ref: 'verify-one', command: 'npm test', codeRevision: 'edited-code-one', afterLatestEdit: true, missingCases: ['Manual UI checks'] })
    expect(JSON.stringify(snapshot.verifications)).not.toContain('grantId')
    expect(JSON.parse(presentReviewJson(snapshot)).verifications).toHaveLength(1)
    await edit('edit-two')
    snapshot = await store.getSnapshot(id)
    expect(snapshot.actions.at(-1)?.verification).toBe('not-run')
    expect(snapshot.verifications[0].afterLatestEdit).toBe(false)
    await store.recordExecution(id, { ref: 'old-check-finishes-late', kind: 'verification', diagnosticIds, paths: [], grantId: verify, succeeded: true, checkedThroughSequence })
    expect((await store.getSnapshot(id)).actions.at(-1)?.verification).toBe('not-run')
    await store.recordExecution(id, { ref: 'verify-two', kind: 'verification', diagnosticIds, paths: [], grantId: verify, succeeded: false })
    expect((await store.getSnapshot(id)).actions.at(-1)?.verification).toBe('failed')
    const restored = new ReviewReportStore(adapter, options)
    snapshot = await restored.getSnapshot(id)
    expect(snapshot.verifications).toHaveLength(3)
    expect(snapshot.verifications[2].afterLatestEdit).toBe(true)
    expect(snapshot.actions.at(-1)?.verification).toBe('failed')
  })

  it('supports zero-finding verification-only epochs without allowing repair or model verification writes', async () => {
    const { store, run } = fixture()
    const { id } = await run()
    await store.submitLedger(id, 'complete-empty', { operation: 'coverage', coverage: { angles: ['lines'], limitations: [], complete: true } })
    await store.submitRecord(id, 'empty-record', await store.expectedRecord(id))
    await store.finish(id, 'finished')
    const grantId = await store.grantAction(id, { kind: 'verification', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds: [], paths: ['src/a.ts'], expiresAt: 200 })
    const epoch = await store.beginActionPhase(id, grantId)
    expect((await store.getSnapshot(id)).run.progress.stage).toBe('verify')
    await store.assertActionAuthorized(id, grantId, 'verification', [], ['src/a.ts'])
    await expect(store.recordExecution(id, { ref: 'forged-edit', kind: 'edit', diagnosticIds: [], paths: ['src/a.ts'], grantId, actionEpoch: epoch, succeeded: true })).rejects.toThrow('action-phase-only')
    await expect(store.reconcile(id, 'forged-model-verification', { operation: 'reconcile', updates: [], verification: 'passed' }, epoch)).rejects.toThrow('verification-host-only')
    await expect(store.recordExecution(id, { ref: 'wrong-path', kind: 'verification', diagnosticIds: [], paths: ['outside.ts'], grantId, actionEpoch: epoch, succeeded: true })).rejects.toThrow('verification-outside-grant')
    await store.recordExecution(id, { ref: 'actual-check', kind: 'verification', diagnosticIds: [], paths: ['src/a.ts'], grantId, actionEpoch: epoch, succeeded: true, command: 'npm test', codeRevision: 'head' })
    await store.endActionPhase(id, epoch)
    const snapshot = await store.getSnapshot(id)
    expect(snapshot.run.progress.status).toBe('finished')
    expect(snapshot.verifications[0]).toMatchObject({ diagnosticIds: [], succeeded: true, afterLatestEdit: true })
    expect(snapshot.actions).toEqual([])
    expect(snapshot.run.progress.verifiedCandidates).toBe(0)
    await expect(store.recordExecution(id, { ref: 'late-check', kind: 'verification', diagnosticIds: [], paths: [], grantId, actionEpoch: epoch, succeeded: true })).rejects.toThrow('run-not-active')
  })

  it('opens publication-only phases with exact grants and restores prior completion', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run({}, true)
    await populate(store, id, anchorKey)
    await store.finish(id, 'finished')
    const diagnosticIds = (await store.getSnapshot(id)).retainedIds
    const grantId = await store.grantAction(id, { kind: 'publication', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, expiresAt: 200 })
    const otherGrant = await store.grantAction(id, { kind: 'publication', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, expiresAt: 200 })
    const epoch = await store.beginActionPhase(id, grantId)
    expect((await store.getSnapshot(id)).run.progress.stage).toBe('publish')
    await store.assertActionAuthorized(id, grantId, 'publication', diagnosticIds)
    await expect(store.assertActionAuthorized(id, otherGrant, 'publication', diagnosticIds)).rejects.toThrow('action-grant-mismatch')
    await expect(store.setStage(id, 'repair')).rejects.toThrow('action-phase-only')
    await expect(store.setStage(id, 'verify')).rejects.toThrow('action-phase-only')
    await store.setStage(id, 'publish')
    await expect(store.submitLedger(id, 'late-ledger-publish', { operation: 'coverage', coverage: { angles: [], limitations: [], complete: true } })).rejects.toThrow('invalid-action-epoch')
    await expect(store.reconcile(id, 'publish-reconcile', { operation: 'reconcile', updates: [] }, epoch)).rejects.toThrow('publication-host-only')
    await expect(store.recordExecution(id, { ref: 'publish-edit', kind: 'edit', diagnosticIds, paths: ['src/a.ts'], grantId, actionEpoch: epoch, succeeded: true })).rejects.toThrow('action-phase-only')
    const request = { grantId, diagnosticIds, remoteHead: 'head', kind: 'inline' as const, normalizedContent: 'Actual finding' }
    await expect(store.beginPublication(id, { ...request, grantId: otherGrant })).rejects.toThrow('action-grant-mismatch')
    const publication = await store.beginPublication(id, request)
    await store.settlePublication(id, publication.operation.id, { state: 'succeeded', externalRef: 'comment-1' })
    await store.endActionPhase(id, epoch)
    expect((await store.getSnapshot(id)).run.progress.status).toBe('finished')
    expect((await store.getSnapshot(id)).actions.at(-1)?.state).toBe('succeeded')
  })

  it('cancels publication phases without erasing reports or permitting further sends', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run({}, true)
    await populate(store, id, anchorKey)
    await store.finish(id, 'finished')
    const diagnosticIds = (await store.getSnapshot(id)).retainedIds
    const grantId = await store.grantAction(id, { kind: 'publication', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, expiresAt: 200 })
    const epoch = await store.beginActionPhase(id, grantId)
    await store.finish(id, 'cancelled')
    expect((await store.getSnapshot(id)).retainedIds).toEqual(diagnosticIds)
    expect((await store.getSnapshot(id)).structured).toBe(true)
    await expect(store.assertActionAuthorized(id, grantId, 'publication', diagnosticIds)).rejects.toThrow('run-not-active')
    await expect(store.beginPublication(id, { grantId, diagnosticIds, remoteHead: 'head', kind: 'inline', normalizedContent: 'Late publish' })).rejects.toThrow('run-not-active')
    await expect(store.endActionPhase(id, epoch)).rejects.toThrow('invalid-action-epoch')
    expect((await store.getSnapshot(id)).run.progress.status).toBe('cancelled')
  })

  it('reconciles only actual successful current-phase edits after an adapter partially fails', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey, 2)
    await store.finish(id, 'finished')
    const diagnosticIds = (await store.getSnapshot(id)).retainedIds
    const grantId = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, paths: ['src/a.ts'], expiresAt: 200 })
    const epoch = await store.beginActionPhase(id, grantId)
    expect(await store.reconcileObservedEdits(id, grantId, diagnosticIds, epoch)).toEqual([])
    const adapter = async () => {
      await store.recordExecution(id, { ref: 'actual-partial-edit', kind: 'edit', diagnosticIds: [diagnosticIds[0]], paths: ['src/a.ts'], grantId, actionEpoch: epoch, succeeded: true })
      await store.recordExecution(id, { ref: 'failed-edit', kind: 'edit', diagnosticIds: [diagnosticIds[1]], paths: ['src/a.ts'], grantId, actionEpoch: epoch, succeeded: false })
      throw new Error('second-file-failed')
    }
    await expect((async () => {
      try { await adapter() } finally { await store.reconcileObservedEdits(id, grantId, diagnosticIds, epoch) }
    })()).rejects.toThrow('second-file-failed')
    const snapshot = await store.getSnapshot(id)
    expect(snapshot.actions).toHaveLength(1)
    expect(snapshot.actions[0]).toMatchObject({ state: 'applied', executionRef: 'actual-partial-edit', diagnosticIds: [diagnosticIds[0]], verification: 'not-run' })
    expect(await store.reconcileObservedEdits(id, grantId, diagnosticIds, epoch)).toEqual(snapshot.actions)
    expect((await store.getSnapshot(id)).actions).toHaveLength(1)
    await expect(store.reconcileObservedEdits(id, 'forged', diagnosticIds, epoch)).rejects.toThrow('action-not-authorized')
    await expect(store.reconcileObservedEdits(id, grantId, ['forged-diagnostic'], epoch)).rejects.toThrow('unknown-diagnostic')
    await expect(store.reconcileObservedEdits(id, grantId, diagnosticIds, 'old-epoch')).rejects.toThrow('invalid-action-epoch')
    await store.endActionPhase(id, epoch)
    const newGrant = await store.grantAction(id, { kind: 'repair', workspaceKey: 'workspace', headRevision: 'head', diagnosticIds, paths: ['src/a.ts'], expiresAt: 200 })
    const newEpoch = await store.beginActionPhase(id, newGrant)
    expect(await store.reconcileObservedEdits(id, newGrant, diagnosticIds, newEpoch)).toEqual([])
    await store.endActionPhase(id, newEpoch)
  })

  it('reconciles a confirmed ordinary edit once, preserves findings, and never creates an edit grant', async () => {
    const { store, run, adapter, options } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    await store.finish(id, 'finished')
    const before = await store.getSnapshot(id)
    const diagnosticId = before.retainedIds[0]
    const receipt = { ref: 'ordinary-edit', runId: id, workspaceKey: 'workspace', headRevision: 'head', paths: ['src/a.ts'],
      beforeDigest: 'before', afterDigest: 'after', expectedSequence: before.events.at(-1)!.sequence,
      evidence: [{ path: 'src/a.ts', revision: 'after', excerpt: 'if (!value) return; read(value)' }], verifyCurrent: async () => true }
    const updates = [{ diagnosticId, outcome: 'resolved' as const, explanation: 'The new guard prevents absent input reaching read', mutationRefs: [receipt.ref], evidence: [{ path: 'src/a.ts', quote: 'if (!value) return;', relevance: 'Corrects absent-input mechanism' }] }]
    const actions = await store.reconcileExternalEdit(id, receipt, updates)
    expect(actions).toMatchObject([{ kind: 'repair', state: 'applied', verification: 'not-run', executionRef: 'ordinary-edit' }])
    expect(await store.reconcileExternalEdit(id, receipt, updates)).toEqual(actions)
    const after = await store.getSnapshot(id)
    expect(after.actions).toHaveLength(1)
    expect(after.diagnostics).toEqual(before.diagnostics)
    expect(after.assessments).toEqual(before.assessments)
    expect(after.retainedIds).toEqual(before.retainedIds)
    expect(after.evidence.at(-1)?.source).toEqual({ path: 'src/a.ts', revision: 'after', toolCallKey: 'ordinary-edit' })
    expect(after.run.progress.status).toBe('finished')
    expect(after.verifications).toEqual([])
    await expect(store.beginActionPhase(id, receipt.ref)).rejects.toThrow('action-not-authorized')
    const restored = new ReviewReportStore(adapter, options)
    expect(await restored.reconcileExternalEdit(id, receipt, updates)).toEqual(actions)
    await expect(store.reconcileExternalEdit(id, { ...receipt, afterDigest: 'different' }, updates)).rejects.toThrow('external-edit-receipt-conflict')
  })

  it('rejects stale current code, foreign runs, unrelated paths and unsupported resolutions atomically', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await populate(store, id, anchorKey)
    await store.finish(id, 'finished')
    const before = await store.getSnapshot(id)
    const receipt = { ref: 'ordinary-edit', runId: id, workspaceKey: 'workspace', headRevision: 'head', paths: ['src/a.ts'],
      beforeDigest: 'before', afterDigest: 'after', expectedSequence: before.events.at(-1)!.sequence,
      evidence: [{ path: 'src/a.ts', revision: 'after', excerpt: 'if (!value) return' }], verifyCurrent: async () => true }
    const updates = [{ diagnosticId: before.retainedIds[0], outcome: 'resolved' as const, explanation: 'Guard prevents failure', mutationRefs: [receipt.ref], evidence: [{ path: 'src/a.ts', quote: 'if (!value) return', relevance: 'Guard' }] }]
    await expect(store.reconcileExternalEdit(id, { ...receipt, verifyCurrent: async () => false }, updates)).rejects.toThrow('external-edit-stale-evidence')
    await expect(store.reconcileExternalEdit(id, { ...receipt, runId: 'other' }, updates)).rejects.toThrow('external-edit-run-mismatch')
    await expect(store.reconcileExternalEdit(id, { ...receipt, workspaceKey: 'other' }, updates)).rejects.toThrow('external-edit-scope-mismatch')
    await expect(store.reconcileExternalEdit(id, { ...receipt, expectedSequence: 0 }, updates)).rejects.toThrow('external-edit-stale-report')
    await expect(store.reconcileExternalEdit(id, { ...receipt, paths: ['src/unrelated.ts'] }, updates)).rejects.toThrow('edit-diagnostic-mismatch')
    await expect(store.reconcileExternalEdit(id, receipt, [{ ...updates[0], evidence: [] }])).rejects.toThrow('invalid-reassessment')
    await expect(store.reconcileExternalEdit(id, receipt, [{ ...updates[0], mutationRefs: ['invented'] }])).rejects.toThrow('invalid-reassessment')
    expect(await store.getSnapshot(id)).toEqual(before)
    const uncertain = [{ ...updates[0], outcome: 'unknown' as const, explanation: 'Cannot establish mechanism correction', evidence: [] }]
    expect(await store.reconcileExternalEdit(id, receipt, uncertain)).toMatchObject([{ state: 'skipped', verification: 'not-run' }])
  })

  it('reconciles a changed supporting caller only with matching dependency evidence and a real receipt ref', async () => {
    const { store, run } = fixture()
    const { id, anchorKey } = await run()
    await store.registerEvidenceSource(id, { path: 'src/caller.ts', revision: 'caller-before', excerpt: 'read(value)' })
    const input = candidate(anchorKey)
    input.support.push({ path: 'src/caller.ts', quote: 'read(value)', relevance: 'Caller passes absent input into the diagnostic path' })
    await store.submitLedger(id, 'caller-candidate', { operation: 'append-candidates', candidates: [input] })
    await store.submitRecord(id, 'caller-record', await store.expectedRecord(id))
    await store.finish(id, 'partial')
    const before = await store.getSnapshot(id)
    const diagnosticId = before.retainedIds[0]
    const receipt = { ref: 'caller-edit', runId: id, workspaceKey: 'workspace', headRevision: 'head', paths: ['src/caller.ts'],
      beforeDigest: 'caller-before', afterDigest: 'caller-after', expectedSequence: before.events.at(-1)!.sequence,
      evidence: [
        { path: 'src/caller.ts', revision: 'caller-after', excerpt: 'if (!value) return; read(value)' },
        { path: 'src/a.ts', revision: 'unchanged-callee', excerpt: 'return value.name' },
      ], verifyCurrent: async () => true }
    const update = { diagnosticId, outcome: 'resolved' as const, explanation: 'The caller now rejects absent input before reaching the unchanged callee', mutationRefs: [receipt.ref],
      evidence: [{ path: 'src/caller.ts', quote: 'if (!value) return;', relevance: 'Corrects the saved trigger at the recorded caller' }] }
    await expect(store.reconcileExternalEdit(id, receipt, [{ ...update, mutationRefs: ['forged-caller-edit'] }])).rejects.toThrow('invalid-reassessment')
    await expect(store.reconcileExternalEdit(id, receipt, [{ ...update, evidence: [{ path: 'src/a.ts', quote: 'return value.name', relevance: 'Unchanged anchor is insufficient' }] }])).rejects.toThrow('invalid-reassessment')
    await expect(store.reconcileExternalEdit(id, { ...receipt, paths: ['src/unrelated.ts'] }, [update])).rejects.toThrow('edit-diagnostic-mismatch')
    expect(await store.getSnapshot(id)).toEqual(before)
    expect(await store.reconcileExternalEdit(id, receipt, [update])).toMatchObject([{ kind: 'repair', state: 'applied', diagnosticIds: [diagnosticId], executionRef: 'caller-edit', verification: 'not-run' }])
    const after = await store.getSnapshot(id)
    expect(after.diagnostics).toEqual(before.diagnostics)
    expect(after.evidence.at(-1)?.source).toEqual({ path: 'src/caller.ts', revision: 'caller-after', toolCallKey: 'caller-edit' })
  })

  it('requires terminal structured local reports for ordinary-edit receipts', async () => {
    const { store, run } = fixture()
    for (const remote of [false, true]) {
      const { id, anchorKey } = await run({}, remote)
      await populate(store, id, anchorKey)
      const snapshot = await store.getSnapshot(id)
      const receipt = { ref: 'edit', runId: id, workspaceKey: 'workspace', headRevision: 'head', paths: ['src/a.ts'], beforeDigest: 'before', afterDigest: 'after',
        expectedSequence: snapshot.events.at(-1)!.sequence, evidence: [{ path: 'src/a.ts', revision: 'after', excerpt: 'guard' }], verifyCurrent: async () => true }
      await expect(store.reconcileExternalEdit(id, receipt, [])).rejects.toThrow('external-edit-terminal-required')
      if (remote) {
        await store.finish(id, 'finished')
        await expect(store.reconcileExternalEdit(id, receipt, [])).rejects.toThrow('external-edit-local-required')
      }
    }
  })

  it('does not publish unpersisted state when a save fails', async () => {
    const { store, run, adapter } = fixture()
    const { id, anchorKey } = await run()
    const save = adapter.save
    adapter.save = async () => { throw new Error('disk-full') }
    await expect(store.submitLedger(id, 'retryable', { operation: 'append-candidates', candidates: [candidate(anchorKey)] })).rejects.toThrow('disk-full')
    expect((await store.getSnapshot(id)).diagnostics).toHaveLength(0)
    adapter.save = save
    await store.submitLedger(id, 'retryable', { operation: 'append-candidates', candidates: [candidate(anchorKey)] })
    expect((await store.getSnapshot(id)).diagnostics).toHaveLength(1)
  })
})


describe('explicit semantic duplicate merges', () => {
  const proof = [{ path: 'src/a.ts', quote: 'read(value)', relevance: 'Both claims describe the same absent-input dereference and trigger' }]
  const merge = (keepId: string, duplicateIds: string[]) => ({ operation: 'merge-duplicates', groups: [{ keepId, duplicateIds, reason: 'Same absent-input dereference despite different wording', support: proof }] })
  async function pair(policy: Partial<ReportPolicy> = {}) {
    const f = fixture(); const run = await f.run(policy)
    const first = candidate(run.anchorKey, 1, 'Absent input is dereferenced before validation')
    first.location.endLine = 3
    const second = candidate(run.anchorKey, 2, 'No null check protects access to the supplied value')
    second.support = [{ quote: 'value.member', relevance: 'The same null access' }]
    const result = await f.store.submitLedger(run.id, 'pair', { operation: 'append-candidates', candidates: [first, second] })
    return { ...f, ...run, first, second, ids: result.accepted.map(item => item.diagnosticId) }
  }
  it('keeps paraphrases and distinct mechanisms separate unless explicitly merged', async () => {
    const h = await pair()
    await h.store.submitLedger(h.id, 'distinct', { operation: 'append-candidates', candidates: [candidate(h.anchorKey, 2, 'Null is handled but a race discards concurrent writes')] })
    const snapshot = await h.store.getSnapshot(h.id)
    expect(snapshot.diagnostics).toHaveLength(3); expect(snapshot.retainedIds).toHaveLength(3)
    expect(snapshot.duplicateIds).toBeUndefined()
    await h.store.submitLedger(h.id, 'merge', merge(h.ids[0], [h.ids[1]]))
    const after = await h.store.getSnapshot(h.id)
    expect(after.retainedIds).toHaveLength(2)
    expect(after.retainedIds).toContain(snapshot.diagnostics[2].id)
    expect(after.diagnostics).toHaveLength(3)
  })
  it('merges paraphrases before the cap and preserves original facts and exact final support', async () => {
    const h = await pair({ reportLimit: 2 })
    const other = await h.store.submitLedger(h.id, 'distinct', { operation: 'append-candidates', candidates: [candidate(h.anchorKey, 20, 'Independent race')] })
    const before = await h.store.getSnapshot(h.id)
    expect(before.run.progress.omittedByLimit).toBe(1)
    const result = await h.store.submitLedger(h.id, 'merge', merge(h.ids[0], [h.ids[1]]))
    expect(result.accepted).toEqual([{ index: 0, diagnosticId: h.ids[0] }])
    const after = await h.store.getSnapshot(h.id)
    expect(after.duplicateIds).toEqual({ [h.ids[1]]: h.ids[0] })
    expect(after.retainedIds).toEqual([h.ids[0], other.accepted[0].diagnosticId])
    expect(after.run.progress.omittedByLimit).toBe(0)
    expect(after.run.progress.verifiedCandidates).toBe(0)
    expect(after.diagnostics.map(item => ({ ...item, evidenceKeys: [] }))).toEqual(before.diagnostics.map(item => ({ ...item, evidenceKeys: [] })))
    expect(after.assessments).toEqual(before.assessments)
    expect(after.evidence).toEqual(expect.arrayContaining(before.evidence))
    const expected = await h.store.expectedRecord(h.id)
    expect(expected.candidates[0].support).toEqual([...h.first.support, ...h.second.support, ...proof])
    await expect(h.store.submitRecord(h.id, 'missing-merged-support', { ...expected, candidates: [{ ...expected.candidates[0], support: h.first.support }, expected.candidates[1]] })).rejects.toThrow('ledger-mismatch')
    await h.store.submitRecord(h.id, 'final', expected)
    expect((await h.store.getSnapshot(h.id)).structured).toBe(true)
    const restored = new ReviewReportStore(h.adapter, h.options)
    expect((await restored.getSnapshot(h.id)).duplicateIds).toEqual(after.duplicateIds)
    expect((await restored.expectedRecord(h.id)).candidates).toEqual(expected.candidates)
  })
  it('is idempotent through modelWrite and persists the merge rationale', async () => {
    const h = await pair(); const input = merge(h.ids[0], [h.ids[1]])
    const results = await Promise.all(Array.from({ length: 4 }, () => h.store.submitLedger(h.id, 'same-merge', input)))
    expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true)
    const snapshot = await h.store.getSnapshot(h.id)
    expect(snapshot.events.filter(event => event.type === 'duplicates-merged')).toHaveLength(1)
    expect(JSON.parse(h.data.get(h.id)!).duplicateMerges).toEqual(input.groups)
    await expect(h.store.submitLedger(h.id, 'same-merge', merge(h.ids[1], [h.ids[0]]))).rejects.toThrow('tool-call-conflict')
    await h.store.finish(h.id, 'partial')
    expect(await h.store.submitLedger(h.id, 'same-merge', input)).toEqual(results[0])
    await expect(h.store.submitLedger(h.id, 'late-merge', input)).rejects.toThrow('run-not-active')
  })
  it.each(['nonoverlap', 'before-revision', 'other-path', 'other-kind', 'no-span', 'foreign-id'] as const)('rejects %s without changing ledger facts', async kind => {
    const h = await pair()
    let key = h.anchorKey
    if (kind === 'before-revision') key = await h.store.registerAnchor(h.id, { path: 'src/a.ts', revision: 'base', side: 'before', span: { start: 1, end: 10 } })
    if (kind === 'other-path') key = await h.store.registerAnchor(h.id, { path: 'src/b.ts', revision: 'head', side: 'after', span: { start: 1, end: 10 } })
    const input = candidate(key, kind === 'nonoverlap' ? 10 : 1, 'Another wording')
    if (kind === 'other-path') input.location.path = 'src/b.ts'
    if (kind === 'other-kind') input.kind = 'security'
    if (kind === 'no-span') delete input.location.line
    let duplicate: string
    if (kind === 'foreign-id') {
      const foreign = await h.run()
      duplicate = (await h.store.submitLedger(foreign.id, 'foreign', { operation: 'append-candidates', candidates: [candidate(foreign.anchorKey)] })).accepted[0].diagnosticId
    } else duplicate = (await h.store.submitLedger(h.id, 'other', { operation: 'append-candidates', candidates: [input] })).accepted[0].diagnosticId
    const before = await h.store.getSnapshot(h.id)
    await expect(h.store.submitLedger(h.id, 'invalid-merge', merge(h.ids[0], [duplicate]))).rejects.toThrow(kind === 'foreign-id' ? 'unknown-diagnostic' : 'duplicate-anchor-mismatch')
    const after = await h.store.getSnapshot(h.id)
    expect(after.diagnostics).toEqual(before.diagnostics); expect(after.evidence).toEqual(before.evidence)
    expect(after.assessments).toEqual(before.assessments); expect(after.retainedIds).toEqual(before.retainedIds)
    expect(after.duplicateIds).toBeUndefined()
  })
  it('rejects malformed, evidence-free and cyclic groups atomically', async () => {
    const h = await pair(); const group = merge(h.ids[0], [h.ids[1]]).groups[0]
    const cases = [
      { ...group, duplicateIds: [] }, { ...group, duplicateIds: [h.ids[0]] }, { ...group, duplicateIds: [h.ids[1], h.ids[1]] },
      { ...group, reason: '' }, { ...group, support: [] }, { ...group, support: [{ quote: '', relevance: 'same' }] },
      { ...group, support: [{ path: 'private.ts', quote: 'x', relevance: 'same' }] }, { ...group, keepId: 'forged' }, { ...group, disposition: 'dismissed' },
    ]
    for (const [index, invalid] of cases.entries()) {
      await expect(h.store.submitLedger(h.id, `invalid-${index}`, { operation: 'merge-duplicates', groups: [group, invalid] })).rejects.toThrow()
      expect((await h.store.getSnapshot(h.id)).duplicateIds).toBeUndefined()
    }
    await expect(h.store.submitLedger(h.id, 'empty-groups', { operation: 'merge-duplicates', groups: [] })).rejects.toThrow('invalid-duplicate-group')
    await expect(h.store.submitLedger(h.id, 'too-many-groups', { operation: 'merge-duplicates', groups: Array(33).fill(group) })).rejects.toThrow('invalid-array')
    await h.store.submitLedger(h.id, 'valid', { operation: 'merge-duplicates', groups: [group] })
    await expect(h.store.submitLedger(h.id, 'cycle', merge(h.ids[1], [h.ids[0]]))).rejects.toThrow('duplicate-merge-conflict')
  })
  it('keeps all IDs independently assessable and propagates later duplicate evidence without changing the kept assessment', async () => {
    const h = await pair()
    await h.store.submitLedger(h.id, 'merge', merge(h.ids[0], [h.ids[1]]))
    const extra = [{ quote: 'caller(undefined)', relevance: 'Independent verifier observed the trigger' }]
    await h.store.submitLedger(h.id, 'verify-duplicate', { operation: 'assess', assessments: [{ candidateId: h.ids[1], disposition: 'proven', reason: 'Actual missing input', support: extra }] })
    for (const diagnosticId of h.ids) {
      const snapshot = await h.store.getSnapshot(h.id)
      const assessment = snapshot.assessments.filter(item => item.diagnosticId === diagnosticId).at(-1)!
      await h.store.noteIndependentVerification(h.id, { ref: `verify-${diagnosticId}`, diagnosticId, assessmentId: assessment.id, finderTaskKey: 'finder', verifierTaskKey: `verifier-${diagnosticId}` })
    }
    const snapshot = await h.store.getSnapshot(h.id)
    expect(snapshot.run.progress.verifiedCandidates).toBe(2)
    expect(snapshot.retainedIds).toEqual([h.ids[0]])
    expect((await h.store.expectedRecord(h.id)).candidates[0].assessment.disposition).toBe('plausible')
    expect((await h.store.expectedRecord(h.id)).candidates[0].support).toEqual(expect.arrayContaining(extra))
    const later = { ...h.second, support: [{ quote: 'another caller', relevance: 'Further support for the duplicate' }] }
    expect((await h.store.submitLedger(h.id, 'repeat-duplicate', { operation: 'append-candidates', candidates: [later] })).accepted[0].diagnosticId).toBe(h.ids[1])
    expect((await h.store.expectedRecord(h.id)).candidates[0].support).toEqual(expect.arrayContaining(later.support))
    expect((await h.store.getSnapshot(h.id)).diagnostics).toHaveLength(2)
  })
  it('rejects merging representatives or reassigning duplicate ownership', async () => {
    const h = await pair()
    const third = (await h.store.submitLedger(h.id, 'third', { operation: 'append-candidates', candidates: [candidate(h.anchorKey, 2, 'Third paraphrase')] })).accepted[0].diagnosticId
    await h.store.submitLedger(h.id, 'merge', merge(h.ids[0], [h.ids[1]]))
    await expect(h.store.submitLedger(h.id, 'reparent', merge(third, [h.ids[0]]))).rejects.toThrow('duplicate-merge-conflict')
    await expect(h.store.submitLedger(h.id, 'reassign', merge(third, [h.ids[1]]))).rejects.toThrow('duplicate-merge-conflict')
  })
  it('rejects merges whose combined support cannot fit a final record', async () => {
    const h = await pair()
    const support = Array.from({ length: 128 }, (_, index) => ({ quote: `proof-${index}`, relevance: 'Shared mechanism' }))
    const before = await h.store.getSnapshot(h.id)
    await expect(h.store.submitLedger(h.id, 'too-much-support', { operation: 'merge-duplicates', groups: [{ ...merge(h.ids[0], [h.ids[1]]).groups[0], support }] })).rejects.toThrow('evidence-limit')
    const after = await h.store.getSnapshot(h.id)
    expect(after.evidence).toEqual(before.evidence)
    expect(after.duplicateIds).toBeUndefined()
  })
  it('never implicitly combines identical wording across classification kinds', async () => {
    const h = fixture(); const { id, anchorKey } = await h.run()
    const first = candidate(anchorKey)
    await h.store.submitLedger(id, 'kinds', { operation: 'append-candidates', candidates: [first, { ...first, kind: 'security' }] })
    expect((await h.store.getSnapshot(id)).diagnostics).toHaveLength(2)
  })
  it('exposes semantic merge while preserving independent-assessment tool restrictions', async () => {
    const h = await pair()
    const tool = createReviewTools({ runId: h.id, store: h.store, signal: new AbortController().signal, read: async () => ({}), changed: () => {}, allowOutput: true, independentAssessments: true }).find(tool => tool.name === 'ReviewLedger')!
    const invoke = (input: Record<string, unknown>, id: string) => tool.call(input, undefined as never, undefined as never, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'ReviewLedger', input }] } } as unknown as Message)
    expect(JSON.stringify(tool.argsSchema)).toContain('merge-duplicates')
    for (const disposition of ['proven', 'dismissed']) {
      await expect(invoke({ operation: 'append-candidates', candidates: [{ ...h.first, assessment: { disposition, reason: 'Coordinator assertion' } }] }, disposition)).rejects.toThrow('independent-verifier-required')
    }
    await expect(invoke({ operation: 'assess', assessments: [] }, 'assess')).rejects.toThrow('independent-verifier-required')
    await invoke(merge(h.ids[0], [h.ids[1]]), 'tool-merge')
    expect((await h.store.getSnapshot(h.id)).retainedIds).toEqual([h.ids[0]])
  })
})
