/**
 * The model call over the browser bridge: build the request once, then attempts that stream (one
 * blocking fallback only when streaming never started or produced nothing). The retry ladder decides
 * retries; otherwise an API-error assistant message, not a throw. Cancellation propagates untouched.
 */
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import type { Message } from '../../runtime/RuntimeTypes'
import type {
  QueryModelCallParams,
  QueryRuntimeDeps,
} from '../../runtime/interfaces/QueryRuntimeDeps'
import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BridgeModelInputMessage,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../../browser/bridge/browserBridgeProtocol'
import { resolveCustomProviderRequest } from '../../config/customProviderRegistry'
import { withModelProviders } from '../../models/drivers/driverTransport'
import { withRequestLog } from '../../models/usage/requestLogTransport'
import { providerRequestSeamFor } from '../../models/drivers/providerRequestSeam'
import { buildRequestContext } from '../../models/drivers/requestContext'
import { getSupportsImageInputForModel } from '../contextWindow'
import { emptyPermissionRuleSet } from '../../toolkit/permissionVerdict'
import { prepareHistoryForModel } from '../../messages/prepareModelHistory'
import { rowsSinceFoldLine } from '../../context/compaction/boundary'
import { isPromptTooLongError } from '../../utils/promptTooLong'
import {
  getProviderConnectivityMaxRetries,
  isAbortLikeError,
} from '../../utils/providerConnectivity'
import { traceLine } from '../../utils/debugLog'
import { MSG_TYPE_ASSISTANT, MSG_TYPE_STREAM_EVENT } from '../../runtime/VercelModelConstants'
import { resolveModelRequestFields } from './modelRequestFields'
import {
  isCallModelLogEnabled,
  logCallModelEvent,
  nextAssistantYieldId,
  nextCallId,
} from './callModelTrace'
import { createTimestamp, createUUID } from './runtimeIds'
import {
  type ModelTransportOptions,
  logModelRequestTrace,
  sanitizeModelTraceValue,
  shouldTraceModelRequests,
} from './modelTrace'
import {
  normalizeAssistantContentBlocksFromBridge,
  serializeMessagesForBridge,
  serializeToolsForModel,
} from './bridgeSerialization'
import {
  isEmptyModelStreamError,
  makePromptTooLongAssistant,
  makeProviderApiErrorAssistant,
  makeProviderRetrySystemMessage,
  isContentFilterStop,
  splitRefusalTurn,
} from './modelErrorMessages'
import {
  cancelStream,
  readModelStream,
  traceAssistant,
  type AttemptTracker,
  type BridgeSend,
  type ModelCall,
  type ModelRequestFacts,
} from './streamReader'
import {
  classifyModelFailure,
  decideRetry,
  retriesAllowed,
  waitRetry,
  type DeclaredRetryPolicy,
  type RetryDecision,
} from './retryLadder'
import { raisesTurnRequest, requestThroughTurnRequest } from './requestThroughMods'
import { raisesTurnRecover, recoverThroughMods } from './recoverThroughMods'
import { observeProviderCall, type CallEnding } from './providerOutcomeCall'
import { providerRouterBoundsFor, RouteSwitchError, type RoutedVia } from '../../models/drivers/providerRouter'
import { routeCallOf, routedViaOf, routeErrorOfCall, shareRouteCall } from '../../models/drivers/providerRouteCall'
import { routeMemberFacts } from '../../models/drivers/providerRouteResolution'
import { sessionUsageOf } from '../../mods/sessionNouns'
import type { StoredRow } from '../../mods/sessionAppendEvent'

/**
 * Whole-response budget for the blocking fallback. A blocking call streams
 * nothing, so an idle clock does not apply; this bounds how long the provider
 * may take to produce the entire answer. The bridge transport's own guard for
 * `model.call` must stay above this value.
 */
const BLOCKING_CALL_TIMEOUT_MS = 300_000

// ── pure: request construction ─────────────────────────────────────────────

