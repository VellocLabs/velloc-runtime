/**
 * Validation of a provider manifest's `policy` block.
 *
 * Contract: `checkPolicy` returns the block as the runtime uses it, or reports
 * every problem through `bad` (which refuses the provider) and returns
 * undefined. The block is strict: an unknown property, an unknown condition
 * or a value of the wrong type is a problem, named by its path, because a
 * rule that is silently dropped looks to the person like a policy that does
 * not work.
 */
import { isLocalizedText, whyNotLocalizedText } from '../../config/localizedText'
import {
  ERROR_RULES_MAX,
  RESET_UNITS,
  type ErrorRuleMatch,
  type ProviderErrorRule,
  type ProviderPolicy,
  type ProviderRetryPolicy,
  type ResetSource,
  type ResetUnit,
} from '../../models/drivers/providerPolicy'
import { PROVIDER_CONNECTIVITY_MAX_RETRIES, PROVIDER_CONNECTIVITY_MAX_RETRY_DELAY_MS } from '../../utils/providerConnectivity'
import {
  VERDICT_ANOMALIES,
  VERDICT_CODE_MAX_LENGTH,
  VERDICT_KINDS,
  VERDICT_SCOPES,
} from '../../utils/providerVerdict'
import { checkPolicyMessages, checkTimeouts } from './providerTimeoutsManifest'

type Problems = (message: string) => void

const TEXT_MAX = 256
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const quoted = (list: readonly string[]): string => list.join(' / ')

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string, bad: Problems): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) bad(`${label}.${key}: not a known property (known: ${quoted(allowed)})`)
  }
}

function wholeNumber(value: unknown, min: number, max: number, label: string, bad: Problems): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    bad(`${label}: expected a whole number from ${min} to ${max}`)
    return undefined
  }
  return value
}

function oneOf<T extends string>(value: unknown, list: readonly T[], label: string, bad: Problems): T | undefined {
  if (typeof value === 'string' && (list as readonly string[]).includes(value)) return value as T
  bad(`${label}: expected one of ${quoted(list)}`)
  return undefined
}

function shortText(value: unknown, max: number, label: string, bad: Problems): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > max) {
    bad(`${label}: expected text of 1 to ${max} characters`)
    return undefined
  }
  return value
}

function pointer(value: unknown, label: string, bad: Problems): string | undefined {
  if (typeof value !== 'string' || value.length > TEXT_MAX || (value !== '' && !value.startsWith('/'))) {
    bad(`${label}: expected a JSON Pointer ("" or a path starting with "/")`)
    return undefined
  }
  return value
}

function headerName(value: unknown, label: string, bad: Problems): string | undefined {
  if (typeof value !== 'string' || !HEADER_NAME.test(value)) {
    bad(`${label}: expected a response header name`)
    return undefined
  }
  return value.toLowerCase()
}

const RETRY_KEYS = ['maxRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio', 'on'] as const

function checkRetry(value: unknown, label: string, bad: Problems): ProviderRetryPolicy | undefined {
  if (!isRecord(value)) {
    bad(`${label}: expected an object`)
    return undefined
  }
  onlyKeys(value, RETRY_KEYS, label, bad)
  const out: ProviderRetryPolicy = {}
  const maxDelay = PROVIDER_CONNECTIVITY_MAX_RETRY_DELAY_MS
  if (value.maxRetries !== undefined) {
    const n = wholeNumber(value.maxRetries, 0, PROVIDER_CONNECTIVITY_MAX_RETRIES, `${label}.maxRetries`, bad)
    if (n !== undefined) out.maxRetries = n
  }
  if (value.initialDelayMs !== undefined) {
    const n = wholeNumber(value.initialDelayMs, 0, maxDelay, `${label}.initialDelayMs`, bad)
    if (n !== undefined) out.initialDelayMs = n
  }
  if (value.maxDelayMs !== undefined) {
    const n = wholeNumber(value.maxDelayMs, 0, maxDelay, `${label}.maxDelayMs`, bad)
    if (n !== undefined) out.maxDelayMs = n
  }
  if (value.jitterRatio !== undefined) {
    const ratio = value.jitterRatio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      bad(`${label}.jitterRatio: expected a number from 0 to 1`)
    } else out.jitterRatio = ratio
  }
  if (value.on !== undefined) {
    if (!Array.isArray(value.on)) bad(`${label}.on: expected a list of verdict kinds`)
    else {
      const kinds = value.on.map((kind, i) => oneOf(kind, VERDICT_KINDS, `${label}.on[${i}]`, bad))
      if (kinds.every(kind => kind !== undefined)) out.on = [...new Set(kinds as NonNullable<(typeof kinds)[number]>[])]
    }
  }
  return out
}

