/**
 * `provider.classify`: a wire provider's own reading of a failed or oddly
 * ended attempt (F-27).
 *
 * Contract: the hook is raised after the platform's classification and the
 * provider's declared error rules, never for an attempt that ended well. Its
 * answer may refine the declared part of the verdict and may ask for the
 * request to be sent again, changed (`replay`). `readClassifyAnswer` returns
 * undefined for an answer of the wrong shape, and the caller then keeps the
 * verdict it had: the hook can never fail a request. Everything here is pure.
 *
 * Security: the answer is plugin input. It names a kind and a scope from the
 * platform's lists, a text only by a key of the manifest's own table, and its
 * verdict still passes the platform's limits where the error is classified.
 * A replay is refused once text or a tool call of the attempt has been shown.
 */
import type { LocalizedText } from '../../config/localizedText'
import { THINKING_TIER_ORDER } from '../../config/nexusModelConfig/providers/shared/listing'
import {
  classifyProviderConnectivityIssue,
  ProviderApiError,
  type ProviderConnectivityIssue,
  type ProviderConnectivityIssueKind,
} from '../../utils/providerConnectivity'
import {
  VERDICT_CODE_MAX_LENGTH,
  VERDICT_KINDS,
  VERDICT_SCOPES,
  type DeclaredVerdict,
  type VerdictAnomaly,
  type VerdictScope,
} from '../../utils/providerVerdict'
import type { DriverFinishReason, DriverStreamEvent, DriverUsage } from './driverTypes'
import type { ProviderErrorRule } from './providerPolicy'
import type { ProviderBodyPatch, ProviderRequestContext } from './providerRequestSeam'

export type FailureEvent = Extract<DriverStreamEvent, { type: 'error' }>

/**
 * The verdict the error event will get where the turn classifies it: the
 * platform's reading, the declared part laid over it, the limits. Null when
 * nothing recognises the failure.
 */
export function verdictOfFailure(failure: FailureEvent, now: number = Date.now()): ProviderConnectivityIssue | null {
  return classifyProviderConnectivityIssue(
    // The turn reads the error under this prefix.
    new ProviderApiError(`provider_error: ${failure.message}`, {
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.retryAfterSeconds !== undefined && failure.retryAfterSeconds >= 0
        ? { retryAfterMs: failure.retryAfterSeconds * 1000 }
        : {}),
      ...(failure.verdict ? { declared: failure.verdict } : {}),
    }),
    now,
  )
}

/** Where in the attempt the failure showed. */
export type ClassifyStage = 'connect' | 'response' | 'stream' | 'end'

export type RequestFinishReason = 'stop' | 'max-tokens' | 'tool-calls' | 'error' | 'aborted'

export type RequestUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** What of the attempt has already been passed on to be shown. */
export type Delivered = { reasoning: boolean; text: boolean; toolCalls: boolean }

export type ProviderClassifyEvent = {
  provider: string
  stage: ClassifyStage
  status?: number
  headers?: Record<string, string>
  bodyText?: string
  finishReason?: RequestFinishReason
  usage?: RequestUsage
  delivered: Delivered
  /** The verdict so far; absent when the platform and the rules found nothing wrong. */
  verdict?: ProviderConnectivityIssue
  /** 1 for the first send of this request, 2 for its re-send. */
  attempt: number
  /** The request's one re-send is spent; a `replay` answered now is ignored. */
  replayed: boolean
  model: string
  context: ProviderRequestContext
}

export type ClassifyReplay = {
  /** A thinking tier of the runtime's vocabulary; the request is built again at it. */
  effort?: string
  patch?: readonly ProviderBodyPatch[]
  headers?: Record<string, string>
}

/** The verdict parts an answer states. */
export type ClassifyRefinement = {
  kind?: ProviderConnectivityIssueKind
  scope?: VerdictScope
  retryable?: boolean
  resetsAt?: number
  code?: string
  message?: LocalizedText
}

export type ClassifyAnswer = {
  refinement?: ClassifyRefinement
  replay?: ClassifyReplay
}

const ANSWER_KEYS = ['kind', 'scope', 'retryable', 'resetsAt', 'code', 'messageKey', 'replay']
const REPLAY_KEYS = ['effort', 'patch', 'headers']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const known = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key))

