/**
 * The continuation through `turn.continue` (L2.16 / L2.17), only when a hook selected it at turn open;
 * same order as `turnContinuation.ts`, but the drained input, attachments and nudge go out as one
 * `raiseTurnContinue` effect. Pure.
 */
import type { Message } from '../runtime/RuntimeTypes'
import { TERMINAL_COMPLETED, TERMINAL_NEXT_TURN } from '../runtime/VercelModelConstants'
import type { TurnEvent, TurnPolicies, TurnState, Transition } from './turnEffects'
import { nudgeRow } from './turnRows'
import { latchNudge } from './loop/nudgePolicy'
import { emit, finish, openDraft, patchState, request, seal } from './turnStep'
import { openRequest } from './turnRequest'

/** Whether drained input waits for `turn.continue`: the event is raised
 *  and a next step follows (a reached budget ends the turn as before). */
export function holdsDrainedInput(state: TurnState, policies: TurnPolicies): boolean {
  if (state.continueRaised !== true) return false
  const { maxTurns } = state.limits
  return !(policies.stepBudget({ k: state.k, maxTurns }).reached && maxTurns)
}

/** Drained input held; the prompt refresh runs over the rows it will see. */
export function holdDrainedInput(state: TurnState, rows: readonly Message[]): Transition {
  const d = openDraft(state)
  const next = [...state.messages, ...state.stepReplies, ...state.stepResults]
  patchState(d, { pendingMessages: next, heldInput: rows })
  request(d, { kind: 'refreshPromptContext', messages: [...next, ...rows], toolCalls: state.stepToolCalls, k: state.k })
  return seal(d)
}

/** The refresh answered: pick the nudge as the engine does, and raise
 *  `turn.continue` over the three pending pieces. */
export function raiseTurnContinue(
  state: TurnState,
  event: Extract<TurnEvent, { type: 'promptContextRefreshed' }>,
  policies: TurnPolicies,
): Transition {
  const d = openDraft(state)
  const ledger = state.loopLedger
  const { maxTurns } = state.limits
  const choice = ledger ? policies.chooseNudge({ k: state.k, maxTurns, loopLedger: ledger }) : undefined
  let nudge: Message | undefined
  if (ledger && choice) {
    patchState(d, { loopLedger: latchNudge(ledger, choice) })
    nudge = nudgeRow(d, choice.text)
  }
  if (event.instructions) patchState(d, { heldInstructions: event.instructions })
  request(d, {
    kind: 'raiseTurnContinue',
    pending: { queuedInput: state.heldInput ?? [], ...(nudge ? { nudge } : {}), attachments: event.injected },
    outcomeSoFar: { failureStreak: ledger?.failureStreak ?? 0, stepsLeft: maxTurns ? Math.max(0, maxTurns - state.k) : null },
    k: state.k,
  })
  return seal(d)
}

/** `turn.continue` settled: add what it handed back and open the next
 *  request, or end the turn as completed. */
export function onTurnContinued(
  state: TurnState,
  event: Extract<TurnEvent, { type: 'turnContinued' }>,
  policies: TurnPolicies,
): Transition {
  const d = openDraft(state)
  patchState(d, { heldInput: undefined, heldInstructions: undefined })
  if (event.stop) {
    finish(d, { reason: TERMINAL_COMPLETED })
    return seal(d)
  }
  const { queuedInput, nudge, attachments } = event.pending
  for (const row of queuedInput) emit(d, row, 'user')
  const injected = [...attachments, ...(nudge ? [nudge] : [])]
  // As without a hook: the attachments and the nudge are recorded rows.
  for (const row of attachments) emit(d, row, 'context')
  if (nudge) emit(d, nudge, 'nudge')
  patchState(d, {
    ...(state.heldInstructions ?? {}),
    stepResults: [...state.stepResults, ...queuedInput],
    messages: [...(state.pendingMessages ?? state.messages), ...queuedInput, ...injected],
    k: state.k + 1,
    outputCapRetries: 0,
    reactiveCompactTried: false,
    outputTokenCapOverride: undefined,
    inStopHook: false,
    lastContinuation: { reason: TERMINAL_NEXT_TURN },
  })
  openRequest(d, policies)
  return seal(d)
}