/**
 * The per-call context the model may act on, rendered into the system prompt.
 * Session id and working directory are left out: they add noise or leak.
 * Skills found mid-session are left out: a growing list would change the
 * cached prefix, and each find reaches the model as an attachment.
 */
function modelVisibleContext(params: QueryModelCallParams): Record<string, unknown> {
  const permissionContext = {
    ...emptyPermissionRuleSet(),
    ...params.callContext.readAppState().permissionRules,
  }
  return {
    permissionMode: permissionContext.mode,
    querySource: params.querySource,
    availableSkills: params.callContext.options.commands.map(command => command.name),
  }
}

export type ModelRequest = {
  payload: Record<string, unknown>
  facts: ModelRequestFacts
  /** Metadata for the request trace entry. */
  trace: {
    sessionId?: string
    turnCaller: string
    providerId?: string
    model?: string
    toolCount: number
    transcriptLength: number
    inputMessageCount: number
  }
}

/** The model a call runs against: an explicit override, else the session's. */
export function effectiveModelOf(params: QueryModelCallParams): string {
  return params.modelOverride ?? params.callContext.options.mainLoopModel
}

/**
 * Build the request for one model call: the transcript after the latest
 * compaction boundary, prepared and serialised for the bridge (images and
 * documents downgraded for text-only models), the tool definitions, the wire
 * provider (a custom provider rides its dialect's id), and the fields that
 * depend on provider, model and thinking tier.
 */
export function buildModelRequest(
  params: QueryModelCallParams,
  tools: unknown[],
): ModelRequest {
  const effectiveModel = effectiveModelOf(params)
  const visible = rowsSinceFoldLine(params.messages)
  const prepared = prepareHistoryForModel(visible) as BridgeModelInputMessage[]
  const messages = serializeMessagesForBridge(
    prepared,
    params.callContext.options.tools,
    { allowImageParts: getSupportsImageInputForModel(effectiveModel, params.providerId) },
  )
  const customRouting = resolveCustomProviderRequest(params.providerId)
  const fields = resolveModelRequestFields({
    model: effectiveModel,
    providerId: params.providerId,
    thinkingProviderId: customRouting?.thinkingProviderId,
    thinkingTier: params.thinkingTier,
    maxOutputTokensOverride: params.outputTokenCapOverride,
  })
  const payload = {
    messages,
    systemPrompt: params.baseInstructions,
    userContext: params.userContext,
    systemContext: params.systemAmbient,
    providerId: customRouting?.providerId ?? params.providerId,
    model: effectiveModel,
    maxOutputTokens: fields.maxOutputTokens,
    tools,
    toolUseContext: modelVisibleContext(params),
    requestContext: buildRequestContext(
      {
        sessionId: params.callContext.options.sessionId,
        spawnerSessionId: params.callContext.options.spawnerSessionId,
        agentId: params.callContext.agentId,
      },
      params.querySource,
    ),
    ...(fields.providerBodyExtension
      ? { providerBodyExtension: fields.providerBodyExtension }
      : {}),
    // For a provider mod's request hook (`effort`); no codec reads it.
    ...(fields.thinkingTier ? { thinkingTier: fields.thinkingTier } : {}),
  }
  return {
    payload,
    facts: {
      effectiveModel,
      thinkingTier: fields.thinkingTier,
      maxOutputTokens: fields.maxOutputTokens,
      toolCount: tools.length,
      transcriptLength: messages.length,
    },
    trace: {
      sessionId: params.callContext.options.sessionId,
      turnCaller: params.querySource,
      providerId: params.providerId,
      model: effectiveModel,
      toolCount: tools.length,
      transcriptLength: messages.length,
      inputMessageCount: prepared.length,
    },
  }
}

// ── IO: one attempt ────────────────────────────────────────────────────────

function emitTrace(call: ModelCall, data: Record<string, unknown>): void {
  if (!call.traceLogger && !shouldTraceModelRequests()) return
  const entry = {
    trace: 'NexusTrace' as const,
    scope: 'ModelUpload' as const,
    ...data,
  }
  if (call.traceLogger) call.traceLogger({ level: 'warn', data: entry })
  else console.warn(entry)
}

