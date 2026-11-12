/**
 * Contract: SessionFamilyCoordinator — the runtime side of the session-family
 * tools (F-36): lists and describes the sessions of this runtime, pages a
 * family member's transcript, delivers a message to a session with a receipt
 * that says what happened, and stops, archives or detaches one. Invariants:
 * - a session outside this runtime is never named, resolved or acted on
 * - a message to a session that cannot take a turn now is held, never dropped:
 *   in memory while the session has a runtime, on its record otherwise
 * - a human gate (a question or permission card) is never acted around: no
 *   stop, no archive while the session waits on the user
 * - control follows delegation: a session stops, archives or detaches only a
 *   session its model started (or one reached through such links); family
 *   membership grants reading, never control
 * - archiving never cascades; detaching keeps the origin on record
 */
import type { SessionCard } from './sharedWorkerProtocol'
import type {
  BrowserConversationStoragePayload,
  BrowserSessionMetadata,
  BrowserSessionSummary,
  SessionMetaFile,
} from '../../sessions/sessionStore'
import {
  directChildrenOf,
  familyOf,
  isDetached,
  lineageInputFromRelationFields,
  originOf,
  resolveLineage,
  type SessionLineageInput,
} from '../../sessions/sessionLineage'
import {
  LIST_SESSIONS_DEFAULT_LIMIT,
  LIST_SESSIONS_MAX_LIMIT,
  READ_EVENTS_DEFAULT_LIMIT,
  READ_EVENTS_MAX_LIMIT,
  appendPeerInbox,
  archiveDecision,
  clampLimit,
  clearDecision,
  controlDecision,
  detachDecision,
  isPeerInboxEntry,
  pageTranscript,
  resolveRecipient,
  type PeerInboxEntry,
} from '../../sessions/sessionFamilyRules'
import type {
  DeliveryReceipt,
  FamilyOutcome,
  ListSessionsQuery,
  SessionDescription,
  SessionDirectory,
  SessionEventRow,
  SessionRow,
  StopResult,
} from '../../sessions/sessionDirectory'
import { TeamMailbox, type MailboxEntry } from '../../team/TeamMailbox'
import { renderPeerSessionFrame } from '../../team/renderPeerSessionFrame'
import type { TeamMessageTrust } from '../../team/teamTypes'
import type { installSessionTracer } from '../../utils/sessionTrace'
import type { LineageDetachInput, LineageDetachSettlement } from '../../mods/sessionFamilyEvents'

type SessionTracer = ReturnType<typeof installSessionTracer>

export interface SessionFamilyHost {
  /** Every session this runtime knows: live entries and persisted summaries. */
  allSessionIds(): Iterable<string>
  summaryOf(sessionId: string): BrowserSessionSummary | undefined
  /** The list entry as the sidebar sees it (title, folder, activity). */
  cardOf(sessionId: string): SessionCard | null
  readMeta(sessionId: string): Promise<SessionMetaFile | null>
  /** Merge `patch` into a session's record: through its live store when it
   *  has one, else on disk; the summary is refreshed either way. */
  patchMeta(sessionId: string, patch: Partial<BrowserSessionMetadata>): Promise<void>
  loadTranscript(sessionId: string): Promise<BrowserConversationStoragePayload>
  /** A worker exists for the session. */
  isLive(sessionId: string): boolean
  /** A turn is in flight. */
  isBusy(sessionId: string): boolean
  /** Another session is starting this one and no first turn ran yet. */
  isStarting(sessionId: string): boolean
  /** Halted on a question or permission card for the user. */
  needsAnswer(sessionId: string): boolean
  /** Under a Stop until the user's next submit. */
  isDeliverySuppressed(sessionId: string): boolean
  /** A sub-agent or background shell of the session is running. */
  hasLiveWork(sessionId: string): boolean
  /** Queue `prompt` as the session's next turn; false without a live worker. */
  enqueueTurn(sessionId: string, prompt: string): boolean
  /** Stop the session's current turn the way the user's Stop does; `by` is
   *  the session whose model asked. */
  interrupt(sessionId: string, by: string): void
  /** Stop everything the session runs before a person's archive: its turn,
   *  sub-agents, shells, teammates and terminals. Never builds an idle
   *  session's runtime. */
  stopForArchive(sessionId: string): Promise<void>
  /** Task results or team frames are queued for the session's next turn. */
  hasQueuedInput(sessionId: string): boolean
  /** Start the session's conversation over the way the user's `/clear`
   *  does, through the same per-submit path; a no-op without a live
   *  worker. */
  clearConversation(sessionId: string): void
  trustOf(sessionId: string): TeamMessageTrust
  tracer: SessionTracer
  /** `lineage.detach` on `callerSessionId`'s plugins; null when none hooks
   *  it. Optional: absent, a detach raises nothing. */
  raiseDetach?(callerSessionId: string, input: LineageDetachInput): Promise<LineageDetachSettlement> | null
}

