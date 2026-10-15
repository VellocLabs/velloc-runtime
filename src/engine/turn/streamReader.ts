/**
 * Reading one streamed model response. Pure half: `assembleChunk`, `isEmptyStream`,
 * `buildStreamedAssistants` (side effects only on the accumulator). IO half: `readModelStream`.
 */
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import type { Message } from '../../runtime/RuntimeTypes'
import type { QueryModelCallParams } from '../../runtime/interfaces/QueryRuntimeDeps'
import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
} from '../../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../../browser/bridge/browserBridgeProtocol'
import { NEXUS_MODEL_CONFIG } from '../../config/nexusModelConfig'
import { ProviderApiError } from '../../utils/providerConnectivity'
import { traceLine } from '../../utils/debugLog'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_STREAM_EVENT,
  ROLE_ASSISTANT,
  PART_TEXT,
  PART_TOOL_CALL,
  STREAM_MESSAGE_START,
  STREAM_MESSAGE_DELTA,
  STREAM_CONTENT_BLOCK_START,
  STREAM_CONTENT_BLOCK_DELTA,
  STREAM_ERROR,
  DELTA_TEXT,
  DELTA_THINKING,
  DELTA_SIGNATURE,
  PART_THINKING,
} from '../../runtime/VercelModelConstants'
import {
  createRepeatedToolCallGuard,
  fnv1aHex,
  REPEATED_TOOL_CALL_LIMIT,
  type RepeatedToolCallCut,
  type RepeatedToolCallGuard,
} from './repeatedToolCallGuard'
import { normalizeAssistantContentPartFromBridge } from './bridgeSerialization'
import {
  EmptyModelStreamError,
  STOP_REASON_CONTENT_FILTER,
  isContentFilterStop,
  splitRefusalTurn,
} from './modelErrorMessages'
import {
  isCallModelLogEnabled,
  logCallModelEvent,
  nextAssistantYieldId,
} from './callModelTrace'
import { logModelResponseTrace, type ModelTransportOptions } from './modelTrace'
import { waitRetry } from './retryLadder'

// ── shared call context ────────────────────────────────────────────────────

/** Sends one bridge request; rejects with `code: message` on a bridge error. */
export type BridgeSend = <
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
>(
  route: BrowserBridgeRoute<C, A>,
  payload: BrowserBridgeRequestPayload<C, A>,
) => Promise<BrowserBridgeResult<C, A>>

/** The request-side facts of a model call that the shape of a cut report needs. */
export type ModelRequestFacts = {
  effectiveModel: string
  thinkingTier?: unknown
  maxOutputTokens?: number
  toolCount: number
  transcriptLength: number
}

/** Everything the IO steps of one model call share. */
export type ModelCall = {
  params: QueryModelCallParams
  runtimeConfig?: RuntimeConfig
  traceLogger?: ModelTransportOptions['traceLogger']
  send: BridgeSend
  /** `sid=<id>` prefix on every `[llm]` debug line. */
  sessionTag: string
  /** Diagnostic call number; 0 when call logging is off. */
  callId: number
  payload: Record<string, unknown>
  facts: ModelRequestFacts
  /** Index of the request trace entry, when request tracing is on. */
  traceIndex?: number
  ids: { uuid(): string; timestamp(): string }
}

/** What one attempt learned about its stream, for the caller's cleanup. */
export type AttemptTracker = {
  streamStarted: boolean
  streamId?: string
  /** A cancel is already on the wire, or the host already cancelled. */
  cancelSent: boolean
}

// ── timing ─────────────────────────────────────────────────────────────────

const LEGACY_POLL_INTERVAL_MS = 25
const FALLBACK_IDLE_TIMEOUT_SECONDS = 90

/**
 * How long a read may sit without new chunks, per provider. The value comes
 * from the model catalog's `streamIdleTimeoutSeconds` (the same figure the
 * driver's raw stream enforces as its idle timeout), else 90 s. It is sent as
 * the hold window of each read; the host owns the real deadline. A guest-URL
 * test knob (`e2eStreamIdleTimeoutMs`) can shrink it.
 */
