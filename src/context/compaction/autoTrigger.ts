import type { Message, UserRow } from '../../runtime/RuntimeTypes.js'
import type {
  AutoCompactResult,
  AutoCompactLedger,
  QueryCompactionContext,
  TurnOrigin,
} from '../../runtime/interfaces/QueryRuntimeDeps.js'
import type {
  BrowserBridgeTransport,
  BridgeModelContentPart,
  BridgeModelInputMessage,
  BridgeModelRequestContext,
} from '../../browser/bridge/browserBridgeProtocol.js'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig.js'
import { createBridgeRoute } from '../../browser/bridge/browserBridgeProtocol.js'
import { withModelProviders } from '../../models/drivers/driverTransport.js'
import {
  buildRequestContext,
  COMPACTION_QUERY_SOURCE,
  type RequestIdentitySource,
} from '../../models/drivers/requestContext.js'
import { prepareHistoryForModel } from '../../messages/prepareModelHistory.js'
import { estimateTranscriptTokens } from '../../engine/tokenCounts.js'
import type { AutoCompactWindowSettings } from './windowSettings.js'
import {
  foldTriggerTokens,
  usableWindowTokens,
} from './triggerThreshold.js'
import {
  contextWindowOf,
  outputBudgetOf,
  getModelForSessionType,
} from '../../engine/contextWindow.js'
import { isPromptTooLongError } from '../../utils/promptTooLong.js'
import { recordPinCandidateFailure } from '../../models/pinFailureLog.js'
import {
  makeContextRow,
  makeFoldLine,
} from '../../messages/messageFactories.js'
import { createInvokedSkillsAttachmentPayload } from '../../skillLibrary/invokedSkillsStore.js'
import { runSessionStartHooks } from '../../lifecycleHooks/sessionLifecycleHooks.js'
import {
  runCompactionDoneHooks,
  runCompactionStartHooks,
} from '../../lifecycleHooks/compactionHooks.js'
import {
  buildSummaryRequestPrompt,
  buildResumeFromSummaryMessage,
  summaryHasContent,
} from './summaryPrompt.js'
import {
  defaultMessageCompactionSettings,
  type MessageCompactionSettings,
} from '../../config/agentLoopConfig.js'
import {
  MSG_TYPE_USER,
  ROLE_USER,
  ROLE_ASSISTANT,
  ROLE_TOOL,
  PART_TEXT,
  PART_IMAGE,
  PART_DOCUMENT,
  PART_TOOL_RESULT_CANONICAL,
  STREAM_CONTENT_BLOCK_DELTA,
  STREAM_ERROR,
  DELTA_TEXT,
  isUserMessage,
} from '../../runtime/VercelModelConstants.js'

// ---------------------------------------------------------------------------
// LLM-driven history compaction.
//
// Fires on token pressure: when the estimated live context reaches the
// model's effective window minus a buffer (see `foldTriggerTokens` in
// triggerThreshold.ts).
// ---------------------------------------------------------------------------

// Stop retrying autocompact after this many consecutive failures, so a
// persistently-failing summarizer can't burn an LLM call every turn. This
// replaces the throttle the old step-cadence gate used to provide.
const SUMMARIZER_STRIKE_LIMIT = 3

// Cap the compaction summary's own output, bounded further by the model's max.
// The cap keeps the summarizer from emitting a wall of tokens that itself re-bloats the post-compact context.
const SUMMARY_REPLY_CAP = 20_000

// Prompt-too-long retries for the summarizer call. The summary sees the whole
// pre-compact history, which can itself overflow — exactly the case that
// triggered compaction. Each retry drops the oldest part of the history.
const MAX_COMPACT_PTL_RETRIES = 3

