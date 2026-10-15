/**
 * After the model asked for tools: run the batch, add the rows gathered
 * after it, count failures, stop for a halted call, check the step budget
 * before draining queued input, refresh the prompt context, add the nudge
 * the policy picks, and open the next request.
 */
import type { Message } from '../runtime/RuntimeTypes'
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import {
  TERMINAL_AWAITING_USER,
  TERMINAL_MAX_FAILURES,
  TERMINAL_MAX_TURNS,
  TERMINAL_NEXT_TURN,
} from '../runtime/VercelModelConstants'
import { toolResultIndicatesSoftFailure } from '../utils/toolResultStatus'
import type { LoopLedger, TurnEvent, TurnPolicies, TurnState, Transition } from './turnEffects'
import { nudgeRow, resultPartsOf, stepBudgetRow } from './turnRows'
import { latchNudge } from './loop/nudgePolicy'
import { emit, finish, openDraft, patchState, request, seal, type Draft } from './turnStep'
import { openRequest } from './turnRequest'
import { holdDrainedInput, holdsDrainedInput, raiseTurnContinue } from './turnContinueStep'

/** A call id dispatched twice would run the tool twice; the later copy is
 *  dropped. */
export function distinctCalls(calls: readonly QueryToolUseBlock[]): QueryToolUseBlock[] {
  const seen = new Set<string>()
  return calls.filter((call) => {
    if (seen.has(call.toolCallId)) return false
    seen.add(call.toolCallId)
    return true
  })
}

export function runToolsFor(d: Draft): void {
  const calls = distinctCalls(d.state.stepToolCalls)
  const identity = request(d, {
    kind: 'startBackground',
    background: 'toolDigest',
    input: { calls, replies: d.state.stepReplies },
  })
  patchState(d, { background: [...d.state.background, { identity, kind: 'toolDigest' }] })
  request(d, { kind: 'runToolBatch', calls, replies: d.state.stepReplies })
}

export function onToolBatchDone(state: TurnState, event: Extract<TurnEvent, { type: 'toolBatchDone' }>): Transition {
  const d = openDraft(state)
  const rows: Message[] = []
  const halts = [...state.pendingHalts]
  for (const update of event.updates) {
    if (update.kind === 'row') rows.push(update.message)
    else if (update.kind === 'halt') halts.push(update.pending)
    else {
      const p = update.patch
      patchState(d, {
        ...(p.fileReadLedger ? { fileReadLedger: p.fileReadLedger } : {}),
        ...(p.nestedMemoryPathsSeen ? { nestedMemoryPathsSeen: p.nestedMemoryPathsSeen } : {}),
        ...(p.loopLedger ? { loopLedger: p.loopLedger } : {}),
        ...(p.visibleTools ? { visibleTools: p.visibleTools } : {}),
      })
    }
  }
  patchState(d, { stepResults: [...state.stepResults, ...rows], pendingHalts: halts })
  request(d, { kind: 'gatherRows', stage: 'afterTools', messages: d.state.messages })
  return seal(d)
}

/** Counts this step's failed results. A hard error or a body that reports
 *  failure adds one to the streak; a step with only successes clears it. Each
 *  call id is counted once. */
export function countFailures(ledger: LoopLedger, results: readonly Message[]): LoopLedger {
  const counted = new Set(ledger.countedFailureToolCallIds)
  let failed = false
  let succeeded = false
  for (const row of results) {
    for (const part of resultPartsOf(row)) {
      if (counted.has(part.toolCallId)) continue
      if (part.failed || toolResultIndicatesSoftFailure(part.body)) {
        counted.add(part.toolCallId)
        failed = true
      } else {
        succeeded = true
      }
    }
  }
  if (failed) return { ...ledger, failureStreak: ledger.failureStreak + 1, countedFailureToolCallIds: counted }
  if (succeeded) return { ...ledger, failureStreak: 0, countedFailureToolCallIds: new Set() }
  return ledger
}

export function onAfterToolRows(state: TurnState, rows: readonly Message[], policies: TurnPolicies): Transition {
  const d = openDraft(state)
  for (const row of rows) emit(d, row, 'context')
  const results = [...state.stepResults, ...rows]
  patchState(d, { stepResults: results })
  const ledger = state.loopLedger ? countFailures(state.loopLedger, results) : undefined
  patchState(d, { loopLedger: ledger })
  // The recovery request still called tools: the limit already tripped.
  if (ledger?.pendingMaxFailuresExit && results.length > 0) {
    finish(d, { reason: TERMINAL_MAX_FAILURES, consecutiveFailures: ledger.failureStreak, turnCount: state.k })
    return seal(d)
  }
  if (state.pendingHalts.length > 0) {
    finish(d, { reason: TERMINAL_AWAITING_USER, pendingToolUses: state.pendingHalts })
    return seal(d)
  }
  // Decided before the drain: with no request left, drained input would be
  // marked delivered and never answered.
  const { reached } = policies.stepBudget({ k: state.k, maxTurns: state.limits.maxTurns })
  request(d, { kind: 'drainQueuedInput', planModeAttachment: reached })
  return seal(d)
}

export function onDrained(state: TurnState, rows: readonly Message[], policies: TurnPolicies): Transition {
  // `turn.continue`: the drained input waits for the chain.
  if (holdsDrainedInput(state, policies)) return holdDrainedInput(state, rows)
  const d = openDraft(state)
  for (const row of rows) emit(d, row, 'user')
  const results = [...state.stepResults, ...rows]
  patchState(d, { stepResults: results })
  const { maxTurns } = state.limits
  const { reached } = policies.stepBudget({ k: state.k, maxTurns })
  if (reached && maxTurns) {
    emit(d, stepBudgetRow(d, maxTurns, state.k + 1), 'system')
    finish(d, { reason: TERMINAL_MAX_TURNS, turnCount: state.k + 1 })
    return seal(d)
  }
  const next = [...state.messages, ...state.stepReplies, ...results]
  patchState(d, { pendingMessages: next })
  request(d, { kind: 'refreshPromptContext', messages: next, toolCalls: state.stepToolCalls, k: state.k })
  return seal(d)
}

export function onRefreshed(
  state: TurnState,
  event: Extract<TurnEvent, { type: 'promptContextRefreshed' }>,
  policies: TurnPolicies,
): Transition {
  // `turn.continue`: the pending pieces go through the chain first.
  if (state.continueRaised) return raiseTurnContinue(state, event, policies)
  const d = openDraft(state)
  const injected = [...event.injected]
  for (const row of injected) emit(d, row, 'context')
  const ledger = state.loopLedger
  const choice = ledger ? policies.chooseNudge({ k: state.k, maxTurns: state.limits.maxTurns, loopLedger: ledger }) : undefined
  if (ledger && choice) {
    patchState(d, { loopLedger: latchNudge(ledger, choice) })
    const row = nudgeRow(d, choice.text)
    injected.push(row)
    // Model-visible means recorded: the nudge is a meta row like any other.
    emit(d, row, 'nudge')
  }
  patchState(d, {
    ...(event.instructions ?? {}),
    messages: [...(state.pendingMessages ?? state.messages), ...injected],
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