function readReplay(value: unknown): ClassifyReplay | undefined {
  if (!isRecord(value) || !known(value, REPLAY_KEYS)) return undefined
  const out: ClassifyReplay = {}
  if (value.effort !== undefined) {
    if (typeof value.effort !== 'string' || !(THINKING_TIER_ORDER as readonly string[]).includes(value.effort)) return undefined
    out.effort = value.effort
  }
  if (value.patch !== undefined) {
    if (!Array.isArray(value.patch)) return undefined
    out.patch = value.patch as ProviderBodyPatch[]
  }
  if (value.headers !== undefined) {
    if (!isRecord(value.headers) || !Object.values(value.headers).every(item => typeof item === 'string')) return undefined
    out.headers = value.headers as Record<string, string>
  }
  return out
}

/**
 * A hook's answer, or undefined when any part of it is not of the stated
 * shape (an unknown property and a `messageKey` the manifest does not hold
 * included). An answer of nothing is `{}`.
 */
export function readClassifyAnswer(
  raw: unknown,
  messages: Readonly<Record<string, LocalizedText>> | undefined,
): ClassifyAnswer | undefined {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw) || !known(raw, ANSWER_KEYS)) return undefined
  const refinement: ClassifyRefinement = {}
  if (raw.kind !== undefined) {
    if (!(VERDICT_KINDS as readonly unknown[]).includes(raw.kind)) return undefined
    refinement.kind = raw.kind as ProviderConnectivityIssueKind
  }
  if (raw.scope !== undefined) {
    if (!(VERDICT_SCOPES as readonly unknown[]).includes(raw.scope)) return undefined
    refinement.scope = raw.scope as VerdictScope
  }
  if (raw.retryable !== undefined) {
    if (typeof raw.retryable !== 'boolean') return undefined
    refinement.retryable = raw.retryable
  }
  if (raw.resetsAt !== undefined) {
    if (typeof raw.resetsAt !== 'number' || !Number.isFinite(raw.resetsAt) || raw.resetsAt < 0) return undefined
    refinement.resetsAt = raw.resetsAt
  }
  if (raw.code !== undefined) {
    if (typeof raw.code !== 'string' || raw.code === '' || raw.code.length > VERDICT_CODE_MAX_LENGTH) return undefined
    refinement.code = raw.code
  }
  if (raw.messageKey !== undefined) {
    if (typeof raw.messageKey !== 'string') return undefined
    const text = messages && Object.prototype.hasOwnProperty.call(messages, raw.messageKey) ? messages[raw.messageKey] : undefined
    if (text === undefined) return undefined
    refinement.message = text
  }
  let replay: ClassifyReplay | undefined
  if (raw.replay !== undefined) {
    replay = readReplay(raw.replay)
    if (!replay) return undefined
  }
  return {
    ...(Object.keys(refinement).length > 0 ? { refinement } : {}),
    ...(replay ? { replay } : {}),
  }
}

/**
 * The declared part of the verdict once the hook's answer is laid over it.
 * An answer that changes the kind starts from that kind; one that keeps it
 * adds to what the rules said. Undefined when there is still no kind to
 * state (nothing was wrong and the hook named none).
 */
export function refineDeclared(
  soFar: ProviderConnectivityIssue | null | undefined,
  declared: DeclaredVerdict | undefined,
  refinement: ClassifyRefinement | undefined,
): DeclaredVerdict | undefined {
  if (!refinement) return declared
  const kind = refinement.kind ?? declared?.kind ?? soFar?.kind
  if (!kind) return declared
  const kept: DeclaredVerdict = declared && declared.kind === kind
    ? declared
    : { kind, ...(declared?.anomaly !== undefined ? { anomaly: declared.anomaly } : {}) }
  return {
    ...kept,
    ...(refinement.scope !== undefined ? { scope: refinement.scope } : {}),
    ...(refinement.retryable !== undefined ? { retryable: refinement.retryable } : {}),
    ...(refinement.resetsAt !== undefined ? { resetsAt: refinement.resetsAt } : {}),
    ...(refinement.code !== undefined ? { code: refinement.code } : {}),
    ...(refinement.message !== undefined ? { message: refinement.message } : {}),
  }
}

