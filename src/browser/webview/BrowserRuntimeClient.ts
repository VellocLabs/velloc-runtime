import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
  BrowserLlmSelection,
} from '../bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../bridge/browserBridgeProtocol'
import type { RuleEdit } from '../../permissions/ruleUpdates'
import type {
  AgentRuntimeWorkerInitPayload,
  AgentRuntimeWorkerSnapshot,
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
  InjectMessageView,
} from '../worker/workerProtocol'
import { isSlashCommandPrompt } from '../../utils/slashCommandPrompt'
import { randomUuid } from '../../utils/randomUuid'

/** How a submit made while the session is busy is delivered: `inject` (plain
 *  Enter — into the running turn) or `next` (Ctrl/Cmd+Enter — the
 *  next-message strip). See `worker.submitMessage` `delivery`. */
export type SubmitDelivery = 'inject' | 'next'
import type { Message, StreamRecord } from '../../runtime/RuntimeTypes'
import type { ContentBlockParam } from '../../runtime/RuntimeTypes'
import type { AppendMessage, CompleteAttachment } from '@assistant-ui/react'
import type { RuntimeFileAccess } from '../runtimeClient/fileAccess'
import { SESSION_OPEN_FORBIDDEN } from '../runtimeClient/workerTransportOverConnection'
import {
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS,
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES,
  pathBytesToAttachmentFile,
} from './BrowserComposerAttachmentAdapter'
import {
  buildPromptFromAppendMessage,
  extractTextFromAppendMessage,
} from './assistantUiAdapter'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { BundledSkillBodyResult } from '../../skillLibrary/builtinSkillBody'
import type { TurnDiffMeta, TurnFileChange } from '../../utils/turnDiffs'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import {
  getBootDiagnosticTraceId,
  installSessionTracer,
  type Span as TraceSpan,
} from '../../utils/sessionTrace'
import { isTraceLogUrlFlagEnabled } from '../../utils/traceLogGate'

/**
 * The stream topic missed events (`createWorkerTransportOverConnection`
 * recovering a gap). Made by the transport, never sent by a worker and never
 * on the wire: the current turn's live events have a hole and are dropped; the
 * transcript refetch that accompanies it brings back what the turn persisted.
 */
export type WorkerStreamGapMessage = { type: 'worker.streamGap' }

/** Union delivered to client message listeners. */
export type BrowserWorkerClientInboundMessage = AgentWorkerOutboundMessage | WorkerStreamGapMessage

// Optional handler installed by `nexusBoot` when the model-upload
// trace gate is on. Kept as a runtime reference (no static import of
// `modelUploadBus`) so production bundles with the switch off omit
// the bus module entirely — `setModelUploadHandler` is the sole
// load-bearing surface, and `nexusBoot` only calls it from inside a
// dynamic `import('../../utils/modelUploadBus')` behind the same gate.
type ModelUploadHandler = (entry: unknown) => void
let modelUploadHandler: ModelUploadHandler | null = null

export function setModelUploadHandler(
  handler: ModelUploadHandler | null,
): void {
  modelUploadHandler = handler
}

export interface BrowserWorkerClientTransport {
  postMessage(message: AgentWorkerInboundMessage): void | Promise<void>
  addMessageListener(
    listener: (message: BrowserWorkerClientInboundMessage) => void,
  ): () => void
  /**
   * Send a raw envelope directly to the SharedWorker manager — used for
   * manager-level protocol like `toolDetail.subscribe` that isn't scoped
   * to a single session's worker. Optional; transports that don't front a
   * SharedWorker can omit it (the client degrades gracefully).
   */
  postManagerMessage?(data: unknown): void
  /**
   * Subscribe to manager-level broadcasts (`toolDetail.ready`, etc.).
   * The listener receives the raw message data as sent by the manager.
   * Returns an unsubscribe function.
   */
  addManagerListener?(listener: (data: unknown) => void): () => void
  dispose?(): void | Promise<void>
}

// Re-exported from its own module so the early index.html warm-up script and
// this boot path share ONE worker asset (same URL + name) and thus one shared
// instance. See createBrowserRuntimeSharedWorker.ts.
export { createBrowserRuntimeSharedWorker } from './createBrowserRuntimeSharedWorker'

type SharedWorkerDispatchEntry = {
  listeners: Set<(message: BrowserWorkerClientInboundMessage) => void>
  /**
   * Number of live transports sharing this entry: two can front one session (strict-mode
   * double mount, async dispose), and a stale dispose must not delete the shared entry.
   */
  refs: number
}

class SharedWorkerPortDispatcher {
  private readonly port: MessagePort
  private readonly sessions = new Map<string, SharedWorkerDispatchEntry>()
  private readonly globalListeners = new Set<(event: MessageEvent) => void>()
  private started = false

  constructor(sharedWorker: SharedWorker) {
    this.port = sharedWorker.port
    this.port.addEventListener('message', this.receiveFrame)
  }