function newMessageId(): string {
  const random =
    globalThis.crypto?.randomUUID?.()?.replace(/-/g, '').slice(0, 12) ??
    Math.random().toString(36).slice(2, 14)
  return `msg_${random}`
}

export class SessionFamilyCoordinator implements SessionDirectory {
  /** Messages for sessions with a runtime that cannot take a turn now. */
  private readonly mailbox = new TeamMailbox()
  /** One writer at a time per session record, so a kept message is never
   *  overwritten by another written at the same moment. */
  private readonly recordLocks = new Map<string, Promise<unknown>>()

  constructor(private readonly host: SessionFamilyHost) {}

  // ---- the family index -----------------------------------------------

  private lineageIndex(): Map<string, SessionLineageInput> {
    const index = new Map<string, SessionLineageInput>()
    for (const id of this.host.allSessionIds()) {
      const summary = this.host.summaryOf(id)
      index.set(id, summary ? lineageInputFromRelationFields(summary) : {})
    }
    return index
  }

  private knows(sessionId: string): boolean {
    return this.host.summaryOf(sessionId) !== undefined || this.host.isLive(sessionId)
  }

  private nameOf(sessionId: string): string | undefined {
    return this.host.summaryOf(sessionId)?.familyName
  }

  private titleOf(sessionId: string): string | undefined {
    return this.host.cardOf(sessionId)?.title
  }

  private async isArchived(sessionId: string): Promise<boolean> {
    const summary = this.host.summaryOf(sessionId)
    if (summary?.archived) return true
    const meta = await this.host.readMeta(sessionId)
    return meta?.metadata.archived === true
  }

  /** Whether `target` is in `caller`'s family, the caller itself included. */
  private inFamily(callerSessionId: string, target: string): boolean {
    if (target === callerSessionId) return true
    const index = this.lineageIndex()
    if (!index.has(target)) return false
    return familyOf(callerSessionId, index).includes(target)
  }

  // ---- queries --------------------------------------------------------

  async list(query: ListSessionsQuery): Promise<SessionRow[]> {
    const { callerSessionId } = query
    const index = this.lineageIndex()
    const scope = query.linked ? new Set(familyOf(callerSessionId, index)) : null
    const rows: SessionRow[] = []
    for (const id of index.keys()) {
      if (id === callerSessionId) continue
      if (scope && !scope.has(id)) continue
      const summary = this.host.summaryOf(id)
      const archived = summary?.archived === true
      if (archived && !query.includeArchived) continue
      const card = this.host.cardOf(id)
      const lineage = resolveLineage(index.get(id) ?? {})
      const startedBy =
        lineage && lineage.initiator === 'model' && index.has(lineage.sessionId)
          ? lineage.sessionId
          : undefined
      const starting = this.host.isStarting(id)
      rows.push({
        sessionId: id,
        ...(card?.title ? { title: card.title } : {}),
        ...(summary?.projectRoot ? { cwd: summary.projectRoot } : {}),
        archived,
        running: this.host.isLive(id) && this.host.isBusy(id),
        ...(starting ? { starting: true } : {}),
        ...(card?.updatedAt ? { lastActivityAt: card.updatedAt } : {}),
        ...(summary?.familyName ? { name: summary.familyName } : {}),
        ...(startedBy ? { startedBy } : {}),
      })
    }
    rows.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    return rows.slice(0, clampLimit(query.limit, LIST_SESSIONS_DEFAULT_LIMIT, LIST_SESSIONS_MAX_LIMIT))
  }

