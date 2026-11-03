import { wireError } from '../runtimeProtocol'
import { getReviewSession, onReviewSessionsChanged } from '../../codeReview/review-channel'
import { REVIEW_ACTION_SCOPES, isReviewActionPayload, isReviewFileLocation, reviewTopic, sessionOfReviewPayload, sessionOfReviewTopic, type ReviewAction, type ReviewActionPayload, type ReviewSessionSnapshot } from '../../codeReview/review-protocol'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'

/** Security: actions control one named session; the observe topic publishes full report projections, never filesystem or grant handles. */
export type ReviewCapabilityOptions = { readStoredSnapshot?: (sessionId: string) => Promise<ReviewSessionSnapshot | undefined> }
export function registerReviewCapability(registry: CapabilityRegistry, broker: TopicBroker, options: ReviewCapabilityOptions = {}): { dispose(): void } {
  const state = async (sessionId: string): Promise<ReviewSessionSnapshot> => {
    let snapshot = await getReviewSession(sessionId)?.getSnapshot()
    if (!snapshot) {
      snapshot = await options.readStoredSnapshot?.(sessionId)
      const live = getReviewSession(sessionId)
      if (live) snapshot = await live.getSnapshot()
    }
    if (!snapshot) return { sessionId, sequence: 0, reports: [] }
    if (snapshot.sessionId !== sessionId || snapshot.reports.some(report => report.run.conversationKey !== sessionId)) throw wireError('forbidden_scope', 'Review session mismatch')
    return snapshot
  }
  broker.registerProvider({
    matches: id => sessionOfReviewTopic(id) !== null,
    authorize: (id, conn) => {
      const sessionId = sessionOfReviewTopic(id)
      return sessionId !== null && scopeAllows(conn.scope.mode, 'observe') && (conn.scope.sessions === 'all' || conn.scope.sessions.includes(sessionId))
    },
    async *snapshot(id) {
      const sessionId = sessionOfReviewTopic(id)
      if (sessionId) yield { type: 'state', payload: await state(sessionId) }
    },
  })
  const actions = Object.fromEntries(Object.entries(REVIEW_ACTION_SCOPES).map(([action, scope]) => [action, {
    scope, sessionOf: sessionOfReviewPayload, guard: (value: unknown) => isReviewActionPayload(action as ReviewAction, value),
  }]))
  registry.registerCapability({
    cap: 'review', actions,
    async handle(request) {
      const action = request.route.act as ReviewAction
      const payload = request.payload as ReviewActionPayload
      const service = getReviewSession(payload.sessionId)
      if (!service) throw wireError('host_unavailable', 'Review service unavailable')
      const report = (await state(payload.sessionId)).reports.find(report => report.run.id === payload.runId)
      if (!report) throw wireError('not_found', 'Review run not in session')
      if (!report.permissions?.[action]) throw wireError('forbidden_scope', 'Review action unavailable')
      switch (action) {
        case 'locate': {
          const diagnostic = report.diagnostics.find(item => item.id === payload.diagnosticId && item.runId === payload.runId)
          if (!diagnostic) throw wireError('not_found', 'Review diagnostic not in run')
          if (diagnostic.anchor.side !== 'working-copy') throw wireError('conflict', 'Historical review anchor requires relocation')
          if (!service.locate) throw wireError('host_unavailable', 'Review location unavailable')
          const location = await service.locate(payload.runId, diagnostic.id)
          if (!isReviewFileLocation(location)) throw wireError('conflict', 'Invalid review location')
          return { path: location.path, ...(location.line !== undefined ? { line: location.line } : {}) }
        }
        case 'cancel': await service.cancel(payload.runId); break
        case 'rerun': return service.rerun(payload.runId, payload.presentation)
        case 'verify':
          if (!service.verify) throw wireError('host_unavailable', 'Review verification unavailable')
          await service.verify(payload.runId)
          break
        case 'repair': {
          const ids = payload.diagnosticIds!
          if (ids.some(id => !report.diagnostics.some(diagnostic => diagnostic.id === id && diagnostic.runId === payload.runId))) throw wireError('not_found', 'Review diagnostic not in run')
          await service.repair(payload.runId, ids)
          break
        }
        case 'publish':
          if (!payload.preview && report.permissions.publishConfirmation && !payload.confirmed) throw wireError('conflict', 'Review publication needs confirmation')
          await service.publish(payload.runId, { preview: payload.preview!, confirmed: payload.confirmed!, ...(payload.discussions !== undefined ? { discussions: payload.discussions } : {}) })
          break
        default: throw wireError('unknown_route', 'Unknown review action')
      }
      return { accepted: true }
    },
  })
  // Serialize projection reads so a slow older snapshot never overwrites a newer one; changes that
  // arrive while a session's publish is still queued fold into that one publish.
  let pending = Promise.resolve()
  const queued = new Set<string>()
  const dispose = onReviewSessionsChanged(sessionId => {
    if (queued.has(sessionId)) return
    queued.add(sessionId)
    pending = pending.then(async () => {
      queued.delete(sessionId)
      const topic = reviewTopic(sessionId)
      if (broker.subscribersOf(topic).length) broker.publish(topic, await state(sessionId), { type: 'state' })
    }).catch(() => {})
  })
  return { dispose }
}