  register(
    sessionId: string,
  ): SharedWorkerDispatchEntry {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { listeners: new Set(), refs: 0 }
      this.sessions.set(sessionId, entry)
    }
    entry.refs++
    this.startOnce()
    return entry
  }

  /**
   * Release one transport's hold on the session entry. The entry (and the
   * session's message routing) survives until the LAST holder unregisters.
   * Returns true when this call removed the entry — the caller uses that to
   * decide whether to tell the manager to detach the session from this port.
   */
  unregister(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId)
    if (!entry) return true
    entry.refs--
    if (entry.refs <= 0) {
      this.sessions.delete(sessionId)
      return true
    }
    return false
  }

  addGlobalListener(listener: (event: MessageEvent) => void): () => void {
    this.globalListeners.add(listener)
    this.startOnce()
    return () => {
      this.globalListeners.delete(listener)
    }
  }

  postMessage(data: unknown, transfer?: Transferable[]): void {
    this.startOnce()
    if (transfer) {
      this.port.postMessage(data, transfer)
    } else {
      this.port.postMessage(data)
    }
  }

  private startOnce(): void {
    if (!this.started) {
      this.port.start()
      this.started = true
    }
  }

  private receiveFrame = (event: MessageEvent): void => {
    const data = event.data as Record<string, unknown>
    if (!data || typeof data.type !== 'string') return

    for (const listener of this.globalListeners) {
      listener(event)
    }

    const sessionId = data.sessionId as string
    if (!sessionId) return

    const entry = this.sessions.get(sessionId)
    if (!entry) return

    const { sessionId: _sid, ...stripped } = data
    const message = stripped as unknown as BrowserWorkerClientInboundMessage
    for (const listener of entry.listeners) {
      listener(message)
    }
  }
}

const dispatcherCache = new WeakMap<SharedWorker, SharedWorkerPortDispatcher>()

function getOrCreateDispatcher(
  sharedWorker: SharedWorker,
): SharedWorkerPortDispatcher {
  let dispatcher = dispatcherCache.get(sharedWorker)
  if (!dispatcher) {
    dispatcher = new SharedWorkerPortDispatcher(sharedWorker)
    dispatcherCache.set(sharedWorker, dispatcher)
  }
  return dispatcher
}

export function createSharedWorkerTransport(
  sharedWorker: SharedWorker,
  openingSessionId?: string,
): BrowserWorkerClientTransport {
  let sessionId = openingSessionId ?? ''
  const dispatcher = getOrCreateDispatcher(sharedWorker)
  let entry: SharedWorkerDispatchEntry | null = null
  const pendingListeners = new Set<
    (message: BrowserWorkerClientInboundMessage) => void
  >()

  function flushPendingListeners(): void {
    if (!entry || pendingListeners.size === 0) return
    for (const listener of pendingListeners) {
      entry.listeners.add(listener)
    }
    pendingListeners.clear()
  }

  return {
    postMessage(message: AgentWorkerInboundMessage): void {
      if (message.type === 'worker.init') {
        if (!sessionId) {
          sessionId =
            message.payload.sessionId || randomUuid()
        }
        // Hold at most ONE ref per transport: a re-init on the live
        // transport (forceReinit) or an addMessageListener that already
        // registered must not double-count — dispose releases exactly one.
        if (!entry) {
          entry = dispatcher.register(sessionId)
        }
        flushPendingListeners()
        dispatcher.postMessage({
          ...message,
          sessionId,
          payload: { ...message.payload, sessionId },
        })
        return
      }

      dispatcher.postMessage({ ...message, sessionId })
    },

    addMessageListener(
      listener: (message: BrowserWorkerClientInboundMessage) => void,
    ): () => void {
      if (!entry && sessionId) {
        entry = dispatcher.register(sessionId)
      }
      if (entry) {
        entry.listeners.add(listener)
      } else {
        pendingListeners.add(listener)
      }
      return () => {
        entry?.listeners.delete(listener)
        pendingListeners.delete(listener)
      }
    },

    postManagerMessage(data: unknown): void {
      dispatcher.postMessage(data)
    },

    addManagerListener(listener: (data: unknown) => void): () => void {
      return dispatcher.addGlobalListener(event => {
        listener((event as MessageEvent).data)
      })
    },

    dispose(): void {
      if (sessionId) {
        // Only the LAST local holder detaches the session from the shared
        // port — a strict-mode ghost's late dispose must not tear down the
        // routing (dispatcher entry + manager port attachment) that the
        // surviving client of the SAME session is using.
        const last = dispatcher.unregister(sessionId)
        if (last) {
          dispatcher.postMessage({ type: 'session.detach', sessionId })
        }
      }
      pendingListeners.clear()
      entry = null
    },
  }
}

