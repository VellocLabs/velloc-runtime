/**
 * Contract: ChildReportCoordinator — a child session's finished turn becomes
 * a report queued on the session it reports to, and that parent's model is
 * woken to read its reports only when it is safe to (F-36). Invariants:
 * - every read-modify-write of a parent's queue and count runs in one chain
 *   per parent, against the parent's live store when it has one
 * - a parent's next non-slash turn takes every queued report once, in the
 *   same metadata write that marks them consumed
 * - an automatic continuation is one mailbox-priority turn; one at most is in
 *   flight per parent, and `AUTO_WAKE_LIMIT` at most run before a person
 *   writes to the parent again
 * - a team child (F-20) is never reported here
 * - nothing wakes on restore: only a child's turn end, a child's status
 *   change or the parent's idle transition evaluates the wake
 */
import type { AgentWorkerOutboundMessage, AgentRuntimeWorkerSnapshot } from './workerProtocol'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import {
  originOf,
  reportTargetOf,
  resolveLineage,
  type ChildReport,
  type ChildReportEnding,
  type SessionLineageIndex,
  type SessionLineageInput,
} from '../../sessions/sessionLineage'
import {
  AUTO_CONTINUATION_PROMPT,
  AUTO_WAKE_LIMIT,
  PERMISSION_PARK_GRACE_MS,
  autoWakeCountOf,
  childReportQueueOf,
  formatChildReportBlock,
  queueChildReport,
  sanitizeChildReportText,
  takeChildReportsPatch,
  type ParkedChild,
} from '../../sessions/childReports'
import { snapshotHaltedOnUser } from '../../utils/sessionNeedsAnswer'
import type {
  SessionReportInput,
  SessionReportSettlement,
  SessionWakeInput,
  SessionWakeSettlement,
} from '../../mods/sessionFamilyEvents'

/** The two calls a live session's conversation store answers. */
export interface ChildReportStore {
  getSessionMetadata(): Promise<BrowserSessionMetadata | undefined>
  updateSessionMetadata(patch: Partial<BrowserSessionMetadata>): Promise<unknown>
}

/** What a session is doing now, as far as the wake is concerned. */
export type SessionActivity = {
  /** Mid-turn (streaming, tools or retry). */
  busy: boolean
  /** Parked on a control a person must answer (a permission card, a
   *  question, a plan approval). */
  needsAnswer: boolean
  /** Started by another session and not yet running its first turn. */
  starting: boolean
}

export interface ChildReportHost {
  /** Whether automatic continuations are on (the feature's channel gate). */
  wakeGateOpen(): boolean
  /** The session's live store, or null when no runtime holds it. */
  liveStore(sessionId: string): ChildReportStore | null
  /** A session's stored metadata, or null when there is no record. */
  readStoredMeta(sessionId: string): Promise<BrowserSessionMetadata | null>
  /** Merge `patch` into a session's stored record and republish it. */
  patchStoredMeta(sessionId: string, patch: Partial<BrowserSessionMetadata>): Promise<void>
  /** Every known session's relation fields, archived ones included. */
  relationIndex(): SessionLineageIndex
  /** One session's relation fields, or undefined when it is not known. */
  relationOf(sessionId: string): SessionLineageInput | undefined
  /** Whether a session still exists to be reported to: known, not archived,
   *  not being deleted. */
  sessionExists(sessionId: string): boolean
  familyNameOf(sessionId: string): string | undefined
  activity(sessionId: string): SessionActivity
  /**
   * Why the session cannot take a turn now, or null when it can: no live
   * runtime, mid-turn, under a person's Stop, parked on a question or
   * permission card, being deleted, or a team frame queued ahead.
   */
  parentHold(sessionId: string): string | null
  /** The session's final assistant message: its text, uuid, and whether it
   *  is a model error. */
  finalAssistant(sessionId: string): { text: string; uuid?: string; error: boolean }
  /** Queue an automatic-continuation turn at mailbox priority; false when no
   *  runtime took it. */
  enqueueWake(sessionId: string, prompt: string): boolean
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  trace(event: string, attrs: Record<string, unknown>): void
  /** `session.report` on the parent's plugins; null when none hooks it.
   *  Optional: absent, reports raise nothing. */
  raiseReport?(parentId: string, input: SessionReportInput): Promise<SessionReportSettlement> | null
  /** `session.wake` on the parent's plugins; null when none hooks it.
   *  Optional: absent, a wake raises nothing. */
  raiseWake?(parentId: string, input: SessionWakeInput): Promise<SessionWakeSettlement> | null
}

