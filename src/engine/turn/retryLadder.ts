/**
 * Retry ladder for one model call.
 *
 * Two pure decisions — what kind of failure an attempt ended with, and
 * whether (and how long) to wait before the next attempt — plus the one IO
 * step the ladder owns: sleeping out the backoff while staying responsive to
 * Stop.
 */
import { isPromptTooLongError } from '../../utils/promptTooLong'
import {
  classifyProviderConnectivityIssue,
  getProviderConnectivityRetryDelayMs,
  isAbortLikeError,
  shouldRetryProviderConnectivityIssue,
  type ProviderConnectivityIssue,
} from '../../utils/providerConnectivity'

/**
 * Callers whose answer nobody is waiting on (titles, memory upkeep, page
 * summaries). When the provider says "slow down", these give up at once
 * rather than adding load the foreground turn needs. Any caller not listed
 * here gets the full foreground ladder, so a new call site is never quietly
 * demoted.
 */
const BACKGROUND_CALLERS = new Set<string>([
  'periodic_tidy',
  'extract_memories',
  'memory_recall',
  'rename_generate_name',
  'web_fetch_apply',
])

export function isBackgroundCaller(caller: string | undefined): boolean {
  return caller !== undefined && BACKGROUND_CALLERS.has(caller)
}

/** An attempt that has gone on this long is worth telling the user about. */
export const SLOW_ATTEMPT_NOTICE_MS = 10_000

/** From this attempt on, every retry is announced regardless of timing. */
const ALWAYS_NOTIFY_FROM_ATTEMPT = 4

export type ModelFailure =
  /** Cancellation or a disposed runtime scope — not the provider's verdict. */
  | { kind: 'aborted'; error: unknown }
  /** The request exceeded the model's input window. */
  | { kind: 'prompt_too_long'; error: unknown }
  /** The provider asked us to back off; `retryAfterMs` when it said for how long. */
  | {
      kind: 'rate_limit'
      error: unknown
      message: string
      issue: ProviderConnectivityIssue
      retryAfterMs?: number
    }
  /** A recognised connectivity / service / account problem. */
  | {
      kind: 'connectivity'
      error: unknown
      message: string
      issue: ProviderConnectivityIssue
      retryAfterMs?: number
    }
  /** Nothing the classifier recognises. Never retried. */
  | { kind: 'other'; error: unknown; message: string }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Sort a thrown attempt error into the classes the ladder acts on. */
export function classifyModelFailure(error: unknown): ModelFailure {
  if (isAbortLikeError(error)) return { kind: 'aborted', error }
  if (isPromptTooLongError(error)) return { kind: 'prompt_too_long', error }
  const message = errorText(error)
  const issue = classifyProviderConnectivityIssue(error)
  if (!issue) return { kind: 'other', error, message }
  const kind = issue.kind === 'rate_limit' ? 'rate_limit' : 'connectivity'
  return {
    kind,
    error,
    message,
    issue,
    ...(issue.retryAfterMs !== undefined ? { retryAfterMs: issue.retryAfterMs } : {}),
  }
}

export type RetryInput = {
  /** 1-based number of the attempt that just failed. */
  attempt: number
  maxAttempts: number
  failure: ModelFailure
  /** Who asked for the call (the turn caller tag). */
  caller: string | undefined
  /** Wall time the failed attempt took. */
  attemptDurationMs: number
  /** Whether the call has been cancelled meanwhile. */
  cancelled: boolean
}

export type RetryDecision =
  | { retry: false }
  | {
      retry: true
      delayMs: number
      /** Show the retry status line to the user. */
      notify: boolean
    }

/**
 * Whether to try again. A retry happens only for a retryable provider verdict,
 * with attempts left, while the call is still live — and never for a
 * background caller that was rate limited. The delay honours a server
 * directive when there is one and otherwise grows with the attempt number.
 * The user is told once retries stop being invisible: from the fourth attempt,
 * or when the failed attempt or the coming wait is itself long.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  const { failure, attempt } = input
  if (failure.kind !== 'rate_limit' && failure.kind !== 'connectivity') {
    return { retry: false }
  }
  if (!shouldRetryProviderConnectivityIssue(failure.issue)) return { retry: false }
  if (failure.kind === 'rate_limit' && isBackgroundCaller(input.caller)) {
    return { retry: false }
  }
  if (attempt >= input.maxAttempts || input.cancelled) return { retry: false }
  const delayMs = getProviderConnectivityRetryDelayMs(
    attempt,
    failure.message,
    failure.retryAfterMs,
  )
  const notify =
    attempt >= ALWAYS_NOTIFY_FROM_ATTEMPT
    || input.attemptDurationMs >= SLOW_ATTEMPT_NOTICE_MS
    || delayMs >= SLOW_ATTEMPT_NOTICE_MS
  return { retry: true, delayMs, notify }
}

/**
 * Wait out a backoff (or a poll pause), waking early when `signal` fires.
 * Never rejects: a Stop during the wait simply ends it, and the caller checks
 * the signal to end quietly instead of starting another attempt.
 */
export function waitRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve()
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })
}