/**
 * The one-shot blocking call, used when streaming was unavailable or empty.
 * Carries its own deadline; a host timeout or a queued expiry becomes a
 * retryable error rather than an empty answer.
 */
async function* blockingFallback(
  call: ModelCall,
  streamError: unknown,
): AsyncGenerator<Message, void, unknown> {
  const { params, sessionTag, runtimeConfig } = call
  const model = call.facts.effectiveModel
  emitTrace(call, {
    event: 'streamStartFallback',
    timestamp: createTimestamp(runtimeConfig),
    sessionId: params.callContext.options.sessionId,
    turnCaller: params.querySource,
    providerId: params.providerId,
    model,
    requestIndex: call.traceIndex,
    error: sanitizeModelTraceValue(streamError),
  })
  if (isCallModelLogEnabled()) {
    logCallModelEvent('fallback', {
      callId: call.callId,
      error: streamError instanceof Error ? streamError.message : String(streamError),
    })
  }
  let result: BrowserBridgeResult<'model', 'call'>
  try {
    const payload = { ...call.payload, deadlineMs: Date.now() + BLOCKING_CALL_TIMEOUT_MS }
    // Still the same call to a router provider's router (F-27).
    shareRouteCall(payload, call.payload)
    result = await call.send(createBridgeRoute('model', 'call'), payload as never)
  } catch (fallbackError) {
    // The blocking route's error crosses as text; a router's decision rides the call.
    const routed = fallbackError instanceof Error ? routeErrorOfCall(call.payload, fallbackError) : undefined
    if (routed) throw routed
    if (isPromptTooLongError(fallbackError)) {
      yield makePromptTooLongAssistant(runtimeConfig, model)
      return
    }
    throw fallbackError
  }
  const timeline = JSON.stringify(result.timeline ?? null)
  if (result.status === 'timeout') {
    traceLine(
      `[llm] blocking call native-timeout ${sessionTag} provider=${params.providerId} src=${params.querySource} timeline=${timeline}`,
      { level: 'warn' },
    )
    throw new Error(
      'call_idle_timeout: native host reported no complete response '
      + 'before the deadline (request cancelled upstream)',
    )
  }
  // Still queued behind the provider's concurrency cap when the deadline hit:
  // the request never left, and the message is an empty placeholder.
  if (result.status === 'queued') {
    traceLine(
      `[llm] blocking call queued-expiry ${sessionTag} provider=${params.providerId} src=${params.querySource} timeline=${timeline}`,
      { level: 'warn' },
    )
    throw new Error(
      'call_queued: request was still queued behind the provider '
      + 'concurrency cap when its deadline expired (never dispatched; '
      + 'host cancelled the queued entry)',
    )
  }
  if (isCallModelLogEnabled()) {
    const content = Array.isArray(result.message.content) ? result.message.content : []
    logCallModelEvent('fallback-yield', {
      callId: call.callId,
      yieldId: nextAssistantYieldId(),
      contentBlocksCount: content.length,
      blockTypes: content.map(b => String((b as { type?: unknown })?.type ?? '<no-type>')),
      model: result.message.model ?? model,
    })
  }
  for (const assistant of buildBlockingAssistants(call, result.message)) {
    traceAssistant(call, assistant)
    yield assistant
  }
}

/** The assistant message(s) for a blocking reply; a safety stop is split. */
export function buildBlockingAssistants(
  call: Pick<ModelCall, 'params' | 'facts' | 'ids'>,
  reply: BrowserBridgeResult<'model', 'call'>['message'],
): Message[] {
  const assistant = {
    type: MSG_TYPE_ASSISTANT,
    uuid: call.ids.uuid(),
    timestamp: call.ids.timestamp(),
    message: {
      ...reply,
      content: normalizeAssistantContentBlocksFromBridge(
        reply.content,
        call.params.callContext.options.tools,
      ),
      model: reply.model ?? call.facts.effectiveModel,
    },
  }
  return (isContentFilterStop(reply.stop_reason)
    ? splitRefusalTurn(assistant as never, call.ids.uuid())
    : [assistant]) as Message[]
}

