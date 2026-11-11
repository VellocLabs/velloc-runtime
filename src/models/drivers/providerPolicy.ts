/**
 * A provider's declared policy: how its failures are retried and what its
 * error responses mean.
 *
 * Contract: `matchErrorRule` is pure. Rules are tried in order and the first
 * whose conditions all hold wins; no rule, or an empty list, yields
 * undefined and the platform's own classification stands.
 *
 * Security: the response is untrusted and the rules are plugin input. A rule
 * can only compare (literal substring, status, header name, JSON pointer,
 * prefix) - no pattern language runs on the error path - and the body text a
 * substring is searched in is bounded.
 */
import type { LocalizedText } from '../../config/localizedText'
import type { ProviderConnectivityIssueKind } from '../../utils/providerConnectivity'
import type { DeclaredVerdict, VerdictAnomaly, VerdictScope } from '../../utils/providerVerdict'

export const ERROR_RULES_MAX = 64
/** `bodyContains` reads this much of the response body, counted in UTF-8 bytes. */
export const ERROR_RULE_BODY_WINDOW_BYTES = 8 * 1024

export const RESET_UNITS = ['epoch-seconds', 'epoch-ms', 'delta-seconds', 'http-date'] as const
export type ResetUnit = (typeof RESET_UNITS)[number]

export type ErrorRuleMatch = {
  /** One status, or an inclusive range. */
  status?: number | { from: number; to: number }
  /** Literal, case-sensitive. */
  bodyContains?: string
  /** JSON Pointer to a value that is present and not empty. */
  bodyPointer?: string
  /** Header name, lower case. */
  headerPresent?: string
  anomaly?: VerdictAnomaly
  /** Model id prefix, case-sensitive. */
  model?: string
}

export type ResetSource = ({ header: string } | { pointer: string }) & { unit: ResetUnit }

export type ProviderErrorRule = {
  match: ErrorRuleMatch
  kind: ProviderConnectivityIssueKind
  scope?: VerdictScope
  retryable?: boolean
  code?: string
  message?: LocalizedText
  resetsAtFrom?: ResetSource
}

export type ProviderRetryPolicy = {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  /** Verdict kinds that are retried. Absent = whatever the verdict allows;
   *  empty = nothing is retried. */
  on?: ProviderConnectivityIssueKind[]
}

export type ProviderPolicy = {
  retry?: ProviderRetryPolicy
  errors?: ProviderErrorRule[]
}

/** What a rule is matched against: one failed response, or one failed stream. */
export type ProviderFailureFacts = {
  status?: number
  headers: Readonly<Record<string, string>>
  /** The response body as far as it was read. */
  bodyText: string
  /** True when the body is an event stream rather than one JSON document. */
  streamed: boolean
  anomaly?: VerdictAnomaly
  model: string
}

/** A response header by name, compared without case. */
export function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

/** The first `ERROR_RULE_BODY_WINDOW_BYTES` of `text`. */
export function bodyWindow(text: string): string {
  // One UTF-16 unit is at most three UTF-8 bytes, so a short text needs no encoding.
  if (text.length * 3 <= ERROR_RULE_BODY_WINDOW_BYTES) return text
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= ERROR_RULE_BODY_WINDOW_BYTES) return text
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, ERROR_RULE_BODY_WINDOW_BYTES))
}

const NO_DOCUMENT = Symbol('no-document')

/** Parses the body once per failure, and only when a rule asks for a pointer. */
class FailureView {
  private parsed: unknown = NO_DOCUMENT
  private window: string | undefined
  constructor(readonly facts: ProviderFailureFacts) {}

  bodyHead(): string {
    this.window ??= bodyWindow(this.facts.bodyText)
    return this.window
  }

  /** The value at `pointer`, or undefined - always undefined for a streamed body. */
  at(pointer: string): unknown {
    if (this.facts.streamed) return undefined
    if (this.parsed === NO_DOCUMENT) {
      try {
        this.parsed = JSON.parse(this.facts.bodyText)
      } catch {
        this.parsed = undefined
      }
    }
    return resolvePointer(this.parsed, pointer)
  }
}

function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document
  let node = document
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return undefined
      node = node[Number(token)]
    } else if (typeof node === 'object' && node !== null) {
      if (!Object.prototype.hasOwnProperty.call(node, token)) return undefined
      node = (node as Record<string, unknown>)[token]
    } else return undefined
  }
  return node
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function statusMatches(wanted: NonNullable<ErrorRuleMatch['status']>, status: number | undefined): boolean {
  if (status === undefined) return false
  return typeof wanted === 'number' ? status === wanted : status >= wanted.from && status <= wanted.to
}

function ruleMatches(match: ErrorRuleMatch, view: FailureView): boolean {
  const { facts } = view
  if (match.status !== undefined && !statusMatches(match.status, facts.status)) return false
  if (match.headerPresent !== undefined && headerValue(facts.headers, match.headerPresent) === undefined) return false
  if (match.anomaly !== undefined && facts.anomaly !== match.anomaly) return false
  if (match.model !== undefined && !facts.model.startsWith(match.model)) return false
  if (match.bodyContains !== undefined && !view.bodyHead().includes(match.bodyContains)) return false
  if (match.bodyPointer !== undefined && isEmptyValue(view.at(match.bodyPointer))) return false
  return true
}

const DIGITS = /^\d{1,16}(?:\.\d+)?$/

/** The recovery time a rule points at, as epoch ms; undefined when the
 *  response does not carry one in the stated unit. */
function readReset(source: ResetSource, view: FailureView, now: number): number | undefined {
  const raw = 'header' in source ? headerValue(view.facts.headers, source.header) : view.at(source.pointer)
  if (source.unit === 'http-date') {
    if (typeof raw !== 'string') return undefined
    const at = Date.parse(raw.trim())
    return Number.isFinite(at) ? at : undefined
  }
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!DIGITS.test(text)) return undefined
  const value = Number(text)
  if (source.unit === 'epoch-ms') return Math.floor(value)
  if (source.unit === 'epoch-seconds') return Math.floor(value * 1000)
  return now + Math.floor(value * 1000)
}

/**
 * What the provider's rules say about one failure: the verdict parts of the
 * first matching rule, or undefined when none matches.
 */
export function matchErrorRule(
  rules: readonly ProviderErrorRule[] | undefined,
  facts: ProviderFailureFacts,
  now: number = Date.now(),
): DeclaredVerdict | undefined {
  if (!rules || rules.length === 0) return undefined
  const view = new FailureView(facts)
  const rule = rules.find(candidate => ruleMatches(candidate.match, view))
  if (!rule) return undefined
  const resetsAt = rule.resetsAtFrom ? readReset(rule.resetsAtFrom, view, now) : undefined
  return {
    kind: rule.kind,
    ...(rule.scope !== undefined ? { scope: rule.scope } : {}),
    ...(rule.retryable !== undefined ? { retryable: rule.retryable } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(rule.code !== undefined ? { code: rule.code } : {}),
    ...(rule.message !== undefined ? { message: rule.message } : {}),
    ...(facts.anomaly !== undefined ? { anomaly: facts.anomaly } : {}),
  }
}

/** True when the response's headers say the body is an event stream. */
export function isEventStreamResponse(headers: Readonly<Record<string, string>>): boolean {
  return (headerValue(headers, 'content-type') ?? '').toLowerCase().includes('text/event-stream')
}