export function streamIdleTimeoutMs(
  providerId: string | undefined,
  runtimeConfig?: RuntimeConfig,
): number {
  const testOverride = Number.parseInt(
    runtimeConfig?.getEnv('e2eStreamIdleTimeoutMs') ?? '',
    10,
  )
  if (Number.isFinite(testOverride) && testOverride > 0) return testOverride
  const seconds =
    (providerId
      ? NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === providerId)
          ?.streamIdleTimeoutSeconds
      : undefined) ?? FALLBACK_IDLE_TIMEOUT_SECONDS
  return seconds * 1000
}

// ── pure: the chunk state machine ──────────────────────────────────────────

type Block = Record<string, unknown>
type StreamReadResult = BrowserBridgeResult<'model', 'streamRead'>
export type StreamChunk = StreamReadResult['chunks'][number]

export type StreamAccumulator = {
  blocks: Block[]
  model?: string
  usage?: Record<string, unknown>
  /** Final stop reason, already normalised to the bridge's vocabulary. */
  stopReason?: string
  stopDetails?: Record<string, unknown>
  /** Set when the repeated-call guard ended the response. */
  cut?: RepeatedToolCallCut
  messageStarts: number
  guard: RepeatedToolCallGuard
}

export function openStreamAccumulator(
  isReadOnlyCall: (toolName: string, args: unknown) => boolean,
): StreamAccumulator {
  return {
    blocks: [],
    messageStarts: 0,
    guard: createRepeatedToolCallGuard(isReadOnlyCall),
  }
}

export type ChunkContext = {
  tools: QueryModelCallParams['callContext']['options']['tools']
  providerId?: string
  baseInstructions: unknown
  facts: ModelRequestFacts
  /** Milliseconds since the stream opened, for a cut report. */
  elapsedMs: number
}

export type ChunkOutcome = {
  /** A usage event to pass on to the turn. */
  emit?: Message
  /** A diagnostic record for the call log. */
  note?: { event: string; data: Record<string, unknown> }
  /** The provider reported an error mid-stream. */
  error?: ProviderApiError
  /** The repeated-call guard ended the response with this chunk. */
  cut?: RepeatedToolCallCut
}

function toolCallIdOf(block: Block): string | undefined {
  return block.type === PART_TOOL_CALL && typeof block.toolCallId === 'string'
    ? block.toolCallId
    : undefined
}

function onMessageStart(acc: StreamAccumulator, chunk: StreamChunk): ChunkOutcome {
  const message = (chunk as { message?: unknown }).message
  if (!message || typeof message !== 'object') return {}
  if ('model' in message) acc.model = String((message as { model?: unknown }).model ?? '')
  acc.messageStarts += 1
  const note = {
    event: 'msg-start',
    data: {
      messageStartCount: acc.messageStarts,
      model: acc.model,
      hasUsage: !!(message as { usage?: unknown }).usage,
      contentBlocksSoFar: acc.blocks.length,
    },
  }
  const startUsage = (message as { usage?: unknown }).usage
  if (!startUsage || typeof startUsage !== 'object') return { note }
  acc.usage = { ...(startUsage as Record<string, unknown>) }
  return {
    note,
    emit: {
      type: MSG_TYPE_STREAM_EVENT,
      event: { type: STREAM_MESSAGE_START, message: { usage: { ...acc.usage } } },
    } as Message,
  }
}

