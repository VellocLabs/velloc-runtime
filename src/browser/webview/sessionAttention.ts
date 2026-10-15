/**
 * Session attention: the queue behind "a session wants you, and you are not looking at it". Pure, apart
 * from {@link reconcileAttention} mutating the marks it is handed; the shell owns state, focus,
 * notifications and switching. Event ids are `<sessionId>:<kind>`; the queue is derived, so an arrival is
 * remembered in `acknowledged` until the event ends.
 */

/** Why a session wants the user. */
export type AttentionEventKind = 'needs_input' | 'ended_with_question'

export type AttentionEvent = {
  /** `<sessionId>:<kind>` — stable, so re-deriving does not duplicate. */
  id: string
  sessionId: string
  kind: AttentionEventKind
  /** Session display title at the time the event was raised. */
  title: string
  /** The session's launcher type (`agent` / `code` / …), so the bar can lead
   *  with the same icon the sidebar row shows. Absent → the default launcher. */
  templateType?: string
  /** The question, for `ended_with_question`. Absent for a halt. */
  detail?: string
  /** Unix ms; preserved across reconciles so ordering is stable. */
  createdAt: number
}

/**
 * Where a newly raised event is delivered: `focus` (the active session in a focused window), `notify`
 * (the window is not the user's active surface), or `bar` (another session in an active window).
 */
export type AttentionDelivery = 'focus' | 'notify' | 'bar'

export type AttentionContext = {
  activeSessionId: string | null
  /** Is the Velloc window the user's active surface right now? */
  windowFocused: boolean
}

export function attentionDelivery(
  event: Pick<AttentionEvent, 'sessionId'>,
  context: AttentionContext,
): AttentionDelivery {
  if (!context.windowFocused) return 'notify'
  return event.sessionId === context.activeSessionId ? 'focus' : 'bar'
}

/**
 * Whether delivering by this route also acknowledges the event: only `focus`. A `bar` row is consumed by
 * visiting its session; a `notify` event stays queued for the user's return.
 */
export function deliveryConsumesEvent(delivery: AttentionDelivery): boolean {
  return delivery === 'focus'
}

/** What the shell observed this render; the desired queue is a function of it. */
export type AttentionInput = {
  /** Sessions halted on the user — the shell's `needsAnswerSessionIds`. */
  needsInputSessionIds: ReadonlySet<string>
  /**
   * sessionId → what the session is halted ON: an opaque identity of the ask
   * (the pending tool-use / plan / interaction ids), for the sessions whose
   * snapshot is at hand. Optional, and optional per session: one the shell
   * knows only through the worker summary flag has no key, and a missing key
   * is "unknown", never "different" — see "Identity" above.
   */
  needsInputKeys?: ReadonlyMap<string, string>
  /**
   * sessionId → the question text, for sessions whose last turn ended on one.
   * The shell derives this on the running → stopped edge; a session that is
   * still running must not appear here.
   */
  endedWithQuestion: ReadonlyMap<string, string>
  /** sessionId → display title. A session missing here is dropped: an event
   *  the user cannot recognise is worse than no event. */
  titles: ReadonlyMap<string, string>
  /** sessionId → launcher type, for the row icon. Optional: a missing entry
   *  renders the default launcher's icon. */
  templateTypes?: ReadonlyMap<string, string | undefined>
  /**
   * Event ids the user has already answered FOR — they were told about the
   * event and went to the session it named. Suppressed rather than dropped:
   * the event is still true, it just must not be queued or delivered again.
   * See "Acknowledgement" above.
   */
  acknowledged?: ReadonlySet<string>
  now: number
}

export type AttentionReconcileResult = {
  /** The next queue. Referentially equal to `queue` when nothing changed. */
  queue: AttentionEvent[]
  /** Events that were NOT in the previous queue — what to deliver. */
  added: AttentionEvent[]
  /**
   * Events still true but held back by `acknowledged` — not queued, not
   * delivered. Returned because "suppressed" is not "gone": the caller needs
   * them to know which acknowledgements are still live (`queue` ∪
   * `suppressed` is the full derived set), and to retry a reveal for the
   * session the user is standing in.
   */
  suppressed: AttentionEvent[]
}

function eventId(sessionId: string, kind: AttentionEventKind): string {
  return `${sessionId}:${kind}`
}

/**
 * Bring the queue in line with what is currently true; new events are reported in `added`. Surviving
 * events keep their positions and new ones append.
 */