const MATCH_KEYS = ['status', 'bodyContains', 'bodyPointer', 'headerPresent', 'anomaly', 'model'] as const
const STATUS_RANGE_KEYS = ['from', 'to'] as const

function checkStatus(value: unknown, label: string, bad: Problems): ErrorRuleMatch['status'] | undefined {
  if (typeof value === 'number') return wholeNumber(value, 100, 599, label, bad)
  if (!isRecord(value)) {
    bad(`${label}: expected a status code or { "from": n, "to": n }`)
    return undefined
  }
  onlyKeys(value, STATUS_RANGE_KEYS, label, bad)
  const from = wholeNumber(value.from, 100, 599, `${label}.from`, bad)
  const to = wholeNumber(value.to, 100, 599, `${label}.to`, bad)
  if (from === undefined || to === undefined) return undefined
  if (from > to) {
    bad(`${label}: "from" must not be greater than "to"`)
    return undefined
  }
  return { from, to }
}

function checkMatch(value: unknown, label: string, bad: Problems): ErrorRuleMatch | undefined {
  if (!isRecord(value)) {
    bad(`${label}: required; an object of conditions`)
    return undefined
  }
  onlyKeys(value, MATCH_KEYS, label, bad)
  const out: ErrorRuleMatch = {}
  if (value.status !== undefined) {
    const status = checkStatus(value.status, `${label}.status`, bad)
    if (status !== undefined) out.status = status
  }
  if (value.bodyContains !== undefined) {
    const text = shortText(value.bodyContains, TEXT_MAX, `${label}.bodyContains`, bad)
    if (text !== undefined) out.bodyContains = text
  }
  if (value.bodyPointer !== undefined) {
    const at = pointer(value.bodyPointer, `${label}.bodyPointer`, bad)
    if (at !== undefined) out.bodyPointer = at
  }
  if (value.headerPresent !== undefined) {
    const name = headerName(value.headerPresent, `${label}.headerPresent`, bad)
    if (name !== undefined) out.headerPresent = name
  }
  if (value.anomaly !== undefined) {
    const anomaly = oneOf(value.anomaly, VERDICT_ANOMALIES, `${label}.anomaly`, bad)
    if (anomaly !== undefined) out.anomaly = anomaly
  }
  if (value.model !== undefined) {
    const prefix = shortText(value.model, TEXT_MAX, `${label}.model`, bad)
    if (prefix !== undefined) out.model = prefix
  }
  if (Object.keys(value).length === 0) bad(`${label}: needs at least one condition (${quoted(MATCH_KEYS)})`)
  return out
}

const RESET_KEYS = ['header', 'pointer', 'unit'] as const

function checkReset(value: unknown, label: string, bad: Problems): ResetSource | undefined {
  if (!isRecord(value)) {
    bad(`${label}: expected an object`)
    return undefined
  }
  onlyKeys(value, RESET_KEYS, label, bad)
  const unit: ResetUnit | undefined = oneOf(value.unit, RESET_UNITS, `${label}.unit`, bad)
  if ((value.header === undefined) === (value.pointer === undefined)) {
    bad(`${label}: needs exactly one of "header" and "pointer"`)
    return undefined
  }
  if (value.header !== undefined) {
    const header = headerName(value.header, `${label}.header`, bad)
    return header !== undefined && unit !== undefined ? { header, unit } : undefined
  }
  const at = pointer(value.pointer, `${label}.pointer`, bad)
  return at !== undefined && unit !== undefined ? { pointer: at, unit } : undefined
}