export type BrowserRuntimeClientState = {
  status: 'idle' | 'initializing' | 'ready' | 'submitting' | 'error'
  snapshot: AgentRuntimeWorkerSnapshot | null
  transcriptMessages: Message[]
  liveEvents: StreamRecord[]
  lastError: { code: string; message: string } | null
  /**
   * A TRANSCRIPT-ONLY view (`startReadOnly`) whose load has settled, with the transcript or
   * `transcript_read_failed`. The loading gates read `snapshot != null`, and a read-only
   * client never gets a snapshot (a shutdown session must not claim a runtime), so this
   * flag marks it as loaded.
   */
  transcriptOnly?: boolean
  pendingPrompt: string | null
  pendingPromptId: string | null
  /**
   * Index into `liveEvents` where the CURRENT turn's events begin; earlier events render
   * BEFORE the optimistic pending-prompt bubble. Reset to 0 when `liveEvents` is cleared;
   * pre-split events are dropped on the next transcript reconcile. The live client always
   * sets it.
   */
  liveEventsTurnStart?: number
  /**
   * The PREVIOUS turn's optimistic user bubble, kept when a consumed next-message batch
   * re-arms `pendingPrompt`, so the consume is a pure APPEND ([U, A] → [U, A, U', A']).
   * Rendered before the pre-split live events, deduped by uuid, cleared by the next
   * transcript reconcile. Single slot. The live client always sets it.
   */
  preSplitPrompt?: string | null
  preSplitPromptId?: string | null
  /**
   * Turn-diff HISTORY metadata for the "Changes this turn" bar, newest first: stats and file
   * list, no hunks (`loadTurnDiffDetail`). `null` before the first `worker.turnDiffHistory`
   * push; `[]` = nothing to show. The live client always sets it.
   */
  turnDiffHistory?: TurnDiffMeta[] | null
  /**
   * The session's saved "next message" (a plain-text submit made while the
   * agent was busy, accumulated by the manager and broadcast in FULL). `null`
   * = none. Rendered verbatim by the NextMessage strip; consumed (auto-run) on
   * completion. Sourced from `worker.pendingMessageUpdated`/`…Cleared`.
   */
  pendingMessage?: string | null
  /**
   * The same saved "next message", but as ONE ENTRY PER PARKED SUBMIT.
   * `pendingMessage` is these joined with newlines and cannot be split back
   * apart — a single submit can be multi-line (Shift+Enter) — so the strip
   * counts and slices the queue from here. `null` = none, or an older worker
   * that doesn't send the list (the strip falls back to splitting the text).
   */
  pendingMessageEntries?: string[] | null
  /**
   * Set when the user clicked the Next-message strip's clear (×) and the
   * manager hasn't confirmed yet. While set, incoming `pendingMessageUpdated`
   * events are ignored so a stale in-flight append can't re-flash the strip the
   * user just dismissed. Cleared by `worker.pendingMessageCleared`. Per-session
   * (each sessionId has its own client), so sessions never interfere.
   */
  pendingClearInFlight?: boolean
  /**
   * Messages sent with plain Enter during a running turn, pinned at the bottom until they
   * land. `pending`: in the worker's inject queue. `landed`: `midturn` or `nextturn`
   * (persisted under `turnUuid`). Dropped once the transcript or live stream renders it.
   */
  injectBubbles?: InjectBubble[]
  /**
   * Inject texts Stop dropped, to hand back to THIS page's composer (set only
   * on the page that asked for the interrupt). Taken from the worker's
   * `injectMessagesCleared`, never from local bubbles: a message drained into
   * the model in the same instant must not also come back. `id` is unique per
   * restore so the composer applies it once. `files` are the attachments this
   * page sent with those messages (`InjectRestoreDraft`); absent when none.
   */
  injectRestore?: { id: string; text: string; files?: File[] } | null
}

/**
 * What THIS page sent with an inject message that carried attachments: the
 * composer text as typed and the attached files. The worker hands a removed /
 * Stop-dropped message back as its display text only — for an attachment-only
 * send, the file names — so without this the attachments were lost and their
 * names came back as typed text.
 */
type InjectRestoreDraft = { text: string; files: File[] }

/** The result of `removeInjectMessage`: `text` (and `files`, when this page
 *  sent attachments with it) go back to the composer on `ok`. */
export type InjectRemoveResult = { ok: boolean; text?: string; files?: File[] }