type OpenTurn = {
  uuidAtStart?: string
  interrupted: boolean
  /** Who stopped the turn: a session's id when its model asked, `''` for a
   *  person. */
  stoppedBy: Set<string>
  closed: boolean
}

type ChildMark = { busy: boolean; parked: boolean; starting: boolean }

function isArchivedMeta(meta: BrowserSessionMetadata): boolean {
  return (meta as { archived?: unknown }).archived === true
}

function isSlashPrompt(prompt: unknown): boolean {
  return typeof prompt === 'string' && prompt.trimStart().startsWith('/')
}

function isClearPrompt(prompt: unknown): boolean {
  return typeof prompt === 'string' && /^\/clear(\s|$)/.test(prompt.trimStart())
}

export class ChildReportCoordinator {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly turns = new Map<string, OpenTurn>()
  private readonly inFlight = new Set<string>()
  private readonly clearing = new Set<string>()
  private readonly startCancelled = new Set<string>()
  private readonly parkedSince = new Map<string, number>()
  private readonly marks = new Map<string, ChildMark>()
  private readonly scheduled = new Set<string>()
  private readonly parkTimers = new Map<string, unknown>()
  private readonly lastReportAt = new Map<string, number>()
  /** Parents whose `session.wake` hooks are being asked. */
  private readonly wakeAsking = new Set<string>()
  /** Parents whose hooks let the wake through: the next evaluation wakes
   *  without asking again, if every condition still holds. */
  private readonly wakeCleared = new Set<string>()

  constructor(private readonly host: ChildReportHost) {}

  // ── The queue ───────────────────────────────────────────────────────────

  /**
   * Queue one report on `parentId`, replacing the same child's earlier one.
   * A not-started note from a child whose start a person cancelled is
   * dropped; any other report from such a child never wakes the parent.
   */
  async record(parentId: string, report: ChildReport): Promise<void> {
    const cancelled = this.startCancelled.has(report.sessionId)
    if (report.notStarted && cancelled) return
    const queued: ChildReport = {
      ...report,
      text: sanitizeChildReportText(report.text),
      ...(cancelled ? { quiet: true as const } : {}),
    }
    await this.serial(parentId, async () => {
      const meta = await this.readMeta(parentId)
      if (!meta) return
      const outcome = queueChildReport(childReportQueueOf(meta), queued)
      if (!outcome.accepted) return
      await this.writeMeta(parentId, {
        childReports: outcome.queue.reports,
        childReportsDropped: outcome.queue.dropped,
      })
      if (outcome.evicted > 0) {
        this.host.trace('nexus_child_reports_evicted', { parentId, evicted: outcome.evicted })
      }
    })
    this.scheduleEvaluate(parentId)
  }

  /**
   * The block a parent's turn starts with, taking every queued report in
   * the write that marks them consumed; null when nothing is queued. An
   * automatic continuation that finds nothing (a person's turn took the
   * reports first) also answers null, and the caller drops that turn.
   */
  takeForTurn(sessionId: string, opts: { autoContinuation: boolean }): Promise<string | null> {
    if (opts.autoContinuation) this.inFlight.delete(sessionId)
    return this.serial(sessionId, async () => {
      const meta = await this.readMeta(sessionId)
      if (!meta) return null
      const queue = childReportQueueOf(meta)
      if (queue.reports.length === 0 && queue.dropped === 0) return null
      await this.writeMeta(sessionId, takeChildReportsPatch(queue))
      return formatChildReportBlock({
        entries: queue.reports.map(report => ({
          report,
          name: this.host.familyNameOf(report.sessionId),
        })),
        dropped: queue.dropped,
        parked: this.ripeParkedChildrenOf(sessionId),
      })
    })
  }

  // ── Events from the session manager ─────────────────────────────────────

  /** A session's turn began. */
  turnStarted(sessionId: string): void {
    this.turns.set(sessionId, {
      uuidAtStart: this.host.finalAssistant(sessionId).uuid,
      interrupted: false,
      stoppedBy: new Set(),
      closed: false,
    })
  }

  /** A Stop reached the session: a person's, or the stop `by` a session's
   *  model asked for. During a child's start this is a cancellation: it
   *  leaves no note and wakes nothing. */
  interruptRequested(sessionId: string, by?: string): void {
    const turn = this.turns.get(sessionId)
    if (turn && !turn.closed) {
      turn.interrupted = true
      turn.stoppedBy.add(by ?? '')
    }
    if (this.host.activity(sessionId).starting) this.startCancelled.add(sessionId)
  }

