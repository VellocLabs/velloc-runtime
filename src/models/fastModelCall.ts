import type { TurnOrigin } from '../runtime/interfaces/QueryRuntimeDeps'
import type { Message, InstructionText } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import {
  MSG_TYPE_ASSISTANT,
  PART_TEXT,
  isAssistantMessage,
} from '../runtime/VercelModelConstants'
import {
  getModelForSessionType,
  getSessionModelPolicyFor,
  getSessionTypeTier,
  getTierModelForProvider,
  type TierModelCandidate,
  type TierModelSessionType,
} from '../engine/contextWindow'
import { recordPinCandidateFailure } from './pinFailureLog'
import {
  notifyFastCallFinished,
  notifyFastCallStarted,
} from '../backgroundTasks/sideTaskSink'
import { serializeSystemPromptForDisplay } from '../utils/systemPromptDisplay'

/**
 * Contract: a one-shot, no-tools, no-extended-thinking call to the session type's
 * tier model (`getModelForSessionType`), falling back to `mainLoopModel` with a trace
 * breadcrumb. Not a subagent. The request MUST NOT carry tools: `forceFinalResponse`
 * is set and the context is cloned with `tools: []`.
 */

/**
 * This module holds NO state: the transport is the CALLER's context's scope-bound
 * `options.callModel` (one SharedWorker realm hosts many runtimes).
 */

export type QueryFastModelParams = {
  /** The single user-message body to send. */
  userPrompt: string
  /**
   * Optional system prompt. Defaults to an empty system prompt.
   */
  systemPrompt?: InstructionText
  /** Cooperative cancellation signal. */
  signal: AbortSignal
  /**
   * Parent's `ToolUseContext`. We clone it with `tools: []` before
   * passing to `callModel`, so the parent's tool catalog never leaks
   * into the fast-model call.
   */
  toolUseContext: ToolCallContext
  /** Provider id (`anthropic` / `openai` / `google` / etc). */
  providerId: string
  /**
   * Telemetry tag for this call. Defaults to `fast_model_call`.
   * Specific callers (WebFetch, memory extraction, etc.) should pass
   * a more specific tag so the request shows up correctly in trace
   * logs.
   */
  querySource?: TurnOrigin
  /**
   * Explicit model id — the feature's own assignment (a `prompt` hook's
   * declared `model:`).
   * It takes precedence over the per-provider `fastModel` unless the user
   * routed this session type explicitly (Settings → Session models:
   * `tier` / `specific` / `same-as-parent`), which wins over it.
   * Leave unset for the default fast-model behavior.
   */
  model?: string
}

/**
 * Maps a caller's `querySource` telemetry tag onto the tier helpers'
 * session-type enum, so the shared `getFastModel` knows which child session
 * is asking (reserved for per-consumer routing; no behavior difference
 * today).
 */
function tierSessionTypeForQuerySource(
  querySource: TurnOrigin | undefined,
): TierModelSessionType {
  switch (querySource) {
    case 'rename_generate_name':
      return 'session_title'
    case 'memory_recall':
      return 'memory_recall'
    case 'web_fetch_apply':
      return 'web_fetch'
    case 'fast_model_call':
      // The default tag; today its only distinct caller is the prompt-hook
      // runner, so label it as such.
      return 'prompt_hook'
    default:
      return 'other'
  }
}

/**
 * One-shot fast-model query: the assistant's plain text. Throws when the caller's
 * `options.callModel` is unset, on abort, or on an empty response.
 */
