// Type-only: the classifier composes no user-visible TEXT, only catalog
// KEYS — the values live in i18n/messages/*.ts and are resolved by `t()` at
// render time (running-indicator). A type import is erased at compile time,
// so this pulls no webview module into the worker bundle and cannot arm an
// import cycle.
import type { MessageKey } from '../browser/webview/i18n/messages/en'

export type ProviderApiErrorKind =
  | 'authentication_failed'
  | 'rate_limit'
  | 'invalid_request'
  // HTTP 402 — the provider account or API key is out of credit
  // (RuntimeTypes already lists the slug).
  | 'billing_error'
  | 'server_error'
  | 'repetitive_tool_calls'
  // A safety stop (`stop_reason: 'content_filter'`), not a transport failure:
  // minted by engine/turn/modelErrorMessages.ts `withRefusalApiError`, never by the
  // classifier below — a refused turn is an HTTP 200 and never enters the
  // retry ladder.
  | 'refusal'
  | 'unknown'

export type ProviderConnectivityIssueKind =
  | 'credentials'
  | 'configuration'
  | 'network'
  | 'rate_limit'
  | 'service'
  | 'provider_policy'
  | 'billing'

export type ProviderConnectivityIssue = {
  kind: ProviderConnectivityIssueKind
  error: ProviderApiErrorKind
  /**
   * Catalog key of the verdict's one-line classification (e.g. resolves to
   * "Provider service unavailable" in `en`). KEYS, not text: the classifier
   * runs in the SharedWorker, which has no locale, and the verdict outlives
   * the classification (the retry system message is persisted into the
   * transcript chain) — a key re-resolves in whatever locale the webview has
   * at render time, where a string would freeze the locale of the moment.
   */
  titleKey: MessageKey
  /**
   * Catalog key of the verdict's full-sentence explanation. No UI surface
   * renders it yet (the error card composes its own copy from `error` +
   * `detail`); it is kept translated so a future card/tooltip can adopt it
   * without another migration.
   */
  summaryKey: MessageKey
  retryable: boolean
  settingsRecommended: boolean
  detail: string
  status?: number
  /**
   * Server `Retry-After` directive in ms, typed-field first (see
   * `ProviderErrorFields`), else parsed from the canonical error-string
   * suffix. The retry loop passes it to
   * `getProviderConnectivityRetryDelayMs` so the server's directive beats
   * the exponential backoff.
   */
  retryAfterMs?: number
}

/**
 * Typed error metadata (`httpStatus` / `retryAfterSeconds`) riding alongside the
 * error string. The classifier reads these first; the string regexes are the
 * fallback for old hosts and non-canonical messages.
 */
export type ProviderErrorFields = {
  /** HTTP status of the provider response (100-599). */
  httpStatus?: number
  /** Server `Retry-After` directive, in milliseconds. */
  retryAfterMs?: number
}

/**
 * Error carrier for typed provider failures. Field detection is duck-typed
 * (`getProviderErrorFields`), not `instanceof` — errors can cross worker /
 * realm boundaries where the class identity is lost but the fields survive.
 */
export class ProviderApiError extends Error {
  readonly httpStatus?: number
  readonly retryAfterMs?: number
  constructor(message: string, fields: ProviderErrorFields = {}) {
    super(message)
    this.name = 'ProviderApiError'
    if (fields.httpStatus !== undefined) this.httpStatus = fields.httpStatus
    if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs
  }
}

export function getProviderErrorFields(value: unknown): ProviderErrorFields {
  if (typeof value !== 'object' || value === null) return {}
  const v = value as { httpStatus?: unknown; retryAfterMs?: unknown }
  const out: ProviderErrorFields = {}
  if (
    typeof v.httpStatus === 'number' &&
    Number.isInteger(v.httpStatus) &&
    v.httpStatus >= 100 &&
    v.httpStatus <= 599
  ) {
    out.httpStatus = v.httpStatus
  }
  if (
    typeof v.retryAfterMs === 'number' &&
    Number.isFinite(v.retryAfterMs) &&
    v.retryAfterMs >= 0
  ) {
    out.retryAfterMs = v.retryAfterMs
  }
  return out
}