  async describe(
    callerSessionId: string,
    target: string,
  ): Promise<FamilyOutcome<{ session: SessionDescription }>> {
    const sessionId = target === 'self' ? callerSessionId : target
    if (!this.knows(sessionId)) {
      return { ok: false, code: 'unknown', reason: 'no session with that id in this runtime.' }
    }
    const meta = await this.host.readMeta(sessionId)
    const metadata = meta?.metadata ?? {}
    const card = this.host.cardOf(sessionId)
    const summary = this.host.summaryOf(sessionId)
    const lineage = resolveLineage(metadata)
    const origin = originOf(metadata)
    const originKnown = origin !== undefined && this.knows(origin.sessionId)
    const starting = this.host.isStarting(sessionId)
    const session: SessionDescription = {
      sessionId,
      ...(card?.title ? { title: card.title } : {}),
      ...(summary?.projectRoot ?? metadata.projectRoot ? { cwd: summary?.projectRoot ?? metadata.projectRoot } : {}),
      ...(card?.templateType ? { templateType: card.templateType } : {}),
      archived: metadata.archived === true,
      running: this.host.isLive(sessionId) && this.host.isBusy(sessionId),
      ...(starting ? { starting: true } : {}),
      waitingForUser: this.host.needsAnswer(sessionId),
      ...(card?.updatedAt ? { lastActivityAt: card.updatedAt } : {}),
      ...(typeof metadata.createdAt === 'number' ? { createdAt: metadata.createdAt } : {}),
      ...(typeof card?.messageCount === 'number' ? { messageCount: card.messageCount } : {}),
      ...(summary?.familyName ?? origin?.name ? { name: summary?.familyName ?? origin?.name } : {}),
      effectiveParentId: lineage?.sessionId ?? null,
      ...(lineage ? { lineageKind: lineage.kind, initiator: lineage.initiator } : {}),
      detached: isDetached(metadata),
      ...(metadata.sideChat === true ? { sideChat: true } : {}),
      ...(originKnown ? { originSessionId: origin.sessionId, originKind: origin.kind } : {}),
      ...(origin?.sharedCheckout ? { sharedCheckout: true } : {}),
      ...(typeof metadata.forkedFromSessionId === 'string' && this.knows(metadata.forkedFromSessionId)
        ? { forkedFromSessionId: metadata.forkedFromSessionId }
        : {}),
      ...(typeof metadata.forkedAtMessageUuid === 'string' ? { forkedAtMessageUuid: metadata.forkedAtMessageUuid } : {}),
    }
    return { ok: true, session }
  }

  async readEvents(
    callerSessionId: string,
    target: string,
    options: { limit?: number; beforeUuid?: string },
  ): Promise<FamilyOutcome<{ events: SessionEventRow[]; hasMore: boolean }>> {
    const sessionId = target === 'self' ? callerSessionId : target
    if (!this.knows(sessionId)) {
      return { ok: false, code: 'unknown', reason: 'no session with that id in this runtime.' }
    }
    if (!this.inFamily(callerSessionId, sessionId)) {
      return { ok: false, code: 'unreachable', reason: 'the session is not in this session\'s family; only a family member\'s transcript can be read.' }
    }
    const payload = await this.host.loadTranscript(sessionId)
    const entries = Array.isArray(payload) ? payload : []
    const page = pageTranscript(
      entries,
      clampLimit(options.limit, READ_EVENTS_DEFAULT_LIMIT, READ_EVENTS_MAX_LIMIT),
      options.beforeUuid,
    )
    if ('error' in page) {
      return { ok: false, code: 'unknown_cursor', reason: 'beforeUuid names no message of that session.' }
    }
    return { ok: true, ...page }
  }

  // ---- messages -------------------------------------------------------

  resolves(callerSessionId: string, to: string): boolean {
    const resolution = resolveRecipient(callerSessionId, to, this.lineageIndex(), id => this.nameOf(id), id => this.knows(id))
    return resolution.kind !== 'unknown'
  }