// Replace image/screenshot blocks with `[image]` text before the summarizer
// sees the history. The summary is text-only (the compact prompt forbids tool calls), so forwarding
// base64 to a vision model just wastes tokens. Handles standalone image blocks
// and images nested in a tool-result block's content array (browser
// screenshots, see toolExecution.buildToolResultContent). Non-user messages
// and string/text-only content pass through untouched.
function dropPicturesForSummary(messages: Message[]): Message[] {
  return messages.map(message => {
    if (!isUserMessage(message)) return message
    const inner = (message as UserRow).message
    const content = inner?.content
    if (!Array.isArray(content)) return message

    let changed = false
    const newContent = content.flatMap(block => {
      if (!block || typeof block !== 'object') return [block]
      const blockType = (block as { type?: unknown }).type

      if (blockType === PART_IMAGE || blockType === PART_DOCUMENT) {
        changed = true
        return [{ type: PART_TEXT, text: blockType === PART_IMAGE ? '[image]' : '[document]' }]
      }

      if (blockType === PART_TOOL_RESULT_CANONICAL) {
        const trContent = (block as { content?: unknown }).content
        if (Array.isArray(trContent)) {
          let trChanged = false
          const newTr = trContent.map(item => {
            if (
              item &&
              typeof item === 'object' &&
              ((item as { type?: unknown }).type === PART_IMAGE ||
                (item as { type?: unknown }).type === PART_DOCUMENT)
            ) {
              trChanged = true
              return {
                type: PART_TEXT,
                text:
                  (item as { type?: unknown }).type === PART_IMAGE
                    ? '[image]'
                    : '[document]',
              }
            }
            return item
          })
          if (trChanged) {
            changed = true
            return [{ ...(block as object), content: newTr }]
          }
        }
      }

      return [block]
    })

    if (!changed) return message
    return {
      ...message,
      message: { ...inner, content: newContent },
    } as Message
  })
}

function isCanonicalToolResultPart(
  part: BridgeModelContentPart,
): boolean {
  return part.type === PART_TOOL_RESULT_CANONICAL
}

function splitToolResultsForBridge(
  messages: BridgeModelInputMessage[],
): BridgeModelInputMessage[] {
  const out: BridgeModelInputMessage[] = []
  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : undefined
    const content = Array.isArray(message.content) ? message.content : null
    if (role !== ROLE_USER || !content) {
      out.push(message)
      continue
    }

    const toolResultParts = content.filter(isCanonicalToolResultPart)
    if (toolResultParts.length === 0) {
      out.push(message)
      continue
    }

    const nonToolResultParts = content.filter(
      part => !isCanonicalToolResultPart(part),
    )
    out.push({
      ...message,
      role: ROLE_TOOL,
      content: toolResultParts,
    })
    if (nonToolResultParts.length > 0) {
      out.push({
        ...message,
        role: ROLE_USER,
        content: nonToolResultParts,
      })
    }
  }
  return out
}

function buildSummarizationBase(slice: Message[]): BridgeModelInputMessage[] {
  return splitToolResultsForBridge(
    prepareHistoryForModel(dropPicturesForSummary(slice)).map(message => {
      const maybeWrapped = message as { message?: BridgeModelInputMessage }
      return maybeWrapped.message ?? (message as BridgeModelInputMessage)
    }),
  ).filter(message => {
    const role = typeof message.role === 'string' ? message.role : undefined
    return role === ROLE_USER || role === ROLE_ASSISTANT || role === ROLE_TOOL
  })
}

// Drop the oldest ~20% of messages so a prompt-too-long summarizer call can
// retry on a smaller history: shed the head, keep the recent tail. Returns
// null when there's nothing left to drop.
function shedOldestForOverflowRetry(messages: Message[]): Message[] | null {
  if (messages.length <= 1) return null
  const drop = Math.max(1, Math.floor(messages.length * 0.2))
  if (drop >= messages.length) return null
  return messages.slice(drop)
}

