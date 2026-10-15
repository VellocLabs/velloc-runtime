import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import type { ProviderStopDetails } from '../../runtime/RuntimeTypes'

import {
  classifyProviderConnectivityIssue,
  formatProviderApiErrorMessage,
  formatProviderRetryStatusMessage,
} from '../../utils/providerConnectivity'

import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_SYSTEM,
  ROLE_ASSISTANT,
  PART_TEXT,
  isToolUsePart,
} from '../../runtime/VercelModelConstants'

import { createTimestamp, createUUID } from './runtimeIds'
// User-facing text for the synthetic assistant message minted when a request
// exceeds the model's context window. Shown in the transcript; the turn loop
// also exits with TERMINAL_PROMPT_TOO_LONG.
const PROMPT_TOO_LONG_MESSAGE_TEXT =
  "This conversation is too long to fit in the model's context window, so the "
  + 'request could not be sent. Start a new session to continue. (Large tool '
  + 'outputs or pasted content are the most common cause.)'

// Mint the `apiError: 'prompt_too_long'` assistant message the turn loop keys
// off (the way `stop_reason: 'max_tokens'` becomes
// `apiError: 'max_output_tokens'`). Content carries a user-facing explanation.
export function makePromptTooLongAssistant(
  runtimeConfig: RuntimeConfig | undefined,
  model: string,
) {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid: createUUID(runtimeConfig),
    timestamp: createTimestamp(runtimeConfig),
    message: {
      role: ROLE_ASSISTANT,
      content: [{ type: PART_TEXT, text: PROMPT_TOO_LONG_MESSAGE_TEXT }],
      model,
    },
    apiError: 'prompt_too_long' as const,
  }
}

// `retryCount` is how many retries actually ran before this failure was
// surfaced (0 for non-retryable classifications, which never re-POST). The UI
// error card renders its "Velloc retried…" line from it — without it the card
// claimed a retry even for outright rejections that were never resent.
export function makeProviderApiErrorAssistant(
  runtimeConfig: RuntimeConfig | undefined,
  model: string,
  error: unknown,
  retryCount: number,
) {
  const issue = classifyProviderConnectivityIssue(error)
  const text = formatProviderApiErrorMessage(error, issue)
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid: createUUID(runtimeConfig),
    timestamp: createTimestamp(runtimeConfig),
    message: {
      role: ROLE_ASSISTANT,
      content: [{ type: PART_TEXT, text }],
      model,
    },
    isApiErrorMessage: true,
    error: issue?.error ?? 'unknown',
    errorDetails: issue?.detail ?? (error instanceof Error ? error.message : String(error ?? '')),
    errorRetryCount: retryCount,
  }
}

/**
 * Every provider's safety stop arrives as this `stop_reason`: the drivers map
 * Anthropic `refusal` and Gemini's policy finish reasons / blocked prompts to
 * it. Both may attach `stop_details`; the reply is often an EMPTY content
 * array.
 */
export const STOP_REASON_CONTENT_FILTER = 'content_filter'

export function isContentFilterStop(stopReason: unknown): boolean {
  return stopReason === STOP_REASON_CONTENT_FILTER
}