/**
 * One attempt: stream the response; on failure, cancel whatever is still
 * open upstream, convert a prompt-too-long into its assistant message, and
 * fall back to a blocking call only when the stream never started or came
 * back empty. Any other failure after the stream started is rethrown for the
 * retry ladder.
 */
export async function* performRequest(call: ModelCall): AsyncGenerator<Message, void, unknown> {
  const attempt: AttemptTracker = { streamStarted: false, cancelSent: false }
  try {
    yield* readModelStream(call, attempt)
  } catch (streamError) {
    // Release the provider slot the failed stream still holds, unless it is
    // already cancelled, never opened, completed naturally (empty), or the
    // scope is gone.
    if (
      attempt.streamId !== undefined
      && !attempt.cancelSent
      && !isAbortLikeError(streamError)
      && !isEmptyModelStreamError(streamError)
    ) {
      attempt.cancelSent = true
      cancelStream(call.send, attempt.streamId)
    }
    if (isAbortLikeError(streamError)) throw streamError
    // A router's switch sends the call to another target, whatever the failed one said.
    if (isPromptTooLongError(streamError) && !(streamError instanceof RouteSwitchError)) {
      yield makePromptTooLongAssistant(call.runtimeConfig, call.facts.effectiveModel)
      return
    }
    if (attempt.streamStarted && !isEmptyModelStreamError(streamError)) throw streamError
    yield* blockingFallback(call, streamError)
  }
}

// ── IO: attempts and the ladder ────────────────────────────────────────────

function createBridgeSend(
  transport: BrowserBridgeTransport,
  runtimeConfig?: RuntimeConfig,
): BridgeSend {
  return async function send<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BrowserBridgeResult<C, A>> {
    const response = await transport.request({
      id: createUUID(runtimeConfig),
      route,
      payload,
    }) as { ok: true; result: BrowserBridgeResult<C, A> } | {
      ok: false
      error: { code: string; message: string }
    }
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }
}

function logCallStart(params: QueryModelCallParams, sessionTag: string): number {
  const model = effectiveModelOf(params)
  let callId = 0
  if (isCallModelLogEnabled()) {
    callId = nextCallId()
    const last = params.messages[params.messages.length - 1] as
      | { message?: { role?: string; content?: unknown } }
      | undefined
    const inner = last?.message
    logCallModelEvent('call-start', {
      callId,
      messageCount: params.messages.length,
      providerId: params.providerId,
      model,
      lastMessageRole: inner?.role,
      lastContentShape: Array.isArray(inner?.content)
        ? `array[${(inner!.content as unknown[]).length}]`
        : typeof inner?.content,
      querySource: params.querySource,
    })
  }
  traceLine(
    `[llm] callModel start ${sessionTag} provider=${params.providerId} model=${model} src=${params.querySource}`,
    { level: 'info' },
  )
  return callId
}

type CallSetup = {
  send: BridgeSend
  params: QueryModelCallParams
  runtimeConfig?: RuntimeConfig
  traceLogger?: ModelTransportOptions['traceLogger']
  sessionTag: string
  callId: number
}

/** Write the request's trace entry, and bundle what the attempts share. */
function createModelCall(setup: CallSetup, request: ModelRequest): ModelCall {
  const { runtimeConfig, traceLogger } = setup
  const traceEntry = logModelRequestTrace(request.payload, request.trace, traceLogger)
  return {
    ...setup,
    payload: request.payload,
    facts: request.facts,
    ...(traceEntry ? { traceIndex: traceEntry.index } : {}),
    ids: {
      uuid: setup.params.rowUuid ?? (() => createUUID(runtimeConfig)),
      timestamp: () => createTimestamp(runtimeConfig),
    },
  }
}

/** Where one call stands on the ladder when an attempt fails. */
type LadderPlace = {
  attempt: number
  maxRetries: number
  attemptMs: number
  policy?: DeclaredRetryPolicy
  waitedMs: number
}

type AfterFailure =
  | { next: 'rethrow' }
  | { next: 'finish'; message: Message }
  | { next: 'retry'; notice?: Message; delayMs: number }