// The compaction summary uses the STREAMING route (streamStart + streamRead),
// NOT the one-shot `model.call`: some backends reject a non-streaming request
// outright ("Stream must be set to true"). The main loop already streams
// successfully against the same backend, so streaming here keeps stream-only
// backends working. The compact prompt forbids tool calls, so we only need
// to accumulate the `text_delta` chunks into the full summary string.
async function callBridgeModelStreaming(
  bridgeTransport: BrowserBridgeTransport,
  runtimeConfig: RuntimeConfig,
  requestPayload: {
    messages: BridgeModelInputMessage[]
    systemPrompt: string[]
    model: string
    providerId?: string
    maxOutputTokens?: number
    requestContext: BridgeModelRequestContext
  },
): Promise<string> {
  // Through the model-provider wrapper, like the main loop: a provider served
  // in the runtime has no host provider to answer a summarizer request.
  const transport = withModelProviders(bridgeTransport, runtimeConfig)
  const startResponse = await transport.request({
    id: runtimeConfig.createUUID(),
    route: createBridgeRoute('model', 'streamStart'),
    payload: requestPayload,
  })
  if (!startResponse.ok) {
    throw new Error(
      `${startResponse.error.code}: ${startResponse.error.message}`,
    )
  }
  const streamId = (startResponse.result as { streamId: string }).streamId

  let aggregated = ''
  let done = false
  while (!done) {
    const readResponse = await transport.request({
      id: runtimeConfig.createUUID(),
      route: createBridgeRoute('model', 'streamRead'),
      payload: { streamId },
    })
    if (!readResponse.ok) {
      throw new Error(
        `${readResponse.error.code}: ${readResponse.error.message}`,
      )
    }
    const result = readResponse.result as {
      chunks?: Array<Record<string, unknown>>
      done?: boolean
    }
    for (const chunk of result.chunks ?? []) {
      if (chunk.type === STREAM_ERROR) {
        const err = chunk.error as { message?: string } | undefined
        throw new Error(err?.message ?? 'Unknown model streaming error')
      }
      if (chunk.type === STREAM_CONTENT_BLOCK_DELTA) {
        const delta = chunk.delta as
          | { type?: string; text?: string }
          | undefined
        if (delta?.type === DELTA_TEXT && typeof delta.text === 'string') {
          aggregated += delta.text
        }
      }
    }
    done = result.done === true
  }
  return aggregated
}

// A terse system prompt — the heavy lifting lives in the user-message
// template in `prompt.ts`.
const COMPACTION_SYSTEM_PROMPT =
  'You are a helpful AI assistant tasked with summarizing conversations.'

/**
 * Run the compaction model call and mint the boundary + summary messages;
 * shared by auto-compaction and `/compact`. Does not mutate `messages`. Returns
 * `{ boundaryMarker, summaryMessages }`, or `{ error }` carrying the reason.
 */
export async function performCompaction(params: {
  messages: Message[]
  bridgeTransport: BrowserBridgeTransport
  runtimeConfig: RuntimeConfig
  mainLoopModel: string
  // Active provider id for this turn (e.g. 'openai'). MUST be forwarded on the
  // summarizer's bridge request — the host resolves the model with it, and
  // without it `model.streamStart` rejects the call as `model: <id>` (the
  // silent auto-compaction failure that left long sessions never compacting).
  providerId?: string
  trigger: 'manual' | 'auto'
  customInstructions?: string
  /** Who is compacting: the summarizer request's `requestContext` ids. */
  requester?: RequestIdentitySource
}): Promise<
  { boundaryMarker: Message; summaryMessages: Message[] } | { error: string }