  /** Run `work` after every earlier write to the same session's record. */
  private withRecordLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.recordLocks.get(sessionId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.recordLocks.set(sessionId, settled)
    void settled.then(() => {
      if (this.recordLocks.get(sessionId) === settled) this.recordLocks.delete(sessionId)
    })
    return run
  }

  /** Append a message to a closed session's record; false when the record is gone. */
  private keepOnRecord(sessionId: string, entry: PeerInboxEntry): Promise<boolean> {
    return this.withRecordLock(sessionId, async () => {
      const current = await this.host.readMeta(sessionId)
      if (!current) return false
      await this.host.patchMeta(sessionId, { peerInbox: appendPeerInbox(current.metadata.peerInbox, entry) })
      return true
    })
  }

  private renderPeerMessage(entry: PeerInboxEntry, toSessionId: string): string {
    return renderPeerSessionFrame(
      {
        v: 1,
        id: entry.messageId,
        seq: 0,
        ts: entry.at,
        from: {
          name: entry.fromSessionId,
          role: 'member',
          sessionId: entry.fromSessionId,
          ...(entry.fromTitle ? { display: entry.fromTitle } : {}),
        },
        to: { name: toSessionId },
        kind: 'message',
        trust: entry.trust,
        body: entry.text,
        meta: { messageId: entry.messageId },
      },
      // Security: the reader's own view of the sender, read now; the stricter
      // of the two wins inside the renderer.
      this.host.trustOf(entry.fromSessionId),
    )
  }

  private canTakeTurnNow(sessionId: string): boolean {
    return (
      this.host.isLive(sessionId) &&
      !this.host.isBusy(sessionId) &&
      !this.host.isDeliverySuppressed(sessionId) &&
      !this.host.needsAnswer(sessionId) &&
      !this.mailbox.hasPending(sessionId)
    )
  }

  async send(callerSessionId: string, to: string, text: string): Promise<DeliveryReceipt> {
    const messageId = newMessageId()
    const refused = (reasonCode: DeliveryReceipt['reasonCode'], reason: string, target?: string): DeliveryReceipt => ({
      messageId,
      state: 'undelivered',
      reasonCode,
      reason,
      ...(target ? { to: this.addressee(target) } : {}),
    })
    const body = text.trim()
    if (!body) return refused('empty', 'the message is empty.')
    const resolution = resolveRecipient(callerSessionId, to, this.lineageIndex(), id => this.nameOf(id), id => this.knows(id))
    switch (resolution.kind) {
      case 'self':
        return refused('self', 'a session cannot message itself.')
      case 'no_parent':
        return refused('unreachable', 'this session has no parent to message.')
      case 'unknown':
        return refused('unknown', `"${to.trim()}" is not a session of this runtime, a short name in this session's family, "parent" or "top".`)
      case 'session':
        break
    }
    const target = resolution.sessionId
    if (!this.knows(target)) {
      return refused('unknown', `the session "${to.trim()}" points at (${target}) is no longer in this runtime.`)
    }
    if (await this.isArchived(target)) {
      return refused('archived', 'the session is archived; unarchive it first.', target)
    }
    if (this.host.isStarting(target)) {
      return refused('starting', 'the session is still starting and has no turn to take a message yet; try once it has started.', target)
    }
    const entry: PeerInboxEntry = {
      messageId,
      fromSessionId: callerSessionId,
      ...(this.titleOf(callerSessionId) ? { fromTitle: this.titleOf(callerSessionId) } : {}),
      trust: this.host.trustOf(callerSessionId),
      text: body,
      at: Date.now(),
    }
    const addressee = this.addressee(target)
    if (!this.host.isLive(target)) {
      if (!(await this.keepOnRecord(target, entry))) {
        return refused('unknown', 'the session has no record to keep the message on.', target)
      }
      this.host.tracer.event('nexus_session_message_kept', { attrs: { to: target, messageId } })
      return {
        messageId,
        state: 'undelivered',
        reasonCode: 'no_turn',
        reason: 'the session has no running runtime; the message is kept on its record and reaches it when the session next opens.',
        to: addressee,
      }
    }
    const prompt = this.renderPeerMessage(entry, target)
    if (this.canTakeTurnNow(target) && this.host.enqueueTurn(target, prompt)) {
      this.host.tracer.event('nexus_session_message_delivered', { attrs: { to: target, messageId } })
      return { messageId, state: 'delivered', to: addressee }
    }
    this.mailbox.enqueue(target, prompt)
    this.host.tracer.event('nexus_session_message_queued', { attrs: { to: target, messageId } })
    return { messageId, state: 'queued', to: addressee }
  }