export async function queryFastModel(
  params: QueryFastModelParams,
): Promise<string> {
  // Scope-bound by construction: the transport rides the CALLER'S context
  // (published at engine construction from the owning scope's
  // `deps.callModel`), never a realm-shared slot — see the module docstring.
  const callModel = params.toolUseContext.options.callModel
  if (!callModel) {
    throw new Error(
      'queryFastModel: toolUseContext.options.callModel is not set. The ' +
        'owning engine must publish its scope deps.callModel on the ' +
        'tool-use context before any fast-model call.',
    )
  }

  // Resolution is the shared per-session-type policy. An explicit `params.model` wins
  // under a `default`/absent policy as a single candidate (no parent retry) and
  // yields to an explicit user route. Candidates: `[resolved, parent]`.
  const sessionType = tierSessionTypeForQuerySource(params.querySource)
  const policy = getSessionModelPolicyFor(sessionType)
  const ownModel =
    params.model && (!policy || policy.mode === 'default')
      ? params.model
      : undefined
  const candidates: TierModelCandidate[] = ownModel
    ? [{ providerId: params.providerId, modelId: ownModel }]
    : getModelForSessionType(
        sessionType,
        params.providerId,
        params.toolUseContext.options.mainLoopModel,
      )
  const head = candidates[0]
  const sessionTier = getSessionTypeTier(sessionType)
  if (
    !ownModel
    && !policy
    && sessionTier !== 'inherit'
    && candidates.length === 1
    && !getTierModelForProvider(params.providerId, sessionTier)
  ) {
    // One-line breadcrumb so the trace log surfaces missing config —
    // suppressed whenever the USER configured this resolution (router
    // policy or a tier pin): a deliberate choice isn't missing config.
    // We deliberately don't escalate this to a warning — falling back
    // to mainLoopModel is safe (just more expensive), not broken.
    // eslint-disable-next-line no-console
    console.info(
      '[queryFastModel] provider %s has no `%sModel` configured; ' +
        'falling back to mainLoopModel %s',
      params.providerId,
      sessionTier,
      head.modelId,
    )
  }

  // Clone toolUseContext with tools: [] — defense-in-depth. The
  // `forceFinalResponse: true` flag below also tells the bridge to
  // drop tools[] from the outbound request; the empty `tools` here
  // is the belt to that suspenders, in case a future bridge path
  // doesn't honour the flag for some provider.
  const oneShotContext: ToolCallContext = {
    ...params.toolUseContext,
    options: {
      ...params.toolUseContext.options,
      tools: [],
    },
  }

  const messages: Message[] = [
    createGeneratedUserMessage(params.userPrompt, { isMeta: false }),
  ]

  // Announce the one-shot to the side-task sink (Background Tasks
  // drawer). Fast calls have no native id of their own (no session, no
  // shell, no sidechain), so mint a correlation key here.
  const callId = `fast-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
  notifyFastCallStarted({
    callId,
    spawnerSessionId: params.toolUseContext.options.sessionId,
    querySource: params.querySource ?? 'fast_model_call',
    providerId: head.providerId,
    model: head.modelId,
    prompt: params.userPrompt,
    // Surface the fixed system prompt in the drawer detail (e.g. the
    // session-title namer directive). Serialized here because the sink is a
    // plain-data channel; `InstructionText` may be a holder-part array.
    systemPrompt: serializeSystemPromptForDisplay(params.systemPrompt),
    startedAt: Date.now(),
  })

  // One attempt against one candidate. The candidate's OWN providerId rides
  // the wire (not the parent's) — a cross-provider pin (`fast` = a DeepSeek
  // model under an Anthropic session) resolves on the host only when the
  // request names the pin's provider.
  const runAttempt = async (candidate: TierModelCandidate): Promise<string> => {
    let assistantText = ''
    let apiErrorDetail: string | undefined
    for await (const message of callModel({
      messages,
      baseInstructions: params.systemPrompt ?? '',
      userContext: {},
      systemAmbient: {},
      callContext: oneShotContext,
      providerId: candidate.providerId,
      querySource: params.querySource ?? 'fast_model_call',
      modelOverride: candidate.modelId,
      ...(candidate.thinkingTier
        ? { thinkingTier: candidate.thinkingTier }
        : {}),
      // Bridge contract: drop tools[] from the outbound request. Set
      // for every queryFastModel call regardless of provider.
      forceFinalResponse: true,
      // Side calls don't pollute the parent session's prompt cache.
      noCacheWrite: true,
    })) {
      if (isAssistantMessage(message)) {
        // A synthetic error assistant is a FAILURE report, not the model's
        // answer: `isApiErrorMessage` marks the retry-exhausted "API Error:
        // …" card and `apiError: 'prompt_too_long'` the context-window
        // explainer. Adopting their text is how "API Error: Runtime scope
        // was disposed" became persisted session titles. (`apiError:
        // 'max_output_tokens'` stays adoptable — that is a REAL, merely
        // truncated, response.)
        const marker = message as {
          isApiErrorMessage?: unknown
          apiError?: unknown
          errorDetails?: unknown
        }
        if (
          marker.isApiErrorMessage === true
          || marker.apiError === 'prompt_too_long'
        ) {
          apiErrorDetail =
            (typeof marker.errorDetails === 'string' && marker.errorDetails)
            || extractAssistantText(message)
            || apiErrorDetail
          continue
        }
        const text = extractAssistantText(message)
        if (text) assistantText = text
      }
    }

    if (params.signal.aborted) {
      throw new APIUserAbortError()
    }
    if (!assistantText) {
      throw new Error(
        apiErrorDetail
          ? `queryFastModel: provider call failed: ${apiErrorDetail}`
          : 'queryFastModel: no assistant text in response (provider returned empty content)',
      )
    }
    return assistantText
  }

  // The candidate that ACTUALLY produced the result (or the final error) —
  // `head` unless the retry below fell back to the parent tail. Rides the
  // finish notification so the drawer stops attributing the outcome to the
  // failed head model that `notifyFastCallStarted` recorded.
  let resultCandidate = head
  try {
    let assistantText: string
    try {
      assistantText = await runAttempt(head)
    } catch (error) {
      // Retry-once-with-parent: the ordered candidate list's tail is the
      // parent model — a failed user pin / tier model degrades to the model
      // the user is looking at (never a third model, never a dead feature).
      // A user Stop is not a model failure — let it surface.
      const fallback = candidates[1]
      if (!fallback || params.signal.aborted) throw error
      // Pin health: mark every user pin naming the failed pair so the
      // Settings page can surface a rotting pin (the fallback below keeps
      // this feature alive, silently). Ladder/census models match nothing.
      recordPinCandidateFailure(
        head,
        error instanceof Error ? error.message : String(error),
      )
      // eslint-disable-next-line no-console
      console.info(
        '[queryFastModel] %s/%s failed (%s); retrying once on the parent model %s/%s',
        head.providerId,
        head.modelId,
        error instanceof Error ? error.message : String(error),
        fallback.providerId,
        fallback.modelId,
      )
      resultCandidate = fallback
      assistantText = await runAttempt(fallback)
    }
    notifyFastCallFinished({
      callId,
      status: 'success',
      finishedAt: Date.now(),
      // Correct the row's model only when the fallback changed it.
      ...(resultCandidate !== head ? { model: resultCandidate.modelId } : {}),
      responseText:
        assistantText.length > FAST_CALL_RESPONSE_SNIPPET_MAX
          ? `${assistantText.slice(0, FAST_CALL_RESPONSE_SNIPPET_MAX)}…`
          : assistantText,
    })
    return assistantText
  } catch (error) {
    // A user Stop mid-turn aborts the signal and surfaces here as
    // APIUserAbortError — report it 'stopped' (like the fork path), not as
    // a red "Failed" row for a call the user deliberately cancelled.
    notifyFastCallFinished({
      callId,
      status: params.signal.aborted ? 'stopped' : 'error',
      finishedAt: Date.now(),
      // A fallback that also failed → attribute the error to the model that
      // actually ran last, not the head.
      ...(resultCandidate !== head ? { model: resultCandidate.modelId } : {}),
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/** Cap on the response snippet retained for the drawer's detail view. */
const FAST_CALL_RESPONSE_SNIPPET_MAX = 4_000

/**
 * Pull text content out of an assistant message. Walks the content
 * blocks, concatenates every `{type: 'text'}` block's `text` field.
 * Returns `undefined` when no text content is present (tool-use-only
 * messages, error messages, etc.).
 */
export function extractAssistantText(message: Message): string | undefined {
  const content = (message as { message?: { content?: unknown } })?.message
    ?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: string }
      if (b.type === PART_TEXT && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.length > 0 ? parts.join('') : undefined
}

/**
 * The error a cancelled fast-model call throws — Nexus doesn't have a
 * shared error type for abort-on-signal yet (the existing query loop
 * just bails out without throwing a named error). When/if Nexus adds
 * a global one, swap this for the import.
 */
class APIUserAbortError extends Error {
  constructor() {
    super('API request was cancelled')
    this.name = 'APIUserAbortError'
  }
}

// Suppress unused-warning for MSG_TYPE_ASSISTANT — imported for
// future-proofing (text extractor may eventually need the discriminator
// constant rather than relying on isAssistantMessage alone).
void MSG_TYPE_ASSISTANT
