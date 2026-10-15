// Agent-loop guardrails: last-step detection, the consecutive-failures
// circuit, and the turn-budget warning. Per-action timeout
// (`actionTimeoutMs`) is enforced C++-side via ToolSession.

import type { AgentLoopState } from './agentLoopState'
import type { AgentLoopSettings } from '../../config/agentLoopConfig'

export function isLastStep(turnCount: number, maxTurns: number | undefined): boolean {
  if (!maxTurns || maxTurns <= 0) return false
  return turnCount >= maxTurns
}

export function isMaxFailures(
  state: AgentLoopState,
  settings: AgentLoopSettings,
): boolean {
  return state.failureStreak >= settings.maxFailures
}

export function shouldFireBudgetWarning(
  state: AgentLoopState,
  turnCount: number,
  maxTurns: number | undefined,
): boolean {
  if (state.budgetWarnFired) return false
  if (!maxTurns || maxTurns <= 0) return false
  return turnCount / maxTurns >= state.settings.budgetWarnFraction
}