  private addressee(sessionId: string): NonNullable<DeliveryReceipt['to']> {
    const name = this.nameOf(sessionId)
    const title = this.titleOf(sessionId)
    return { sessionId, ...(name ? { name } : {}), ...(title ? { title } : {}) }
  }

  /** A queued message becomes the session's next turn at this boundary when it can take one. */
  maybeDrain(sessionId: string): void {
    if (!this.mailbox.hasPending(sessionId)) return
    if (this.host.isDeliverySuppressed(sessionId)) return
    if (this.host.needsAnswer(sessionId)) return
    if (!this.host.isLive(sessionId) || this.host.isBusy(sessionId)) return
    const prompt = this.mailbox.takePending(sessionId)
    if (prompt === null) return
    this.host.enqueueTurn(sessionId, prompt)
  }

  /** Every queued message, taken by the session's running turn between two tool rounds. */
  takeMidTurn(sessionId: string): MailboxEntry[] {
    if (this.host.isDeliverySuppressed(sessionId)) return []
    return this.mailbox.takeAll(sessionId)
  }

  /** A session's runtime is bound: the messages kept on its record move to
   *  its mailbox, and the first becomes a turn if it can take one. */
  async onSessionBound(sessionId: string): Promise<void> {
    const kept = await this.withRecordLock(sessionId, async () => {
      const meta = await this.host.readMeta(sessionId)
      const entries = Array.isArray(meta?.metadata.peerInbox) ? meta.metadata.peerInbox.filter(isPeerInboxEntry) : []
      if (entries.length > 0) await this.host.patchMeta(sessionId, { peerInbox: [] })
      return entries
    })
    if (kept.length === 0) return
    for (const entry of kept) this.mailbox.enqueue(sessionId, this.renderPeerMessage(entry, sessionId))
    this.maybeDrain(sessionId)
  }

  /** The session is gone; nothing queued for it may surface again. */
  forget(sessionId: string): void {
    this.mailbox.clear(sessionId)
  }

  // ---- lifecycle ------------------------------------------------------

  async stop(callerSessionId: string, target: string): Promise<FamilyOutcome<{ result: StopResult }>> {
    if (target === callerSessionId || target === 'self') {
      return { ok: false, code: 'self', reason: 'a session does not stop itself with this tool; end your turn instead.' }
    }
    if (!this.knows(target)) return { ok: false, code: 'unknown', reason: 'no session with that id in this runtime.' }
    const control = controlDecision(callerSessionId, target, this.lineageIndex(), 'stop')
    if (!control.ok) return control
    if (this.host.isStarting(target)) return { ok: true, result: 'starting' }
    if (this.host.needsAnswer(target)) {
      return { ok: false, code: 'waiting_user', reason: 'the session is waiting on the user (a question or permission card); that is the user\'s to answer, not the model\'s to stop.' }
    }
    if (!this.host.isLive(target) || !this.host.isBusy(target)) return { ok: true, result: 'idle' }
    this.host.interrupt(target, callerSessionId)
    return { ok: true, result: 'interrupted' }
  }

