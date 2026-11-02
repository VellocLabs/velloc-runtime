import type { OutputMode } from './contracts'
import type { ReviewFileLocation, ReviewSessionSnapshot } from './review-protocol'
export type { ReviewReportView, ReviewSessionSnapshot } from './review-protocol'

/** Runtime-owned facades; methods must enforce host grants before edits or external writes. */
export interface ReviewSessionFacade {
  getSnapshot(): ReviewSessionSnapshot | Promise<ReviewSessionSnapshot>
  subscribe(listener: () => void): () => void
  cancel(runId: string): Promise<unknown>
  repair(runId: string, diagnosticIds: string[]): Promise<unknown>
  publish(runId: string, options: { preview: boolean; confirmed: boolean; discussions?: boolean }): Promise<unknown>
  rerun(runId: string, presentation?: OutputMode): Promise<unknown>
  verify?(runId: string): Promise<unknown>
  locate?(runId: string, diagnosticId: string): Promise<ReviewFileLocation>
}
const sessions = new Map<string, { service: ReviewSessionFacade; unsubscribe: () => void }>()
const listeners = new Set<(sessionId: string) => void>()
const changed = (sessionId: string) => { for (const listener of listeners) listener(sessionId) }
export function registerReviewSession(sessionId: string, service: ReviewSessionFacade): () => void {
  sessions.get(sessionId)?.unsubscribe()
  const entry = { service, unsubscribe: service.subscribe(() => changed(sessionId)) }
  sessions.set(sessionId, entry)
  changed(sessionId)
  return () => {
    if (sessions.get(sessionId) !== entry) return
    entry.unsubscribe()
    sessions.delete(sessionId)
    changed(sessionId)
  }
}
export function getReviewSession(sessionId: string): ReviewSessionFacade | undefined { return sessions.get(sessionId)?.service }
export function onReviewSessionsChanged(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
