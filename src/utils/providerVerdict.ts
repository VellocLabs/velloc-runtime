/**
 * The parts of a provider verdict a provider's manifest can state, and the
 * platform's limits on them.
 *
 * Contract: `overlayDeclaredVerdict` lays a matched manifest rule over the
 * platform classifier's result; `clampVerdict` then bounds what the rule
 * said. Both are pure. The rule itself is matched where the response is read
 * (models/drivers/providerPolicy.ts) and rides the error as typed fields.
 *
 * Security: a declared verdict is plugin input. It can never make a
 * credentials or configuration failure retryable, never park a provider past
 * the per-kind reset ceiling, and its text is the manifest's, bounded in
 * length, never the upstream response's.
 */
import type { MessageKey } from '../browser/webview/i18n/messages/en'
import { isLocalizedText, type LocalizedText } from '../config/localizedText'
import type {
  ProviderApiErrorKind,
  ProviderConnectivityIssue,
  ProviderConnectivityIssueKind,
} from './providerConnectivity'

export const VERDICT_KINDS = [
  'credentials',
  'configuration',
  'network',
  'rate_limit',
  'service',
  'provider_policy',
  'billing',
  'quota',
  'model_unavailable',
] as const satisfies readonly ProviderConnectivityIssueKind[]

export const VERDICT_SCOPES = ['request', 'model', 'key', 'account', 'provider'] as const
/** How much of the provider a failure rules out. */
export type VerdictScope = (typeof VERDICT_SCOPES)[number]

export const VERDICT_ANOMALIES = [
  'empty',
  'truncated',
  'in_body_error',
  'first_byte_timeout',
  'idle_timeout',
  'first_content_timeout',
  'stall_timeout',
] as const
/** A failure that is not an HTTP error status. */
export type VerdictAnomaly = (typeof VERDICT_ANOMALIES)[number]

/** What a matched manifest rule states about a failure. */
export type DeclaredVerdict = {
  kind: ProviderConnectivityIssueKind
  scope?: VerdictScope
  retryable?: boolean
  /** Epoch ms. */
  resetsAt?: number
  code?: string
  message?: LocalizedText
  anomaly?: VerdictAnomaly
}

export const VERDICT_CODE_MAX_LENGTH = 64
export const VERDICT_MESSAGE_MAX_LENGTH = 300
const HOUR_MS = 60 * 60 * 1000
export const VERDICT_RESET_CEILING_MS = HOUR_MS
export const VERDICT_QUOTA_RESET_CEILING_MS = 31 * 24 * HOUR_MS

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)

/**
 * A declared verdict read off an error carrier. Duck-typed, like the other
 * typed error fields: the carrier may have crossed a realm. A malformed part
 * is dropped; without a known `kind` there is no declared verdict.
 */
export function readDeclaredVerdict(value: unknown): DeclaredVerdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (!isOneOf(VERDICT_KINDS, v.kind)) return undefined
  const out: DeclaredVerdict = { kind: v.kind }
  if (isOneOf(VERDICT_SCOPES, v.scope)) out.scope = v.scope
  if (typeof v.retryable === 'boolean') out.retryable = v.retryable
  if (typeof v.resetsAt === 'number' && Number.isFinite(v.resetsAt) && v.resetsAt >= 0) out.resetsAt = v.resetsAt
  if (typeof v.code === 'string' && v.code !== '') out.code = v.code
  if (isLocalizedText(v.message)) out.message = v.message
  if (isOneOf(VERDICT_ANOMALIES, v.anomaly)) out.anomaly = v.anomaly
  return out
}

type KindDefaults = {
  error: ProviderApiErrorKind
  titleKey: MessageKey
  summaryKey: MessageKey
  retryable: boolean
  settingsRecommended: boolean
  scope: VerdictScope
}

const KIND_DEFAULTS: Readonly<Record<ProviderConnectivityIssueKind, KindDefaults>> = {
  credentials: {
    error: 'authentication_failed',
    titleKey: 'providerIssue.credentials.title',
    summaryKey: 'providerIssue.credentials.summary',
    retryable: false,
    settingsRecommended: true,
    scope: 'key',
  },
  configuration: {
    error: 'invalid_request',
    titleKey: 'providerIssue.configuration.title',
    summaryKey: 'providerIssue.configuration.summary',
    retryable: false,
    settingsRecommended: true,
    scope: 'request',
  },
  network: {
    error: 'unknown',
    titleKey: 'providerIssue.network.title',
    summaryKey: 'providerIssue.network.summary',
    retryable: true,
    settingsRecommended: false,
    scope: 'provider',
  },
  rate_limit: {
    error: 'rate_limit',
    titleKey: 'providerIssue.rateLimit.title',
    summaryKey: 'providerIssue.rateLimit.summary',
    retryable: true,
    settingsRecommended: false,
    scope: 'key',
  },
  service: {
    error: 'server_error',
    titleKey: 'providerIssue.serviceUnavailable.title',
    summaryKey: 'providerIssue.serviceUnavailable.summaryUpstream',
    retryable: true,
    settingsRecommended: false,
    scope: 'provider',
  },
  provider_policy: {
    error: 'invalid_request',
    titleKey: 'providerIssue.providerPolicy.title',
    summaryKey: 'providerIssue.providerPolicy.summary',
    retryable: false,
    settingsRecommended: false,
    scope: 'request',
  },
  billing: {
    error: 'billing_error',
    titleKey: 'providerIssue.billing.title',
    summaryKey: 'providerIssue.billing.summary',
    retryable: false,
    settingsRecommended: false,
    scope: 'account',
  },
  quota: {
    error: 'rate_limit',
    titleKey: 'providerIssue.quota.title',
    summaryKey: 'providerIssue.quota.summary',
    retryable: false,
    settingsRecommended: false,
    scope: 'account',
  },
  model_unavailable: {
    error: 'invalid_request',
    titleKey: 'providerIssue.modelUnavailable.title',
    summaryKey: 'providerIssue.modelUnavailable.summary',
    retryable: false,
    settingsRecommended: false,
    scope: 'model',
  },
}