  async clear(callerSessionId: string, target: string): Promise<FamilyOutcome<Record<never, never>>> {
    if (target === callerSessionId || target === 'self') {
      return { ok: false, code: 'self', reason: 'a session does not clear itself with this tool.' }
    }
    if (!this.knows(target)) return { ok: false, code: 'unknown', reason: 'no session with that id in this runtime.' }
    const index = this.lineageIndex()
    const control = controlDecision(callerSessionId, target, index, 'clear')
    if (!control.ok) return control
    const decision = clearDecision({
      live: this.host.isLive(target),
      running: this.host.isLive(target) && this.host.isBusy(target),
      starting: this.host.isStarting(target),
      waitingForUser: this.host.needsAnswer(target),
      stoppedByUser: this.host.isDeliverySuppressed(target),
      liveWork: this.host.hasLiveWork(target),
      childRunning: directChildrenOf(target, index).some(
        child => this.host.isStarting(child) || (this.host.isLive(child) && this.host.isBusy(child)),
      ),
      messagesQueued: this.mailbox.hasPending(target) || this.host.hasQueuedInput(target),
    })
    if (!decision.ok) return decision
    this.host.clearConversation(target)
    return { ok: true }
  }

  async setArchived(
    callerSessionId: string,
    target: string,
    archived: boolean,
  ): Promise<FamilyOutcome<{ changed: boolean }>> {
    if (!this.knows(target)) return { ok: false, code: 'unknown', reason: 'no session with that id in this runtime.' }
    const control = controlDecision(callerSessionId, target, this.lineageIndex(), archived ? 'archive' : 'unarchive')
    if (!control.ok) return control
    return this.applyArchived(target, archived)
  }

  /**
   * The person's archive / unarchive from the session list: no delegation
   * check (the person controls every session). Unlike the tool's archive, a
   * running, waiting or working session is stopped and then archived; only a
   * starting one is refused.
   */
  async setArchivedByUser(
    target: string,
    archived: boolean,
  ): Promise<FamilyOutcome<{ changed: boolean }>> {
    if (!this.knows(target)) return { ok: false, code: 'unknown', reason: 'no session with that id in this runtime.' }
    if (!archived) return this.applyArchived(target, false)
    const decision = archiveDecision({
      archived: await this.isArchived(target),
      running: false,
      liveWork: false,
      waitingForUser: false,
      starting: this.host.isStarting(target),
    })
    if (!decision.ok) return decision
    if (!decision.changed) return { ok: true, changed: false }
    await this.host.stopForArchive(target)
    await this.host.patchMeta(target, { archived: true, archivedAt: Date.now() })
    return { ok: true, changed: true }
  }

  private async applyArchived(
    target: string,
    archived: boolean,
  ): Promise<FamilyOutcome<{ changed: boolean }>> {
    const current = await this.isArchived(target)
    if (!archived) {
      if (!current) return { ok: true, changed: false }
      await this.host.patchMeta(target, { archived: false })
      return { ok: true, changed: true }
    }
    const decision = archiveDecision({
      archived: current,
      running: this.host.isLive(target) && this.host.isBusy(target),
      liveWork: this.host.hasLiveWork(target),
      waitingForUser: this.host.needsAnswer(target),
      starting: this.host.isStarting(target),
    })
    if (!decision.ok) return decision
    if (!decision.changed) return { ok: true, changed: false }
    await this.host.patchMeta(target, { archived: true, archivedAt: Date.now() })
    return { ok: true, changed: true }
  }

  async detach(
    callerSessionId: string,
    target: string,
    initiator: 'model' | 'user' = 'model',
  ): Promise<FamilyOutcome<{ changed: boolean }>> {
    const sessionId = target === 'self' ? callerSessionId : target
    if (!this.knows(sessionId)) return { ok: false, code: 'unknown', reason: 'no session with that id in this runtime.' }
    const meta = await this.host.readMeta(sessionId)
    if (!meta) return { ok: false, code: 'unknown', reason: 'the session has no record to update.' }
    const decision = detachDecision(callerSessionId, sessionId, meta.metadata)
    if (!decision.ok) return decision
    if (meta.metadata.lineageDetached === true) return { ok: true, changed: false }
    const raised = this.host.raiseDetach?.(callerSessionId, {
      sessionId,
      parentSessionId: resolveLineage(meta.metadata)?.sessionId ?? '',
      initiator,
    })
    if (raised) {
      const settled = await raised
      if ('deny' in settled) return { ok: false, code: 'plugin_denied', reason: `a plugin refused the detach: ${settled.deny}` }
    }
    await this.host.patchMeta(sessionId, { lineageDetached: true })
    return { ok: true, changed: true }
  }
}