export type InjectBubble = {
  uuid: string
  text: string
  hasAttachments: boolean
  state: 'pending' | 'landed'
  landedVia?: 'midturn' | 'nextturn'
  /** `nextturn` only: the user message the merged turn persists under. */
  turnUuid?: string
  /** Shown before the worker confirmed it parked the submit. */
  optimistic?: boolean
  /** Hidden while this page's remove (×) request is in flight. */
  removing?: boolean
}

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
  /**
   * Outer bound for a tool-detail subscribe that never resolves — e.g. the
   * tool call was interrupted or the server restarted before persisting.
   * Short enough that a stuck click doesn't sit forever, long enough that
   * genuinely slow tools still land.
   */
  private static readonly TOOL_DETAIL_TIMEOUT_MS = 15_000
  private readonly createWorkerTransport: () => BrowserWorkerClientTransport
  private readonly hostBridgeTransport: BrowserBridgeTransport
  private readonly files: RuntimeFileAccess | null
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
    pendingMessage: null,
    pendingMessageEntries: null,
    pendingClearInFlight: false,
  }
  private lastKnownOrdinal = 0
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
  private readonly toolCallDetailWaiters = new Map<
    string,
    Array<(detail: BrowserToolCallDetailRecord | null) => void>
  >()
  private readonly turnDiffDetailWaiters = new Map<
    number,
    Array<(files: TurnFileChange[] | null) => void>
  >()
  /** Pending `worker.getSkillBody` requests, keyed by bundled-skill name. */
  private readonly skillBodyWaiters = new Map<
    string,
    Array<(result: BundledSkillBodyResult | null) => void>
  >()
  /** Per-turn hunks, cached after first fetch; cleared on each history push. */
  private readonly turnDiffDetailCache = new Map<
    number,
    TurnFileChange[] | null
  >()

  constructor(options: BrowserRuntimeClientOptions) {
    this.createWorkerTransport = options.createWorkerTransport
    this.hostBridgeTransport = options.hostBridgeTransport
    this.files = options.files ?? null
    this.initPayload = options.initPayload
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
    void this.requestMessages()

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
      attachment => this.uploadComposerAttachment(attachment),
    )
    // Kept in case this lands as an inject message that is later removed or
    // dropped by Stop: the composer gets the files back, not their names.
    const files = (message.attachments ?? []).flatMap(attachment =>
      attachment.file instanceof File ? [attachment.file] : [],
    )
    const restoreDraft: InjectRestoreDraft | undefined =
      files.length > 0
        ? { text: extractTextFromAppendMessage(message), files }
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

  /**
   * Remove one parked inject message (its × in the conversation). Hidden at
   * once; resolves with the worker's verdict. `ok:true` carries the text the
   * caller hands back to the composer; `ok:false` means it already landed or
   * another window removed it first — the caller must NOT restore it.
   */
  removeInjectMessage(uuid: string): Promise<InjectRemoveResult> {
    const requestId = randomUuid()
    this.setInjectBubbles(
      (this.state.injectBubbles ?? []).map(bubble =>
        bubble.uuid === uuid ? { ...bubble, removing: true } : bubble,
      ),
    )
    const result = new Promise<InjectRemoveResult>(resolve => {
      this.injectRemoveWaiters.set(requestId, resolve)
    })
    void this.transport?.postMessage({
      type: 'worker.removeInjectMessage',
      payload: { uuid, requestId },
    })
    return result
  }

  private setInjectBubbles(next: InjectBubble[]): void {
    this.state = { ...this.state, injectBubbles: next }
    this.emitState()
  }

  /** Replace the pending half of the bubble list with the worker's list;
   *  landed bubbles and not-yet-confirmed optimistic ones are kept. */
  private reconcileInjectEntries(entries: readonly InjectMessageView[]): InjectBubble[] {
    const byUuid = new Map(entries.map(entry => [entry.uuid, entry]))
    const current = this.state.injectBubbles ?? []
    const next: InjectBubble[] = []
    const seen = new Set<string>()
    for (const bubble of current) {
      const entry = byUuid.get(bubble.uuid)
      if (entry) {
        next.push({
          ...bubble,
          text: entry.text,
          hasAttachments: entry.hasAttachments,
          state: 'pending',
          optimistic: false,
        })
        seen.add(bubble.uuid)
        continue
      }
      if (bubble.state === 'landed' || bubble.optimistic) {
        next.push(bubble)
      }
    }
    for (const entry of entries) {
      if (seen.has(entry.uuid)) continue
      next.push({
        uuid: entry.uuid,
        text: entry.text,
        hasAttachments: entry.hasAttachments,
        state: 'pending',
      })
    }
    return next
  }

  /** Bubbles whose message the transcript now carries — as the persisted
   *  user message (its own uuid or the merged turn's) or as a mid-turn
   *  `queued_command` attachment — are no longer needed. */
  private pruneInjectBubbles(
    bubbles: readonly InjectBubble[],
    transcript: readonly Message[],
  ): InjectBubble[] {
    if (bubbles.length === 0) return bubbles as InjectBubble[]
    const ids = new Set<string>()
    for (const message of transcript) {
      const record = message as { uuid?: string; type?: string; attachment?: { source_uuid?: unknown } }
      if (typeof record.uuid === 'string') ids.add(record.uuid)
      const source = record.attachment?.source_uuid
      if (record.type === 'attachment' && typeof source === 'string') ids.add(source)
    }
    return bubbles.filter(
      bubble =>
        !ids.has(bubble.uuid) &&
        !(bubble.turnUuid !== undefined && ids.has(bubble.turnUuid)),
    )
  }

  /**
   * Optimistically clear the saved "next message": hide the strip now, ignore stale
   * `pendingMessageUpdated` events while the clear is in flight, then ask the manager to drop
   * the text. Composer-text restore is the strip's own (UI-local) job.
   */
  clearPendingMessage(): void {
    this.state = {
      ...this.state,
      pendingMessage: null,
      pendingMessageEntries: null,
      pendingClearInFlight: true,
    }
    this.emitState()
    void this.transport?.postMessage({ type: 'worker.clearPendingMessage' })
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

  async loadToolCallDetail(
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    await this.startOnce()

    const transport = this.transport
    if (!transport?.postManagerMessage || !transport.addManagerListener) {
      // Transport doesn't expose manager-level channels (e.g. test doubles)
      // — fall back to the legacy point-to-point request so callers keep
      // working. Still no retry loop; the worker returns whatever it has
      // after one round-trip.
      return this.legacyRequestToolCallDetail(toolCallId)
    }

    return new Promise<BrowserToolCallDetailRecord | null>(resolve => {
      let settled = false
      const settle = (detail: BrowserToolCallDetailRecord | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        unsubscribe()
        transport.postManagerMessage?.({
          type: 'toolDetail.unsubscribe',
          toolCallIds: [toolCallId],
        })
        resolve(detail)
      }

      const unsubscribe = transport.addManagerListener!(data => {
        const msg = data as { type?: string; payload?: unknown } | null
        if (msg?.type !== 'toolDetail.ready') return
        const payload = msg.payload as {
          toolCallId?: string
          detail?: BrowserToolCallDetailRecord | null
        }
        if (payload?.toolCallId !== toolCallId) return
        settle(payload.detail ?? null)
      })

      const timeoutId = setTimeout(() => {
        settle(null)
      }, BrowserRuntimeClient.TOOL_DETAIL_TIMEOUT_MS)

      transport.postManagerMessage!({
        type: 'toolDetail.subscribe',
        toolCallIds: [toolCallId],
        sessionId: this.initPayload.sessionId,
      })
    })
  }

  /**
   * Fetch one turn's hunks from the worker history cache, on expand. Cached
   * client-side after the first fetch (cleared whenever a new history pushes).
   * Point-to-point request/response (`worker.getTurnDiffDetail` →
   * `worker.turnDiffDetail`) — the worker serves it from memory.
   */
  async loadTurnDiffDetail(
    turnIndex: number,
  ): Promise<TurnFileChange[] | null> {
    await this.startOnce()
    const cached = this.turnDiffDetailCache.get(turnIndex)
    if (cached !== undefined) return cached

    const promise = new Promise<TurnFileChange[] | null>(resolve => {
      const waiters = this.turnDiffDetailWaiters.get(turnIndex) ?? []
      waiters.push(resolve)
      this.turnDiffDetailWaiters.set(turnIndex, waiters)
    })
    await this.transport?.postMessage({
      type: 'worker.getTurnDiffDetail',
      payload: { turnIndex },
    })
    return promise
  }

  private resolveTurnDiffDetailWaiters(
    turnIndex: number,
    files: TurnFileChange[] | null,
  ): void {
    this.turnDiffDetailCache.set(turnIndex, files)
    const waiters = this.turnDiffDetailWaiters.get(turnIndex) ?? []
    this.turnDiffDetailWaiters.delete(turnIndex)
    for (const waiter of waiters) {
      waiter(files)
    }
  }

  /**
   * Resolve a BUNDLED skill's body for the Skills tab (`bundled:<name>` has no file on disk):
   * `worker.getSkillBody` → `worker.skillBody`, uncached. Resolves `null` on dispose.
   */
  async loadBundledSkillBody(
    name: string,
  ): Promise<BundledSkillBodyResult | null> {
    await this.startOnce()
    const promise = new Promise<BundledSkillBodyResult | null>(resolve => {
      const waiters = this.skillBodyWaiters.get(name) ?? []
      waiters.push(resolve)
      this.skillBodyWaiters.set(name, waiters)
    })
    await this.transport?.postMessage({
      type: 'worker.getSkillBody',
      payload: { name },
    })
    return promise
  }

  private resolveSkillBodyWaiters(
    name: string,
    result: BundledSkillBodyResult | null,
  ): void {
    const waiters = this.skillBodyWaiters.get(name) ?? []
    this.skillBodyWaiters.delete(name)
    for (const waiter of waiters) {
      waiter(result)
    }
  }

  private async legacyRequestToolCallDetail(
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const promise = new Promise<BrowserToolCallDetailRecord | null>(resolve => {
      const waiters = this.toolCallDetailWaiters.get(toolCallId) ?? []
      waiters.push(resolve)
      this.toolCallDetailWaiters.set(toolCallId, waiters)
    })
    await this.transport?.postMessage({
      type: 'worker.getToolCallDetail',
      payload: { toolCallId },
    })
    return promise
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
      this.injectDrafts.set(options.promptUuid!, options.restoreDraft)
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
    this.cancelReadOnlyLoad?.()
    this.cancelReadOnlyLoad = null
    this.unsubscribeTransport?.()
    this.unsubscribeTransport = null
    await this.transport?.dispose?.()
    this.transport = null
    this.lastKnownOrdinal = 0
    for (const [toolCallId, waiters] of this.toolCallDetailWaiters) {
      this.toolCallDetailWaiters.delete(toolCallId)
      for (const waiter of waiters) {
        waiter(null)
      }
    }
    for (const [name, waiters] of this.skillBodyWaiters) {
      this.skillBodyWaiters.delete(name)
      for (const waiter of waiters) {
        waiter(null)
      }
    }
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

  private async requestHostBridge<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BrowserBridgeResult<C, A>> {
    const response = await this.hostBridgeTransport.request({
      id: randomUuid(),
      route,
      payload,
    }) as { ok: true; result: BrowserBridgeResult<C, A> } | {
      ok: false
      error: { code: string; message: string }
    }

    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }

    return response.result
  }

  /** The session this client's file requests are made for. */
  private fileSessionId(): string {
    const sessionId = this.state.snapshot?.sessionId ?? this.initPayload.sessionId
    if (!sessionId) throw new Error('fsx: this client has no session id yet')
    return sessionId
  }

  /** `fsx` over the runtime connection. Absent only in tests that never touch files — and then loudly. */
  private requireFiles(): RuntimeFileAccess {
    if (!this.files) throw new Error('fsx: this BrowserRuntimeClient was built without file access')
    return this.files
  }

  /**
   * Read a file's full contents as UTF-8 text, over `fsx.readText`. Backs the
   * right-panel Files view, which shows the complete, current file for a
   * path the user clicked in the transcript (the inline Read card only has the
   * slice that was read). Rejects on error (missing file, a path outside a
   * scoped connection's roots).
   */
  async readFileText(path: string): Promise<string> {
    await this.startOnce()
    return this.requireFiles().readText(this.fileSessionId(), path)
  }

  /**
   * Existence check for a batch of paths (one `fsx.statBatch`). Never rejects: anything that
   * cannot be stat'ed resolves `isFile: false`.
   */
  async statFilePaths(
    paths: string[],
  ): Promise<Array<{ path: string; isFile: boolean }>> {
    if (paths.length === 0) return []
    await this.startOnce()
    try {
      const results = await this.requireFiles().statBatch(this.fileSessionId(), paths)
      return results.map((entry) => ({ path: entry.path, isFile: entry.isFile }))
    } catch {
      return paths.map((path) => ({ path, isFile: false }))
    }
  }

  /**
   * Write UTF-8 text back to a file over `fsx.writeText` (`full` scope) —
   * backs the right-panel Files view's editable mode (explicit save).
   */
  async writeFileText(path: string, text: string): Promise<void> {
    await this.startOnce()
    await this.requireFiles().writeText(this.fileSessionId(), path, text)
  }

  /**
   * Open the host's native multi-file picker and return the chosen files as `File`s (read
   * via `fsx.readBlob`). `[]` on cancel; a file that fails to read is skipped. `allowImages`
   * is a UX hint only — `BrowserComposerAttachmentAdapter.add` is the hard gate; an explicit
   * `options.extensions` wins over it.
   */
  async pickComposerAttachmentFiles(
    options?: { allowImages?: boolean; extensions?: readonly string[] },
  ): Promise<File[]> {
    await this.startOnce()
    const extensions =
      options?.extensions !== undefined
        ? [...options.extensions]
        : options?.allowImages === false
          ? [...BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES]
          : [...BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS]
    const result = await this.requestHostBridge(
      createBridgeRoute('ui', 'pickAttachmentFiles'),
      { extensions },
    )
    if (result.canceled || result.paths.length === 0) {
      return []
    }
    const files: File[] = []
    const sessionId = this.fileSessionId()
    for (const path of result.paths) {
      try {
        const bytes = await this.requireFiles().readBytes(sessionId, path)
        files.push(pathBytesToAttachmentFile(path, bytes))
      } catch (error) {
        console.warn('Failed to read picked attachment file:', path, error)
      }
    }
    return files
  }

  /**
   * Store a composer attachment as a session upload (`sys.putBlob` +
   * `fsx.commitUpload`); the runtime picks the path under the session's
   * uploads directory and the prompt quotes it.
   */
  private async uploadComposerAttachment(
    attachment: CompleteAttachment,
  ): Promise<string | null> {
    const file = attachment.file
    if (!(file instanceof File)) {
      return null
    }
    await this.startOnce()
    const content = new Uint8Array(await file.arrayBuffer())
    return this.requireFiles().upload(
      this.fileSessionId(),
      attachment.name || file.name,
      content,
      file.type || undefined,
    )
  }

  /**
   * Re-arm the optimistic user bubble for a turn the worker built from parked
   * input (a consumed next message, or inject messages merged into the next
   * turn). Its user message is persisted but never streamed back, and the
   * transcript isn't refetched until the turn ends.
   */
  private rearmPendingPrompt(
    text: string,
    promptUuid: string | null,
  ): Partial<BrowserRuntimeClientState> {
    // Any re-arm (a consumed strip batch OR an inject next-turn landing) is
    // what a later landing from the same consume must not displace.
    this.injectRearmTurnUuid = promptUuid
    return {
      pendingPrompt: text,
      pendingPromptId: promptUuid,
      // The finished turn's own optimistic bubble may still be the
      // only render of ITS user message (same reconcile gap) —
      // promote it to the pre-split slot instead of overwriting it,
      // so the thread transition is a pure append. Dropping it here
      // blanked the previous user message until the reconcile AND
      // reshaped every message index, which could crash the thread
      // mid-render (see `preSplitPrompt` in the state type).
      preSplitPrompt: this.state.pendingPrompt,
      preSplitPromptId: this.state.pendingPromptId,
      // Everything in `liveEvents` right now belongs to the turn(s)
      // that just FINISHED (the consume fires at their boundary) —
      // their transcript reconcile may not have landed yet, so they
      // must keep rendering, but BEFORE the re-armed bubble. Record
      // the split; the combine layer renders pre-split events ahead
      // of the bubble so the picked-up message never jumps above
      // the tool block it followed.
      liveEventsTurnStart: this.state.liveEvents.length,
    }
  }

  /** True while the bubble armed by a re-arm (a consumed strip batch or an
   *  inject next-turn landing) still stands for a turn that has not streamed
   *  anything yet — a later landing from the same consume (a send that became
   *  its own later turn) must not displace it. */
  private injectRearmActive(): boolean {
    return (
      this.injectRearmTurnUuid !== null &&
      this.state.pendingPromptId === this.injectRearmTurnUuid &&
      this.state.liveEvents.length === (this.state.liveEventsTurnStart ?? 0)
    )
  }

  /**
   * Parked mid-turn input is runtime state carried by every snapshot: a page
   * that attached (or reloaded) after it was parked restores the pending
   * bubbles and the next-message strip from here instead of showing nothing
   * until the next change event.
   */
  private restoreParkedInputFromSnapshot(
    snapshot: AgentRuntimeWorkerSnapshot,
  ): Partial<BrowserRuntimeClientState> {
    const patch: Partial<BrowserRuntimeClientState> = {}
    if (snapshot.injectMessages) {
      const next = this.reconcileInjectEntries(snapshot.injectMessages)
      const current = this.state.injectBubbles ?? []
      const same =
        next.length === current.length &&
        next.every((bubble, i) => {
          const other = current[i]!
          return other.uuid === bubble.uuid && other.state === bubble.state &&
            other.text === bubble.text && other.optimistic === bubble.optimistic
        })
      if (!same) patch.injectBubbles = next
    }
    if (
      snapshot.nextMessages &&
      snapshot.nextMessages.length > 0 &&
      !this.state.pendingMessage &&
      !this.state.pendingClearInFlight
    ) {
      patch.pendingMessage = snapshot.nextMessages.join('\n')
      patch.pendingMessageEntries = [...snapshot.nextMessages]
    }
    return patch
  }

  /** Pending `removeInjectMessage` replies, keyed by requestId. */
  private readonly injectRemoveWaiters = new Map<
    string,
    (result: InjectRemoveResult) => void
  >()
  /** Attachment-carrying inject messages this page sent, by bubble uuid —
   *  kept while their bubble is shown (`pruneInjectDrafts`). */
  private readonly injectDrafts = new Map<string, InjectRestoreDraft>()
  /** The turn uuid the last re-arm (strip consume or inject landing) armed. */
  private injectRearmTurnUuid: string | null = null
  /** This page asked for the interrupt now in flight: only it restores the
   *  inject texts Stop drops. Cleared once the session settles. */
  private interruptRequested = false

  private async handleWorkerMessage(
    message: BrowserWorkerClientInboundMessage,
  ): Promise<void> {
    switch (message.type) {
      // Manager-sourced "next message" feed. The pending text always arrives
      // in FULL (never a delta) — render it verbatim.
      case 'worker.pendingMessageUpdated': {
        // Ignore stale updates while a clear is in flight: the manager may have
        // already queued an append before it processes our clear request, and
        // replaying it would re-flash the strip the user just dismissed.
        if (this.state.pendingClearInFlight) return
        const { promptUuids, consumed } = message.payload
        // The worker is authoritative about whether a submit started a turn or
        // was parked. `submitInput` guesses from `snapshot.isBusy`, which lags
        // the worker by a postMessage — when it guessed wrong we are showing an
        // optimistic bubble for a message the worker actually parked, and the
        // same text renders twice (bubble + strip) for the rest of the turn.
        // The worker names the parked uuids, so retract the bubble here.
        const bubbleWasParked =
          this.state.pendingPromptId !== null &&
          promptUuids?.includes(this.state.pendingPromptId) === true
        // Same for a plain-Enter bubble the worker routed to the strip (a
        // slash command it recognised, or an older worker without the inject
        // queue): the strip is then its only surface.
        const injectBubbles = (this.state.injectBubbles ?? []).filter(
          bubble => !(bubble.optimistic && promptUuids?.includes(bubble.uuid) === true),
        )
        // A consumed batch becomes a persisted but never-streamed turn: re-arm the optimistic
        // bubble with its uuid, unless the transcript already carries it (nothing would clear it).
        const rearm =
          consumed?.text != null &&
          consumed.text.length > 0 &&
          !(
            consumed.promptUuid != null &&
            this.state.transcriptMessages.some(
              m => (m as { uuid?: string }).uuid === consumed.promptUuid,
            )
          )
        this.state = {
          ...this.state,
          injectBubbles,
          pendingMessage: message.payload.text ? message.payload.text : null,
          // Kept in lockstep with the text: a `consumed` event carries neither,
          // and it is the text going empty that hides the strip.
          pendingMessageEntries: message.payload.text
            ? (message.payload.entries ?? null)
            : null,
          ...(rearm
            ? this.rearmPendingPrompt(consumed!.text, consumed!.promptUuid ?? null)
            : bubbleWasParked
              ? { pendingPrompt: null, pendingPromptId: null }
              : {}),
        }
        this.emitState()
        return
      }

      case 'worker.injectMessagesUpdated': {
        const injectBubbles = this.reconcileInjectEntries(message.payload.entries)
        // `submitInput` guessed idle and armed the optimistic user bubble, but
        // the worker parked the submit: the pending bubble is now its only
        // surface (same as `bubbleWasParked` for the strip).
        const parkedPrompt =
          this.state.pendingPromptId !== null &&
          message.payload.entries.some(entry => entry.uuid === this.state.pendingPromptId)
        this.state = {
          ...this.state,
          injectBubbles,
          ...(parkedPrompt ? { pendingPrompt: null, pendingPromptId: null } : {}),
        }
        this.emitState()
        return
      }

      case 'worker.injectMessagesLanded': {
        const { uuids, via, turnUuid, text } = message.payload
        const landedSet = new Set(uuids)
        let bubbles = (this.state.injectBubbles ?? []).map(bubble =>
          landedSet.has(bubble.uuid)
            ? {
                ...bubble,
                state: 'landed' as const,
                landedVia: via,
                optimistic: false,
                removing: false,
                ...(turnUuid !== undefined ? { turnUuid } : {}),
              }
            : bubble,
        )
        let rearm: Partial<BrowserRuntimeClientState> = {}
        if (via === 'nextturn' && turnUuid !== undefined && text) {
          const persisted = this.state.transcriptMessages.some(
            m => (m as { uuid?: string }).uuid === turnUuid,
          )
          if (this.state.pendingPromptId === turnUuid) {
            // The strip's `consumed` already armed this turn's bubble (a
            // merged Enter + Ctrl+Enter batch): show the whole merged text and
            // let that one bubble stand for all of them.
            rearm = { pendingPrompt: text }
            bubbles = bubbles.filter(bubble => !landedSet.has(bubble.uuid))
          } else if (!persisted && !this.injectRearmActive()) {
            // Inject-only next turn: arm the optimistic user bubble exactly
            // like a consumed next message (stable anchor for the new turn's
            // live assistant ids).
            rearm = this.rearmPendingPrompt(text, turnUuid)
            bubbles = bubbles.filter(bubble => !landedSet.has(bubble.uuid))
          }
        }
        this.state = { ...this.state, ...rearm, injectBubbles: bubbles }
        this.emitState()
        return
      }

      case 'worker.injectMessageRemoved': {
        const { uuid, requestId, ok, text } = message.payload
        const waiter = this.injectRemoveWaiters.get(requestId)
        // Read before the bubble goes (pruning drops the draft with it).
        const draft = this.injectDrafts.get(uuid)
        if (ok) {
          this.setInjectBubbles(
            (this.state.injectBubbles ?? []).filter(bubble => bubble.uuid !== uuid),
          )
        } else if (waiter) {
          this.setInjectBubbles(
            (this.state.injectBubbles ?? []).map(bubble =>
              bubble.uuid === uuid ? { ...bubble, removing: false } : bubble,
            ),
          )
        }
        if (waiter) {
          this.injectRemoveWaiters.delete(requestId)
          waiter(
            !ok
              ? { ok }
              : draft
                ? { ok, text: draft.text, files: draft.files }
                : { ok, ...(text !== undefined ? { text } : {}) },
          )
        }
        return
      }

      case 'worker.injectMessagesCleared': {
        const cleared = new Set(message.payload.entries.map(entry => entry.uuid))
        // This page's own attachment sends come back as typed (text + files),
        // not as the worker's display text (the file names).
        const drafts = message.payload.entries.map(entry =>
          this.injectDrafts.get(entry.uuid),
        )
        const restoreText = message.payload.entries
          .map((entry, index) => drafts[index]?.text ?? entry.text)
          .filter(text => text.length > 0)
          .join('\n')
        const restoreFiles = drafts.flatMap(draft => draft?.files ?? [])
        this.state = {
          ...this.state,
          injectBubbles: (this.state.injectBubbles ?? []).filter(
            bubble => bubble.state === 'landed' || !cleared.has(bubble.uuid),
          ),
          ...(this.interruptRequested && (restoreText || restoreFiles.length > 0)
            ? {
                injectRestore: {
                  id: randomUuid(),
                  text: restoreText,
                  ...(restoreFiles.length > 0 ? { files: restoreFiles } : {}),
                },
              }
            : {}),
        }
        this.emitState()
        return
      }

      case 'worker.pendingMessageCleared': {
        this.state = {
          ...this.state,
          pendingMessage: null,
          pendingMessageEntries: null,
          pendingClearInFlight: false,
        }
        this.emitState()
        return
      }

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
          ...this.restoreParkedInputFromSnapshot(message.payload),
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
          injectBubbles: this.pruneInjectBubbles(
            this.state.injectBubbles ?? [],
            mergedMessages,
          ),
        }
        this.resolveMessagesWaiters(mergedMessages)
        this.emitState()
        return
      }

      case 'worker.toolCallDetail':
        this.resolveToolCallDetailWaiters(
          message.payload.toolCallId,
          message.payload.detail,
        )
        return

      case 'worker.turnDiffHistory':
        // History changed → any cached per-turn detail may be stale (the
        // current turn can grow); drop it so the next expand re-fetches.
        this.turnDiffDetailCache.clear()
        this.state = {
          ...this.state,
          turnDiffHistory: message.payload.turns,
        }
        this.emitState()
        return

      case 'worker.turnDiffDetail':
        this.resolveTurnDiffDetailWaiters(
          message.payload.turnIndex,
          message.payload.files,
        )
        return

      case 'worker.skillBody':
        this.resolveSkillBodyWaiters(
          message.payload.name,
          message.payload.result,
        )
        return

      case 'worker.debugLog': {
        const { level, data } = message.payload
        // ModelUpload info entries go EXCLUSIVELY to the upload bus when its handler is installed;
        // warn-level entries always reach the console.
        const isModelUploadTraceEntry =
          data !== null
          && typeof data === 'object'
          && (data as { trace?: unknown }).trace === 'NexusTrace'
          && (data as { scope?: unknown }).scope === 'ModelUpload'
        const traceUiOnly =
          level !== 'warn'
          && isModelUploadTraceEntry
          && modelUploadHandler !== null
        if (!traceUiOnly) {
          if (level === 'warn') {
            if (data !== undefined) {
              console.warn(data)
            } else {
              console.warn(message.payload.message)
            }
          } else {
            if (data !== undefined) {
              console.info(data)
            } else {
              console.info(message.payload.message)
            }
          }
        }
        if (modelUploadHandler && data !== undefined) {
          // The handler is responsible for checking the entry shape;
          // when it's not installed, no work is done here at all and
          // the `modelUploadBus` module is never imported.
          modelUploadHandler(data)
        }
        return
      }

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

  private resolveToolCallDetailWaiters(
    toolCallId: string,
    detail: BrowserToolCallDetailRecord | null,
  ): void {
    const waiters = this.toolCallDetailWaiters.get(toolCallId) ?? []
    this.toolCallDetailWaiters.delete(toolCallId)
    for (const waiter of waiters) {
      waiter(detail)
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

  /** Drop the drafts whose bubble is gone (landed into the transcript,
   *  removed, cleared): nothing can hand them back any more. */
  private pruneInjectDrafts(): void {
    const shown = new Set((this.state.injectBubbles ?? []).map(bubble => bubble.uuid))
    for (const uuid of [...this.injectDrafts.keys()]) {
      if (!shown.has(uuid)) this.injectDrafts.delete(uuid)
    }
  }

  private emitState(): void {
    if (this.injectDrafts.size > 0) this.pruneInjectDrafts()
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
