/**
 * `turn.recover`: raised for each failed attempt the retry ladder judges (never for a
 * cancellation or a too-long prompt). A hook may answer another decision; the engine
 * still bounds it (no retry past the last attempt, a wait within
 * `RECOVER_DELAY_CAP_MS`). Pure.
 */

/** The failure kinds the ladder judges. */
export type TurnRecoverFailureKind = 'rate_limit' | 'connectivity' | 'other'

export type TurnRecoverDecision = { retry: false } | { retry: true; delayMs: number; notify: boolean }

export type TurnRecoverInput = {
  turnId: string
  /** The attempt that failed, from 1. */
  attempt: number
  failure: { kind: TurnRecoverFailureKind; message: string; retryAfterMs?: number }
  decision: TurnRecoverDecision
  agentId?: string
}

/** The longest wait a hook may ask for: ten minutes. */
export const RECOVER_DELAY_CAP_MS = 600_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What a `turn.recover` hook may answer: a decision. `delayMs` and
 *  `notify` may be left out of a retry (0 and false). */
export function isTurnRecoverResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.retry !== 'boolean') return false
  if (value.delayMs !== undefined && (typeof value.delayMs !== 'number' || !Number.isFinite(value.delayMs))) return false
  return value.notify === undefined || typeof value.notify === 'boolean'
}

/** A hook's answer as the engine takes it: the wait clamped to
 *  0 … `RECOVER_DELAY_CAP_MS`. */
export function recoverDecisionOf(value: Record<string, unknown>): TurnRecoverDecision {
  if (value.retry !== true) return { retry: false }
  const delay = typeof value.delayMs === 'number' ? value.delayMs : 0
  return { retry: true, delayMs: Math.min(Math.max(0, delay), RECOVER_DELAY_CAP_MS), notify: value.notify === true }
}

/** Core: the decision as it arrived — a hook may rewrite it on the way down
 *  (`next({ ...e, decision })`); anything that is not one is the ladder's. */
export function arrivedRecoverDecision(sent: TurnRecoverInput, arrived: unknown): TurnRecoverDecision {
  const decision = isRecord(arrived) ? arrived.decision : undefined
  return isTurnRecoverResult(decision) ? recoverDecisionOf(decision as Record<string, unknown>) : sent.decision
}
