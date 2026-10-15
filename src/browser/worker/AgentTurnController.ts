/**
 * Contract: AgentTurnController — the session turn lifecycle: phase, submit queue, pending and inject
 * messages, stopping flag and retry timer. Invariants:
 * - only one turn executes at a time; retry remains a running phase
 * - the pending message is consumed only at idle, never while halted on a user interaction
 * - an inject message leaves its queue exactly once (drained, consumed, removed or cleared by Stop)
 * - Stop clears pending AND inject messages
 */
import { submitCarriesToolResult } from '../../utils/sessionNeedsAnswer'
import type { AgentSessionPhase, AgentSessionToolInfo, AgentToolKind } from './AgentTurnState'
import type { AgentWorkerInboundMessage } from './workerProtocol'
import {
  isHaltSafeSlashCommandPrompt,
  isSlashCommandPrompt,
} from '../../utils/slashCommandPrompt'

export { isSlashCommandPrompt }

/**
 * How long `holdForAnswer` keeps the halt gate closed with no answer submit
 * arriving. The page sends the clear and the answer back to back (three
 * round trips at most), so this is a safety net for a page that died between
 * the two — after which the held turns run, exactly as they would have had
 * the halt been cleared any other way.
 */
export const ANSWER_HOLD_MS = 15_000

export type AgentTurnResult =
  | { status: 'completed' }
  | { status: 'aborted'; reason: string }
  | { status: 'failed'; code: string; message: string }

type SubmitMessage = Extract<
  AgentWorkerInboundMessage,
  { type: 'worker.submitMessage' }
>

export type QueuedTurn = {
  message: SubmitMessage
  source: 'user' | 'mailbox' | 'task_delivery' | 'plugin'
  /** A `plugin` turn's prompt as `prompt.submit` let it in (F-25). */
  plugin?: import('../../mods/promptNouns').PluginPromptTurn
  priority: number
  sequence: number
  /** Resolved when the turn's executeSubmit settles. UI turns leave this undefined. */
  completion?: {
    resolve(result: AgentTurnResult): void
    promise: Promise<AgentTurnResult>
  }
}

export type RetryInfo = {
  retryInMs: number
  attempt: number
  maxRetries: number
  errorKind?: string
  /**
   * Catalog key of the classification (`ProviderConnectivityIssue.titleKey`);
   * the webview resolves it with `t()` in its own locale.
   */
  errorTitleKey?: string
  /**
   * Legacy pre-i18n classification TEXT ("Provider rate limit reached") from
   * workers that predate `errorTitleKey`. Read, never written.
   */
  errorTitle?: string
  errorDetail?: string
}

export type AgentToolEndTransition = {
  ended: AgentSessionToolInfo | undefined
  reachedTurnBoundary: boolean
}

/** One submit parked in the pending batch while the session was busy. */
type PendingUserEntry = {
  /**
   * The ORIGINAL submit message. Kept whole (not flattened to its text) so
   * `promptUuid`, `isMeta` and a content-array prompt all survive the round
   * trip out of the batch — flattening lost the uuid (leaving the auto-run
   * turn with no bubble to dedup against) and could strip `isMeta` off a
   * hidden A2UI action, turning it into a visible user turn.
   */
  message: SubmitMessage
  /** What the NextMessage strip shows for this entry. */
  text: string
  /** Submit order across BOTH parked queues (pending + inject). */
  order: number
}

/** One plain-Enter submit parked while the session was busy. */
type InjectEntry = {
  message: SubmitMessage
  /** The bubble's id and the attachment's `source_uuid`. */
  uuid: string
  text: string
  order: number
  /** Wall-clock enqueue time: orders a mid-turn drain against background
   *  task notifications, which are queued outside this controller. */
  enqueuedAt: number
}

/** One inject message handed to the running turn by `drainInjectEntries`. */
export type InjectDrainItem = {
  uuid: string
  prompt: SubmitMessage['payload']['prompt']
  enqueuedAt: number
}

export type InjectMessageEntryView = {
  uuid: string
  text: string
  hasAttachments: boolean
}

export type InjectLandedInfo = {
  uuids: string[]
  via: 'midturn' | 'nextturn'
  turnUuid?: string
  text?: string
}