  /** A person submitted `prompt` to the session. Their own message resets the
   *  automatic-continuation count; a slash command does not, and `/clear`
   *  holds continuations until its turn ends. */
  personWrote(sessionId: string, prompt: unknown): void {
    if (isSlashPrompt(prompt)) {
      if (isClearPrompt(prompt)) this.clearing.add(sessionId)
      return
    }
    void this.serial(sessionId, async () => {
      const meta = await this.readMeta(sessionId)
      if (!meta || autoWakeCountOf(meta) === 0) return
      await this.writeMeta(sessionId, { autoWakeCount: 0 })
    }).catch(() => {})
  }

  /** The engine's stream for the session's turn ended. A Stop-interrupted
   *  turn is reported here as stopped, however it resolved. */
  streamEnded(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn && !turn.closed && turn.interrupted) this.finishTurn(sessionId, { halted: false, failed: false })
    this.clearing.delete(sessionId)
    this.noteSession(sessionId)
    this.scheduleEvaluate(sessionId)
  }

  /** A worker event of the session: turn completion, failure, and status
   *  changes. */
  observe(sessionId: string, message: AgentWorkerOutboundMessage): void {
    if (message.type === 'worker.completed') {
      const halted = snapshotHaltedOnUser(message.payload as AgentRuntimeWorkerSnapshot)
      this.finishTurn(sessionId, { halted, failed: false })
    } else if (message.type === 'worker.error') {
      const code = (message.payload as { code?: unknown } | undefined)?.code
      if (code === 'worker_submit_failed') this.finishTurn(sessionId, { halted: false, failed: true })
    }
    if (
      message.type === 'worker.state' ||
      message.type === 'worker.completed' ||
      message.type === 'worker.ready'
    ) {
      this.noteSession(sessionId)
    }
  }

  /** The session's runtime is going away. A turn still open is reported as
   *  lost; one a person removed never wakes its parent. */
  sessionGone(sessionId: string, opts: { byPerson: boolean }): void {
    if (opts.byPerson && this.host.activity(sessionId).starting) this.startCancelled.add(sessionId)
    const turn = this.turns.get(sessionId)
    if (turn && !turn.closed) {
      turn.closed = true
      const final = this.host.finalAssistant(sessionId)
      const text = final.uuid !== undefined && final.uuid === turn.uuidAtStart ? '' : final.text
      void this.reportTurnEnd(sessionId, 'lost', text, opts.byPerson).catch(() => {})
    }
    this.turns.delete(sessionId)
    this.inFlight.delete(sessionId)
    this.clearing.delete(sessionId)
    this.parkedSince.delete(sessionId)
    this.marks.delete(sessionId)
    const timer = this.parkTimers.get(sessionId)
    if (timer !== undefined) this.host.clearTimer(timer)
    this.parkTimers.delete(sessionId)
    const parent = this.delegatedParentOf(sessionId)
    if (parent) this.scheduleEvaluate(parent)
  }

  /** A session's state may have changed: keep its parked time, and when it
   *  is a delegated child whose blocking state moved, evaluate its parent. */
  noteSession(sessionId: string): void {
    const activity = this.host.activity(sessionId)
    const parked = activity.busy && activity.needsAnswer
    if (parked) {
      if (!this.parkedSince.has(sessionId)) this.parkedSince.set(sessionId, this.host.now())
    } else {
      this.parkedSince.delete(sessionId)
    }
    const next: ChildMark = { busy: activity.busy, parked, starting: activity.starting }
    const prev = this.marks.get(sessionId)
    this.marks.set(sessionId, next)
    if (prev && prev.busy === next.busy && prev.parked === next.parked && prev.starting === next.starting) return
    const parent = this.delegatedParentOf(sessionId)
    if (parent) this.scheduleEvaluate(parent)
  }

  // ── Turn ends ───────────────────────────────────────────────────────────

  private finishTurn(sessionId: string, how: { halted: boolean; failed: boolean }): void {
    const turn = this.turns.get(sessionId)
    if (!turn || turn.closed) return
    turn.closed = true
    const final = this.host.finalAssistant(sessionId)
    const fresh = !(final.uuid !== undefined && final.uuid === turn.uuidAtStart)
    let ending: ChildReportEnding
    if (turn.interrupted) ending = 'stopped'
    else if (how.failed || (fresh && final.error)) ending = 'failed'
    else if (how.halted) ending = 'waiting_user'
    else ending = 'finished'
    // A turn that finished without a new answer has nothing to report.
    if (ending === 'finished' && !fresh) return
    const stoppedBy = ending === 'stopped' ? turn.stoppedBy : undefined
    void this.reportTurnEnd(sessionId, ending, fresh ? final.text : '', false, stoppedBy).catch(err => {
      this.host.trace('nexus_child_report_failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  private async reportTurnEnd(
    childId: string,
    ending: ChildReportEnding,
    rawText: string,
    quiet: boolean,
    stoppedBy?: ReadonlySet<string>,
  ): Promise<void> {
    // A session listed with no relation at all is top-level: nothing to read.
    const listed = this.host.relationOf(childId)
    if (listed && !listed.spawnedFrom && !listed.forkedFromSessionId && !listed.spawnerSessionId) return
    const meta = await this.readMeta(childId)
    if (!meta) return
    // A side chat is the person's aside: it queues no report and wakes no
    // parent; what it has to say it sends as a message (F-36).
    if (meta.sideChat === true) return
    const origin = originOf(meta)
    // A teammate reports through its lead's inbox (F-20).
    if (!origin || origin.kind === 'team') return
    const index = new Map(this.host.relationIndex())
    index.set(childId, meta)
    const target = reportTargetOf(childId, index, id => this.host.sessionExists(id))
    if (!target) return
    // A parent that stopped its own child already knows: the report is data
    // for its next turn, never a reason to wake it.
    const stoppedByTarget = stoppedBy !== undefined && stoppedBy.size > 0 && [...stoppedBy].every(id => id === target)
    let text = sanitizeChildReportText(rawText)
    const raised = this.host.raiseReport?.(target, {
      childSessionId: childId,
      parentSessionId: target,
      ending,
      text,
      lineageKind: resolveLineage(meta)?.kind ?? origin.kind,
    })
    if (raised) {
      const settled = await raised
      if ('consumed' in settled) {
        this.host.trace('nexus_child_report_consumed', { childId, parentId: target })
        return
      }
      text = settled.text
    }
    // Strictly increasing per child: a report is told from a consumed one by
    // its time.
    const at = Math.max(this.host.now(), (this.lastReportAt.get(childId) ?? 0) + 1)
    this.lastReportAt.set(childId, at)
    await this.record(target, {
      sessionId: childId,
      ending,
      text,
      at,
      ...(quiet || stoppedByTarget ? { quiet: true as const } : {}),
    })
  }

  // ── The wake ────────────────────────────────────────────────────────────

  private scheduleEvaluate(parentId: string): void {
    if (this.scheduled.has(parentId)) return
    this.scheduled.add(parentId)
    queueMicrotask(() => {
      this.scheduled.delete(parentId)
      void this.serial(parentId, () => this.evaluate(parentId)).catch(err => {
        this.host.trace('nexus_child_wake_failed', {
          parentId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    })
  }

  /** The wake predicate, stated once (F-36). Runs inside the parent's chain. */
  private async evaluate(parentId: string): Promise<void> {
    const cleared = this.wakeCleared.delete(parentId)
    if (!this.host.wakeGateOpen()) return
    if (this.inFlight.has(parentId) || this.clearing.has(parentId)) return
    if (this.host.parentHold(parentId) !== null) return
    const meta = await this.readMeta(parentId)
    if (!meta || isArchivedMeta(meta)) return
    const count = autoWakeCountOf(meta)
    if (count >= AUTO_WAKE_LIMIT) return
    const queue = childReportQueueOf(meta)
    if (queue.reports.length === 0) return
    const children = this.delegatedChildrenOf(parentId)
    if (!queue.reports.some(r => !r.quiet && children.has(r.sessionId))) return

    const now = this.host.now()
    let ripeAt: number | undefined
    for (const child of children) {
      const activity = this.host.activity(child)
      if (activity.starting) return
      if (!activity.busy) continue
      if (!activity.needsAnswer) return
      let since = this.parkedSince.get(child)
      if (since === undefined) {
        since = now
        this.parkedSince.set(child, since)
      }
      const ripe = since + PERMISSION_PARK_GRACE_MS
      if (now < ripe) ripeAt = ripeAt === undefined ? ripe : Math.min(ripeAt, ripe)
    }
    if (ripeAt !== undefined) {
      this.armParkTimer(parentId, ripeAt - now)
      return
    }

    // Re-read the live state: the metadata read above yielded.
    if (this.inFlight.has(parentId) || this.host.parentHold(parentId) !== null) return
    if (!cleared && this.askWakeHooks(parentId, { parentSessionId: parentId, reports: queue.reports, count })) return
    this.inFlight.add(parentId)
    if (!this.host.enqueueWake(parentId, AUTO_CONTINUATION_PROMPT)) {
      this.inFlight.delete(parentId)
      return
    }
    await this.writeMeta(parentId, { autoWakeCount: count + 1 })
    this.host.trace('nexus_child_wake', { parentId, count: count + 1, reports: queue.reports.length })
  }

  /**
   * Ask the parent's `session.wake` hooks, outside its chain. True while
   * they are asked: the wake waits, and goes through a fresh evaluation
   * once they let it, never on their word alone. A deferral holds it until
   * the next evaluation; a chain that fails lets it through.
   */
  private askWakeHooks(parentId: string, input: SessionWakeInput): boolean {
    if (this.wakeAsking.has(parentId)) return true
    const raised = this.host.raiseWake?.(parentId, input)
    if (!raised) return false
    this.wakeAsking.add(parentId)
    void raised
      .then(
        settled => ('defer' in settled ? settled.defer : null),
        () => null,
      )
      .then(deferred => {
        this.wakeAsking.delete(parentId)
        if (deferred !== null) {
          this.host.trace('nexus_child_wake_deferred', { parentId })
          return
        }
        this.wakeCleared.add(parentId)
        this.scheduleEvaluate(parentId)
      })
    return true
  }

  private armParkTimer(parentId: string, delayMs: number): void {
    const prior = this.parkTimers.get(parentId)
    if (prior !== undefined) this.host.clearTimer(prior)
    this.parkTimers.set(
      parentId,
      this.host.setTimer(() => {
        this.parkTimers.delete(parentId)
        this.scheduleEvaluate(parentId)
      }, Math.max(0, delayMs)),
    )
  }

  /** The children `parentId`'s model started and still controls, teammates
   *  aside. */
  private delegatedChildrenOf(parentId: string): Set<string> {
    const children = new Set<string>()
    for (const [id, input] of this.host.relationIndex()) {
      if (id === parentId) continue
      const lineage = resolveLineage(input)
      if (lineage && lineage.initiator === 'model' && lineage.kind !== 'team' && lineage.sessionId === parentId) {
        children.add(id)
      }
    }
    return children
  }

  private delegatedParentOf(sessionId: string): string | undefined {
    const input = this.host.relationOf(sessionId)
    if (!input) return undefined
    const lineage = resolveLineage(input)
    if (!lineage || lineage.initiator !== 'model' || lineage.kind === 'team') return undefined
    return lineage.sessionId
  }

  private ripeParkedChildrenOf(parentId: string): ParkedChild[] {
    const now = this.host.now()
    const parked: ParkedChild[] = []
    for (const child of this.delegatedChildrenOf(parentId)) {
      const since = this.parkedSince.get(child)
      if (since === undefined || now - since < PERMISSION_PARK_GRACE_MS) continue
      parked.push({ sessionId: child, name: this.host.familyNameOf(child) })
    }
    return parked
  }

  // ── Metadata, one chain per session ─────────────────────────────────────

  private serial<T>(sessionId: string, step: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(sessionId) ?? Promise.resolve()
    const run = prior.then(step, step)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(sessionId, settled)
    void settled.then(() => {
      if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId)
    })
    return run
  }

  private async readMeta(sessionId: string): Promise<BrowserSessionMetadata | null> {
    const live = this.host.liveStore(sessionId)
    if (live) return (await live.getSessionMetadata()) ?? {}
    return this.host.readStoredMeta(sessionId)
  }

  private async writeMeta(sessionId: string, patch: Partial<BrowserSessionMetadata>): Promise<void> {
    const live = this.host.liveStore(sessionId)
    if (live) {
      await live.updateSessionMetadata(patch)
      return
    }
    await this.host.patchStoredMeta(sessionId, patch)
    // A runtime that bound while the record was written would persist its
    // own copy over it; hand it the same values.
    const late = this.host.liveStore(sessionId)
    if (late) await late.updateSessionMetadata(patch)
  }
}