/**
 * Decide what follows a failed attempt, and write its diagnostics: rethrow a
 * cancellation, finish with a prompt-too-long or API-error message, or retry
 * after a delay (with a user-visible notice when the ladder says so).
 */
function afterFailedAttempt(
  call: ModelCall,
  error: unknown,
  place: LadderPlace,
  /** The decision `turn.recover` settled on, when a hook selects it. */
  recovered?: RetryDecision,
): AfterFailure {
  const { params, runtimeConfig, sessionTag } = call
  const { attempt, maxRetries, attemptMs } = place
  const model = call.facts.effectiveModel
  const failure = classifyModelFailure(error)
  if (failure.kind === 'aborted') return { next: 'rethrow' }
  traceLine(
    `[llm] provider stream error: ${sessionTag} `
    + (error instanceof Error ? error.message : String(error)),
    { level: 'warn' },
  )
  if (failure.kind === 'prompt_too_long') {
    return { next: 'finish', message: makePromptTooLongAssistant(runtimeConfig, model) as Message }
  }
  const decision = recovered ?? decideRetry({
    attempt,
    maxAttempts: maxRetries + 1,
    failure,
    caller: params.querySource,
    attemptDurationMs: attemptMs,
    cancelled: params.callContext.cancelSource.signal.aborted,
    ...(place.policy ? { policy: place.policy, waitedMs: place.waitedMs } : {}),
  })
  if (!decision.retry) {
    return {
      next: 'finish',
      message: makeProviderApiErrorAssistant(runtimeConfig, model, error, attempt - 1) as Message,
    }
  }
  const issueKind = failure.kind === 'other' ? undefined : failure.issue.kind
  emitTrace(call, {
    event: 'providerRetry',
    timestamp: createTimestamp(runtimeConfig),
    sessionId: params.callContext.options.sessionId,
    turnCaller: params.querySource,
    providerId: params.providerId,
    model,
    attempt,
    maxRetries,
    delayMs: decision.delayMs,
    issueKind,
    error: sanitizeModelTraceValue(error),
  })
  const notice = makeProviderRetrySystemMessage(runtimeConfig, error, decision.delayMs, attempt, maxRetries)
  traceLine(
    `[llm] retry ${sessionTag} provider=${params.providerId} attempt=${attempt}/${maxRetries} delayMs=${Math.round(decision.delayMs)} attemptMs=${attemptMs} kind=${issueKind ?? 'unknown'}`,
    { level: 'warn' },
  )
  return {
    next: 'retry',
    delayMs: decision.delayMs,
    ...(notice && decision.notify ? { notice: notice as Message } : {}),
  }
}

/**
 * Starts the record of a call to a router provider: the session's context in
 * tokens, counted as its usage meter counts it (absent for a request of no
 * session). Returns who served the session's previous routed reply.
 */
function openRouteCall(payload: object, params: QueryModelCallParams): RoutedVia | undefined {
  const rows = params.messages as unknown as readonly StoredRow[]
  if (params.callContext.options.sessionId) {
    routeCallOf(payload).contextTokens =
      sessionUsageOf({ rows, window: 0, fallbackStartedAt: 0 }).context.tokens ?? 0
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!
    if (row.type !== MSG_TYPE_ASSISTANT || row.isApiErrorMessage || row.apiError) continue
    const via = row.routedVia as RoutedVia | undefined
    return via && typeof via.provider === 'string' && typeof via.model === 'string' ? via : undefined
  }
  return undefined
}

/**
 * One attempt of a routed call: each reply row records who served it, and so
 * does the attempt's first stream event, so a reader knows the member while
 * the reply is still arriving.
 */
async function* routedReplies(call: ModelCall, previous: RoutedVia | undefined): AsyncGenerator<Message, void, unknown> {
  let announced = false
  for await (const message of performRequest(call)) {
    const names = message.type === MSG_TYPE_ASSISTANT || (!announced && message.type === MSG_TYPE_STREAM_EVENT)
    const via = names ? routedViaOf(call.payload, previous) : undefined
    if (via) {
      ;(message as { routedVia?: RoutedVia }).routedVia = { ...via, ...routeMemberFacts(via.provider, via.model) }
      announced = true
    }
    yield message
  }
}