> {
  const {
    messages,
    bridgeTransport,
    runtimeConfig,
    mainLoopModel,
    providerId,
    trigger,
    customInstructions,
    requester,
  } = params
  const requestContext = buildRequestContext(requester ?? {}, COMPACTION_QUERY_SOURCE)

  const summaryRequestUserMessage: BridgeModelInputMessage = {
    role: ROLE_USER,
    content: buildSummaryRequestPrompt(customInstructions),
  } as BridgeModelInputMessage

  // The summarizer's model goes through the shared per-session-type policy
  // (`getModelForSessionType`, engine/contextWindow.ts) like every other child
  // session. The census default for 'compact' is 'inherit' (the summarizer
  // runs on the main-loop model), so without user routing this resolves to `[mainLoopModel]`. A user
  // pin/tier yields `[override, parent]` — the head drives the request (with
  // its OWN providerId; a cross-provider pin must name its provider or
  // `model.streamStart` rejects), the tail is the non-PTL failure fallback.
  const compactCandidates = getModelForSessionType(
    'compact',
    providerId ?? '',
    mainLoopModel,
  )
  let candidate = compactCandidates[0]
  let usedModelFallback = false

  // PTL retry (`shedOldestForOverflowRetry`): the summarizer
  // sees the whole pre-compact history, which can itself be prompt-too-long —
  // exactly the case that triggered compaction. On a context-window rejection,
  // shed the oldest messages and retry ON THE SAME MODEL, up to
  // MAX_COMPACT_PTL_RETRIES times. Any OTHER failure on an overridden
  // summarizer retries ONCE on the parent model (the candidate tail) — a
  // failed user pin must not leave long sessions never compacting.
  let rawSummary = ''
  let summarizeFrom = messages
  for (let attempt = 0; ; attempt++) {
    // Cap the summary's own output (SUMMARY_REPLY_CAP),
    // bounded by the ACTIVE candidate's own max — recomputed per attempt so
    // the parent-fallback retry uses the parent's ceiling. For an
    // UNCATALOGUED model fall back to the same 8 192 floor `query/deps` uses
    // for the main loop — NOT 20K, which can exceed a small model's real
    // output limit and gets the summarizer call rejected.
    const maxOutputTokens = Math.min(
      SUMMARY_REPLY_CAP,
      outputBudgetOf(candidate.modelId, candidate.providerId) ??
        8_192,
    )
    const requestPayload = {
      messages: [
        ...buildSummarizationBase(summarizeFrom),
        summaryRequestUserMessage,
      ],
      systemPrompt: [COMPACTION_SYSTEM_PROMPT],
      model: candidate.modelId,
      // Forward the provider so the host can resolve `model` (e.g. gpt-5.5 →
      // openai). Omitting it is what made the summarizer throw `model: <id>`.
      ...(candidate.providerId ? { providerId: candidate.providerId } : {}),
      maxOutputTokens,
      requestContext,
    }
    try {
      rawSummary = await callBridgeModelStreaming(
        bridgeTransport,
        runtimeConfig,
        requestPayload,
      )
      break
    } catch (error) {
      const retrySlice =
        attempt < MAX_COMPACT_PTL_RETRIES && isPromptTooLongError(error)
          ? shedOldestForOverflowRetry(summarizeFrom)
          : null
      if (retrySlice) {
        summarizeFrom = retrySlice
        continue
      }
      if (
        !isPromptTooLongError(error) &&
        !usedModelFallback &&
        compactCandidates.length > 1
      ) {
        usedModelFallback = true
        const fallback = compactCandidates[1]
        // Pin health: mark every user pin naming the failed summarizer pair
        // (the retry below keeps compaction alive, silently).
        recordPinCandidateFailure(
          candidate,
          error instanceof Error ? error.message : String(error),
        )
        // eslint-disable-next-line no-console
        console.info(
          '[Nexus Compact] summarizer %s/%s failed (%s); retrying once on the parent model %s/%s',
          candidate.providerId,
          candidate.modelId,
          error instanceof Error ? error.message : String(error),
          fallback.providerId,
          fallback.modelId,
        )
        candidate = fallback
        continue
      }
      console.error('[Nexus Compact] Summarization failed', error)
      return {
        error:
          error instanceof Error
            ? error.message
            : String(error ?? 'unknown error'),
      }
    }
  }

  // Judged on the digest text: a reply that is only the working-out block,
  // or an empty digest block, carries nothing and must not replace the history.
  if (!rawSummary || !summaryHasContent(rawSummary)) {
    console.error('[Nexus Compact] Empty summary response')
    return { error: 'the model returned an empty summary' }
  }

  // `preTokens` is the pre-compact context size, displayed by the boundary
  // divider as "saved ~N tokens". It comes from `tokenCountWithEstimation`
  // so the number reads as real tokens — the same estimate the
  // token-pressure gate and the token usage indicator use.
  const boundaryMarker: Message = makeFoldLine(
    trigger,
    estimateTranscriptTokens(messages),
    messages.at(-1)?.uuid,
  )

  const summaryMessage: Message = {
    type: MSG_TYPE_USER,
    uuid: runtimeConfig.createUUID(),
    timestamp: runtimeConfig.createTimestamp(),
    // Hidden from the conversation view: the summary is internal context the
    // model reads on the post-compact turn, not user-authored chat. It is
    // marked `isMeta`, which the assistant-ui adapter filters to null while the model-submission path keeps it. The
    // compact_boundary divider still renders, so the user sees that a
    // compaction happened without the wall of summary text.
    isMeta: true,
    message: {
      role: ROLE_USER,
      content: buildResumeFromSummaryMessage(rawSummary, {
        resumeSilently: true,
      }),
    },
  }

  return { boundaryMarker, summaryMessages: [summaryMessage] }
}

