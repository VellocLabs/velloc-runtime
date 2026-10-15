/**
 * Per-session append-only record of skill invocations and outcomes (loaded /
 * failed) for the Skills tab. Distinct from `invokedSkillsStore`, which dedupes
 * for the compaction budget.
 */

export type SkillInvocationStatus = 'loaded' | 'failed'

export type SkillInvocationEvent = {
  /** Unique per event. For a `loaded` event this is the invocation message
   *  uuid, so `skill:<id>` resolves the instructions on click. */
  id: string
  skillName: string
  skillPath: string
  /** Unix ms — the event log is rendered newest-first. */
  invokedAt: number
  status: SkillInvocationStatus
  /** Scope: null for the main session, a sub-agent id for a forked skill. The
   *  Skills-tab feed reads the null scope only, matching the compaction store's
   *  producer. */
  agentId: string | null
  /** UTF-8 byte length of the injected body. Set for `loaded`; omitted for
   *  `failed`. */
  size?: number
  /** The `skill:<uuid>` sidecar id that resolves the body on click. Set for
   *  `loaded`; a `failed` event has no body. */
  detailId?: string
  /** Failure message — set only for `failed`. */
  error?: string
}

/** Backstop so a pathological session cannot grow the log without bound. The
 *  Skills tab is a recent-activity log, not an audit trail; oldest events are
 *  dropped first. Far above any real session's skill-invocation count. */
export const SKILL_EVENT_LOG_MAX = 500

// --- event log (append-only, per session) ---------------------------------

const EVENT_LOG = new Map<string, SkillInvocationEvent[]>()

/**
 * Write-through persistence seam: the Manager registers a persister, notified
 * per session on change. Bound to the worker-lifetime Manager, so safe as a
 * module global.
 */
export type SkillEventLogPersister = (sessionId: string) => void
let persister: SkillEventLogPersister | null = null

/** Register (or clear, with null) the write-through persister. */
export function setSkillEventLogPersister(
  fn: SkillEventLogPersister | null,
): void {
  persister = fn
}

/** Append one invocation outcome. Ignored when unkeyable (no session / name). */
export function recordSkillInvocationEvent(
  sessionId: string,
  event: SkillInvocationEvent,
): void {
  if (!sessionId || !event.skillName) return
  let events = EVENT_LOG.get(sessionId)
  if (!events) {
    events = []
    EVENT_LOG.set(sessionId, events)
  }
  events.push(event)
  if (events.length > SKILL_EVENT_LOG_MAX) {
    events.splice(0, events.length - SKILL_EVENT_LOG_MAX)
  }
  // Notify the Manager so it can persist this session's log (best-effort,
  // coalesced on its side). No-op when no persister is registered (unit tests).
  persister?.(sessionId)
}

/**
 * The full stored event array for a session (all agent scopes), oldest-first —
 * the on-disk serialization order, so a recovery re-seeds it verbatim. A copy,
 * so callers can't mutate the live log.
 */
export function getAllSkillInvocationEvents(
  sessionId: string,
): SkillInvocationEvent[] {
  const events = EVENT_LOG.get(sessionId)
  return events ? events.slice() : []
}

/**
 * Merge recovered (older) events before in-memory ones, deduped by id and
 * capped. Idempotent; returns whether the log changed. Never persists.
 */
export function seedSkillInvocationEvents(
  sessionId: string,
  recovered: readonly SkillInvocationEvent[],
): boolean {
  if (!sessionId || recovered.length === 0) return false
  const existing = EVENT_LOG.get(sessionId) ?? []
  const seen = new Set<string>()
  const merged: SkillInvocationEvent[] = []
  for (const event of [...recovered, ...existing]) {
    if (!event || !event.id || !event.skillName || seen.has(event.id)) continue
    seen.add(event.id)
    merged.push(event)
  }
  if (merged.length > SKILL_EVENT_LOG_MAX) {
    merged.splice(0, merged.length - SKILL_EVENT_LOG_MAX)
  }
  // No-op when the merge produced the same sequence of ids already held.
  if (
    existing.length === merged.length &&
    existing.every((event, i) => event.id === merged[i]!.id)
  ) {
    return false
  }
  EVENT_LOG.set(sessionId, merged)
  return true
}

/** Events for a (sessionId, agentId), newest-first. Pass null for the main
 *  session (the only scope the Skills tab feed reads today). */
export function getSkillInvocationEventsForAgent(
  sessionId: string,
  agentId: string | null = null,
): SkillInvocationEvent[] {
  const events = EVENT_LOG.get(sessionId)
  if (!events) return []
  const out: SkillInvocationEvent[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].agentId === agentId) out.push(events[i])
  }
  return out
}

/** Drop the session's event log (on session close). */
export function clearSkillInvocationLogForSession(sessionId: string): void {
  EVENT_LOG.delete(sessionId)
}

/** Test-only: wipe the log and the persister slot. */
export function __resetSkillInvocationLogForTests(): void {
  EVENT_LOG.clear()
  persister = null
}