function readStopDetails(value: unknown): ProviderStopDetails | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const out: ProviderStopDetails = {}
  for (const key of ['type', 'category', 'explanation', 'recommended_model'] as const) {
    const v = raw[key]
    if (typeof v === 'string' && v.length > 0) out[key] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Turn a content-filter stop into an API-error assistant turn classified `error: 'refusal'`, carrying
 * `stop_details`; no fallback model is requested. `errorRetryCount: 0` (never resent). Only an empty
 * turn gets the explanation as content; a turn with content goes through `splitRefusalTurn`.
 */
export function withRefusalApiError<
  T extends { message: Record<string, unknown> },
>(assistant: T): T & {
  message: T['message'] & {
    content: Array<Record<string, unknown>>
    stop_details?: ProviderStopDetails
  }
  isApiErrorMessage: true
  error: 'refusal'
  errorDetails: string
  errorRetryCount: 0
} {
  const stopDetails = readStopDetails(assistant.message.stop_details)
  const category = stopDetails?.category
  const explanation = stopDetails?.explanation
  const categoryLine = category ? ` (category: ${category})` : ''
  const text =
    `API Error: The provider declined this request on safety grounds${categoryLine}. `
    + 'Rephrase the request, or choose a different model and try again.'
  const errorDetails = [
    category ? `category: ${category}` : '',
    explanation ?? '',
  ].filter(Boolean).join('\n')
  const existing = Array.isArray(assistant.message.content)
    ? (assistant.message.content as Array<Record<string, unknown>>).filter(
        part => !(part.type === PART_TEXT && part.text === ''),
      )
    : []
  return {
    ...assistant,
    message: {
      ...assistant.message,
      content: existing.length > 0 ? existing : [{ type: PART_TEXT, text }],
      // Re-stamp the sanitized form (drops non-string / empty fields); absent
      // when the provider sent nothing usable.
      ...(stopDetails ? { stop_details: stopDetails } : {}),
    },
    isApiErrorMessage: true as const,
    error: 'refusal' as const,
    errorDetails,
    errorRetryCount: 0 as const,
  }
}

/**
 * A content-filter stop yields the streamed output as an ordinary assistant message (if any), then a
 * separate API-error message. Tool calls and empty text parts are dropped from the kept part.
 */
export function splitRefusalTurn<
  T extends { uuid: string; message: Record<string, unknown> },
>(assistant: T, errorUuid: string) {
  const kept = Array.isArray(assistant.message.content)
    ? (assistant.message.content as Array<Record<string, unknown>>).filter(
        part =>
          !(typeof part.type === 'string' && isToolUsePart({ type: part.type }))
          && !(part.type === PART_TEXT && part.text === ''),
      )
    : []
  const error = withRefusalApiError({
    ...assistant,
    uuid: errorUuid,
    message: { ...assistant.message, content: [] },
  })
  if (kept.length === 0) return [error]
  return [{ ...assistant, message: { ...assistant.message, content: kept } }, error]
}

export function makeProviderRetrySystemMessage(
  runtimeConfig: RuntimeConfig | undefined,
  error: unknown,
  backoffMs: number,
  attemptNumber: number,
  maxRetries: number,
) {
  const issue = classifyProviderConnectivityIssue(error)
  if (!issue) return null
  return {
    type: MSG_TYPE_SYSTEM,
    subtype: 'api_error',
    level: 'error',
    message: formatProviderRetryStatusMessage(
      issue,
      backoffMs,
      attemptNumber,
      maxRetries,
    ),
    retryInMs: backoffMs,
    retryAttempt: attemptNumber,
    maxRetries,
    error: issue.error,
    errorStatus: issue.status ?? null,
    // Classification KEY + the provider's own text. The running indicator
    // resolves the key with `t()` in the webview's locale and shows it
    // instead of the bare `error` slug ('server_error'), which told the user
    // nothing about what actually failed. The key (not resolved text) is
    // what rides the wire and the persisted transcript: this function runs
    // in the SharedWorker, which has no locale, and a persisted key
    // re-resolves in whatever locale the webview has at render time.
    errorTitleKey: issue.titleKey,
    errorDetail: issue.detail,
    uuid: createUUID(runtimeConfig),
    timestamp: createTimestamp(runtimeConfig),
  }
}

/**
 * Thrown when a started stream ends with NO content blocks and no `stop_reason` (a cut-off, not an empty
 * turn). The only post-start failure allowed to fall back to the blocking call.
 */
export class EmptyModelStreamError extends Error {
  readonly isEmptyModelStream = true as const
  constructor(message: string) {
    super(message)
    this.name = 'EmptyModelStreamError'
  }
}

export function isEmptyModelStreamError(value: unknown): value is EmptyModelStreamError {
  return (
    value instanceof EmptyModelStreamError
    || (typeof value === 'object'
      && value !== null
      && (value as { isEmptyModelStream?: unknown }).isEmptyModelStream === true)
  )
}