/** Whether the attempt may be sent again: only while no text and no tool
 *  call of it has been passed on. Reasoning alone does not forbid it. */
export function replayPermitted(delivered: Delivered): boolean {
  return !delivered.text && !delivered.toolCalls
}

export function requestFinishReason(reason: DriverFinishReason | undefined): RequestFinishReason {
  switch (reason) {
    case 'length':
      return 'max-tokens'
    case 'tool_calls':
      return 'tool-calls'
    case 'error':
    case 'content_filter':
      return 'error'
    default:
      return 'stop'
  }
}

export function requestUsage(usage: DriverUsage | undefined): RequestUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    ...(usage.promptCacheHits !== undefined ? { cacheReadTokens: usage.promptCacheHits } : {}),
    ...(usage.promptCacheWrites !== undefined ? { cacheWriteTokens: usage.promptCacheWrites } : {}),
  }
}

const CONTENT_EVENTS: ReadonlySet<DriverStreamEvent['type']> = new Set([
  'text_delta',
  'reasoning_delta',
  'reasoning_signature',
  'tool_call_start',
  'tool_call_delta',
  'tool_call',
])

/** Whether a decoded event carries content, as the content timeouts count it. */
export function isContentEvent(event: DriverStreamEvent): boolean {
  return CONTENT_EVENTS.has(event.type)
}

/** What one request has passed on and how its stream ended. */
export class StreamTally {
  readonly delivered: Delivered = { reasoning: false, text: false, toolCalls: false }
  /** The stream's `finish` event arrived. */
  finished = false
  finishReason: DriverFinishReason | undefined
  usage: DriverUsage | undefined

  /** The request goes out again: its next stream has not ended. What was
   *  passed on stays passed on. */
  restart(): void {
    this.finished = false
    this.finishReason = undefined
  }

  note(events: readonly DriverStreamEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'text_delta':
          if (event.text !== '') this.delivered.text = true
          break
        case 'reasoning_delta':
        case 'reasoning_signature':
          this.delivered.reasoning = true
          break
        // A call still being assembled counts: its parts are already held for the reply.
        case 'tool_call_start':
        case 'tool_call_delta':
        case 'tool_call':
          this.delivered.toolCalls = true
          break
        case 'message_start':
          if (event.usage) this.usage = event.usage
          break
        case 'finish':
          this.finished = true
          this.finishReason = event.finishReason
          if (event.usage) this.usage = event.usage
          break
        default:
          break
      }
    }
  }
}

/**
 * What is odd about a stream that ended without an error: it broke off
 * before its finish or at the output cap with no answer (`truncated`), or it
 * finished with neither text nor a tool call (`empty`). Undefined for an
 * ordinary end.
 */
export function endAnomaly(tally: StreamTally): Extract<VerdictAnomaly, 'empty' | 'truncated'> | undefined {
  const answered = tally.delivered.text || tally.delivered.toolCalls
  if (!tally.finished) return 'truncated'
  if (answered) return undefined
  if (tally.finishReason === 'length') return 'truncated'
  if (tally.finishReason === 'error' || tally.finishReason === 'content_filter') return undefined
  return 'empty'
}

/** The rules that state an anomaly: the only ones put to a failure that is
 *  not a refused response or an error inside the stream. */
export function anomalyRules(rules: readonly ProviderErrorRule[] | undefined): ProviderErrorRule[] | undefined {
  const stated = rules?.filter(rule => rule.match.anomaly !== undefined)
  return stated && stated.length > 0 ? stated : undefined
}

/** The rules that state an anomaly of a reply's end (`empty`, `truncated`), or undefined when none does. */
export function endAnomalyRules(rules: readonly ProviderErrorRule[] | undefined): ProviderErrorRule[] | undefined {
  const stated = rules?.filter(rule => rule.match.anomaly === 'empty' || rule.match.anomaly === 'truncated')
  return stated && stated.length > 0 ? stated : undefined
}

/** The error text of a stream whose end a rule or the hook judged a failure. */
export function endAnomalyMessage(anomaly: 'empty' | 'truncated'): string {
  return anomaly === 'empty'
    ? 'The provider ended its reply without any content'
    : 'The provider ended its reply before it was complete'
}
