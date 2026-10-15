/**
 * Opening a model request: the failure-limit latch and the forced final
 * reply, the request-start marker, fitting the context (the summarizer runs
 * as an effect; the machine reacts to a compaction and checks the blocking
 * limit), and the request itself.
 */
import type { Message } from '../runtime/RuntimeTypes'
import { TERMINAL_PROMPT_TOO_LONG } from '../runtime/VercelModelConstants'
import { estimateTranscriptTokens } from './tokenCounts'
import type { LoopLedger, RefreshedInstructions, TurnEvent, TurnPolicies, TurnState, Transition } from './turnEffects'
import { REQUEST_START_ROW, overLimitReply } from './turnRows'
import { emit, finish, openDraft, patchState, request, seal, type Draft } from './turnStep'

/** Host settings pushed after a compaction: the read ledger is gone, and the
 *  next page observation must be complete. */
export const AFTER_COMPACTION_HOST_FIELDS = {
  clearReadState: true,
  browserObservationDiffOptIn: true,
  clearBrowserObservationCache: true,
} as const

function finalReplyDue(state: TurnState, policies: TurnPolicies): boolean {
  const budget = policies.stepBudget({ k: state.k, maxTurns: state.limits.maxTurns })
  return state.loopLedger?.forceFinalResponse === true || budget.lastStep
}

/** Latches the failure limit: once the streak reaches the limit, one more
 *  request runs, tool-less, and the turn then ends as `max_failures`. */
function latchFailureLimit(ledger: LoopLedger | undefined): LoopLedger | undefined {
  if (!ledger) return ledger
  if (ledger.failureStreak < ledger.settings.maxFailures || ledger.pendingMaxFailuresExit) return ledger
  return { ...ledger, pendingMaxFailuresExit: true, forceFinalResponse: true }
}

export function openRequest(d: Draft, policies: TurnPolicies): void {
  patchState(d, {
    loopLedger: latchFailureLimit(d.state.loopLedger),
    stepReplies: [],
    stepToolCalls: [],
    stepResults: [],
    pendingHalts: [],
    pendingMessages: undefined,
  })
  const ledger = d.state.loopLedger
  if (ledger && !ledger.forceFinalResponse && finalReplyDue(d.state, policies)) {
    patchState(d, { loopLedger: { ...ledger, forceFinalResponse: true } })
  }
  emit(d, REQUEST_START_ROW, 'system')
  request(d, {
    kind: 'summarizeForCompaction',
    messages: d.state.messages,
    autoCompactLedger: d.state.autoCompactLedger,
  })
}

export function onContextFitted(
  state: TurnState,
  event: Extract<TurnEvent, { type: 'contextFitted' }>,
  policies: TurnPolicies,
): Transition {
  const d = openDraft(state)
  patchState(d, { messages: event.messages, autoCompactLedger: event.autoCompactLedger ?? state.autoCompactLedger })
  if (event.compacted) {
    // The summary replaces the history; what was read before it is forgotten.
    patchState(d, { messages: event.rows, fileReadLedger: new Map(), nestedMemoryPathsSeen: new Set() })
    request(d, { kind: 'pushHostSettings', fields: AFTER_COMPACTION_HOST_FIELDS })
    request(d, { kind: 'gatherRows', stage: 'afterCompaction', messages: event.rows })
    return seal(d)
  }
  const choice = policies.fitContext({
    estimatedTokens: estimateTranscriptTokens(event.messages as Message[]),
    contextWindow: state.limits.blockingLimitTokens ?? Number.POSITIVE_INFINITY,
    autoCompactLedger: d.state.autoCompactLedger,
  })
  if (choice === 'overBlockingLimit') {
    emit(d, overLimitReply(d, state.limits.servingModel), 'system')
    finish(d, { reason: TERMINAL_PROMPT_TOO_LONG, turnCount: state.k })
    return seal(d)
  }
  issueModelRequest(d, policies)
  return seal(d)
}

/** The plan rows and read restore are in: the compacted rows go out, under
 *  the prompt rendered again after the boundary when there is one. */
export function onCompactionRows(
  state: TurnState,
  rows: readonly Message[],
  policies: TurnPolicies,
  instructions?: RefreshedInstructions,
): Transition {
  const d = openDraft(state)
  const all = [...state.messages, ...rows]
  for (const row of all) emit(d, row, 'context')
  patchState(d, { ...(instructions ?? {}), messages: all })
  issueModelRequest(d, policies)
  return seal(d)
}

export function issueModelRequest(d: Draft, policies: TurnPolicies): void {
  const s = d.state
  request(d, {
    kind: 'requestModel',
    k: s.k,
    messages: s.messages,
    baseInstructions: s.baseInstructions,
    userAmbient: s.userAmbient,
    systemAmbient: s.systemAmbient,
    tools: s.visibleTools,
    outputTokenCapOverride: s.outputTokenCapOverride,
    finalResponse: finalReplyDue(s, policies),
  })
}
