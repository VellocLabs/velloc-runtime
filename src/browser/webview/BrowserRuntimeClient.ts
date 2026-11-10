import type { BrowserBridgeTransport, BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import type { RuleEdit } from '../../permissions/ruleUpdates'
import type {
  AgentRuntimeWorkerInitPayload,
  AgentRuntimeWorkerSnapshot,
} from '../worker/workerProtocol'
import { isSlashCommandPrompt } from '../../utils/slashCommandPrompt'
import { randomUuid } from '../../utils/randomUuid'
import type { Message } from '../../runtime/RuntimeTypes'
import type { ContentBlockParam } from '../../runtime/RuntimeTypes'
import type { AppendMessage } from '@assistant-ui/react'
import type { FileSearchRequest, RuntimeFileAccess } from '../runtimeClient/fileAccess'
import type { FsxListDirResult, FsxListTreeResult, FsxSearchState } from '../runtimeProtocol'
import { SESSION_OPEN_FORBIDDEN } from '../runtimeClient/workerTransportOverConnection'
import {
  buildPromptFromAppendMessage,
  extractTextFromAppendMessage,
} from './assistantUiAdapter'
import { serializePassagePrompt } from './capturedPassages'
import { passagesOfMetadata } from './replyQuote'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { BundledSkillBodyResult } from '../../skillLibrary/builtinSkillBody'
import type { TurnFileChange } from '../../utils/turnDiffs'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import {
  getBootDiagnosticTraceId,
  installSessionTracer,
  type Span as TraceSpan,
} from '../../utils/sessionTrace'
import { isTraceLogUrlFlagEnabled } from '../../utils/traceLogGate'
import type {
  BrowserWorkerClientInboundMessage,
  BrowserWorkerClientTransport,
} from './sharedWorkerTransport'
import type {
  BrowserRuntimeClientState,
  InjectRemoveResult,
  InjectRestoreDraft,
  SubmitDelivery,
} from './browserRuntimeClientState'
import { RuntimeClientParkedInput } from './RuntimeClientParkedInput'
import { RuntimeClientFileRequests } from './RuntimeClientFileRequests'
import type { RuntimeClientDetailRequests } from './RuntimeClientDetailRequests'
import { routeWorkerDebugLog } from './workerDebugLog'

export {
  createSharedWorkerTransport,
  type AgentChangesMessage,
  type BrowserWorkerClientInboundMessage,
  type BrowserWorkerClientTransport,
  type WorkerStreamGapMessage,
} from './sharedWorkerTransport'
export type {
  BrowserRuntimeClientState,
  InjectBubble,
  InjectRemoveResult,
  SubmitDelivery,
} from './browserRuntimeClientState'

export { setModelUploadHandler } from './workerDebugLog'

// Re-exported from its own module so the early index.html warm-up script and
// this boot path share ONE worker asset (same URL + name) and thus one shared
// instance. See createBrowserRuntimeSharedWorker.ts.
export { createBrowserRuntimeSharedWorker } from './createBrowserRuntimeSharedWorker'

export type BrowserRuntimeToolResultSubmission = {
  toolCallId: string
  toolName: string
  result: unknown
  isError?: boolean
}

export type BrowserRuntimeClientOptions = {
  createWorkerTransport: () => BrowserWorkerClientTransport
  /** The page's host calls (`ui.pickAttachmentFiles`) — a client's, scope-checked by the runtime. */
  hostBridgeTransport: BrowserBridgeTransport
  /**
   * The client's files — the Files view, path chips, picked attachments,
   * composer uploads — over `fsx` on the runtime connection. There is no
   * `fs.*` fallback: a client without it cannot touch files.
   */
  files?: RuntimeFileAccess
  initPayload: AgentRuntimeWorkerInitPayload
}

type StateListener = (state: BrowserRuntimeClientState) => void

/**
 * Model-facing text of the hidden `isMeta` continuation the composer's
 * Continue button submits (`continueConversation`). Never rendered — the
 * transcript view filters `isMeta` user turns — so it is not a catalog
 * string.
 */
export const CONTINUE_CONVERSATION_PROMPT = 'Continue from where you left off.'

/**
 * Continuation text for the assistant-ended-on-tool-calls case; also hidden
 * behind `isMeta`.
 */
export const RESUME_INTERRUPTED_TOOLS_PROMPT =
  '[Resume interrupted tool execution]'

export class BrowserRuntimeClient {
  private readonly createWorkerTransport: () => BrowserWorkerClientTransport
  private initPayload: AgentRuntimeWorkerInitPayload
  private transport: BrowserWorkerClientTransport | null = null
  private unsubscribeTransport: (() => void) | null = null
  private readonly listeners = new Set<StateListener>()
  private state: BrowserRuntimeClientState = {
    status: 'idle',
    snapshot: null,
    transcriptMessages: [],
    liveEvents: [],
    lastError: null,
    transcriptOnly: false,
    pendingPrompt: null,
    pendingPromptId: null,
    liveEventsTurnStart: 0,
    preSplitPrompt: null,
    preSplitPromptId: null,
    turnDiffHistory: null,
    sessionChangeFigures: null,
    pendingMessage: null,
    pendingMessageEntries: null,
    pendingClearInFlight: false,
  }
  private lastKnownOrdinal = 0
  /**
   * Set when start() resolved on a provisional snapshot before the worker's
   * pushed transcript arrived: the catch-up pull waits for that copy so it
   * can ask only for later rows, or for `worker.ready` if no copy comes.
   */
  private catchUpPullPending = false
  private cachedExternalState: BrowserRuntimeClientState | null = null
  /**
   * Open span for an in-progress `start()` call. Closed when the matching
   * `worker.ready` lands so the start latency is captured edge-to-edge
   * (UI thread initiation → SharedWorker reply).
   */
  private startSpan: TraceSpan | null = null
  private readyWaiters: Array<(snapshot: AgentRuntimeWorkerSnapshot) => void> =
    []
  private stateWaiters: Array<(snapshot: AgentRuntimeWorkerSnapshot) => void> =
    []
  /** Resolved when the manager refuses worker.init because the persisted marker
   *  says this session is shut down — start() then degrades to read-only. */
  private shutdownInitRefused = false
  private shutdownWaiters: Array<() => void> = []
  /** Cancels an in-flight `startReadOnly` read (its timer and listener). */
  private cancelReadOnlyLoad: (() => void) | null = null
  private messagesWaiters: Array<(messages: Message[]) => void> = []
  private readonly parkedInput: RuntimeClientParkedInput
  private readonly fileRequests: RuntimeClientFileRequests
  /** Set once the first detail request has loaded it (`loadDetailRequests`). */
  private detailRequests: RuntimeClientDetailRequests | null = null
  private detailRequestsLoad: Promise<RuntimeClientDetailRequests> | null = null
  /** Bumped by `dispose`, so a detail request that spans one resolves null. */
  private disposeCount = 0

  constructor(options: BrowserRuntimeClientOptions) {
    this.createWorkerTransport = options.createWorkerTransport
    this.initPayload = options.initPayload
    const client = this
    this.parkedInput = new RuntimeClientParkedInput({
      get state() { return client.state },
      set state(next) { client.state = next },
      get transport() { return client.transport },
      get interruptRequested() { return client.interruptRequested },
      emitState: () => this.emitState(),
    })
    this.fileRequests = new RuntimeClientFileRequests(
      options.files ?? null,
      options.hostBridgeTransport,
      {
        get state() { return client.state },
        get initPayload() { return client.initPayload },
        startOnce: () => this.startOnce(),
      },
    )
  }

  getState(): BrowserRuntimeClientState {
    if (this.cachedExternalState) {
      return this.cachedExternalState
    }
    const snapshot: BrowserRuntimeClientState = {
      ...this.state,
      transcriptMessages: this.state.transcriptMessages,
      liveEvents: this.state.liveEvents,
    }
    this.cachedExternalState = snapshot
    return snapshot
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(opts?: { traceId?: string }): Promise<BrowserRuntimeClientState> {
    if (this.transport) {
      return this.getState()
    }

    const tracer = installSessionTracer({ context: 'ui' })
    const traceId = opts?.traceId
    const startSpan = tracer.span('ui.client.start', {
      traceId,
      attrs: { sessionId: this.initPayload.sessionId },
    })
    // Hold the start span on the instance so the worker.ready receipt
    // can close it from the message handler — `start()` itself is
    // already awaiting waitForReady which races the same event.
    this.startSpan = startSpan

    this.state = {
      ...this.state,
      status: 'initializing',
      snapshot: null,
      lastError: null,
      // A LIVE start is not a settled read-only view. Clearing it here matters
      // for the restart-after-read-only order (`dispose` → `start`) as much as
      // for the first start.
      transcriptOnly: false,
    }
    this.emitState()

    this.transport = this.createWorkerTransport()
    this.unsubscribeTransport = this.transport.addMessageListener(message => {
      void this.handleWorkerMessage(message)
    })

    tracer.event('ui.worker.init.post', {
      traceId: startSpan.traceId,
      parentSpanId: startSpan.spanId,
      attrs: { sessionId: this.initPayload.sessionId },
    })
    await this.transport.postMessage({
      type: 'worker.init',
      payload: { ...this.initPayload, traceId: startSpan.traceId },
    })

    // Race the init against a shutdown refusal: the manager gate
    // (SessionInitOrchestrator) answers worker.init for a session marked
    // shutdown with a session_shutdown error and never sends worker.ready, so a
    // plain waitForReady() would hang. On that refusal this client becomes the
    // read-only transcript view instead. A grant that may not open sessions at
    // all (`observe`: `session.open` is `control`) is refused the same way —
    // `session_open_forbidden` — and reads every session the same way.
    const shutdownRefused = new Promise<void>(resolve => {
      if (this.shutdownInitRefused) { resolve(); return }
      this.shutdownWaiters.push(resolve)
    })
    const ready = await Promise.race([
      this.waitForReady().then(() => 'ready' as const),
      shutdownRefused.then(() => 'shutdown' as const),
    ])
    // The race's loser never settles: drop its waiter. And the refusal is
    // consumed — a later start() (after a dispose) must ask the manager again,
    // not degrade on this one.
    this.shutdownWaiters = []
    this.shutdownInitRefused = false
    if (ready === 'shutdown') {
      // No worker.ready is coming: release the ready waiter the race left and
      // close the start span here, or both stay open for the client's life.
      this.readyWaiters = []
      this.startSpan?.end({ readOnly: true })
      this.startSpan = null
      // Tear down the half-open transport (it never registered a runtime) and
      // load the persisted transcript read-only.
      this.unsubscribeTransport?.()
      this.unsubscribeTransport = null
      await this.transport?.dispose?.()
      this.transport = null
      return this.startReadOnly()
    }
    const provisional =
      this.state.snapshot?.uiReady === true && !this.state.snapshot.initialized
    if (provisional && this.lastKnownOrdinal === 0) {
      this.catchUpPullPending = true
    } else {
      void this.requestMessages()
    }

    return this.getState()
  }

  async submitMessage(
    prompt: string | Array<ContentBlockParam>,
    displayPrompt?: string,
    delivery?: SubmitDelivery,
    restoreDraft?: InjectRestoreDraft,
  ): Promise<void> {
    const promptUuid = randomUuid()
    const display = displayPrompt ?? (typeof prompt === 'string' ? prompt : '')
    await this.submitInput(prompt, {
      ...(restoreDraft ? { restoreDraft } : {}),
      // The optimistic pending bubble only shows text. For content-array
      // sends (images) there's no meaningful text to flash, so it stays
      // empty until the persisted user message renders the image.
      pendingPrompt: display,
      pendingPromptId: promptUuid,
      promptUuid,
      ...(display ? { displayPrompt: display } : {}),
      ...(delivery ? { delivery } : {}),
    })
  }

  /**
   * Submit a hidden, model-only "meta" turn — used by A2UI surface actions (a
   * button click). Carries `isMeta: true`, so the worker records it as internal
   * context the model receives while the chat view hides it (assistantUiAdapter
   * filters `!isMeta` user turns). No optimistic bubble (pendingPrompt: null).
   */
  async submitActionMessage(prompt: string): Promise<void> {
    if (!prompt.trim()) return
    const promptUuid = randomUuid()
    await this.submitInput(prompt, {
      pendingPrompt: null,
      pendingPromptId: null,
      promptUuid,
      isMeta: true,
    })
  }

  async submitComposerMessage(
    message: AppendMessage,
    options: { delivery?: SubmitDelivery } = {},
  ): Promise<void> {
    const prompt = await buildPromptFromAppendMessage(
      message,
      attachment => this.fileRequests.uploadComposerAttachment(attachment),
    )
    // Kept in case this lands as an inject message that is later removed or
    // dropped by Stop: the composer gets the files back, not their names.
    const files = (message.attachments ?? []).flatMap(attachment =>
      attachment.file instanceof File ? [attachment.file] : [],
    )
    const restoreDraft: InjectRestoreDraft | undefined =
      files.length > 0
        ? {
            text: serializePassagePrompt(
              passagesOfMetadata(message.metadata),
              extractTextFromAppendMessage(message),
            ),
            files,
          }
        : undefined

    if (typeof prompt === 'string') {
      if (!prompt.trim()) {
        return
      }
      await this.submitMessage(prompt, undefined, options.delivery, restoreDraft)
      return
    }

    // Content-array send (images present). Don't drop image-only sends just
    // because the text part is empty.
    if (prompt.length === 0) {
      return
    }
    // An image-only send has no text at all; fall back to the attachment
    // filenames so the next-message strip has something to render when this
    // lands while the session is busy.
    const displayPrompt =
      extractTextFromAppendMessage(message) ||
      (message.attachments ?? [])
        .map(attachment => attachment.name)
        .filter(name => typeof name === 'string' && name.length > 0)
        .join(', ')
    await this.submitMessage(prompt, displayPrompt, options.delivery, restoreDraft)
  }

  // Parked mid-turn input (inject bubbles, next-message strip): RuntimeClientParkedInput.
  removeInjectMessage(uuid: string): Promise<InjectRemoveResult> {
    return this.parkedInput.removeInjectMessage(uuid)
  }

  clearPendingMessage(): void {
    this.parkedInput.clearPendingMessage()
  }

  async submitToolResult(
    submission: BrowserRuntimeToolResultSubmission,
  ): Promise<void> {    await this.submitInput(
      [
        {
          type: 'tool-result',
          toolCallId: submission.toolCallId,
          result: serializeToolResultContent(submission.result),
          ...(submission.isError ? { isError: true } : {}),
        },
      ],
      {
        pendingPrompt: null,
        pendingPromptId: null,
        toolCallDetail: {
          toolCallId: submission.toolCallId,
          toolName: submission.toolName,
          result: submission.result,
          isError: submission.isError,
        },
      },
    )
  }

  /**
   * Continue an interrupted or completed conversation via a hidden `isMeta` continuation (as
   * `PROVIDER_API_ERROR_RESUME_PROMPT` does), never a visible or empty user turn. Only call
   * when the conversation is resumable (check via isConversationResumable).
   */
  async continueConversation(): Promise<void> {
    const messages = this.state.transcriptMessages
    if (!messages.length) return

    const lastMsg = messages[messages.length - 1]
    const lastMsgType = lastMsg.type

    if (lastMsgType === 'user') {
      // A pending user prompt or the interrupt marker with no assistant
      // reply — the model's work is already in the transcript, so re-enter
      // the loop without restating anything.
      await this.submitContinuation(CONTINUE_CONVERSATION_PROMPT)
    } else if (lastMsgType === 'assistant') {
      // Check if assistant message has tool calls
      const content = (lastMsg as { message?: { content?: unknown } }).message?.content
      const hasToolCalls = Array.isArray(content) && content.some(
        (block: { type?: unknown }) => block.type === 'tool-call'
      )

      if (hasToolCalls) {
        // Has pending tool calls - inject resume note
        // TODO: Investigate if query loop can auto-resume pending tools
        await this.submitContinuation(RESUME_INTERRUPTED_TOOLS_PROMPT)
      } else {
        await this.submitContinuation(CONTINUE_CONVERSATION_PROMPT)
      }
    }
  }

  /**
   * Hidden, model-only continuation turn: `isMeta: true` so the worker
   * persists it as internal context the transcript view never renders
   * (assistantUiAdapter filters `isMeta` user turns), and no optimistic
   * bubble (`pendingPrompt: null`) so nothing flashes while it submits.
   */
  private async submitContinuation(prompt: string): Promise<void> {
    await this.submitInput(prompt, {
      pendingPrompt: null,
      pendingPromptId: null,
      promptUuid: randomUuid(),
      isMeta: true,
    })
  }

  /**
   * The detail-request helper, imported on the first detail request. Resolves
   * null when the client was disposed while the import was pending; a failed
   * import is retried by the next request.
   */
  private async loadDetailRequests(): Promise<RuntimeClientDetailRequests | null> {
    const disposeCount = this.disposeCount
    this.detailRequestsLoad ??= import('./RuntimeClientDetailRequests').then(
      ({ RuntimeClientDetailRequests }) => {
        const client = this
        this.detailRequests = new RuntimeClientDetailRequests({
          get transport() { return client.transport },
          get initPayload() { return client.initPayload },
          startOnce: () => this.startOnce(),
        })
        return this.detailRequests
      },
      (error: unknown) => {
        this.detailRequestsLoad = null
        throw error
      },
    )
    const detailRequests = await this.detailRequestsLoad
    return disposeCount === this.disposeCount ? detailRequests : null
  }

  // On-demand details: RuntimeClientDetailRequests, loaded on first use.
  async loadToolCallDetail(
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    return (await this.loadDetailRequests())?.loadToolCallDetail(toolCallId) ?? null
  }

  /**
   * Ask for the turn-diff history when a view lists it; it arrives as
   * `worker.turnDiffHistory`. An opened session sends only its stored figures
   * until something needs the history.
   */
  async requestTurnDiffHistory(): Promise<void> {
    await this.startOnce()
    await this.transport?.postMessage({ type: 'worker.getTurnDiffHistory' })
  }

  async loadTurnDiffDetail(
    turnIndex: number,
  ): Promise<TurnFileChange[] | null> {
    return (await this.loadDetailRequests())?.loadTurnDiffDetail(turnIndex) ?? null
  }

  async loadBundledSkillBody(
    name: string,
  ): Promise<BundledSkillBodyResult | null> {
    return (await this.loadDetailRequests())?.loadBundledSkillBody(name) ?? null
  }

  private async submitInput(
    prompt: string | Array<ContentBlockParam>,
    options: {
      pendingPrompt: string | null
      pendingPromptId: string | null
      promptUuid?: string
      toolCallDetail?: BrowserToolCallDetailRecord
      isMeta?: boolean
      displayPrompt?: string
      delivery?: SubmitDelivery
      restoreDraft?: InjectRestoreDraft
    },
  ): Promise<void> {
    await this.startOnce()
    // The optimistic bubble belongs ONLY to a submit while IDLE: a busy submit goes to the
    // "next message" strip, which is the single source of truth while busy.
    const sessionBusy = this.state.snapshot?.isBusy === true
    const showOptimisticBubble = !sessionBusy && !options.isMeta
    // A plain-Enter send while busy is shown IN the conversation at once, as a
    // pending bubble pinned at the bottom (the worker confirms or re-routes it
    // with `injectMessagesUpdated` / `pendingMessageUpdated`). A slash command
    // always goes to the next-message strip, so it gets no bubble.
    const showInjectBubble =
      sessionBusy &&
      !options.isMeta &&
      options.delivery === 'inject' &&
      options.promptUuid !== undefined &&
      !isSlashCommandPrompt(prompt)
    if (showInjectBubble && options.restoreDraft) {
      this.parkedInput.injectDrafts.set(options.promptUuid!, options.restoreDraft)
    }
    this.state = {
      ...this.state,
      status: 'submitting',
      lastError: null,
      ...(showInjectBubble
        ? {
            injectBubbles: [
              ...(this.state.injectBubbles ?? []),
              {
                uuid: options.promptUuid!,
                text: options.displayPrompt ?? (typeof prompt === 'string' ? prompt : ''),
                hasAttachments: typeof prompt !== 'string',
                state: 'pending' as const,
                optimistic: true,
              },
            ],
          }
        : {}),
      // Only a submit that STARTS a turn may touch the running turn's view.
      // While the session is busy this submit is routed into the next-message
      // strip and the turn in flight keeps streaming — and since the transcript
      // is not refetched until turn end, BOTH of these are the sole render of
      // that turn: `liveEvents` is its streamed output, `pendingPrompt` is its
      // user bubble. Resetting either one here deleted the running turn from
      // the screen (truncated reply / vanished user message) the moment the
      // user typed ahead.
      ...(sessionBusy
        ? {}
        : {
            liveEvents: [],
            liveEventsTurnStart: 0,
            preSplitPrompt: null,
            preSplitPromptId: null,
            pendingPrompt: showOptimisticBubble ? options.pendingPrompt : null,
            pendingPromptId: showOptimisticBubble
              ? options.pendingPromptId
              : null,
          }),
    }
    this.emitState()

    // Yield to the browser so React can render the submitting state
    // before the in-process transport processes the entire request
    // synchronously within postMessage.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0)
    })

    await this.transport?.postMessage({
      type: 'worker.submitMessage',
      payload: {
        prompt,
        promptUuid: options.promptUuid,
        toolCallDetail: options.toolCallDetail,
        isMeta: options.isMeta,
        // Label for the next-message strip when the worker parks this submit.
        // An image-only send has no text in `prompt`, so without it the entry
        // would sit in the pending batch with nothing to render.
        ...(options.displayPrompt ? { displayPrompt: options.displayPrompt } : {}),
        ...(options.delivery ? { delivery: options.delivery } : {}),
      },
    })
  }

  async interrupt(): Promise<void> {
    this.interruptRequested = true
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.interrupt',
    })
  }

  async setModelSelection(
    selection: BrowserLlmSelection,
  ): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.setModelSelection',
      payload: {
        selection,
      },
    })
    await this.requestState()
    return this.getState()
  }

  async setPermissionMode(mode: string): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.setPermissionMode',
      payload: {
        mode,
      },
    })
    await this.requestState()
    return this.getState()
  }

  /**
   * Save (a token count) or clear (`'auto'`) the active model's auto-compact
   * window — the composer popover's drag handle. The result arrives on the
   * snapshot (`autoCompact`, with `saveError` on a failed write).
   */
  async setAutoCompactWindow(value: number | 'auto'): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.setAutoCompactWindow',
      payload: { value },
    })
    await this.requestState()
    return this.getState()
  }

  /**
   * Persist the user's acceptance of the Bypass-Permissions warning dialog
   * (F-13) to `userSettings.skipDangerousModePermissionPrompt`. Suppresses
   * the warning on future switches into bypass mode.
   */
  async setSkipDangerousMode(value: boolean): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.setSkipDangerousMode',
      payload: {
        value,
      },
    })
    await this.requestState()
    return this.getState()
  }

  async resolveToolUseConfirm(params: {
    approvalCallId: string
    behavior: 'allow' | 'reject' | 'abort'
    updatedInput?: Record<string, unknown>
    feedback?: string
    ruleEdits?: RuleEdit[]
  }): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.resolveToolUseConfirm',
      payload: params,
    })
    await this.requestState()
    return this.getState()
  }

  /**
   * Grant a permission from the ask-modal banner: add an
   * allow rule to the live session so the gated tool's retry passes, and (when
   * `persist`) write it to settings.json. The banner submits the tool-result
   * separately to resume the loop.
   */
  async addPermissionRule(params: {
    rule: string
    toolCallId: string
    persist: boolean
  }): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.addPermissionRule',
      payload: params,
    })
    await this.requestState()
    return this.getState()
  }

  /**
   * Apply a general RuleEdit (F-13) — used by the banner's "Allow this
   * folder" to add the target's directory to `additionalDirectories` (live +
   * persisted). When `toolCallId` is set the matching pending prompt is cleared;
   * the caller submits the tool-result separately to resume the loop.
   */
  async applyPermissionUpdate(params: {
    update: RuleEdit
    toolCallId?: string
  }): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.applyPermissionUpdate',
      payload: params,
    })
    await this.requestState()
    return this.getState()
  }

  /**
   * Resolve a pending plan approval: clear it AUTHORITATIVELY in the engine and
   * pull a fresh snapshot, so the plan-approval control dismisses immediately
   * (instead of staying pinned until the follow-up turn completes). Called by
   * the footer plan control on BOTH approve and keep-planning, BEFORE
   * setPermissionMode / submitActionMessage, so no later snapshot re-asserts the
   * stale approval.
   */
  async clearPlanApproval(toolCallId?: string): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.clearPlanApproval',
      payload: { toolCallId },
    })
    await this.requestState()
    return this.getState()
  }

  async refreshModelCatalog(): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    // Register the state waiter BEFORE posting the refresh message. The
    // worker's `worker.refreshModelCatalog` handler is async (it awaits the
    // host-bridge catalog fetch) and emits `worker.state` only after the
    // fetch + reconcile completes. By registering first, we guarantee the
    // waiter catches THAT post-refresh state push — not a stale snapshot
    // from a racing `worker.getState`. Bounded: if the worker's refresh
    // hangs (e.g. model discovery timeout on an unreachable provider), fall
    // back to the current state after 10s rather than wedging the caller.
    let resolveState!: (snapshot: AgentRuntimeWorkerSnapshot) => void
    const statePromise = new Promise<AgentRuntimeWorkerSnapshot>(resolve => {
      resolveState = resolve
      this.stateWaiters.push(resolve)
    })
    await this.transport?.postMessage({
      type: 'worker.refreshModelCatalog',
    })
    // On the timeout path the waiter is REMOVED from `stateWaiters` (it would
    // otherwise sit there as a dead resolver until some unrelated state push
    // flushed it); on the state path the timer is cleared so it doesn't hold
    // the (test) event loop for the residual 10s.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        statePromise,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 10_000)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      const idx = this.stateWaiters.indexOf(resolveState)
      if (idx !== -1) this.stateWaiters.splice(idx, 1)
    }
    return this.getState()
  }

  /**
   * Forward a unified agent-config dict to this session's worker. The worker
   * hands it to `engine.applyRuntimeSettings`, which applies the keys it
   * recognizes (maxTurns, …). Generic — adding a setting
   * never changes this method.
   */
  async applyRuntimeSettings(
    config: Record<string, unknown>,
  ): Promise<BrowserRuntimeClientState> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.applyRuntimeSettings',
      payload: {
        config,
      },
    })
    await this.requestState()
    return this.getState()
  }

  /**
   * Persist a partial metadata patch (composer draft, last composer
   * edit time, etc.) to fs via the worker's conversation store. The
   * worker will broadcast `worker.metadataUpdated` so the SharedWorker
   * manager can rebroadcast `session.updated` to other listeners.
   * Fire-and-forget — the UI's local cache has already been updated
   * optimistically by the caller.
   */
  async updateSessionMetadata(
    metadata: Partial<BrowserSessionMetadata>,
  ): Promise<void> {
    await this.startOnce()
    await this.transport?.postMessage({
      type: 'worker.updateSessionMetadata',
      payload: { metadata },
    })
  }

  async restart(): Promise<BrowserRuntimeClientState> {
    return this.restartWithInitPayload({})
  }

  async restartWithInitPayload(
    updates: Partial<AgentRuntimeWorkerInitPayload>,
  ): Promise<BrowserRuntimeClientState> {
    const sessionId = this.state.snapshot?.sessionId ?? this.initPayload.sessionId
    await this.dispose()
    this.initPayload = {
      ...this.initPayload,
      ...updates,
      sessionId,
    }
    return this.start()
  }

  /**
   * Re-bind this session's project folder IN PLACE: re-post `worker.init` with `forceReinit`
   * on the LIVE transport so the SAME worker re-inits. Resolves on the next `worker.ready`;
   * falls back to `start()` if never started.
   */
  async reinitWithProjectRoot(
    projectRoot: string,
  ): Promise<BrowserRuntimeClientState> {
    const sessionId =
      this.state.snapshot?.sessionId ?? this.initPayload.sessionId
    this.initPayload = { ...this.initPayload, projectRoot, sessionId }
    if (!this.transport) {
      return this.start()
    }
    // Reset to the loading state so `waitForReady` actually waits for the NEW
    // worker.ready (it short-circuits while `state.snapshot` is still set).
    this.state = {
      ...this.state,
      status: 'initializing',
      snapshot: null,
      lastError: null,
    }
    this.emitState()
    await this.transport.postMessage({
      type: 'worker.init',
      payload: { ...this.initPayload, forceReinit: true },
    })
    await this.waitForReady()
    void this.requestMessages()
    return this.getState()
  }

  async requestState(): Promise<AgentRuntimeWorkerSnapshot> {
    await this.startOnce()
    const promise = new Promise<AgentRuntimeWorkerSnapshot>(resolve => {
      this.stateWaiters.push(resolve)
    })
    await this.transport?.postMessage({
      type: 'worker.getState',
    })
    return promise
  }

  async requestMessages(): Promise<Message[]> {
    await this.startOnce()
    const promise = new Promise<Message[]>(resolve => {
      this.messagesWaiters.push(resolve)
    })
    if (this.lastKnownOrdinal > 0) {
      await this.transport?.postMessage({
        type: 'worker.getMessagesSince',
        payload: { sinceOrdinal: this.lastKnownOrdinal },
      })
    } else {
      await this.transport?.postMessage({
        type: 'worker.getMessages',
      })
    }
    return promise
  }

  /**
   * Load a shutdown session's transcript from disk WITHOUT registering a
   * worker/runtime (no `worker.init`). Resolves with the loaded messages, or
   * rejects with a real error — a failed read, a missing manager channel, or a
   * timeout are NOT an empty transcript: the tab must be able to tell "no
   * content" apart from "couldn't read the content".
   */
  async startReadOnly(): Promise<BrowserRuntimeClientState> {
    if (this.transport) return this.getState()
    const transport = this.createWorkerTransport()
    this.transport = transport
    const requestId = randomUuid()
    let cancelled = false
    let transcriptMessages: Message[]
    try {
      transcriptMessages = await new Promise<Message[]>((resolve, reject) => {
        if (!transport.addManagerListener || !transport.postManagerMessage) {
          reject(new Error('read-only transcript: no manager channel'))
          return
        }
        let unsubscribe: (() => void) | undefined
        // 15s: generous enough for a cold storage read on a big profile, short
        // enough that a wedged SharedWorker doesn't leave the tab blank forever.
        const timeoutId = setTimeout(() => {
          unsubscribe?.()
          reject(new Error('read-only transcript: request timed out'))
        }, 15_000)
        // A dispose mid-read cancels it: no timer outlives the client.
        this.cancelReadOnlyLoad = () => {
          cancelled = true
          clearTimeout(timeoutId)
          unsubscribe?.()
          reject(new Error('read-only transcript: disposed'))
        }
        unsubscribe = transport.addManagerListener(data => {
          const message = data as {
            type?: string
            payload?: {
              sessionId?: string
              requestId?: string
              messages?: Message[]
              error?: string
            }
          }
          if (
            message.type !== 'session.transcript' ||
            message.payload?.requestId !== requestId
          ) return
          clearTimeout(timeoutId)
          unsubscribe?.()
          if (message.payload.error !== undefined) {
            reject(new Error(message.payload.error))
          } else {
            resolve(message.payload.messages ?? [])
          }
        })
        transport.postManagerMessage({
          type: 'session.transcript',
          sessionId: this.initPayload.sessionId,
          requestId,
        })
      })
    } catch (err) {
      this.cancelReadOnlyLoad = null
      // Disposed (or restarted) while the read was in flight: this outcome
      // belongs to a client that no longer exists.
      if (cancelled || this.transport !== transport) return this.getState()
      // Release the transport, so a later start (`startOnce`, a re-mount)
      // re-issues the read instead of returning this failure for good.
      this.transport = null
      await transport.dispose?.()
      const reason = err instanceof Error ? err.message : String(err)
      this.state = {
        ...this.state,
        status: 'error',
        snapshot: null,
        transcriptMessages: [],
        liveEvents: [],
        lastError: { code: 'transcript_read_failed', message: reason },
        // Settled — badly, but settled. Without this the loading overlay stays
        // up and COVERS the error banner it is meant to have made way for, so
        // the failure the read-only tab exists to report renders as a spinner.
        transcriptOnly: true,
      }
      this.emitState()
      return this.getState()
    }
    this.cancelReadOnlyLoad = null
    if (this.transport !== transport) return this.getState()
    this.state = {
      ...this.state,
      status: 'ready',
      snapshot: null,
      transcriptMessages,
      liveEvents: [],
      lastError: null,
      transcriptOnly: true,
    }
    this.emitState()
    return this.getState()
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1
    this.cancelReadOnlyLoad?.()
    this.cancelReadOnlyLoad = null
    this.unsubscribeTransport?.()
    this.unsubscribeTransport = null
    await this.transport?.dispose?.()
    this.transport = null
    this.lastKnownOrdinal = 0
    this.catchUpPullPending = false
    this.detailRequests?.releaseWaiters()
    this.state = {
      ...this.state,
      status: 'idle',
      snapshot: null,
      liveEvents: [],
      liveEventsTurnStart: 0,
      preSplitPrompt: null,
      preSplitPromptId: null,
      pendingPrompt: null,
      pendingPromptId: null,
      // A disposed client is not a settled read-only view: `startOnce`
      // re-runs `start()` on the next call, and leaving the flag set would tell
      // both gates the (re)load had already finished.
      transcriptOnly: false,
    }
    this.emitState()
  }

  private async startOnce(): Promise<void> {
    if (!this.transport) {
      await this.start()
    }
  }

  // Files and the attachment picker: RuntimeClientFileRequests.
  readFileText(path: string): Promise<string> {
    return this.fileRequests.readFileText(path)
  }

  openFileInWindow(path: string): Promise<void> {
    return this.fileRequests.openFileInWindow(path)
  }

  listDir(path: string): Promise<FsxListDirResult> {
    return this.fileRequests.listDir(path)
  }

  listTree(path: string, depth?: number): Promise<FsxListTreeResult> {
    return this.fileRequests.listTree(path, depth)
  }

  startFileSearch(
    request: FileSearchRequest,
    onState: (state: FsxSearchState) => void,
  ): Promise<() => void> {
    return this.fileRequests.startFileSearch(request, onState)
  }

  statFilePaths(
    paths: string[],
  ): Promise<Array<{ path: string; isFile: boolean }>> {
    return this.fileRequests.statFilePaths(paths)
  }

  writeFileText(path: string, text: string): Promise<void> {
    return this.fileRequests.writeFileText(path, text)
  }

  pickComposerAttachmentFiles(
    options?: { allowImages?: boolean; extensions?: readonly string[] },
  ): Promise<File[]> {
    return this.fileRequests.pickComposerAttachmentFiles(options)
  }

  /** This page asked for the interrupt now in flight: only it restores the
   *  inject texts Stop drops. Cleared once the session settles. */
  private interruptRequested = false

  private async handleWorkerMessage(
    message: BrowserWorkerClientInboundMessage,
  ): Promise<void> {
    switch (message.type) {
      case 'worker.pendingMessageUpdated':
      case 'worker.injectMessagesUpdated':
      case 'worker.injectMessagesLanded':
      case 'worker.injectMessageRemoved':
      case 'worker.injectMessagesCleared':
      case 'worker.pendingMessageCleared':
        this.parkedInput.handleMessage(message)
        return

      case 'worker.uiReady': {
        // UI-ready split: provisional boot snapshot — the persisted
        // transcript is read (the worker pushes it as `worker.messages`
        // right behind this event; do NOT requestMessages here, the pull
        // route parks on init), but MCP connect + engine build are still
        // running. Render now; `worker.ready` follows as the commit barrier.
        // A real (initialized) snapshot always wins — ignore a stale replay.
        if (this.state.snapshot?.initialized) return
        this.state = {
          ...this.state,
          status: message.payload.isBusy ? 'submitting' : 'ready',
          snapshot: message.payload,
        }
        // start()/reinit callers unblock here — the session is renderable
        // and a submit is safe (it parks worker-side until the engine
        // lands). The boot startSpan stays open: it measures to the REAL
        // worker.ready.
        this.resolveReadyWaiters(message.payload)
        this.emitState()
        return
      }

      case 'worker.ready': {
        // Boot narration — opt-in via the debug URL flags, like the
        // `[NexusTrace][GuestBoot]` lines in nexusBoot.
        if (isTraceLogUrlFlagEnabled()) {
          console.info('[HostedToolsWorker] ready', {
            toolCount: message.payload.toolNames.length,
            toolNames: message.payload.toolNames,
          })
        }
        const tracer = installSessionTracer({ context: 'ui' })
        if (this.startSpan) {
          tracer.event('ui.worker.ready.recv', {
            traceId: this.startSpan.traceId,
            parentSpanId: this.startSpan.spanId,
            attrs: {
              sessionId: this.initPayload.sessionId,
              messageCount: message.payload.messageCount,
            },
          })
          this.startSpan.end({
            messageCount: message.payload.messageCount,
          })
          this.startSpan = null
        } else {
          tracer.event('ui.worker.ready.recv', {
            attrs: {
              sessionId: this.initPayload.sessionId,
              messageCount: message.payload.messageCount,
            },
          })
        }
        // The session-switch flow is over — clear the tracer's
        // currentTraceContext so subsequent React commits + state
        // updates (typing in the composer, idle re-renders) don't
        // pile into this trace and inflate it indefinitely.
        tracer.setCurrentTraceContext(undefined)
        // Derive status from the snapshot's isBusy, exactly like the
        // `worker.state` handler. A re-attach to a session whose worker is
        // STILL running (the SharedWorker reuse branch replies `worker.ready`
        // with a live snapshot where isBusy===true) must surface as
        // 'submitting' — hardcoding 'ready' here made the composer editable
        // for an in-flight turn after an LRU eviction + switch-back.
        this.state = {
          ...this.state,
          status: message.payload.isBusy ? 'submitting' : 'ready',
          snapshot: message.payload,
        }
        this.resolveReadyWaiters(message.payload)
        this.emitState()
        if (this.catchUpPullPending) {
          this.catchUpPullPending = false
          void this.requestMessages()
        }
        return
      }

      case 'worker.stream':
        this.state = {
          ...this.state,
          status: 'submitting',
          liveEvents: [...this.state.liveEvents, message.payload.event],
        }
        this.emitState()
        return

      case 'worker.streamGap': {
        // A stream with a hole cannot be rebuilt (a missing
        // `content_block_start` misplaces every later delta), so the current
        // turn's partial events go. Events before `liveEventsTurnStart` belong
        // to finished turns and stay until their reconcile lands; the bubble
        // stays too. The in-flight message reappears when it persists.
        const turnStart = this.state.liveEventsTurnStart ?? 0
        if (this.state.liveEvents.length <= turnStart) return
        this.state = {
          ...this.state,
          liveEvents: this.state.liveEvents.slice(0, turnStart),
        }
        this.emitState()
        return
      }

      case 'worker.completed':
        // Keep pendingPrompt / pendingPromptId populated until the next
        // worker.messages fills in the persisted transcript. Clearing them
        // here would briefly strip the turn anchor used by the adapter to
        // mint stable assistant-message ids, which would remount the live
        // assistant component mid-transition (visible as a conversation-wide
        // flash once a TodoWrite plan finishes).
        this.state = {
          ...this.state,
          status: 'ready',
          snapshot: {
            ...message.payload,
            isBusy: false,
          },
        }
        this.emitState()
        void this.requestMessages()
        return

      case 'worker.state':
        if (!message.payload.isBusy && !message.payload.isStopping) {
          this.interruptRequested = false
        }
        this.state = {
          ...this.state,
          snapshot: message.payload,
          status: message.payload.isBusy ? 'submitting' : 'ready',
          ...this.parkedInput.restoreParkedInputFromSnapshot(message.payload),
        }
        this.resolveStateWaiters(message.payload)
        this.emitState()
        return

      case 'worker.messages': {
        const sinceOrdinal = message.payload.sinceOrdinal
        const isDelta =
          sinceOrdinal !== undefined && sinceOrdinal > 0
        let mergedMessages: Message[]
        if (isDelta) {
          const existing = this.state.transcriptMessages
          mergedMessages =
            sinceOrdinal >= existing.length
              ? [...existing, ...message.payload.messages]
              : [
                  ...existing.slice(0, sinceOrdinal),
                  ...message.payload.messages,
                ]
        } else {
          mergedMessages = message.payload.messages
        }
        // Diagnostic: emit tracer event so transcriptMessages
        // arrival shows up alongside other boot.* events in the
        // single boot diagnostic trace the user copies from the
        // overlay.
        installSessionTracer({ context: 'ui' }).event(
          'boot.workerMessages.received',
          {
            traceId: getBootDiagnosticTraceId(),
            attrs: {
              sessionId: this.initPayload.sessionId,
              sinceOrdinal: sinceOrdinal ?? null,
              incoming: message.payload.messages.length,
              merged: mergedMessages.length,
            },
          },
        )
        // Boot instrumentation. First-ever workerMessages arrival is one
        // of the key sub-phase boundaries inside ms_react_mount_to_ready
        // — captured here so the boot.guestReady.signaled event can
        // attribute time across snapshot-arrived → messages-arrived →
        // transcript-merged → assistant-ui-rendered.
        const bootMarks = (globalThis as {
          __nexusBootMarks?: Record<string, number>
        }).__nexusBootMarks ?? {}
        if (bootMarks.firstWorkerMessagesReceivedMs == null) {
          bootMarks.firstWorkerMessagesReceivedMs = Date.now()
          ;(globalThis as {
            __nexusBootMarks?: Record<string, number>
          }).__nexusBootMarks = bootMarks
        }
        this.lastKnownOrdinal = mergedMessages.length
        if (this.catchUpPullPending && !isDelta) {
          this.catchUpPullPending = false
          void this.requestMessages()
        }
        // Preserve the in-flight turn's pending prompt + live stream while a
        // turn is still live (`submitting`) OR has just failed (`error`): in
        // both cases the reconcile fetch must not blank the partial content
        // the user is looking at. Any other state (idle/ready) clears them.
        const turnLive =
          this.state.status === 'submitting' || this.state.status === 'error'
        // Drop the bubble once the transcript carries the persisted message, whatever the status:
        // `pendingPrompt !== null` also feeds the composer's busy gate.
        const bubblePersisted =
          this.state.pendingPromptId !== null &&
          mergedMessages.some(
            m => (m as { uuid?: string }).uuid === this.state.pendingPromptId,
          )
        const keepBubble = turnLive && !bubblePersisted
        // Pre-split live events (a finished turn kept on screen only until
        // its reconcile landed — see `liveEventsTurnStart`) are persisted by
        // construction (the engine persists each message BEFORE yielding it),
        // so this fetch carries them; drop them or they'd render a second
        // time after the transcript copy.
        const liveTurnStart = this.state.liveEventsTurnStart ?? 0
        const keptLiveEvents = !turnLive
          ? []
          : liveTurnStart > 0
            ? this.state.liveEvents.slice(liveTurnStart)
            : this.state.liveEvents
        this.state = {
          ...this.state,
          transcriptMessages: mergedMessages,
          liveEvents: keptLiveEvents,
          liveEventsTurnStart: 0,
          // The pre-split bubble's persisted copy has been in the engine's
          // list since its turn STARTED — long before the consume that armed
          // this slot — so this fetch (or an earlier one already merged)
          // carries it. Drop the optimistic copy alongside the pre-split
          // events it belongs with.
          preSplitPrompt: null,
          preSplitPromptId: null,
          pendingPrompt: keepBubble ? this.state.pendingPrompt : null,
          pendingPromptId: keepBubble ? this.state.pendingPromptId : null,
          injectBubbles: this.parkedInput.pruneInjectBubbles(
            this.state.injectBubbles ?? [],
            mergedMessages,
          ),
        }
        this.resolveMessagesWaiters(mergedMessages)
        this.emitState()
        return
      }

      case 'worker.toolCallDetail':
        this.detailRequests?.resolveToolCallDetailWaiters(
          message.payload.toolCallId,
          message.payload.detail,
        )
        return

      case 'worker.turnDiffHistory':
        // History changed → any cached per-turn detail may be stale (the
        // current turn can grow); drop it so the next expand re-fetches.
        this.detailRequests?.clearTurnDiffDetailCache()
        this.state = {
          ...this.state,
          turnDiffHistory: message.payload.turns,
        }
        this.emitState()
        return

      case 'worker.agentChanges':
        this.state = { ...this.state, agentChanges: message.payload.agents }
        this.emitState()
        return

      case 'worker.sessionChangeFigures':
        this.state = {
          ...this.state,
          sessionChangeFigures: message.payload.figures,
        }
        this.emitState()
        return

      case 'worker.turnDiffDetail':
        this.detailRequests?.resolveTurnDiffDetailWaiters(
          message.payload.turnIndex,
          message.payload.files,
        )
        return

      case 'worker.skillBody':
        this.detailRequests?.resolveSkillBodyWaiters(
          message.payload.name,
          message.payload.result,
        )
        return

      case 'worker.debugLog':
        routeWorkerDebugLog(message.payload)
        return

      case 'worker.error':
        // The manager refused worker.init because this session's persisted
        // marker says shutdown — the boot-active shutdown tab. Degrade to the
        // read-only transcript load instead of an error banner. Same for a
        // connection whose grant cannot open a session (an `observe` client):
        // it can read the transcript, and waiting for a snapshot would pin the
        // boot splash forever.
        if (
          message.payload?.code === 'session_shutdown' ||
          message.payload?.code === SESSION_OPEN_FORBIDDEN
        ) {
          this.shutdownInitRefused = true
          const waiters = [...this.shutdownWaiters]
          this.shutdownWaiters = []
          for (const w of waiters) w()
          return
        }
        this.state = {
          ...this.state,
          status: 'error',
          lastError: message.payload,
          // Preserve pendingPrompt + liveEvents: the failed turn's partial
          // content (user message, streamed assistant text, tool calls) must
          // stay visible alongside the error banner. Clearing them here made
          // the entire current turn vanish from the thread (the user saw only
          // the previous conversation). The pendingPrompt dedup guard in
          // combineThreadMessages prevents a double-render if the engine also
          // persisted the prompt before failing.
        }
        this.emitState()
        // Reconcile the transcript after a failed turn too: the engine may already hold the user
        // message, and an empty thread with messageCount > 0 would wedge the loading skeleton.
        void this.requestMessages()
        return
    }
  }

  private resolveReadyWaiters(snapshot: AgentRuntimeWorkerSnapshot): void {
    const waiters = [...this.readyWaiters]
    this.readyWaiters = []
    for (const waiter of waiters) {
      waiter(snapshot)
    }
  }

  private resolveStateWaiters(snapshot: AgentRuntimeWorkerSnapshot): void {
    const waiters = [...this.stateWaiters]
    this.stateWaiters = []
    for (const waiter of waiters) {
      waiter(snapshot)
    }
  }

  private resolveMessagesWaiters(messages: Message[]): void {
    const waiters = [...this.messagesWaiters]
    this.messagesWaiters = []
    for (const waiter of waiters) {
      waiter(messages)
    }
  }

  private waitForReady(): Promise<AgentRuntimeWorkerSnapshot> {
    if (this.state.snapshot) {
      return Promise.resolve(this.state.snapshot)
    }

    return new Promise(resolve => {
      this.readyWaiters.push(resolve)
    })
  }

  private emitState(): void {
    if (this.parkedInput.injectDrafts.size > 0) this.parkedInput.pruneInjectDrafts()
    this.cachedExternalState = null
    const snapshot = this.getState()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}

function serializeToolResultContent(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }

  if (result === undefined || result === null) {
    return ''
  }

  return JSON.stringify(result)
}
