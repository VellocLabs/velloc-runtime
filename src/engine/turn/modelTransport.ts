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
import { MSG_TYPE_ASSISTANT } from '../../runtime/VercelModelConstants'
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
import { classifyModelFailure, decideRetry, waitRetry, type RetryDecision } from './retryLadder'
import { raisesTurnRequest, requestThroughTurnRequest } from './requestThroughMods'
import { raisesTurnRecover, recoverThroughMods } from './recoverThroughMods'

/**
 * Whole-response budget for the blocking fallback. A blocking call streams
 * nothing, so an idle clock does not apply; this bounds how long the provider
 * may take to produce the entire answer. The bridge transport's own guard for
 * `model.call` must stay above this value.
 */
const BLOCKING_CALL_TIMEOUT_MS = 300_000

// ── pure: request construction ─────────────────────────────────────────────

/**
 * The per-call context the model may act on. Session id and working
 * directory are deliberately left out: the host could inline them into the
 * prompt, where they add noise or leak.
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
    discoveredSkillNames: [
      ...(params.callContext.skillsFound ?? new Set<string>()),
    ],
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
    result = await call.send(createBridgeRoute('model', 'call'), {
      ...call.payload,
      deadlineMs: Date.now() + BLOCKING_CALL_TIMEOUT_MS,
    } as never)
  } catch (fallbackError) {
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
    if (isPromptTooLongError(streamError)) {
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
  attempt: number,
  maxRetries: number,
  attemptMs: number,
  /** The decision `turn.recover` settled on, when a hook selects it. */
  recovered?: RetryDecision,
): AfterFailure {
  const { params, runtimeConfig, sessionTag } = call
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
  const send = createBridgeSend(withModelProviders(bridgeTransport, runtimeConfig), runtimeConfig)
  return async function* callModel(params) {
    const sessionTag = `sid=${params.callContext.options.sessionId ?? '?'}`
    const callId = logCallStart(params, sessionTag)
    const tools = await serializeToolsForModel(params)
    const built = buildModelRequest(params, tools)
    // `turn.request`: once per call; every attempt sends what it settled on.
    const request = raisesTurnRequest(params)
      ? await requestThroughTurnRequest(built, params, rebuilt => buildModelRequest(rebuilt, tools))
      : built
    const call = createModelCall({ send, params, runtimeConfig, traceLogger, sessionTag, callId }, request)
    const signal = params.callContext.cancelSource.signal
    const maxRetries = getProviderConnectivityMaxRetries(runtimeConfig?.getEnv('e2eProviderMaxRetries'))
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const startedAt = Date.now()
      try {
        yield* performRequest(call)
        return
      } catch (error) {
        const attemptMs = Date.now() - startedAt
        const recovered = raisesTurnRecover(params)
          ? await recoverThroughMods(params, error, { attempt, maxAttempts: maxRetries + 1, attemptDurationMs: attemptMs })
              .catch(() => undefined)
          : undefined
        const after = afterFailedAttempt(call, error, attempt, maxRetries, attemptMs, recovered)
        if (after.next === 'rethrow') throw error
        if (after.next === 'finish') {
          yield after.message
          return
        }
        if (after.notice) yield after.notice
        await waitRetry(after.delayMs, signal)
        if (signal.aborted) return
      }
    }
  }
}