/** The scope the platform assumes for one of its own classifications. */
export function defaultVerdictScope(
  issue: Pick<ProviderConnectivityIssue, 'kind' | 'retryLimit'>,
): VerdictScope {
  // A reply the provider could not parse says nothing about the next request.
  if (issue.kind === 'service' && issue.retryLimit !== undefined) return 'request'
  return KIND_DEFAULTS[issue.kind].scope
}

export type VerdictBase = {
  detail: string
  status?: number
  retryAfterMs?: number
}

/**
 * The verdict once a matched rule is laid over the platform's. A rule that
 * keeps the platform's kind keeps its wording, retry limit and retryability
 * unless it says otherwise; a rule that changes the kind starts from that
 * kind's defaults.
 */
export function overlayDeclaredVerdict(
  platform: ProviderConnectivityIssue | null,
  declared: DeclaredVerdict,
  base: VerdictBase,
): ProviderConnectivityIssue {
  const defaults = KIND_DEFAULTS[declared.kind]
  const sameKind = platform !== null && platform.kind === declared.kind
  const start: ProviderConnectivityIssue = sameKind
    ? platform
    : {
        kind: declared.kind,
        error: defaults.error,
        titleKey: defaults.titleKey,
        summaryKey: defaults.summaryKey,
        retryable: defaults.retryable,
        settingsRecommended: defaults.settingsRecommended,
        detail: platform?.detail ?? base.detail,
        status: platform?.status ?? base.status,
        retryAfterMs: platform?.retryAfterMs ?? base.retryAfterMs,
        scope: defaults.scope,
      }
  return {
    ...start,
    retryable: declared.retryable ?? start.retryable,
    scope: declared.scope ?? (sameKind ? start.scope : defaults.scope),
    ...(declared.resetsAt !== undefined ? { resetsAt: declared.resetsAt } : {}),
    ...(declared.code !== undefined ? { code: declared.code } : {}),
    ...(declared.message !== undefined ? { message: declared.message } : {}),
    ...(declared.anomaly !== undefined ? { anomaly: declared.anomaly } : {}),
  }
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function truncateMessage(message: LocalizedText): LocalizedText {
  if (typeof message === 'string') return truncateText(message, VERDICT_MESSAGE_MAX_LENGTH)
  return Object.fromEntries(
    Object.entries(message).map(([locale, text]) => [locale, truncateText(text, VERDICT_MESSAGE_MAX_LENGTH)]),
  )
}

/** The latest moment a verdict of this kind may name as its recovery, or
 *  undefined when the kind takes no recovery time at all. */
function resetCeiling(issue: ProviderConnectivityIssue, now: number): number | undefined {
  switch (issue.kind) {
    case 'billing':
    case 'credentials':
      return undefined
    case 'quota':
      return now + VERDICT_QUOTA_RESET_CEILING_MS
    case 'rate_limit':
      return now + Math.max(issue.retryAfterMs ?? 0, VERDICT_RESET_CEILING_MS)
    default:
      return now + VERDICT_RESET_CEILING_MS
  }
}

/** Bound the parts of a verdict a provider's manifest supplied. */
export function clampVerdict(issue: ProviderConnectivityIssue, now: number): ProviderConnectivityIssue {
  const out: ProviderConnectivityIssue = { ...issue }
  if (out.kind === 'credentials' || out.kind === 'configuration') out.retryable = false
  if (out.resetsAt !== undefined) {
    const ceiling = resetCeiling(out, now)
    if (ceiling === undefined) delete out.resetsAt
    else out.resetsAt = Math.min(out.resetsAt, ceiling)
  }
  if (out.code !== undefined) out.code = out.code.slice(0, VERDICT_CODE_MAX_LENGTH)
  if (out.message !== undefined) out.message = truncateMessage(out.message)
  return out
}