const RULE_KEYS = ['match', 'kind', 'scope', 'retryable', 'code', 'message', 'resetsAtFrom'] as const

function checkErrorRule(value: unknown, label: string, bad: Problems): ProviderErrorRule | undefined {
  if (!isRecord(value)) {
    bad(`${label}: expected an object`)
    return undefined
  }
  onlyKeys(value, RULE_KEYS, label, bad)
  const match = checkMatch(value.match, `${label}.match`, bad)
  const kind = oneOf(value.kind, VERDICT_KINDS, `${label}.kind`, bad)
  if (match === undefined || kind === undefined) return undefined
  const out: ProviderErrorRule = { match, kind }
  if (value.scope !== undefined) {
    const scope = oneOf(value.scope, VERDICT_SCOPES, `${label}.scope`, bad)
    if (scope !== undefined) out.scope = scope
  }
  if (value.retryable !== undefined) {
    if (typeof value.retryable !== 'boolean') bad(`${label}.retryable: expected true or false`)
    else out.retryable = value.retryable
  }
  if (value.code !== undefined) {
    const code = shortText(value.code, VERDICT_CODE_MAX_LENGTH, `${label}.code`, bad)
    if (code !== undefined) out.code = code
  }
  if (value.message !== undefined) {
    if (!isLocalizedText(value.message)) bad(`${label}.message ${whyNotLocalizedText(value.message)}`)
    else out.message = value.message
  }
  if (value.resetsAtFrom !== undefined) {
    const reset = checkReset(value.resetsAtFrom, `${label}.resetsAtFrom`, bad)
    if (reset !== undefined) out.resetsAtFrom = reset
  }
  return out
}

function checkErrors(value: unknown, label: string, bad: Problems): ProviderErrorRule[] | undefined {
  if (!Array.isArray(value)) {
    bad(`${label}: expected a list of rules`)
    return undefined
  }
  if (value.length > ERROR_RULES_MAX) {
    bad(`${label}: ${value.length} rules; the most is ${ERROR_RULES_MAX}`)
    return undefined
  }
  const rules: ProviderErrorRule[] = []
  value.forEach((raw, i) => {
    const rule = checkErrorRule(raw, `${label}[${i}]`, bad)
    if (rule) rules.push(rule)
  })
  return rules
}

const POLICY_KEYS = ['retry', 'errors', 'timeouts', 'messages'] as const

/** Validate `providers.<key>.policy`. */
export function checkPolicy(
  value: unknown,
  bad: Problems,
  wireFormats: readonly string[] = [],
): ProviderPolicy | undefined {
  const label = 'policy'
  if (!isRecord(value)) {
    bad(`${label}: expected an object`)
    return undefined
  }
  onlyKeys(value, POLICY_KEYS, label, bad)
  const out: ProviderPolicy = {}
  if (value.retry !== undefined) {
    const retry = checkRetry(value.retry, `${label}.retry`, bad)
    if (retry) out.retry = retry
  }
  if (value.errors !== undefined) {
    const errors = checkErrors(value.errors, `${label}.errors`, bad)
    if (errors && errors.length > 0) out.errors = errors
  }
  if (value.timeouts !== undefined) {
    const timeouts = checkTimeouts(value.timeouts, `${label}.timeouts`, bad, wireFormats)
    if (timeouts && Object.keys(timeouts).length > 0) out.timeouts = timeouts
  }
  if (value.messages !== undefined) {
    const messages = checkPolicyMessages(value.messages, `${label}.messages`, bad)
    if (messages && Object.keys(messages).length > 0) out.messages = messages
  }
  return out
}