/**
 * An abort-shaped error (DOM `AbortError` or `APIUserAbortError`): a
 * cancellation artifact, never a provider verdict, so retry loops rethrow it.
 * Name-based: class identity does not survive realm boundaries.
 */
export function isAbortLikeError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const name = (value as { name?: unknown }).name
  return name === 'AbortError' || name === 'APIUserAbortError'
}

export const PROVIDER_FAILURE_LEAD = 'API Error'
export const PROVIDER_CONNECTIVITY_MAX_RETRIES = 10
export const PROVIDER_CONNECTIVITY_MAX_ATTEMPTS =
  PROVIDER_CONNECTIVITY_MAX_RETRIES + 1
export const PROVIDER_CONNECTIVITY_BASE_RETRY_DELAY_MS = 500
export const PROVIDER_CONNECTIVITY_MAX_RETRY_DELAY_MS = 32_000
// Ceiling on an honored `Retry-After`. Past it a rate limit is not retryable:
// quota gateways send the window reset (hours or days), so the error is surfaced.
export const PROVIDER_RETRY_AFTER_HONOR_CAP_MS = 300_000

/**
 * Wordings that say the account is OUT of quota (terminal), as opposed to
 * throttling (retryable); both arrive as 429. Deliberately narrow: excludes
 * `resource_exhausted` (also a per-minute limit) and bare `limit exceeded`.
 */
const QUOTA_EXHAUSTED_PATTERNS: readonly RegExp[] = [
  // "The usage limit has been reached" / "you have reached your usage limit"
  /\busage limits?\b[\s\S]{0,40}?\b(reached|exceeded|exhausted|used up)\b/,
  /\b(reached|exceeded|exhausted|used up)\b[\s\S]{0,40}?\busage limits?\b/,
  // "quota has been exhausted", "credits exhausted", "balance depleted"
  /\b(quota|credits?|balance)\b[\s\S]{0,40}?\b(exhausted|depleted|used up)\b/,
  /\b(exhausted|depleted|used up)\b[\s\S]{0,40}?\b(quota|credits?|balance)\b/,
  // OpenAI's terminal billing code and its prose form.
  /\binsufficient[_ ]quota\b/,
  /\bexceeded your (current |monthly )?quota\b/,
  // "out of credits", "no credits remaining", "credit balance is too low"
  /\b(out of|no remaining|no more)\b[\s\S]{0,20}?\b(credits?|quota)\b/,
  /\bcredit balance\b[\s\S]{0,40}?\b(too low|insufficient|depleted)\b/,
]

function isQuotaExhaustedText(text: string): boolean {
  return QUOTA_EXHAUSTED_PATTERNS.some(pattern => pattern.test(text))
}

export function getProviderConnectivityMaxRetries(value?: string | null): number {
  if (value === undefined || value === null || value.trim() === '') {
    return PROVIDER_CONNECTIVITY_MAX_RETRIES
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : PROVIDER_CONNECTIVITY_MAX_RETRIES
}

function getErrorText(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value ?? '')
}

function cleanupDetail(text: string): string {
  return text
    .replace(/^\s*(LLM_ERROR|provider_error|api_error|STREAM_ERROR):\s*/i, '')
    .replace(/^\s*Provider connection failed after \d+ attempts? \([^)]*\)\. Last error:\s*/i, '')
    // Strip the internal machine token the idle-timeout throws (engine/turn/turnDependencies.ts)
    // prefix their message with. `stream_idle_timeout` names a code path, not
    // anything the user can act on. `classifyProviderConnectivityIssue` matches
    // on this *stripped* text, so the strip has to be verdict-neutral, and it
    // is: the token never carried the classification — the surviving
    // `(stream cancelled upstream)` clause is what matches `\bupstream\b` and
    // yields the retryable/service verdict. Stripping it therefore only cleans
    // up what the retry status line and the API-error card display.
    .replace(/^\s*stream_idle_timeout:\s*/i, '')
    .trim()
}

/**
 * The HTTP status from a provider error string: only a marker-prefixed status
 * (`HTTP 429`, `status: 500`, `Error code: 429`) or a leading one, in 1xx-5xx.
 */
function extractStatus(text: string): number | undefined {
  const marked = text.match(
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s*code)?|error\s*code)\b[\s:/-]*(\d{3})\b/i,
  )
  const leading = text.match(/^\s*(\d{3})\b/)
  const raw = marked?.[1] ?? leading?.[1]
  if (!raw) return undefined
  const status = Number.parseInt(raw, 10)
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    return undefined
  }
  return status
}