export type PendingConsumeInfo = {
  text: string
  promptUuid?: string
}

export type AgentTurnControllerOptions = {
  onStateChanged(): void
  onTurnReady(turn: QueuedTurn): void
  onPendingMessageChanged(
    text: string,
    reason: 'appended' | 'consumed',
    extra?: {
      promptUuids?: string[]
      entries?: string[]
      consumed?: PendingConsumeInfo
    },
  ): void
  onPendingMessageCleared(): void
  /** The inject queue changed (full list). */
  onInjectMessagesChanged?(entries: InjectMessageEntryView[]): void
  /** Inject messages were handed to the model. */
  onInjectMessagesLanded?(info: InjectLandedInfo): void
  /** Stop dropped these inject messages (handed back to the composer). */
  onInjectMessagesCleared?(entries: InjectMessageEntryView[]): void
  /**
   * True while the session is halted waiting for the user (an AskUserQuestion
   * card, a plan approval). The turn has ENDED, but parked input must not be
   * submitted underneath the unanswered interaction: it stays parked (pending
   * bubbles / strip) and flushes at the idle boundary after the answer's turn.
   */
  isAwaitingUser?(): boolean
  /**
   * A slash command typed while a turn is in flight whose command declares
   * `immediate: true`: the worker runs it now,
   * beside the turn, instead of parking it until the turn ends. Returns
   * whether it took the message; false parks it as before.
   */
  runImmediateCommand?(message: SubmitMessage): boolean
}

export type AgentTurnSnapshot = {
  phase: AgentSessionPhase
  isBusy: boolean
  isStopping: boolean
}

export class AgentTurnController {
  private phase: AgentSessionPhase = { kind: 'idle' }
  private streamActive = false
  private submitting = false
  private stopping = false

  private queue: QueuedTurn[] = []
  private nextSequence = 0
  /** Submits parked while the session was busy, oldest first. */
  private pendingUserEntries: PendingUserEntry[] = []
  /** Plain-Enter submits parked while busy, oldest first. */
  private injectEntries: InjectEntry[] = []
  private nextParkOrder = 0
  /** The turn currently dispatched to executeSubmit. Owned here
   *  so reset/dispose can settle its completion and Stop can reason about
   *  an in-flight turn that hasn't produced its first stream event yet. */
  private activeTurn: QueuedTurn | null = null
  /** Set once dispose() runs — later submits resolve aborted immediately
   *  instead of queueing against a dead worker. */
  private disposed = false