export function reconcileAttentionQueue(
  queue: readonly AttentionEvent[],
  input: AttentionInput,
): AttentionReconcileResult {
  const desired = new Map<string, AttentionEvent>()
  for (const sessionId of input.needsInputSessionIds) {
    const title = input.titles.get(sessionId)
    if (title === undefined) continue
    const id = eventId(sessionId, 'needs_input')
    desired.set(id, {
      id,
      sessionId,
      kind: 'needs_input',
      title,
      templateType: input.templateTypes?.get(sessionId),
      createdAt: input.now,
    })
  }
  for (const [sessionId, question] of input.endedWithQuestion) {
    // A session that is halted is already reported as `needs_input`; raising
    // a second row for the same session would double-count it in the bar.
    if (input.needsInputSessionIds.has(sessionId)) continue
    const title = input.titles.get(sessionId)
    if (title === undefined) continue
    const id = eventId(sessionId, 'ended_with_question')
    desired.set(id, {
      id,
      sessionId,
      kind: 'ended_with_question',
      title,
      templateType: input.templateTypes?.get(sessionId),
      detail: question,
      createdAt: input.now,
    })
  }

  // Acknowledged events leave `desired` entirely: they must not be queued,
  // must not be reported as added, and — the reason this runs BEFORE the walk
  // below rather than as a filter after it — an event acknowledged while it
  // sat in the queue has to leave the queue too.
  const suppressed: AttentionEvent[] = []
  if (input.acknowledged && input.acknowledged.size > 0) {
    for (const [id, event] of [...desired]) {
      if (!input.acknowledged.has(id)) continue
      desired.delete(id)
      suppressed.push(event)
    }
  }

  const next: AttentionEvent[] = []
  const added: AttentionEvent[] = []
  let changed = false

  for (const existing of queue) {
    const stillWanted = desired.get(existing.id)
    if (!stillWanted) {
      changed = true
      continue
    }
    desired.delete(existing.id)
    // Keep `createdAt` (stable ordering) but take the fresh title/detail/type:
    // a session renamed while queued should read by its new name.
    if (
      stillWanted.title === existing.title &&
      stillWanted.detail === existing.detail &&
      stillWanted.templateType === existing.templateType
    ) {
      next.push(existing)
    } else {
      changed = true
      next.push({ ...stillWanted, createdAt: existing.createdAt })
    }
  }
  for (const event of desired.values()) {
    changed = true
    next.push(event)
    added.push(event)
  }

  return {
    queue: changed ? next : (queue as AttentionEvent[]),
    added,
    suppressed,
  }
}

/**
 * How long an event's input may stop producing it and come back without the event having ended: covers a
 * thread remount's blink, short next to a model round trip.
 */
export const ATTENTION_DROP_GRACE_MS = 2000

/**
 * What the caller remembers about events between reconciles. Held by the
 * caller (the shell keeps it in a ref) and updated IN PLACE by
 * {@link reconcileAttention}, because the shell's other writers — the visit
 * rule, the bar click — add to the same sets directly.
 */
export type AttentionMarks = {
  /** Event ids the user has acknowledged — see "Acknowledgement" above. */
  acknowledged: Set<string>
  /** Event ids already delivered (revealed / notified). */
  delivered: Set<string>
  /** Marked id → when the inputs were first seen NOT producing it. */
  absentSince: Map<string, number>
  /**
   * Live or marked id → the ask key it was last seen producing. Stamped for
   * EVERY live id, not only marked ones, so a mark the shell adds after a
   * reconcile is measured against the ask that was live when the user saw it
   * — not against whatever the next reconcile happens to find.
   */
  askKeys: Map<string, string>
}

export function createAttentionMarks(): AttentionMarks {
  return {
    acknowledged: new Set(),
    delivered: new Set(),
    absentSince: new Map(),
    askKeys: new Map(),
  }
}

/** Event id → the ask key the inputs currently carry for it (known keys only). */
function liveAskKeys(input: Omit<AttentionInput, 'acknowledged'>): Map<string, string> {
  const keys = new Map<string, string>()
  for (const sessionId of input.needsInputSessionIds) {
    const key = input.needsInputKeys?.get(sessionId)
    if (key) keys.set(eventId(sessionId, 'needs_input'), key)
  }
  for (const [sessionId, question] of input.endedWithQuestion) {
    // Mirrors the derivation: a halted session raises no question event.
    if (input.needsInputSessionIds.has(sessionId)) continue
    keys.set(eventId(sessionId, 'ended_with_question'), question)
  }
  return keys
}

function forgetMarks(marks: AttentionMarks, id: string): void {
  marks.absentSince.delete(id)
  marks.acknowledged.delete(id)
  marks.delivered.delete(id)
  marks.askKeys.delete(id)
}

/**
 * {@link reconcileAttentionQueue}, plus the lifetime of the caller's marks. Before it, a mark is forgotten
 * when its id's absence outlasted {@link ATTENTION_DROP_GRACE_MS} or its id is live under a different ask
 * key (an unknown key keeps the mark); after it, each mark is stamped present or absent and live ids record
 * their ask key.
 */
