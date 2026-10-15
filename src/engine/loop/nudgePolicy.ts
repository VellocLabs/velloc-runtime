/**
 * The nudge a step adds after its tool results, highest priority first: the
 * step-budget warning, the consecutive-failure notice, the last-step
 * notice, then the repeated-action and unchanged-page notices. Pure: it
 * reads a copy of the ledger, and the machine applies the latch the choice
 * implies (`latchNudge`).
 */
import type { LoopLedger, NudgeChoice, NudgeInput } from '../turnEffects'
import type { AgentLoopState } from './agentLoopState'
import { getNudge } from './actionLoopDetector'
import { renderNudge } from './nudges'
import { shouldFireBudgetWarning } from './stepBudget'

export function chooseLoopNudge({ k, maxTurns, loopLedger }: NudgeInput): NudgeChoice | undefined {
  const view = { ...loopLedger } as unknown as AgentLoopState
  if (shouldFireBudgetWarning(view, k, maxTurns)) {
    return { kind: 'BUDGET_75', text: renderNudge('BUDGET_75', { turnCount: k, maxTurns }) }
  }
  if (loopLedger.failureStreak >= loopLedger.settings.maxFailures) {
    return { kind: 'MAX_FAILURES', text: renderNudge('MAX_FAILURES', { failureCount: loopLedger.failureStreak }) }
  }
  if (maxTurns !== undefined && k >= maxTurns) {
    return { kind: 'LAST_STEP_FORCE_DONE', text: renderNudge('LAST_STEP_FORCE_DONE') }
  }
  const nudge = getNudge(view)
  return nudge ? { kind: nudge.kind, text: renderNudge(nudge.kind, nudge.context) } : undefined
}

/** The ledger after `choice` fired: the budget warning fires once, and a
 *  repeated-action or unchanged-page level fires once per entry. */
export function latchNudge(ledger: LoopLedger, choice: NudgeChoice): LoopLedger {
  switch (choice.kind) {
    case 'BUDGET_75':
      return { ...ledger, budgetWarnFired: true }
    case 'LOOP_5':
    case 'LOOP_8':
    case 'LOOP_12':
    case 'STAGNATION_5':
      return { ...ledger, lastNudgeKind: choice.kind }
    default:
      return ledger
  }
}