/**
 * The bridge-backed `callModel`. Providers served by in-runtime drivers are
 * layered over the transport here, so retries, idle handling, cancellation
 * and error messages behave the same whichever side speaks the wire format.
 * Attempts run until one succeeds, the ladder gives up, or the call is
 * cancelled during a backoff (which ends the call without a message).
 */
export function bridgeModelTransport(
  bridgeTransport: BrowserBridgeTransport,
  runtimeConfig?: RuntimeConfig,
  traceLogger?: ModelTransportOptions['traceLogger'],
): QueryRuntimeDeps['callModel'] {
  const served = withRequestLog(withModelProviders(bridgeTransport, runtimeConfig), bridgeTransport, runtimeConfig)
  const send = createBridgeSend(served, runtimeConfig)
  return async function* callModel(params) {
    const sessionTag = `sid=${params.callContext.options.sessionId ?? '?'}`
    const callId = logCallStart(params, sessionTag)
    const tools = await serializeToolsForModel(params)
    const built = buildModelRequest(params, tools)
    // `turn.request`: once per call; every attempt sends what it settled on.
    const settled = raisesTurnRequest(params)
      ? await requestThroughTurnRequest(built, params, rebuilt => buildModelRequest(rebuilt, tools))
      : built
    // A provider whose module watches its requests is told when this call is over.
    const observed = observeProviderCall(params.providerId, settled.facts.effectiveModel)
    const request = observed ? { ...settled, payload: observed.mark(settled.payload) } : settled
    const call = createModelCall({ send, params, runtimeConfig, traceLogger, sessionTag, callId }, request)
    const signal = params.callContext.cancelSource.signal
    // The selected provider's declared retry policy; a provider without one
    // gets the platform's ladder.
    // A request to a router provider (F-27) follows the router's declared
    // policy, never that of the target that happens to serve it.
    const routed = params.providerId ? providerRouterBoundsFor(params.providerId) : undefined
    const policy = routed
      ? routed.retry
      : params.providerId ? providerRequestSeamFor(params.providerId)?.policy?.retry : undefined
    const previousRoute = routed ? openRouteCall(call.payload, params) : undefined
    const retryOverride = runtimeConfig?.getEnv('e2eProviderMaxRetries')
    const platformMaxRetries = getProviderConnectivityMaxRetries(retryOverride)
    const maxRetries = retriesAllowed(
      platformMaxRetries,
      policy,
      retryOverride?.trim() ? platformMaxRetries : undefined,
    )
    let waitedMs = 0
    // How the call ended; unset when it was cancelled or its reader left.
    let ending: CallEnding | undefined
    let attempts = 0
    try {
      for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
        const startedAt = Date.now()
        attempts = attempt
        try {
          yield* (routed ? routedReplies(call, previousRoute) : performRequest(call))
          ending = { ok: true, attempts }
          return
        } catch (error) {
          const attemptMs = Date.now() - startedAt
          const recovered = raisesTurnRecover(params)
            ? await recoverThroughMods(params, error, {
                attempt,
                maxAttempts: maxRetries + 1,
                attemptDurationMs: attemptMs,
                ...(policy ? { policy, waitedMs } : {}),
              }).catch(() => undefined)
            : undefined
          const after = afterFailedAttempt(call, error, { attempt, maxRetries, attemptMs, waitedMs, ...(policy ? { policy } : {}) }, recovered)
          if (after.next === 'rethrow') throw error
          if (after.next === 'finish') {
            ending = { ok: false, error, attempts }
            yield after.message
            return
          }
          if (after.notice) yield after.notice
          waitedMs += after.delayMs
          await waitRetry(after.delayMs, signal)
          if (signal.aborted) return
        }
      }
    } finally {
      observed?.settle(ending ?? { ok: false, aborted: true, attempts })
    }
  }
}