function onMessageDelta(acc: StreamAccumulator, chunk: StreamChunk): ChunkOutcome {
  const delta = (chunk as { delta?: unknown }).delta
  if (delta && typeof delta === 'object') {
    const reason = (delta as { stop_reason?: unknown }).stop_reason
    if (typeof reason === 'string' && reason.length > 0) acc.stopReason = reason
    const details = (delta as { stop_details?: unknown }).stop_details
    if (details && typeof details === 'object') {
      acc.stopDetails = details as Record<string, unknown>
    }
  }
  const usage = (chunk as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return {}
  acc.usage = { ...(acc.usage ?? {}), ...(usage as Record<string, unknown>) }
  return {
    emit: {
      type: MSG_TYPE_STREAM_EVENT,
      event: { type: STREAM_MESSAGE_DELTA, usage: { ...acc.usage } },
    } as Message,
  }
}

function cutReport(acc: StreamAccumulator, block: Block, ctx: ChunkContext): RepeatedToolCallCut {
  const promptText = JSON.stringify(ctx.baseInstructions ?? '')
  const { facts } = ctx
  return {
    toolName: String(block.toolName),
    repeatCount: REPEATED_TOOL_CALL_LIMIT,
    providerId: ctx.providerId,
    model: acc.model ?? facts.effectiveModel,
    ...(facts.thinkingTier ? { thinkingTier: String(facts.thinkingTier) } : {}),
    ...(typeof facts.maxOutputTokens === 'number'
      ? { maxOutputTokens: facts.maxOutputTokens }
      : {}),
    systemPromptChars: promptText.length,
    systemPromptHash: fnv1aHex(promptText),
    toolCount: facts.toolCount,
    transcriptLength: facts.transcriptLength,
    elapsedMs: ctx.elapsedMs,
  }
}

function onBlockStart(acc: StreamAccumulator, chunk: StreamChunk, ctx: ChunkContext): ChunkOutcome {
  const raw = (chunk as { content_block?: unknown }).content_block
  if (!raw) return {}
  const block = normalizeAssistantContentPartFromBridge(raw as never, ctx.tools) as Block
  // The host can announce the same tool call twice (two flush paths racing).
  // A second copy would run the tool twice and break the UI's keyed parts, so
  // only the first one is kept.
  const callId = toolCallIdOf(block)
  if (callId !== undefined && acc.blocks.some(b => toolCallIdOf(b) === callId)) {
    return {
      note: {
        event: 'dup-content-block-skip',
        data: {
          toolCallId: callId,
          messageStartCount: acc.messageStarts,
          contentBlocksSoFar: acc.blocks.length,
        },
      },
    }
  }
  acc.blocks.push(block)
  if (!acc.guard.observe(block)) return {}
  // The model is looping on one read-only call: keep the first of the run,
  // drop the copies, and finish as an ordinary tool-use response.
  acc.blocks.splice(acc.blocks.length - (REPEATED_TOOL_CALL_LIMIT - 1))
  acc.cut = cutReport(acc, block, ctx)
  acc.stopReason = 'tool_use'
  return { cut: acc.cut }
}

function onBlockDelta(acc: StreamAccumulator, chunk: StreamChunk): ChunkOutcome {
  const { delta, index } = chunk as { delta?: { type?: unknown }; index?: number }
  if (!delta || index === undefined) return {}
  const block = acc.blocks[index]
  if (!block) return {}
  if (delta.type === DELTA_TEXT) {
    block.text = (block.text ?? '') + String((delta as { text?: string }).text ?? '')
  } else if (delta.type === DELTA_THINKING && block.type === PART_THINKING) {
    block.thinking = String(block.thinking ?? '')
      + String((delta as { thinking?: string }).thinking ?? '')
  } else if (delta.type === DELTA_SIGNATURE && block.type === PART_THINKING) {
    const signature = (delta as { signature?: unknown }).signature
    if (typeof signature === 'string' && signature) block.signature = signature
  }
  return {}
}

function foldErrorChunk(chunk: StreamChunk): ChunkOutcome {
  // The error carries the wire's classifier as a `type: ` prefix and, from
  // current hosts, the HTTP status and Retry-After as typed fields so the
  // retry ladder can read structure before falling back to text.
  const error = (chunk as {
    error?: { type?: string; message?: string; httpStatus?: unknown; retryAfterSeconds?: unknown }
  }).error
  const prefix = error?.type ? `${error.type}: ` : ''
  const status = error?.httpStatus
  const retryAfterS = error?.retryAfterSeconds
  return {
    error: new ProviderApiError(
      `${prefix}${error?.message ?? 'Unknown model streaming error'}`,
      {
        ...(typeof status === 'number' ? { httpStatus: status } : {}),
        ...(typeof retryAfterS === 'number' && retryAfterS >= 0
          ? { retryAfterMs: retryAfterS * 1000 }
          : {}),
      },
    ),
  }
}

/** Fold one wire chunk into the accumulator. */
export function assembleChunk(
  acc: StreamAccumulator,
  chunk: StreamChunk,
  ctx: ChunkContext,
): ChunkOutcome {
  switch (chunk.type) {
    case STREAM_MESSAGE_START: return onMessageStart(acc, chunk)
    case STREAM_MESSAGE_DELTA: return onMessageDelta(acc, chunk)
    case STREAM_CONTENT_BLOCK_START: return onBlockStart(acc, chunk, ctx)
    case STREAM_CONTENT_BLOCK_DELTA: return onBlockDelta(acc, chunk)
    case STREAM_ERROR: return foldErrorChunk(chunk)
    default: return {}
  }
}

/**
 * A stream that opened but delivered nothing usable: no blocks, and either no
 * stop reason or zero output tokens (some bridges synthesise a benign stop
 * reason when the body simply ends). A truncation, a safety stop (which
 * legitimately has no output) and a cancelled read are not empty streams.
 */
export function isEmptyStream(acc: StreamAccumulator, cancelled: boolean): boolean {
  const outputTokens =
    typeof acc.usage?.output_tokens === 'number' ? (acc.usage.output_tokens as number) : 0
  return (
    acc.blocks.length === 0
    && acc.stopReason !== 'max_tokens'
    && acc.stopReason !== STOP_REASON_CONTENT_FILTER
    && (!acc.stopReason || outputTokens === 0)
    && !cancelled
  )
}

/**
 * The assistant message(s) for a finished stream: blocks (or one empty text
 * part), usage, stop reason and details, a truncation marker, the cut report;
 * a safety stop is split into the streamed part plus an API-error message.
 */
export function buildStreamedAssistants(
  acc: StreamAccumulator,
  effectiveModel: string,
  ids: { uuid(): string; timestamp(): string },
): Message[] {
  const assistant = {
    type: MSG_TYPE_ASSISTANT,
    uuid: ids.uuid(),
    timestamp: ids.timestamp(),
    message: {
      role: ROLE_ASSISTANT,
      content: acc.blocks.length > 0 ? acc.blocks : [{ type: PART_TEXT, text: '' }],
      model: acc.model ?? effectiveModel,
      ...(acc.usage ? { usage: acc.usage } : {}),
      ...(acc.stopReason ? { stop_reason: acc.stopReason } : {}),
      ...(acc.stopDetails ? { stop_details: acc.stopDetails } : {}),
    },
    ...(acc.stopReason === 'max_tokens' ? { apiError: 'max_output_tokens' as const } : {}),
    ...(acc.cut ? { repeatedToolCallCut: acc.cut } : {}),
  }
  return (isContentFilterStop(acc.stopReason)
    ? splitRefusalTurn(assistant as never, ids.uuid())
    : [assistant]) as Message[]
}

// ── IO: the read loop ──────────────────────────────────────────────────────

/** Fire-and-forget upstream cancel; older hosts without the action are fine. */
export function cancelStream(send: BridgeSend, streamId: string): void {
  void send(createBridgeRoute('model', 'streamCancel'), { streamId }).catch(() => {})
}

type HeldRead =
  /** Cancelled before the read could be raced. */
  | { kind: 'cancelled' }
  | {
      kind: 'pending'
      /** The read, raced against Stop. */
      race: Promise<StreamReadResult | 'aborted'>
      /** The bare read, so a dropped one can be silenced. */
      read: Promise<StreamReadResult>
      /** Remove the Stop listener; called once the race settles. */
      detach(): void
    }

/**
 * Issue one read that the host may hold until chunks arrive, raced against
 * Stop so a long hold never delays cancellation. The listener is detached
 * after every read so a long turn does not pile them up on the signal.
 */
function startHeldRead(
  send: BridgeSend,
  streamId: string,
  idleMs: number,
  signal: AbortSignal,
): HeldRead {
  const read = send(createBridgeRoute('model', 'streamRead'), {
    streamId,
    deadlineMs: Date.now() + idleMs,
    waitMs: idleMs,
  })
  if (signal.aborted) {
    read.catch(() => {})
    return { kind: 'cancelled' }
  }
  let onAbort!: () => void
  const aborted = new Promise<'aborted'>(resolve => {
    onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    kind: 'pending',
    race: Promise.race([read, aborted]),
    read,
    detach: () => signal.removeEventListener('abort', onAbort),
  }
}

type ReadWatch = {
  startedAt: number
  lastChunkAt: number
  queuedReads: number
  reads: number
  idlePolls: number
  chunkTypes: Set<string>
}

function secondsSince(at: number): number {
  return Math.round((Date.now() - at) / 1000)
}

function logReadForDiagnostics(call: ModelCall, watch: ReadWatch, read: StreamReadResult): void {
  if (!isCallModelLogEnabled()) return
  watch.reads += 1
  for (const c of read.chunks) watch.chunkTypes.add(c.type)
  // Empty, unfinished reads are only counted; the count rides on the next
  // read that brings something so the log stays readable.
  if (read.chunks.length === 0 && !read.done) {
    watch.idlePolls += 1
    return
  }
  logCallModelEvent('stream-read', {
    callId: call.callId,
    streamReadCount: watch.reads,
    done: read.done,
    chunkCount: read.chunks.length,
    chunkTypes: read.chunks.map(c => c.type),
    ...(watch.idlePolls > 0 ? { idlePollsBefore: watch.idlePolls } : {}),
  })
  watch.idlePolls = 0
}

/**
 * Handle a read that brought no chunks. A host without hold support answers
 * at once, so the JS side keeps the idle clock (cancelling upstream when it
 * runs out) and returns the poll pause to wait out; a hold-capable host
 * already waited, so nothing is returned and the next read goes out at once.
 */
function onEmptyRead(
  call: ModelCall,
  attempt: AttemptTracker,
  streamId: string,
  holdCapable: boolean,
  idleMs: number,
  idleLimitMs: number,
): Promise<void> | undefined {
  if (holdCapable) return undefined
  const { params, sessionTag } = call
  if (idleMs >= idleLimitMs) {
    traceLine(
      `[llm] streamRead js-timeout (legacy host) ${sessionTag} provider=${params.providerId} src=${params.querySource} idleSec=${Math.round(idleMs / 1000)}`,
      { level: 'warn' },
    )
    attempt.cancelSent = true
    cancelStream(call.send, streamId)
    // "upstream" in this text is what the connectivity classifier keys on to
    // treat the timeout as a retryable service problem.
    throw new Error(
      `stream_idle_timeout: no chunks received for `
      + `${Math.round(idleMs / 1000)}s (stream cancelled upstream)`,
    )
  }
  return waitRetry(LEGACY_POLL_INTERVAL_MS, params.callContext.cancelSource.signal)
}

/**
 * Note a read that did not deliver: still queued for a provider slot (keep
 * the place and read again; queue time is not provider silence), or the
 * host's idle verdict (it has already cancelled upstream; throws). Returns
 * true when the read should simply be re-issued.
 */
function onUndeliveredRead(
  call: ModelCall,
  attempt: AttemptTracker,
  watch: ReadWatch,
  read: StreamReadResult,
): boolean {
  const { params, sessionTag } = call
  if (read.status === 'queued') {
    watch.queuedReads += 1
    watch.lastChunkAt = Date.now()
    if (watch.queuedReads === 1 || watch.queuedReads % 5 === 0) {
      traceLine(
        `[llm] streamRead queued ${sessionTag} provider=${params.providerId} src=${params.querySource} waits=${watch.queuedReads} sinceStartSec=${secondsSince(watch.startedAt)}`,
        { level: 'warn' },
      )
    }
    return true
  }
  if (read.status === 'timeout') {
    traceLine(
      `[llm] streamRead native-timeout ${sessionTag} provider=${params.providerId} src=${params.querySource} sinceStartSec=${secondsSince(watch.startedAt)} timeline=${JSON.stringify(read.timeline ?? null)}`,
      { level: 'warn' },
    )
    attempt.cancelSent = true
    throw new Error(
      `stream_idle_timeout: native host reported no chunks for `
      + `${secondsSince(watch.startedAt)}s (stream cancelled upstream)`,
    )
  }
  return false
}

/** Track provider silence; log once a minute while it lasts. Returns the idle time. */
function trackIdle(call: ModelCall, watch: ReadWatch, read: StreamReadResult): number {
  if (read.chunks.length > 0) watch.lastChunkAt = Date.now()
  const idleMs = Date.now() - watch.lastChunkAt
  if (idleMs >= 60000 && Math.floor(idleMs / 60000) !== Math.floor((idleMs - 25) / 60000)) {
    traceLine(
      `[llm] streamRead idle ${call.sessionTag} provider=${call.params.providerId} src=${call.params.querySource} idleSec=${Math.round(idleMs / 1000)} sinceStartSec=${secondsSince(watch.startedAt)}`,
      { level: 'warn' },
    )
  }
  return idleMs
}

function chunkContext(call: ModelCall, watch: ReadWatch): ChunkContext {
  return {
    tools: call.params.callContext.options.tools,
    providerId: call.params.providerId,
    baseInstructions: call.params.baseInstructions,
    facts: call.facts,
    elapsedMs: Date.now() - watch.startedAt,
  }
}

type FoldedBatch = { emits: Message[]; error?: ProviderApiError; cut: boolean }

/**
 * Fold a batch of chunks. Stops at a provider error, or at a repeated-call
 * cut (the stream is cancelled upstream; chunks behind the cut belong to it
 * and are dropped).
 */
function foldChunks(
  call: ModelCall,
  attempt: AttemptTracker,
  streamId: string,
  acc: StreamAccumulator,
  chunks: StreamChunk[],
  watch: ReadWatch,
): FoldedBatch {
  const emits: Message[] = []
  for (const chunk of chunks) {
    const outcome = assembleChunk(acc, chunk, chunkContext(call, watch))
    if (outcome.note && isCallModelLogEnabled()) {
      logCallModelEvent(outcome.note.event, { callId: call.callId, ...outcome.note.data })
    }
    if (outcome.error) return { emits, error: outcome.error, cut: false }
    if (outcome.emit) emits.push(outcome.emit)
    if (outcome.cut) {
      attempt.cancelSent = true
      cancelStream(call.send, streamId)
      traceLine(
        `[llm] repeated tool call cut ${call.sessionTag} provider=${call.params.providerId} ${JSON.stringify(outcome.cut)}`,
        { level: 'warn' },
      )
      return { emits, cut: true }
    }
  }
  return { emits, cut: false }
}

function logAssistantYield(call: ModelCall, acc: StreamAccumulator, watch: ReadWatch): void {
  if (!isCallModelLogEnabled()) return
  const yieldId = nextAssistantYieldId()
  if (watch.idlePolls > 0) {
    logCallModelEvent('stream-read', {
      callId: call.callId,
      streamReadCount: watch.reads,
      done: true,
      chunkCount: 0,
      chunkTypes: [],
      idlePollsBefore: watch.idlePolls,
    })
    watch.idlePolls = 0
  }
  logCallModelEvent('assistant-yield', {
    callId: call.callId,
    yieldId,
    messageStartCount: acc.messageStarts,
    streamReadTotal: watch.reads,
    chunkTypesSeen: Array.from(watch.chunkTypes).sort(),
    contentBlocksCount: acc.blocks.length,
    blockTypes: acc.blocks.map(b => String(b.type ?? '<no-type>')),
    totalTextLen: acc.blocks.reduce(
      (sum, b) => sum + (typeof b.text === 'string' ? (b.text as string).length : 0),
      0,
    ),
    model: acc.model ?? call.facts.effectiveModel,
  })
}

/** Trace one final assistant message when request tracing is on. */
export function traceAssistant(call: ModelCall, assistant: Message): void {
  if (call.traceIndex === undefined) return
  logModelResponseTrace(assistant, {
    requestIndex: call.traceIndex,
    sessionId: call.params.callContext.options.sessionId,
    turnCaller: call.params.querySource,
    providerId: call.params.providerId,
    model: call.facts.effectiveModel,
  }, call.traceLogger)
}

function newReadWatch(): ReadWatch {
  const now = Date.now()
  return { startedAt: now, lastChunkAt: now, queuedReads: 0, reads: 0, idlePolls: 0, chunkTypes: new Set() }
}

/**
 * Open the stream and read it to the end, yielding usage events as they come
 * and the finished assistant message(s) last. Ends early on Stop (cancelling
 * upstream). Throws on a provider error, an idle timeout or an empty stream;
 * `attempt` records how far it got so the caller can clean up and decide on
 * a fallback.
 */
export async function* readModelStream(
  call: ModelCall,
  attempt: AttemptTracker,
): AsyncGenerator<Message, void, unknown> {
  const { params, sessionTag } = call
  const signal = params.callContext.cancelSource.signal
  const openedAt = Date.now()
  const opened = await call.send(createBridgeRoute('model', 'streamStart'), call.payload as never)
  attempt.streamStarted = true
  traceLine(
    `[llm] streamStart resolved ${sessionTag} provider=${params.providerId} src=${params.querySource} elapsedMs=${Date.now() - openedAt}`,
    { level: 'info' },
  )
  const streamId = opened.streamId
  attempt.streamId = streamId
  if (isCallModelLogEnabled()) logCallModelEvent('stream-start', { callId: call.callId, streamId })
  const tools = params.callContext.options.tools
  const acc = openStreamAccumulator((toolName, args) => {
    const tool = tools.find(t => t.name === toolName)
    return tool ? tool.readsOnly(args as never) === true : false
  })
  const watch = newReadWatch()

  let done = false
  while (!done) {
    if (signal.aborted) {
      cancelStream(call.send, streamId)
      break
    }
    const idleLimitMs = streamIdleTimeoutMs(params.providerId, call.runtimeConfig)
    const held = startHeldRead(call.send, streamId, idleLimitMs, signal)
    if (held.kind === 'cancelled') break
    let raced: StreamReadResult | 'aborted'
    try {
      raced = await held.race
    } finally {
      held.detach()
    }
    if (raced === 'aborted') {
      held.read.catch(() => {})
      cancelStream(call.send, streamId)
      break
    }
    done = raced.done
    if (onUndeliveredRead(call, attempt, watch, raced)) continue
    const idleMs = trackIdle(call, watch, raced)
    logReadForDiagnostics(call, watch, raced)
    if (raced.chunks.length === 0 && !done) {
      const pause = onEmptyRead(call, attempt, streamId, raced.status !== undefined, idleMs, idleLimitMs)
      if (pause) await pause
      continue
    }
    const batch = foldChunks(call, attempt, streamId, acc, raced.chunks, watch)
    for (const emit of batch.emits) yield emit
    if (batch.error) throw batch.error
    if (batch.cut) done = true
  }

  if (isEmptyStream(acc, signal.aborted)) {
    throw new EmptyModelStreamError(
      'Model stream ended with no content blocks and no output tokens',
    )
  }
  logAssistantYield(call, acc, watch)
  for (const assistant of buildStreamedAssistants(acc, call.facts.effectiveModel, call.ids)) {
    traceAssistant(call, assistant)
    yield assistant
  }
}