export function createBrowserAutoCompact(
  bridgeTransport: BrowserBridgeTransport,
  runtimeConfig: RuntimeConfig,
  settingsOverride?: Partial<MessageCompactionSettings>,
  windowSettings?: AutoCompactWindowSettings,
) {
  const settings: MessageCompactionSettings = {
    ...defaultMessageCompactionSettings(),
    ...settingsOverride,
  }

  return async function autocompact(
    messages: Message[],
    _toolUseContext: QueryCompactionContext['callContext'],
    context: QueryCompactionContext,
    _querySource: TurnOrigin,
    tracking?: AutoCompactLedger,
  ): Promise<AutoCompactResult> {
    if (!settings.enabled) return {}

    // Circuit breaker: after repeated failures, stop retrying so a
    // persistently-failing summarizer doesn't burn an LLM call every turn.
    // `engine/turnLoop.ts` threads `tracking.consecutiveFailures` back across loop
    // iterations and resets it to 0 on success. This replaces the throttle the old step-cadence gate provided.
    if (
      (tracking?.failureStreak ?? 0) >= SUMMARIZER_STRIKE_LIMIT
    ) {
      return {}
    }

    // The user's switch and window (settings.json / `/autocompact`), re-read
    // each attempt so a change from any session applies on the next turn.
    const model = context.callContext.options.mainLoopModel
    const choice = await windowSettings?.resolve(model, context.providerId)
    if (choice && !choice.enabled) return {}

    // Token-pressure gate: fire when the estimated live context reaches the
    // effective window minus the buffer. The window is the user's when set,
    // capped at the model's. The optional `autoCompactTokenThreshold`
    // override lets e2e tests force a compaction deterministically.
    const threshold =
      settings.autoCompactTokenThreshold
      ?? foldTriggerTokens(model, context.providerId, choice?.windowTokens)
    if (estimateTranscriptTokens(messages) < threshold) {
      return {}
    }

    // PreCompact hook fires after both gates pass but before the
    // summarizer model call. A blocking outcome cancels compaction
    // for this turn — useful for policy hooks that want to suppress
    // summarization in certain workspaces or skill scopes. The
    // skipped compaction is signalled to the caller via an empty
    // result; the conversation continues unsummarized.
    const sessionId = context.callContext.options.sessionId
    // `classic.PreCompact` (F-25) beneath the mods'; trigger `auto`, no
    // instructions (8-3-2, shared with `/compact`).
    const preHook = await runCompactionStartHooks(context.callContext, 'auto')
    if (!preHook.proceed) {
      return {}
    }

    // Non-destructive compaction. The pre-compact messages STAY in the transcript; the query loop
    // appends boundary + summary to `messagesForQuery` and the API
    // submission path uses `rowsSinceFoldLine(messages)` to
    // slice the post-boundary tail.
    // `session.compact` (F-25): the slot's mods around the compaction, when
    // the holder is the slot's own runtime (a child loop's view has none).
    const runCompaction = (e: { instructions?: string; messages: Message[] }) =>
      performCompaction({
        messages: e.messages,
        bridgeTransport,
        runtimeConfig,
        mainLoopModel: context.callContext.options.mainLoopModel,
        providerId: context.providerId,
        trigger: 'auto',
        customInstructions: e.instructions,
        requester: {
          sessionId: context.callContext.options.sessionId,
          spawnerSessionId: context.callContext.options.spawnerSessionId,
          agentId: context.callContext.agentId,
        },
      })
    const mods = context.callContext.options.mods
    const compactionResult = mods?.sessionCompact
      ? await mods.sessionCompact(
          { trigger: 'auto', messages },
          {
            run: e => runCompaction(e as { instructions?: string; messages: Message[] }),
            boundary: rows =>
              makeFoldLine(
                'auto',
                estimateTranscriptTokens(rows as Message[]),
                rows.at(-1)?.uuid as string | undefined,
              ),
          },
          context.callContext.cancelSource.signal,
        )
      : await runCompaction({ messages })
    if ('skip' in compactionResult) {
      // A hook left the conversation as it is: not a failure of the
      // summarizer, so the breaker does not count it.
      return {}
    }
    if ('error' in compactionResult) {
      return {
        failureStreak: (tracking?.failureStreak ?? 0) + 1,
      }
    }

    // PostCompact hook fires after the summary lands. The summary is
    // already built — a blocking outcome here can't undo compaction.
    // We attach the hook errors to the summaryMessages stream so the
    // model sees them on its post-compact turn, after the boundary
    // marker. Errors are non-fatal: failing this hook does not
    // invalidate the compaction.
    // `classic.PostCompact` (F-25): the settings hooks beneath the mods',
    // with the summary text as `compact_summary`.
    let extraSummaryMessages: Message[] = await runCompactionDoneHooks(
      context.callContext,
      'auto',
      compactionResult.summaryMessages,
    )

    // `SessionStart` with source `compact` runs after every compaction: the
    // hooks' context follows the summary.
    extraSummaryMessages = [
      ...extraSummaryMessages,
      ...(await runSessionStartHooks('compact', context.callContext)),
    ]

    // Preserve invoked skill bodies across the compact boundary so the
    // model still has the skill guidelines after summarisation — otherwise
    // any skill the model called earlier silently vanishes from context.
    const invokedSkillsAttachments: Message[] = []
    if (sessionId) {
      const payload = createInvokedSkillsAttachmentPayload(
        sessionId,
        context.callContext.agentId ?? null,
      )
      if (payload) {
        invokedSkillsAttachments.push(
          makeContextRow(runtimeConfig, payload),
        )
      }
    }

    return {
      compactionResult: {
        boundaryMarker: compactionResult.boundaryMarker,
        summaryMessages: [
          ...compactionResult.summaryMessages,
          ...invokedSkillsAttachments,
          ...extraSummaryMessages,
        ],
      },
    }
  }
}

// Exported for tests — lets unit tests assert the token-pressure threshold
// math without going through the full bridge call.
export const __testInternals = {
  usableWindowTokens,
  foldTriggerTokens,
  dropPicturesForSummary,
  buildSummarizationBase,
  shedOldestForOverflowRetry,
}