export function reconcileAttention(
  queue: readonly AttentionEvent[],
  input: Omit<AttentionInput, 'acknowledged'>,
  marks: AttentionMarks,
  graceMs: number = ATTENTION_DROP_GRACE_MS,
): AttentionReconcileResult {
  for (const [id, since] of [...marks.absentSince]) {
    if (input.now - since < graceMs) continue
    forgetMarks(marks, id)
  }

  const keys = liveAskKeys(input)
  for (const [id, recorded] of [...marks.askKeys]) {
    const current = keys.get(id)
    if (current === undefined || current === recorded) continue
    forgetMarks(marks, id)
  }

  const result = reconcileAttentionQueue(queue, {
    ...input,
    acknowledged: marks.acknowledged,
  })

  const live = new Set<string>()
  for (const event of result.queue) live.add(event.id)
  for (const event of result.suppressed) live.add(event.id)
  for (const id of [...marks.absentSince.keys()]) {
    if (live.has(id)) marks.absentSince.delete(id)
  }
  for (const set of [marks.acknowledged, marks.delivered]) {
    for (const id of set) {
      if (!live.has(id) && !marks.absentSince.has(id)) {
        marks.absentSince.set(id, input.now)
      }
    }
  }
  // Record the key of every live id; an unmarked id that has gone silent has
  // nothing to compare against later, so its entry goes with it. A marked
  // one keeps its entry until the marks end (`forgetMarks`) — that is the
  // record a blink-and-return is measured against.
  for (const id of live) {
    const key = keys.get(id)
    if (key !== undefined) marks.askKeys.set(id, key)
  }
  for (const id of [...marks.askKeys.keys()]) {
    if (live.has(id) || marks.absentSince.has(id)) continue
    marks.askKeys.delete(id)
  }
  return result
}

/** Drop every event for `sessionId`: the shell calls this on the visit, whatever route brought the user. */
export function clearAttentionForSession(
  queue: readonly AttentionEvent[],
  sessionId: string,
): AttentionEvent[] {
  const next = queue.filter(event => event.sessionId !== sessionId)
  return next.length === queue.length ? (queue as AttentionEvent[]) : next
}

/**
 * The "turn ended on a question" detector's memory between passes. Held by
 * the caller (the shell keeps it in a ref) and updated in place by
 * {@link detectEndedWithQuestion}.
 */
export type EndedQuestionTracker = {
  /** Sessions running on the previous pass. */
  running: ReadonlySet<string>
  /** Running session -> the preview it showed when its turn STARTED. */
  atStart: Map<string, string | undefined>
  /** Stopped session whose question is not settled yet -> its latches. */
  pending: Map<string, { atStart: string | undefined; atStop: string | undefined }>
}

export function createEndedQuestionTracker(): EndedQuestionTracker {
  return { running: new Set(), atStart: new Map(), pending: new Map() }
}

/**
 * One pass of the "turn ended on a question" detector: the sessions whose turn just ended with a preview
 * that reads as a question. A preview that changed since the stop, or already differs from the start value
 * at the stop, is taken; the start latch keeps the user's own prompt out. `ranSince` holds the sessions
 * reported running since the previous pass.
 */
export function detectEndedWithQuestion(
  tracker: EndedQuestionTracker,
  running: ReadonlySet<string>,
  previewOf: (sessionId: string) => string | undefined | null,
  exists: (sessionId: string) => boolean,
  ranSince: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const previous = tracker.running
  tracker.running = running
  for (const sessionId of new Set([...running, ...ranSince])) {
    if (!previous.has(sessionId)) {
      tracker.atStart.set(sessionId, previewOf(sessionId) ?? undefined)
      tracker.pending.delete(sessionId)
    }
  }
  for (const sessionId of new Set([...previous, ...ranSince])) {
    if (running.has(sessionId)) continue
    const atStart = tracker.atStart.get(sessionId)
    tracker.atStart.delete(sessionId)
    if (tracker.pending.has(sessionId)) continue
    tracker.pending.set(sessionId, {
      atStart,
      atStop: previewOf(sessionId) ?? undefined,
    })
  }

  const raised = new Map<string, string>()
  for (const [sessionId, latch] of [...tracker.pending]) {
    if (running.has(sessionId)) {
      // Running again before its preview settled: nothing to report.
      tracker.pending.delete(sessionId)
      continue
    }
    if (!exists(sessionId)) {
      // Session is gone from the list (deleted): stop tracking it.
      tracker.pending.delete(sessionId)
      continue
    }
    const preview = previewOf(sessionId) ?? undefined
    const arrivedAfterStop = preview !== latch.atStop
    const arrivedBeforeStop = preview === latch.atStop && preview !== latch.atStart
    if (!arrivedAfterStop && !arrivedBeforeStop) continue
    tracker.pending.delete(sessionId)
    if (preview && readsAsQuestion(preview)) raised.set(sessionId, preview)
  }
  return raised
}

/**
 * Does `text` read as a question? A trailing `?` after stripping trailing whitespace and closing
 * punctuation; shallow, since it only raises a dismissible notification.
 */
export function readsAsQuestion(text: string | undefined | null): boolean {
  if (!text) return false
  const trimmed = text.replace(/[\s)\]}"'`*_>]+$/u, '')
  if (trimmed.endsWith('?')) return true
  // Full-width question mark — the CJK locales write it this way.
  return trimmed.endsWith('？')
}
