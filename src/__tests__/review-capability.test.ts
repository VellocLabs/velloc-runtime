import { convertTranscriptToThreadMessages, transcriptWillHydrateAssistantBody } from '../browser/webview/assistantUiAdapter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { CapabilityRegistry, ConnectionHub, TopicBroker, type ConnectionInfo, type RuntimeContext } from '../browser/runtimeHub'
import { connectRuntime } from '../browser/runtimeClient'
import { registerReviewCapability } from '../browser/runtimeHub/reviewCapability'
import { registerReviewSession, type ReviewSessionFacade } from '../codeReview/review-channel'
import { REVIEW_ACTION_SCOPES, isReviewActionPayload, reviewNoticeRunId, reviewTopic, type ReviewSessionSnapshot } from '../codeReview/review-protocol'
const dispose: Array<() => void> = []
afterEach(() => { for (const release of dispose.splice(0)) release() })
function rig(options: { cold?: boolean; readStoredSnapshot?: (sessionId: string) => Promise<ReviewSessionSnapshot | undefined> } = {}) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const capability = registerReviewCapability(registry, broker, options)
  dispose.push(capability.dispose)
  const snapshot: ReviewSessionSnapshot = { sessionId: 's1', sequence: 1, reports: [{ run: { id: 'r1', conversationKey: 's1', scope: { kind: 'workspace', workspaceKey: 'w', repository: { projectKey: 'p' }, revision: { base: 'a', head: 'b' }, pathFilter: [] }, policy: { level: 'medium', recipe: 'local-eight', recipeRevision: 1, execution: 'isolated', presentation: 'panel', reportLimit: 8 }, progress: { status: 'active', stage: 'inspect', coveredAngles: [], unavailableAngles: [], spawnedTasks: 0, verifiedCandidates: 0, omittedByLimit: 0 }, reportRevision: 0 }, diagnostics: [], assessments: [], actions: [], evidence: [], coverage: { complete: false, angles: [], limitations: [] }, permissions: { cancel: true, repair: true, publish: true, publishConfirmation: true, rerun: true } }] }
  const service: ReviewSessionFacade = { getSnapshot: () => snapshot, subscribe: () => () => {}, cancel: vi.fn(async () => {}), repair: vi.fn(async () => {}), publish: vi.fn(async () => {}), rerun: vi.fn(async () => {}) }
  if (!options.cold) dispose.push(registerReviewSession('s1', service))
  const context: RuntimeContext = { fs: {} as RuntimeFs, host: null, homeDir: '/h', publish: (id, payload, opts) => broker.publish(id, payload, opts), connections: () => hub.list(), webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null } }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'review', bootstrap: () => undefined })
  const connect = async (scopeCeiling: 'observe' | 'control') => {
    const channel = new MessageChannel()
    hub.attach(createMessagePortTransport(channel.port1))
    const conn = await connectRuntime({ transport: createMessagePortTransport(channel.port2), client: { clientId: 'c', kind: 'desktop-shell' }, scopeCeiling })
    dispose.push(() => conn.close())
    return conn
  }
  return { registry, broker, service, snapshot, connect, capability }
}
describe('review protocol', () => {
  it('binds all control actions to session ownership and rejects filesystem or grant payloads', () => {
    const { registry, broker } = rig()
    for (const action of Object.keys(REVIEW_ACTION_SCOPES)) {
      const spec = registry.resolve('review', action)!.spec
      expect(spec.scope).toBe('control')
      expect(spec.sessionOf?.({ sessionId: 's1' })).toBe('s1')
    }
    expect(isReviewActionPayload('cancel', { sessionId: 's1', runId: 'r1', path: '/secret' })).toBe(false)
    expect(isReviewActionPayload('repair', { sessionId: 's1', runId: 'r1', diagnosticIds: ['d', 'd'] })).toBe(false)
    const conn: ConnectionInfo = { connectionId: 'n', clientId: 'n', kind: 'mobile', scope: { mode: 'observe', sessions: ['s1'] }, transport: 'websocket', connectedAt: 0 }
    expect(broker.authorize(reviewTopic('s1'), conn)).not.toBe('forbidden')
    expect(broker.authorize(reviewTopic('s2'), conn)).toBe('forbidden')
  })
  it('refuses observer actions over the real connection', async () => {
    const { connect, service } = rig()
    const conn = await connect('observe')
    for (const [action, extra] of [['cancel', {}], ['repair', { diagnosticIds: ['d1'] }], ['publish', { preview: true, confirmed: false }], ['rerun', {}], ['verify', {}], ['locate', { diagnosticId: 'd1' }]] as const) {
      await expect(conn.request(`review.${action}`, { sessionId: 's1', runId: 'r1', ...extra })).rejects.toMatchObject({ code: 'forbidden_scope' })
    }
    expect(service.cancel).not.toHaveBeenCalled()
  })
  it('checks run and finding ownership and publication confirmation before dispatch', async () => {
    const { connect, service } = rig()
    const conn = await connect('control')
    await expect(conn.request('review.cancel', { sessionId: 's1', runId: 'other' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(conn.request('review.repair', { sessionId: 's1', runId: 'r1', diagnosticIds: ['foreign'] })).rejects.toMatchObject({ code: 'not_found' })
    await expect(conn.request('review.publish', { sessionId: 's1', runId: 'r1', preview: false, confirmed: false })).rejects.toMatchObject({ code: 'conflict' })
    await conn.request('review.publish', { sessionId: 's1', runId: 'r1', preview: true, confirmed: false })
    expect(service.publish).toHaveBeenCalledWith('r1', { preview: true, confirmed: false })
    await conn.request('review.cancel', { sessionId: 's1', runId: 'r1' })
    expect(service.cancel).toHaveBeenCalledWith('r1')
  })
  it('cancels a model-requested review that is still preparing, by the id the snapshot lists only', async () => {
    const { connect, service, snapshot } = rig()
    snapshot.preparing = [{ id: 'preparing-1', toolCallId: 'call-1' }]
    const conn = await connect('control')
    await conn.request('review.cancel', { sessionId: 's1', runId: 'preparing-1' })
    expect(service.cancel).toHaveBeenCalledWith('preparing-1')
    await expect(conn.request('review.rerun', { sessionId: 's1', runId: 'preparing-1' })).rejects.toMatchObject({ code: 'forbidden_scope' })
    await expect(conn.request('review.cancel', { sessionId: 's1', runId: 'call-1' })).rejects.toMatchObject({ code: 'not_found' })
    const observer = await connect('observe')
    await expect(observer.request('review.cancel', { sessionId: 's1', runId: 'preparing-1' })).rejects.toMatchObject({ code: 'forbidden_scope' })
    expect(service.cancel).toHaveBeenCalledTimes(1)
  })
  it('recognizes only structured system notices, not model or tool text', () => {
    expect(reviewNoticeRunId({ type: 'system', subtype: 'code-review', review: { runId: 'r1' }, message: 'anything' })).toBe('r1')
    expect(reviewNoticeRunId({ type: 'assistant', subtype: 'code-review', review: { runId: 'r1' } })).toBeNull()
    expect(reviewNoticeRunId({ type: 'system', message: 'code-review r1' })).toBeNull()
  })
})

it('routes persisted report metadata without parsing the notice body or blocking hydration', () => {
  const { messages: rows } = convertTranscriptToThreadMessages([{ type: 'system', subtype: 'code-review', uuid: 'notice-1', message: 'opaque', review: { runId: 'r1' } }])
  expect(rows).toHaveLength(1)
  expect(rows[0]!.metadata?.custom).toMatchObject({ sourceType: 'code-review', reviewRunId: 'r1' })
  expect(transcriptWillHydrateAssistantBody(rows)).toBe(false)
})

it('subscribes to a complete report projection without initiating any work', async () => {
  const { connect, service } = rig()
  const conn = await connect('observe')
  const seen: unknown[] = []
  const unsubscribe = conn.subscribe('review/s1', event => seen.push(event.payload))
  dispose.push(unsubscribe)
  await vi.waitFor(() => expect(seen).toHaveLength(1))
  expect(seen[0]).toMatchObject({ sessionId: 's1', sequence: 1, reports: [{ run: { id: 'r1' } }] })
  expect(service.rerun).not.toHaveBeenCalled()
  expect(service.publish).not.toHaveBeenCalled()
})


it('folds a burst of review changes into one publish per session', async () => {
  const { broker, connect } = rig({ cold: true })
  let notify = () => {}
  const getSnapshot = vi.fn(() => ({ sessionId: 's1', sequence: 2, reports: [] }))
  dispose.push(registerReviewSession('s1', { getSnapshot, subscribe: listener => { notify = listener; return () => {} }, cancel: async () => {}, repair: async () => {}, publish: async () => {}, rerun: async () => {} }))
  const conn = await connect('observe')
  dispose.push(conn.subscribe('review/s1', () => {}))
  await vi.waitFor(() => expect(broker.subscribersOf('review/s1').length).toBeGreaterThan(0))
  const publish = vi.spyOn(broker, 'publish')
  for (let n = 0; n < 5; n++) notify()
  await vi.waitFor(() => expect(publish).toHaveBeenCalled())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(publish.mock.calls.filter(([topic]) => topic === 'review/s1')).toHaveLength(1)
})

it('unsubscribes the review facade listener when its capability is disposed', async () => {
  const { capability, broker } = rig()
  const publish = vi.spyOn(broker, 'publish')
  capability.dispose()
  dispose.push(registerReviewSession('s2', { getSnapshot: () => ({ sessionId: 's2', sequence: 1, reports: [] }), subscribe: () => () => {}, cancel: async () => {}, repair: async () => {}, publish: async () => {}, rerun: async () => {} }))
  await Promise.resolve()
  expect(publish).not.toHaveBeenCalled()
})

it('restricts presentation to supported rerun modes and verify to a bare session/run payload', async () => {
  for (const presentation of ['terminal', 'json', 'panel']) expect(isReviewActionPayload('rerun', { sessionId: 's1', runId: 'r1', presentation })).toBe(true)
  for (const presentation of ['html', '', {}, 1, null]) expect(isReviewActionPayload('rerun', { sessionId: 's1', runId: 'r1', presentation })).toBe(false)
  expect(isReviewActionPayload('rerun', { sessionId: 's1', runId: 'r1', presentation: 'json', command: 'unsafe' })).toBe(false)
  expect(isReviewActionPayload('verify', { sessionId: 's1', runId: 'r1' })).toBe(true)
  expect(isReviewActionPayload('verify', { sessionId: 's1', runId: 'r1', presentation: 'json' })).toBe(false)
  expect(isReviewActionPayload('verify', { sessionId: 's1', runId: 'r1', command: 'unsafe' })).toBe(false)
  const { connect, service, snapshot } = rig()
  const conn = await connect('control')
  await conn.request('review.rerun', { sessionId: 's1', runId: 'r1', presentation: 'json' })
  expect(service.rerun).toHaveBeenCalledWith('r1', 'json')
  await expect(conn.request('review.verify', { sessionId: 's1', runId: 'r1' })).rejects.toMatchObject({ code: 'forbidden_scope' })
  snapshot.reports[0]!.permissions!.verify = true
  await expect(conn.request('review.verify', { sessionId: 's1', runId: 'r1' })).rejects.toMatchObject({ code: 'host_unavailable' })
  service.verify = vi.fn(async () => {})
  await conn.request('review.verify', { sessionId: 's1', runId: 'r1' })
  expect(service.verify).toHaveBeenCalledWith('r1')
  await expect(conn.request('review.verify', { sessionId: 's1', runId: 'foreign' })).rejects.toMatchObject({ code: 'not_found' })
})

it('validates diagnostic ownership and current side before locating and rejects arbitrary locator fields', async () => {
  const { connect, service, snapshot } = rig()
  const report = snapshot.reports[0]!
  report.permissions!.locate = true
  report.diagnostics.push({ id: 'd1', runId: 'r1', anchor: { path: 'a.ts', revision: 'b', side: 'working-copy' }, claim: { title: 'Issue', explanation: 'Details', trigger: 'Input' }, classification: { kind: 'correctness', impact: 'major' }, evidenceKeys: [], origin: { angle: 'lines' } })
  service.locate = vi.fn(async () => ({ path: '/repo/a.ts', line: 9 }))
  const conn = await connect('control')
  expect(isReviewActionPayload('locate', { sessionId: 's1', runId: 'r1', diagnosticId: 'd1' })).toBe(true)
  expect(isReviewActionPayload('locate', { sessionId: 's1', runId: 'r1', diagnosticId: 'd1', path: '/secret' })).toBe(false)
  expect(isReviewActionPayload('locate', { sessionId: 's1', runId: 'r1' })).toBe(false)
  await expect(conn.request('review.locate', { sessionId: 's1', runId: 'r1', diagnosticId: 'foreign' })).rejects.toMatchObject({ code: 'not_found' })
  expect(service.locate).not.toHaveBeenCalled()
  expect(await conn.request('review.locate', { sessionId: 's1', runId: 'r1', diagnosticId: 'd1' })).toEqual({ path: '/repo/a.ts', line: 9 })
  expect(service.locate).toHaveBeenCalledWith('r1', 'd1')
  report.diagnostics[0]!.anchor.side = 'before'
  await expect(conn.request('review.locate', { sessionId: 's1', runId: 'r1', diagnosticId: 'd1' })).rejects.toMatchObject({ code: 'conflict' })
  expect(service.locate).toHaveBeenCalledTimes(1)
  report.diagnostics[0]!.anchor.side = 'working-copy'
  service.locate = async () => ({ path: '../secret', line: 0 })
  await expect(conn.request('review.locate', { sessionId: 's1', runId: 'r1', diagnosticId: 'd1' })).rejects.toMatchObject({ code: 'conflict' })
})

it('reads persisted reviews with no live service and refuses actions rather than booting a runtime', async () => {
  let saved!: ReviewSessionSnapshot
  const readStoredSnapshot = vi.fn(async () => saved)
  const { connect, snapshot, service } = rig({ cold: true, readStoredSnapshot })
  saved = structuredClone(snapshot)
  saved.reports[0]!.run.progress.status = 'finished'
  saved.reports[0]!.permissions = { cancel: false, repair: false, publish: false, rerun: false }
  const conn = await connect('control')
  const seen: unknown[] = []
  dispose.push(conn.subscribe('review/s1', event => seen.push(event.payload)))
  await vi.waitFor(() => expect(seen).toHaveLength(1))
  expect(seen[0]).toMatchObject({ reports: [{ run: { progress: { status: 'finished' } } }] })
  expect(readStoredSnapshot).toHaveBeenCalledWith('s1')
  await expect(conn.request('review.rerun', { sessionId: 's1', runId: 'r1' })).rejects.toMatchObject({ code: 'host_unavailable' })
  expect(service.rerun).not.toHaveBeenCalled()
})

it('prefers a live service registered while the persisted snapshot is loading', async () => {
  let release!: (value: ReviewSessionSnapshot) => void
  const readStoredSnapshot = vi.fn(() => new Promise<ReviewSessionSnapshot>(resolve => { release = resolve }))
  const { connect, snapshot, service } = rig({ cold: true, readStoredSnapshot })
  const conn = await connect('observe')
  const seen: ReviewSessionSnapshot[] = []
  dispose.push(conn.subscribe('review/s1', event => seen.push(event.payload as ReviewSessionSnapshot)))
  await vi.waitFor(() => expect(readStoredSnapshot).toHaveBeenCalledTimes(1))
  dispose.push(registerReviewSession('s1', service))
  release({ sessionId: 's1', sequence: 0, reports: [] })
  await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
  expect(seen.every(value => value.reports[0]?.run.id === snapshot.reports[0]!.run.id)).toBe(true)
})

it('accepts optional discussion intent only on publication and forwards it unchanged', async () => {
  const payload = { sessionId: 's1', runId: 'r1', preview: true, confirmed: false }
  expect(isReviewActionPayload('publish', payload)).toBe(true)
  for (const discussions of [true, false]) expect(isReviewActionPayload('publish', { ...payload, discussions })).toBe(true)
  for (const discussions of ['true', 1, null, {}]) expect(isReviewActionPayload('publish', { ...payload, discussions })).toBe(false)
  expect(isReviewActionPayload('rerun', { sessionId: 's1', runId: 'r1', discussions: true })).toBe(false)
  const { connect, service, snapshot } = rig()
  snapshot.reports[0]!.run.scope.repository.platform = 'gitlab'
  const conn = await connect('control')
  await conn.request('review.publish', { ...payload, discussions: true })
  expect(service.publish).toHaveBeenCalledWith('r1', { preview: true, confirmed: false, discussions: true })
  await conn.request('review.publish', { ...payload, preview: false, confirmed: true, discussions: true })
  expect(service.publish).toHaveBeenCalledWith('r1', { preview: false, confirmed: true, discussions: true })
})