export function classifyProviderConnectivityIssue(
  value: unknown,
): ProviderConnectivityIssue | null {
  const raw = getErrorText(value)
  const detail = cleanupDetail(raw)
  const text = detail.toLowerCase()
  if (!text) return null
  // Typed fields first (ProviderApiError / duck-typed carriers) — the string
  // regexes below are the compatibility fallback, not the primary channel.
  const typed = getProviderErrorFields(value)
  const status = typed.httpStatus ?? extractStatus(detail)
  const retryAfterMs = typed.retryAfterMs ?? parseRetryAfterMs(detail) ?? undefined

  // Provider-side loop guards (observed on Qwen/DashScope: "Repetitive tool
  // calls detected in the conversation history…") reject the request based on
  // the *conversation history*, not on transport health: the guard compares
  // tool name + arguments across consecutive rounds and never sees that the
  // results differed. Retrying resends the same history unchanged, so it can
  // only fail identically — classify it first, and non-retryable, so the error
  // card can say what actually unblocks it (compact, or vary the repeated
  // call) instead of falling through to `unknown`.
  if (
    /\brepetitive tool call/.test(text) ||
    /\bavoid infinite loops?\b/.test(text) ||
    (/\btool call\b/.test(text) && /\b(identical|same)\b/.test(text) &&
      /\brepeat(ed|ing|s)?\b/.test(text))
  ) {
    return {
      kind: 'provider_policy',
      error: 'repetitive_tool_calls',
      titleKey: 'providerIssue.repetitiveToolCalls.title',
      summaryKey: 'providerIssue.repetitiveToolCalls.summary',
      retryable: false,
      settingsRecommended: false,
      detail,
      status,
    }
  }

  // 402 Payment Required: terminal despite any retry directive; matched first so
  // no later branch's wording can claim it.
  if (status === 402 || /\bpayment[_ ]required\b/.test(text)) {
    return {
      kind: 'billing',
      error: 'billing_error',
      titleKey: 'providerIssue.billing.title',
      summaryKey: 'providerIssue.billing.summary',
      retryable: false,
      settingsRecommended: false,
      detail,
      status,
      retryAfterMs,
    }
  }

  // Explicit service-capacity codes (retryable), matched before the rate-limit
  // branch would claim them. Only when no definitive 4xx status says otherwise;
  // in-stream errors carry no status.
  const statusAllowsServiceCode =
    status === undefined || status === 200 || status >= 500
  // A service code never makes an exhausted quota retryable: fall through to the
  // quota logic below.
  const looksQuotaExhausted =
    isQuotaExhaustedText(text) ||
    (retryAfterMs !== undefined &&
      retryAfterMs > PROVIDER_RETRY_AFTER_HONOR_CAP_MS)
  // Same reasoning for CREDENTIALS. The status gate above is vacuous for the
  // very shape this branch exists for — an in-stream error carries no status
  // — so a relay that reports an auth failure under a generic `server_error`
  // code (`server_error: Invalid API key`, which the C++ side renders as
  // `<code>: <message>`) would be retried ten times with no "check your
  // settings" hint. When the message names a credential problem, fall through
  // and let the credentials branch own it.
  const looksLikeAuthFailure =
    /\b(bad|invalid|incorrect|expired|revoked|missing) api[_ ]?key\b/.test(text) ||
    /\bapi[_ ]?key\b[\s\S]{0,30}?\b(invalid|incorrect|expired|revoked|missing|not found)\b/.test(text) ||
    /\b(unauthorized|forbidden|authentication failed|invalid_api_key)\b/.test(text)
  if (
    statusAllowsServiceCode &&
    status !== 529 &&
    !looksQuotaExhausted &&
    !looksLikeAuthFailure &&
    (/\bservice_unavailable(_error)?\b/.test(text) ||
      /\bserver_is_overloaded\b/.test(text) ||
      /\b(internal_server_error|internal_error|server_error)\b/.test(text))
  ) {
    return {
      kind: 'service',
      error: 'server_error',
      titleKey: 'providerIssue.serviceUnavailable.title',
      summaryKey: 'providerIssue.serviceUnavailable.summaryCapacity',
      retryable: true,
      settingsRecommended: false,
      detail,
      status,
      retryAfterMs,
    }
  }

  if (
    status === 429 ||
    status === 529 ||
    /\b(too many requests|rate limit|rate-limit|ratelimit|quota|insufficient_quota|resource_exhausted|overage|overloaded)\b/.test(text)
  ) {
    // Quota exhaustion is terminal: a Retry-After beyond the honor cap, or a
    // message saying the allowance is gone. Surface it immediately.
    const directiveIsQuotaScale =
      retryAfterMs !== undefined &&
      retryAfterMs > PROVIDER_RETRY_AFTER_HONOR_CAP_MS
    if (directiveIsQuotaScale || isQuotaExhaustedText(text)) {
      return {
        kind: 'rate_limit',
        error: 'rate_limit',
        titleKey: 'providerIssue.quotaExhausted.title',
        summaryKey: directiveIsQuotaScale
          ? 'providerIssue.quotaExhausted.summaryDirective'
          : 'providerIssue.quotaExhausted.summaryMessage',
        retryable: false,
        settingsRecommended: false,
        detail,
        status,
        retryAfterMs,
      }
    }
    return {
      kind: 'rate_limit',
      error: 'rate_limit',
      titleKey: 'providerIssue.rateLimit.title',
      summaryKey: 'providerIssue.rateLimit.summary',
      retryable: true,
      settingsRecommended: false,
      detail,
      status,
      retryAfterMs,
    }
  }

  // The host or the request flow found the provider signed out: resending
  // cannot succeed until the person signs in.
  if (/\bsign in (again )?(to this provider )?in settings\b/.test(text)) {
    return {
      kind: 'credentials',
      error: 'authentication_failed',
      titleKey: 'providerIssue.credentials.title',
      summaryKey: 'providerIssue.credentials.summary',
      retryable: false,
      settingsRecommended: true,
      detail,
      status,
      retryAfterMs,
    }
  }

  if (
    status === 401 ||
    status === 403 ||
    /\b(unauthorized|forbidden|bad api key|invalid api key|api key .*invalid|invalid .*api key)\b/.test(text) ||
    /\b(authentication|auth)\b.*\b(failed|invalid|required|expired|revoked)\b/.test(text) ||
    /\b(invalid|expired|revoked)\b.*\b(token|oauth|credential|credentials)\b/.test(text) ||
    /\b(oauth token|access token|credentials?)\b.*\b(invalid|expired|revoked|missing)\b/.test(text)
  ) {
    return {
      kind: 'credentials',
      error: 'authentication_failed',
      titleKey: 'providerIssue.credentials.title',
      summaryKey: 'providerIssue.credentials.summary',
      retryable: true,
      settingsRecommended: true,
      detail,
      status,
      retryAfterMs,
    }
  }

  // Host-side concurrency-queue expiry (`call_queued:` / `queue_timeout:`): the
  // request never reached the provider, so always retryable.
  if (
    /\bcall_queued\b/.test(text) ||
    /\bqueue_timeout\b/.test(text) ||
    /\bstill queued\b.*\bconcurrency\b/.test(text) ||
    /\bwaiting for a provider concurrency slot\b/.test(text)
  ) {
    return {
      kind: 'service',
      error: 'server_error',
      titleKey: 'providerIssue.queued.title',
      summaryKey: 'providerIssue.queued.summary',
      retryable: true,
      settingsRecommended: false,
      detail,
      status,
      retryAfterMs,
    }
  }

  if (
    status === 408 ||
    status === 409 ||
    (status !== undefined && status >= 500) ||
    /\b(service unavailable|server error|internal error|bad gateway|gateway timeout|capacity|temporarily unavailable|upstream)\b/.test(text)
  ) {
    return {
      kind: 'service',
      error: 'server_error',
      titleKey: 'providerIssue.serviceUnavailable.title',
      summaryKey: 'providerIssue.serviceUnavailable.summaryUpstream',
      retryable: true,
      settingsRecommended: false,
      detail,
      status,
      retryAfterMs,
    }
  }

  if (
    /\b(network error|stream network error|failed to fetch|timeout|timed out|socket|dns)\b/.test(text) ||
    /\b(net::err|err_|econnreset|epipe|etimedout|enotfound|econnrefused)\b/.test(text) ||
    /\bconnection\b.*\b(reset|refused|closed|failed|lost|aborted)\b/.test(text)
  ) {
    return {
      kind: 'network',
      error: 'unknown',
      titleKey: 'providerIssue.network.title',
      summaryKey: 'providerIssue.network.summary',
      retryable: true,
      settingsRecommended: false,
      detail,
      status,
      retryAfterMs,
    }
  }

  if (
    /\b(provider not configured|not configured|missing api key|no api key)\b/.test(text) ||
    /\b(unsupported model|model .*not supported|unknown model|invalid model)\b/.test(text) ||
    /\b(invalid_request|invalid request|invalid argument|bad request|http 400)\b/.test(text) ||
    (status !== undefined && status >= 400)
  ) {
    return {
      kind: 'configuration',
      error: 'invalid_request',
      titleKey: 'providerIssue.configuration.title',
      summaryKey: 'providerIssue.configuration.summary',
      retryable: false,
      settingsRecommended: true,
      detail,
      status,
      retryAfterMs,
    }
  }

  return null
}