  private retryTimer: ReturnType<typeof setInterval> | null = null
  /**
   * The page dismissed a halt control and its answer submit is on the wire
   * (`holdForAnswer`). The halt RECORD is already gone — the control had to
   * dismiss at once — so this is what keeps the gate closed until the answer
   * dispatches. Without it, the clear opened the gate, a turn held under the
   * halt ran first, and the answer landed as a duplicate tool_result.
   */
  private answerExpected = false
  private answerHoldTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: AgentTurnControllerOptions) {}

  // --- Phase queries ---

  isBusy(): boolean {
    return this.phase.kind === 'running'
  }

  isStopping(): boolean {
    return this.stopping
  }

  getPhase(): AgentSessionPhase {
    return this.phase
  }

  /**
   * Set the phase directly. Worker-internal only: the dequeue
   * busy-mark and the worker's turn-end normalization
   * (`normalizeTurnEndPhase`, which also emits the transition). Not exposed
   * on the worker handle — external callers go through the mark* points.
   */
  setPhase(phase: AgentSessionPhase): void {
    this.phase = phase
  }

  // --- Stream lifecycle ---

  markStreamStart(): void {
    this.streamActive = true
    if (this.phase.kind !== 'idle') return
    this.phase = { kind: 'running', sub: { type: 'streaming' } }
  }

  markStreamEnd(): void {
    this.markStreamEndWithBoundary()
  }

  markStreamEndWithBoundary(): boolean {
    this.streamActive = false
    if (this.phase.kind !== 'running') return false
    if (this.phase.sub.type === 'tools') return false
    this.phase = { kind: 'idle' }
    this.consumePendingAsNextSubmit()
    this.pumpSubmits()
    return true
  }

  // --- Tool lifecycle ---

  markToolStart(name: string, kind: AgentToolKind, actionType?: string): void {
    const tool: AgentSessionToolInfo = {
      name,
      kind,
      ...(actionType !== undefined ? { actionType } : {}),
    }
    const existing =
      this.phase.kind === 'running' && this.phase.sub.type === 'tools'
        ? this.phase.sub.tools
        : []
    this.phase = {
      kind: 'running',
      sub: { type: 'tools', tools: [...existing, tool] },
    }
  }

  markToolEnd(): AgentSessionToolInfo | undefined {
    return this.markToolEndWithBoundary().ended
  }

  markToolEndWithBoundary(): AgentToolEndTransition {
    const tools =
      this.phase.kind === 'running' && this.phase.sub.type === 'tools'
        ? [...this.phase.sub.tools]
        : []
    const ended = tools.pop()
    this.phase =
      tools.length > 0
        ? { kind: 'running', sub: { type: 'tools', tools } }
        : this.streamActive
          ? { kind: 'running', sub: { type: 'streaming' } }
          : { kind: 'idle' }
    const reachedTurnBoundary = this.phase.kind === 'idle'
    if (reachedTurnBoundary) {
      this.consumePendingAsNextSubmit()
      this.pumpSubmits()
    }
    return {
      ended,
      reachedTurnBoundary,
    }
  }

  // --- Retry ---

  beginRetry(info: RetryInfo): void {
    this.clearRetryTimer()
    const deadlineMs = Date.now() + info.retryInMs
    this.phase = {
      kind: 'running',
      sub: {
        type: 'retry',
        attempt: info.attempt,
        maxRetries: info.maxRetries,
        deadlineMs,
        ...(info.errorKind !== undefined ? { errorKind: info.errorKind } : {}),
        ...(info.errorTitleKey !== undefined
          ? { errorTitleKey: info.errorTitleKey }
          : {}),
        ...(info.errorTitle !== undefined ? { errorTitle: info.errorTitle } : {}),
        ...(info.errorDetail !== undefined
          ? { errorDetail: info.errorDetail }
          : {}),
      },
    }
    this.options.onStateChanged()
    // Tick every second for the whole retry phase (countdown, then in-flight count-up). Cleared by
    // resumeFromRetry, endRetry and the turn's terminal `finally`.
    this.retryTimer = setInterval(() => {
      this.options.onStateChanged()
    }, 1_000)
  }

  endRetry(): void {
    this.clearRetryTimer()
  }

  /**
   * The provider recovered after a retry countdown: the first stream event
   * of the new attempt flips the phase back to streaming.
   * Previously nothing did this — `markStreamStart` no-ops while running,
   * so the UI kept showing "Retrying" (even a frozen countdown) while the
   * model was already producing output. No-op outside the retry phase.
   */
  resumeFromRetry(): void {
    if (this.phase.kind !== 'running' || this.phase.sub.type !== 'retry') {
      return
    }
    this.clearRetryTimer()
    this.phase = { kind: 'running', sub: { type: 'streaming' } }
    this.options.onStateChanged()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer)
      this.retryTimer = null
    }
  }

  // --- Stopping ---

  /**
   * Begin stopping. Returns false if already stopping or not busy (re-entrant
   * no-op). Caller should emit state and return early when false.
   */
  beginStopping(): boolean {
    if (!this.isBusy() || this.stopping) return false
    this.stopping = true
    return true
  }

  finishStopping(): void {
    this.stopping = false
  }

  // --- Halt gate ---

  /**
   * Halted on the user: the turn has ENDED on an unanswered AskUserQuestion
   * or a staged plan approval (the engine's records), or the page has just
   * cleared such a record and its answer has not dispatched yet.
   */
  private isHalted(): boolean {
    return this.answerExpected || (this.options.isAwaitingUser?.() ?? false)
  }

  /**
   * Whether `prompt` may start under a halt: the ANSWER (a tool-result
   * submit) — or a halt-safe built-in, which neither starts a model turn nor
   * rewrites the transcript / mode the open question hangs on
   * (isHaltSafeSlashCommandPrompt). `/compact`, `/clear`, `/plan` and
   * `/exit-plan` are held like any other prompt.
   */
  private static admittedUnderHalt(prompt: SubmitMessage['payload']['prompt']): boolean {
    return submitCarriesToolResult(prompt) || isHaltSafeSlashCommandPrompt(prompt)
  }

  /**
   * The page cleared a halt record ahead of the answer it is about to submit
   * (`worker.clearPlanApproval`: the approval control dismisses before the
   * approve / reject tool result goes out). Keep the gate closed until that
   * answer dispatches; `ANSWER_HOLD_MS` bounds a hold whose answer never
   * comes.
   */
  holdForAnswer(): void {
    this.answerExpected = true
    if (this.answerHoldTimer !== null) clearTimeout(this.answerHoldTimer)
    this.answerHoldTimer = setTimeout(() => {
      this.answerHoldTimer = null
      this.haltCleared()
    }, ANSWER_HOLD_MS)
  }

  private releaseAnswerHold(): void {
    this.answerExpected = false
    if (this.answerHoldTimer !== null) {
      clearTimeout(this.answerHoldTimer)
      this.answerHoldTimer = null
    }
  }

  /**
   * A halt record went away OUTSIDE an answer turn (an expired answer hold, a
   * halt the engine cleared underneath a turn that was not the answer). The
   * idle boundaries are the only other places that flush parked input and
   * pump the queue, and none is coming: run both here, or the strip and the
   * held turns sit until some unrelated later turn ends.
   */
  haltCleared(): void {
    this.releaseAnswerHold()
    if (!this.isBusy()) {
      this.consumePendingAsNextSubmit()
    }
    this.pumpSubmits()
  }

  // --- Submit queue ---

  submitUserMessage(message: SubmitMessage): void {
    const busy = this.submitting || this.isBusy()
    // Halted on the user with the composer still enabled (a staged plan
    // approval): a message that is not the answer cannot start a turn —
    // pumpSubmits holds it — so queuing it would hide it until the halt
    // settles. Park it like a busy-time send instead: it shows in the strip,
    // can be removed there, and runs once the answer's turn has settled.
    const heldByHalt =
      !busy &&
      !AgentTurnController.admittedUnderHalt(message.payload.prompt) &&
      this.isHalted()
    if (!busy && !heldByHalt) {
      const { delivery, promptUuid, isMeta, prompt, displayPrompt } = message.payload
      if (
        delivery === 'inject' &&
        promptUuid !== undefined &&
        !isMeta &&
        !isSlashCommandPrompt(prompt)
      ) {
        // The page sent it as mid-turn input because its snapshot still read
        // busy (and may be showing a pending bubble), but it starts a turn
        // right now: report it landed as that turn so the page swaps the
        // bubble for the turn's user message.
        this.options.onInjectMessagesLanded?.({
          uuids: [promptUuid],
          via: 'nextturn',
          turnUuid: promptUuid,
          text: displayPrompt ?? (typeof prompt === 'string' ? prompt : ''),
        })
      }
      this.enqueue(message, 'user', 0)
      return
    }
    // A hidden meta turn (an A2UI surface action) must never surface in the
    // user-visible next-message strip, and must never lose `isMeta` on the way
    // back out — flattening it into the pending text did both, turning a
    // model-only prompt into a visible user message. Queue it as its own turn
    // instead; the pump is blocked while busy, so it still runs at the next
    // idle boundary, ahead of the pending batch (lower sequence).
    if (message.payload.isMeta) {
      this.enqueue(message, 'user', 0)
      return
    }
    // An immediate command typed mid-turn runs at
    // once (`queryGuard.isActive && cmd.immediate`). Only while a turn is
    // actually running — a halt-held send is not mid-turn, and an idle
    // session runs every command at once anyway.
    if (busy && isSlashCommandPrompt(message.payload.prompt) && this.options.runImmediateCommand?.(message)) {
      return
    }
    if (
      message.payload.delivery === 'inject' &&
      !isSlashCommandPrompt(message.payload.prompt)
    ) {
      this.appendInjectEntry(message)
      return
    }
    this.appendPendingMessage(message)
  }

  enqueueExternalTurn(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
    source: 'mailbox' | 'task_delivery',
  ): void {
    const priority = source === 'mailbox' ? 1 : 2
    this.enqueue(message, source, priority)
  }

  /**
   * A plugin's `$.prompt.submit` (F-25): "a turn of its own, once the
   * session is idle" — queued beside the deliveries, after any user turn.
   */
  enqueuePluginTurn(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
    plugin: import('../../mods/promptNouns').PluginPromptTurn,
  ): void {
    this.queue.push({ message, source: 'plugin', plugin, priority: 2, sequence: this.nextSequence++ })
    this.pumpSubmits()
  }

  /**
   * Enqueue a turn and return a promise that resolves when the turn's
   * executeSubmit settles. Used by headless/sub-agent/teammate callers that
   * need to await actual turn completion (not just enqueue).
   */
  submitAndWait(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
    source: QueuedTurn['source'],
  ): Promise<AgentTurnResult> {
    // A disposed worker must not park callers forever — the
    // headless/sub-agent/teammate drives await this promise.
    if (this.disposed) {
      return Promise.resolve({ status: 'aborted', reason: 'worker_disposed' })
    }
    let resolve!: (result: AgentTurnResult) => void
    const promise = new Promise<AgentTurnResult>(r => { resolve = r })
    const priority = source === 'user' ? 0 : source === 'mailbox' ? 1 : 2
    this.queue.push({
      message,
      source,
      priority,
      sequence: this.nextSequence++,
      completion: { resolve, promise },
    })
    this.pumpSubmits()
    return promise
  }

  private enqueue(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
    source: QueuedTurn['source'],
    priority: number,
  ): void {
    this.queue.push({ message, source, priority, sequence: this.nextSequence++ })
    this.pumpSubmits()
  }

  pumpSubmits(): void {
    if (this.disposed) return
    if (this.submitting || this.isBusy()) return
    if (this.queue.length === 0) return
    // Halted on the user: only the ANSWER (a tool-result submit) or a local slash command may start;
    // held turns run when the answer's turn settles. This is the single dispatch gate.
    const halted = this.isHalted()
    // Highest priority (lowest number), FIFO within a priority via sequence.
    let bestIdx = -1
    for (let i = 0; i < this.queue.length; i++) {
      const a = this.queue[i]!
      if (halted && !AgentTurnController.admittedUnderHalt(a.message.payload.prompt)) {
        continue
      }
      const b = bestIdx === -1 ? undefined : this.queue[bestIdx]!
      if (
        !b ||
        a.priority < b.priority ||
        (a.priority === b.priority && a.sequence < b.sequence)
      ) {
        bestIdx = i
      }
    }
    if (bestIdx === -1) return
    const [next] = this.queue.splice(bestIdx, 1)
    // The answer is dispatching: the hold `holdForAnswer` opened is over. Not
    // at enqueue — a turn held under the halt has the lower sequence, and an
    // open gate would have picked it first.
    if (submitCarriesToolResult(next!.message.payload.prompt)) {
      this.releaseAnswerHold()
    }
    this.submitting = true
    this.activeTurn = next!
    // The turn counts as BUSY from dequeue, not from its first
    // stream event. executeSubmit's pre-stream setup (waitForInit, model
    // catalog grace, storage reads) previously ran with phase=idle, so the
    // composer gate re-enabled, Stop no-opped (`beginStopping` requires
    // isBusy), and task delivery / mailbox drains read the session as free.
    // Reusing the `streaming` sub-state keeps the wire phase shape frozen
    // (no new sub.type value for clients to learn); the spinner simply
    // starts at dispatch, which is the honest signal anyway.
    this.phase = { kind: 'running', sub: { type: 'streaming' } }
    this.options.onStateChanged()
    this.announceDeliveryTurn(next!)
    this.options.onTurnReady(next!)
  }

  /**
   * Give a manager-queued `<task-notification>` turn a stable uuid and report it as a next-turn
   * landing so the page renders its card. Mailbox turns are left alone.
   */
  private announceDeliveryTurn(turn: QueuedTurn): void {
    const { payload } = turn.message
    if (turn.source !== 'task_delivery' || payload.isMeta) return
    if (typeof payload.prompt !== 'string' || payload.prompt.length === 0) return
    const promptUuid =
      payload.promptUuid ??
      globalThis.crypto?.randomUUID?.() ??
      `delivery-${Date.now()}-${turn.sequence}`
    turn.message = { ...turn.message, payload: { ...payload, promptUuid } }
    this.options.onInjectMessagesLanded?.({
      uuids: [],
      via: 'nextturn',
      turnUuid: promptUuid,
      text: payload.prompt,
    })
  }

  /** Called by the Worker when a turn's executeSubmit resolves/rejects. */
  markExecutionFinished(): void {
    this.submitting = false
    this.activeTurn = null
    // A turn that dies before its stream opens: consume the pending message here (idle-gated).
    if (!this.isBusy()) {
      this.consumePendingAsNextSubmit()
    }
    this.pumpSubmits()
  }

  /** Called by the Worker when executeSubmit begins. */
  markExecutionStarted(): void {
    this.submitting = true
  }

  // --- Pending message ---

  /**
   * One string per parked entry — the strip's message LIST.
   *
   * `pendingText()` is this joined with newlines, which is lossy: an entry's
   * own text can contain newlines (a Shift+Enter multi-line composer submit),
   * so the join is not reversible by splitting. The UI needs the list, not
   * just the join, to count the queue and to show the first message whole.
   */
  private pendingEntryTexts(): string[] {
    return this.pendingUserEntries
      .map(entry => entry.text)
      .filter(text => text.length > 0)
  }

  /** The strip's text: every parked entry's label, newline-joined. */
  private pendingText(): string {
    return this.pendingEntryTexts().join('\n')
  }

  private pendingPromptUuids(): string[] {
    return this.pendingUserEntries
      .map(entry => entry.message.payload.promptUuid)
      .filter((uuid): uuid is string => typeof uuid === 'string')
  }

  private appendPendingMessage(message: SubmitMessage): void {
    const { prompt, displayPrompt } = message.payload
    this.pendingUserEntries.push({
      message,
      // A content-array prompt (an image send) has no text of its own, so the
      // UI supplies the label — without it the entry sat in the batch with
      // nothing to render and the send looked like it had been dropped.
      text: displayPrompt ?? (typeof prompt === 'string' ? prompt : ''),
      order: this.nextParkOrder++,
    })
    this.options.onPendingMessageChanged(this.pendingText(), 'appended', {
      promptUuids: this.pendingPromptUuids(),
      entries: this.pendingEntryTexts(),
    })
  }

  /**
   * Flush the parked batch into the submit queue at idle: consecutive plain-text submits merge into one
   * turn with the FIRST entry's `promptUuid`; content arrays and slash commands flush as their own turns.
   */
  consumePendingAsNextSubmit(): void {
    if (this.pendingUserEntries.length === 0 && this.injectEntries.length === 0) {
      return
    }
    if (this.isHalted()) {
      return
    }
    // Both parked queues flush together, in SUBMIT order: an inject message
    // that was never drained (no tool round followed it) becomes part of the
    // next turn exactly like a strip entry typed at the same point.
    type Parked = {
      kind: 'next' | 'inject'
      message: SubmitMessage
      text: string
      order: number
      uuid?: string
    }
    const strip = this.pendingUserEntries
    const injected = this.injectEntries
    this.pendingUserEntries = []
    this.injectEntries = []
    const entries: Parked[] = [
      ...strip.map(e => ({ kind: 'next' as const, message: e.message, text: e.text, order: e.order })),
      ...injected.map(e => ({
        kind: 'inject' as const,
        message: e.message,
        text: e.text,
        order: e.order,
        uuid: e.uuid,
      })),
    ].sort((a, b) => a.order - b.order)

    type Turn = { message: SubmitMessage; injectUuids: string[]; hasStrip: boolean }
    const turns: Turn[] = []
    let textRun: Parked[] = []
    const injectUuidsOf = (run: Parked[]): string[] =>
      run.filter(e => e.kind === 'inject' && e.uuid).map(e => e.uuid!)
    const flushTextRun = () => {
      if (textRun.length === 0) return
      turns.push({
        message: {
          type: 'worker.submitMessage',
          payload: {
            prompt: textRun.map(e => e.message.payload.prompt as string).join('\n'),
            ...(textRun[0]!.message.payload.promptUuid !== undefined
              ? { promptUuid: textRun[0]!.message.payload.promptUuid }
              : {}),
          },
        },
        injectUuids: injectUuidsOf(textRun),
        hasStrip: textRun.some(e => e.kind === 'next'),
      })
      textRun = []
    }
    for (const entry of entries) {
      // A slash command breaks the run: merged into text it would reach the
      // model as literal "/compact" (or, first, run with the user's message as
      // its arguments). It is its own turn, in submit order, like an attachment.
      if (
        typeof entry.message.payload.prompt === 'string' &&
        !isSlashCommandPrompt(entry.message.payload.prompt)
      ) {
        textRun.push(entry)
        continue
      }
      flushTextRun()
      turns.push({
        message: entry.message,
        injectUuids: injectUuidsOf([entry]),
        hasStrip: entry.kind === 'next',
      })
    }
    flushTextRun()

    if (strip.length > 0) {
      // Hide the strip AND hand the WebView the turn it became, so the user's
      // own message stays on screen instead of vanishing until the turn ends.
      const first = turns.find(turn => turn.hasStrip)?.message
      this.options.onPendingMessageChanged('', 'consumed', {
        consumed: {
          text: strip
            .map(entry => entry.text)
            .filter(text => text.length > 0)
            .join('\n'),
          ...(first?.payload.promptUuid !== undefined
            ? { promptUuid: first.payload.promptUuid }
            : {}),
        },
      })
    }
    // Landed at the consume, not at dequeue: a queued user turn survives Stop
    // (clearForInterrupt keeps it), so from here it WILL be sent. Reported
    // before the list empties so a page never sees the bubble vanish first.
    for (const turn of turns) {
      if (turn.injectUuids.length === 0) continue
      const prompt = turn.message.payload.prompt
      this.options.onInjectMessagesLanded?.({
        uuids: turn.injectUuids,
        via: 'nextturn',
        ...(turn.message.payload.promptUuid !== undefined
          ? { turnUuid: turn.message.payload.promptUuid }
          : {}),
        text:
          turn.message.payload.displayPrompt ??
          (typeof prompt === 'string' ? prompt : ''),
      })
    }
    if (injected.length > 0) {
      this.options.onInjectMessagesChanged?.([])
    }
    for (const turn of turns) {
      this.queue.push({
        message: turn.message,
        source: 'user',
        priority: 0,
        sequence: this.nextSequence++,
      })
    }
    this.pumpSubmits()
  }

  // --- Inject messages ---

  private injectViews(): InjectMessageEntryView[] {
    return this.injectEntries.map(entry => ({
      uuid: entry.uuid,
      text: entry.text,
      hasAttachments: typeof entry.message.payload.prompt !== 'string',
    }))
  }

  private appendInjectEntry(message: SubmitMessage): void {
    const { prompt, displayPrompt, promptUuid } = message.payload
    const order = this.nextParkOrder++
    this.injectEntries.push({
      message,
      uuid: promptUuid ?? `inject-${order}`,
      text: displayPrompt ?? (typeof prompt === 'string' ? prompt : ''),
      order,
      enqueuedAt: Date.now(),
    })
    this.options.onInjectMessagesChanged?.(this.injectViews())
  }

  /**
   * Hand every parked inject message to the RUNNING turn (the query loop's
   * mid-turn drain). They leave the queue here, in the same synchronous step
   * that reports them landed, so x / Stop / the idle consume can never see
   * them again.
   */
  drainInjectEntries(): InjectDrainItem[] {
    // While Stop unwinds the turn is still "running", so an Enter in that
    // window parks here AFTER clearForInterrupt ran. The unwinding loop must
    // not take it (its next model call aborts: the message would land with no
    // reply); it stays parked and the idle consume sends it as the next turn.
    if (this.stopping) return []
    if (this.injectEntries.length === 0) return []
    const drained = this.injectEntries
    this.injectEntries = []
    // Landed first, then the (now empty) list: see consumePendingAsNextSubmit.
    this.options.onInjectMessagesLanded?.({
      uuids: drained.map(entry => entry.uuid),
      via: 'midturn',
    })
    this.options.onInjectMessagesChanged?.([])
    return drained.map(entry => ({
      uuid: entry.uuid,
      prompt: entry.message.payload.prompt,
      enqueuedAt: entry.enqueuedAt,
    }))
  }

  /** Remove one parked inject message (its x). Null when it already landed
   *  or was removed: first writer wins. */
  removeInjectEntry(uuid: string): { text: string } | null {
    const index = this.injectEntries.findIndex(entry => entry.uuid === uuid)
    if (index === -1) return null
    const [removed] = this.injectEntries.splice(index, 1)
    this.options.onInjectMessagesChanged?.(this.injectViews())
    return { text: removed!.text }
  }

  getInjectMessageViews(): InjectMessageEntryView[] {
    return this.injectViews()
  }

  /** Whether any inject message is parked for the running turn — the same
   *  queue `drainInjectEntries` takes, false while Stop unwinds (a drain
   *  then returns nothing, so there is nothing to wake for). */
  hasInjectEntries(): boolean {
    return !this.stopping && this.injectEntries.length > 0
  }

  getNextMessageTexts(): string[] {
    return this.pendingEntryTexts()
  }

  clearPendingUserMessage(): void {
    this.pendingUserEntries = []
    this.options.onPendingMessageCleared()
  }

  getPendingMessage(): string | undefined {
    const text = this.pendingText()
    return text.length > 0 ? text : undefined
  }

  // --- Interrupt ---

  clearForInterrupt(): void {
    // Stop ends the halt too (QueryEngine.interrupt clears the records); an
    // answer hold outliving it would park the next send for ANSWER_HOLD_MS.
    this.releaseAnswerHold()
    if (this.pendingUserEntries.length > 0) {
      this.pendingUserEntries = []
      this.options.onPendingMessageCleared()
    }
    if (this.injectEntries.length > 0) {
      const views = this.injectViews()
      this.injectEntries = []
      this.options.onInjectMessagesCleared?.(views)
      this.options.onInjectMessagesChanged?.([])
    }
    // Stop also drops queued EXTERNAL turns (task delivery, mailbox) and busy-time `isMeta` submits, so
    // nothing revives the halted session; queued user turns are kept.
    const isRevivable = (t: QueuedTurn): boolean =>
      t.source === 'user' && t.message.payload.isMeta !== true
    if (this.queue.some(t => !isRevivable(t))) {
      const kept: QueuedTurn[] = []
      for (const turn of this.queue) {
        if (isRevivable(turn)) {
          kept.push(turn)
          continue
        }
        turn.completion?.resolve({
          status: 'aborted',
          reason: 'parent_interrupted',
        })
      }
      this.queue = kept
    }
  }

  // --- Snapshot ---

  snapshot(): AgentTurnSnapshot {
    return {
      phase: this.phase,
      isBusy: this.isBusy(),
      isStopping: this.stopping,
    }
  }

  // --- Lifecycle ---

  /**
   * Clear all turn state. Every queued (and the active) `submitAndWait`
   * completion is RESOLVED as aborted first — silently dropping
   * them would hang the headless/sub-agent/teammate drives that await turn
   * completion, permanently in the teammate idle-loop case.
   */
  reset(reason = 'worker_reset'): void {
    const result: AgentTurnResult = { status: 'aborted', reason }
    this.activeTurn?.completion?.resolve(result)
    this.activeTurn = null
    for (const turn of this.queue) {
      turn.completion?.resolve(result)
    }
    this.clearRetryTimer()
    this.releaseAnswerHold()
    this.phase = { kind: 'idle' }
    this.streamActive = false
    this.submitting = false
    this.stopping = false
    this.queue = []
    this.pendingUserEntries = []
    if (this.injectEntries.length > 0) {
      this.injectEntries = []
      this.options.onInjectMessagesChanged?.([])
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reset('worker_disposed')
  }
}
