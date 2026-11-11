/**
 * `provider.outcome`: what a provider's module is told when a request of its
 * provider is over (F-27).
 *
 * Contract: an observer. `raiseProviderOutcome` returns at once, never
 * throws and never rejects; a hook that throws or runs out of time is logged
 * and has no other effect. A caller that sends one request over several
 * streams (the retry ladder) opens a call with `openOutcomeCall`, marks its
 * payload with the call's key, and closes it once: the streams then add
 * their facts to the call and the caller raises the event. A stream whose
 * payload carries no call's key raises the event itself when it ends; one
 * that ends after its call was closed says nothing, since the caller already
 * told the hook.
 */
import type { ProviderConnectivityIssue } from '../../utils/providerConnectivity'
import { traceLine } from '../../utils/debugLog'
import type { RequestFinishReason, RequestUsage } from './providerClassify'
import type { ProviderRequestContext, ProviderRequestSeam } from './providerRequestSeam'

export type ProviderOutcomeEvent = {
  provider: string
  model: string
  /** Who served the request: for a wire provider, itself. */
  target: { provider: string; model: string }
  context?: ProviderRequestContext
  ok: boolean
  status?: number
  verdict?: ProviderConnectivityIssue
  finishReason?: RequestFinishReason
  usage?: RequestUsage
  hadReasoning?: boolean
  hadOutput?: boolean
  /** How many times the request went out, re-sends and retries included. */
  attempts: number
  durationMs: number
  firstByteMs?: number
}

/** What one stream learned about its request. */
export type StreamFacts = {
  /** Times the stream sent the request (0: it never left). */
  sends: number
  context?: ProviderRequestContext
  status?: number
  firstByteMs?: number
  finishReason?: RequestFinishReason
  usage?: RequestUsage
  hadReasoning: boolean
  hadOutput: boolean
}

/** The payload field that carries an open call's key to its streams. Read by
 *  the stream host alone; no codec sends it. */
export const OUTCOME_CALL_FIELD = 'outcomeCall'

type OpenCall = { sends: number; last?: StreamFacts }

const openCalls = new Map<string, OpenCall>()
/** Keys of calls already closed, so a stream that ends late is not told twice. */
const closedCalls = new Set<string>()
const CLOSED_CALLS_KEPT = 256
let nextCall = 0

export type OutcomeCall = {
  key: string
  /** Ends the call: what its streams reported, summed. */
  close(): { sends: number; last?: StreamFacts }
}

export function openOutcomeCall(): OutcomeCall {
  nextCall += 1
  const key = `outcome-${nextCall}`
  openCalls.set(key, { sends: 0 })
  return {
    key,
    close: () => {
      const call = openCalls.get(key) ?? { sends: 0 }
      openCalls.delete(key)
      closedCalls.add(key)
      if (closedCalls.size > CLOSED_CALLS_KEPT) closedCalls.delete(closedCalls.values().next().value as string)
      return call
    },
  }
}

export function outcomeCallKeyOf(payload: object): string | undefined {
  const key = (payload as Record<string, unknown>)[OUTCOME_CALL_FIELD]
  return typeof key === 'string' ? key : undefined
}

/** Adds a stream's facts to its caller's call; false when no caller counts
 *  the stream (the stream host then tells the hook itself). */
export function reportStreamFacts(key: string | undefined, facts: StreamFacts): boolean {
  if (key === undefined) return false
  const call = openCalls.get(key)
  if (!call) return closedCalls.has(key)
  call.sends += facts.sends
  call.last = facts
  return true
}

export type OutcomeResult = {
  ok: boolean
  verdict?: ProviderConnectivityIssue
  aborted?: boolean
  /** Attempts the caller counted itself, used when no stream reported. */
  attempts?: number
  durationMs: number
}

export function outcomeEvent(
  provider: string,
  model: string,
  result: OutcomeResult,
  reported: { sends: number; last?: StreamFacts },
): ProviderOutcomeEvent {
  const last = reported.last
  const finishReason: RequestFinishReason | undefined = result.aborted
    ? 'aborted'
    : result.ok
      ? last?.finishReason
      : 'error'
  return {
    provider,
    model,
    target: { provider, model },
    ...(last?.context ? { context: last.context } : {}),
    ok: result.ok,
    ...(last?.status !== undefined ? { status: last.status } : {}),
    ...(result.verdict ? { verdict: result.verdict } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(last?.usage ? { usage: last.usage } : {}),
    ...(last ? { hadReasoning: last.hadReasoning, hadOutput: last.hadOutput } : {}),
    attempts: Math.max(reported.sends, result.attempts ?? 0),
    durationMs: result.durationMs,
    ...(last?.firstByteMs !== undefined ? { firstByteMs: last.firstByteMs } : {}),
  }
}

function logFailure(provider: string, error: unknown): void {
  traceLine(
    `[providers] ${provider}: provider.outcome failed: ${error instanceof Error ? error.message : String(error)}`,
    { level: 'warn' },
  )
}

/** Tell the provider's module, if it listens. Nothing waits for it. */
export function raiseProviderOutcome(seam: ProviderRequestSeam | undefined, event: ProviderOutcomeEvent): void {
  let hook: ProviderRequestSeam['outcome']
  try {
    hook = seam?.outcome
    if (!hook) return
    void Promise.resolve(hook.call(seam, event)).catch(error => logFailure(event.provider, error))
  } catch (error) {
    logFailure(event.provider, error)
  }
}