export function shouldRetryProviderConnectivityIssue(
  issue: ProviderConnectivityIssue | null,
): boolean {
  return issue?.retryable === true
}

export function getProviderConnectivityRetryDelayMs(
  failedAttempt: number,
  message?: string,
  /**
   * Typed `Retry-After` (ms) from `ProviderConnectivityIssue.retryAfterMs`.
   * Wins over message parsing — pass it whenever an issue is in hand so the
   * server directive is honoured even when the display string omits it.
   */
  retryAfterMsOverride?: number,
): number {
  // Server directives are honored, but never past the cap — an uncapped
  // directive is how a quota gateway's "retry-after: 352452s" parked a turn
  // in a silent 4-day sleep. Rate-limit verdicts above the cap never reach
  // this function (classified non-retryable), so the clamp is defense in
  // depth for the other retryable kinds (e.g. a 503 carrying a long
  // directive): each attempt waits at most 5 minutes, visibly (the retry
  // notice always shows for delays >= 10s).
  if (retryAfterMsOverride !== undefined) {
    return Math.min(retryAfterMsOverride, PROVIDER_RETRY_AFTER_HONOR_CAP_MS)
  }
  const retryAfterMs = parseRetryAfterMs(message)
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, PROVIDER_RETRY_AFTER_HONOR_CAP_MS)
  }
  const baseDelay = Math.min(
    PROVIDER_CONNECTIVITY_BASE_RETRY_DELAY_MS * 2 ** Math.max(0, failedAttempt - 1),
    PROVIDER_CONNECTIVITY_MAX_RETRY_DELAY_MS,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

export function formatProviderApiErrorMessage(
  error: unknown,
  issue: ProviderConnectivityIssue | null,
): string {
  const detail = issue?.detail || cleanupDetail(getErrorText(error))
  return `${PROVIDER_FAILURE_LEAD}: ${detail || 'Provider request failed'}`
}

export function formatProviderRetryStatusMessage(
  issue: ProviderConnectivityIssue,
  retryInMs: number,
  retryAttempt: number,
  maxRetries = PROVIDER_CONNECTIVITY_MAX_RETRIES,
): string {
  const retryInSeconds = Math.max(0, Math.round(retryInMs / 1000))
  const unit = retryInSeconds === 1 ? 'second' : 'seconds'
  return `${PROVIDER_FAILURE_LEAD}: ${issue.detail}\nRetrying in ${retryInSeconds} ${unit}… (attempt ${retryAttempt}/${maxRetries})`
}

export function buildProviderRetryExhaustedMessage(
  error: unknown,
  attempts: number,
  issue: ProviderConnectivityIssue,
): string {
  return `Provider connection failed after ${attempts} attempts (${issue.kind}). Last error: ${issue.detail || getErrorText(error)}`
}

function parseRetryAfterMs(message?: string): number | null {
  if (!message) return null
  const match = message.match(/retry-after\D+(\d+)/i) ??
    message.match(/retry after\D+(\d+)/i)
  if (!match?.[1]) return null
  const seconds = Number.parseInt(match[1], 10)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return seconds * 1000
}
