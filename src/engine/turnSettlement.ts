/**
 * Settling a model reply: an output-cap cut (raise the cap once, then ask
 * the model to carry on up to three times, then give up), a too-long prompt,
 * an API failure, a cancellation, and the reply that called no tool (the
 * stop hooks decide whether the turn ends or goes on).
 */
import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import {
  TERMINAL_ABORTED,
  TERMINAL_API_ERROR,
  TERMINAL_COMPLETED,
  TERMINAL_MAX_FAILURES,
  TERMINAL_MAX_OUTPUT_TOKENS,
  TERMINAL_PROMPT_TOO_LONG,
  TERMINAL_STOP_HOOK_BLOCKING,
  TERMINAL_STOP_HOOK_PREVENTED,
} from '../runtime/VercelModelConstants'
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import type { ModelFailureKind, TurnEvent, TurnPolicies, TurnState, Transition } from './turnEffects'
import {
  answerUnansweredCalls,
  interruptionRow,
  outputCapNote,
  replyFailure,
  resultPartsOf,
  stepBudgetRow,
} from './turnRows'
import { emit, finish, idle, openDraft, patchState, request, seal, type Draft } from './turnStep'
import { openRequest } from './turnRequest'
import { runToolsFor } from './turnContinuation'

/** Used when the model's catalog entry names no output ceiling. */
export const FALLBACK_OUTPUT_CEILING = 64_000

function withoutDigest(d: Draft): void {
  patchState(d, { background: d.state.background.filter((b) => b.kind !== 'toolDigest') })
}

export function onModelAnswer(
  state: TurnState,
  replies: readonly ModelReplyRow[],
  toolCalls: readonly QueryToolUseBlock[],
  policies: TurnPolicies,
  reported?: ModelFailureKind,
  reportedError?: string,
): Transition {
  const d = openDraft(state)
  patchState(d, { stepReplies: replies, stepToolCalls: toolCalls })
  const last = replies.at(-1)
  const failure = reported ?? replyFailure(last)
  if (failure === 'aborted') return settleCancellation(d, 'user', replies)
  if (failure === 'output_cap') {
    const choice = policies.recoverOutputCap({
      outputCapRetries: state.outputCapRetries,
      outputTokenCapOverride: state.outputTokenCapOverride,
    })
    if (choice === 'escalate') {
      // Same input again with the model's full output allowance; the cut
      // reply is dropped.
      withoutDigest(d)
      patchState(d, {
        outputTokenCapOverride: state.limits.outputCeilingTokens ?? FALLBACK_OUTPUT_CEILING,
        lastContinuation: { reason: 'max_output_tokens_escalate' },
      })
      openRequest(d, policies)
      return seal(d)
    }
    if (choice === 'resume') {
      withoutDigest(d)
      patchState(d, {
        messages: [...state.messages, ...replies, outputCapNote(d)],
        outputCapRetries: state.outputCapRetries + 1,
        outputTokenCapOverride: undefined,
        lastContinuation: { reason: 'max_output_tokens_recovery' },
      })
      openRequest(d, policies)
      return seal(d)
    }
    failAfterReply(d, replies)
    finish(d, { reason: TERMINAL_MAX_OUTPUT_TOKENS, turnCount: state.k, recoveryCount: state.outputCapRetries })
    return seal(d)
  }
  if (failure === 'prompt_too_long') {
    failAfterReply(d, replies)
    finish(d, { reason: TERMINAL_PROMPT_TOO_LONG, turnCount: state.k })
    return seal(d)
  }
  if (failure === 'api_error') {
    failAfterReply(d, replies)
    const error = reportedError ?? (last as { error?: string } | undefined)?.error
    finish(d, { reason: TERMINAL_API_ERROR, turnCount: state.k, error })
    return seal(d)
  }
  if (state.background.some((b) => b.kind === 'toolDigest')) {
    request(d, { kind: 'awaitBackground', background: 'toolDigest' })
    return seal(d)
  }
  afterReply(d)
  return seal(d)
}

/** An API failure ended the turn: the failure hooks run, unawaited. */
function failAfterReply(d: Draft, replies: readonly ModelReplyRow[]): void {
  const last = replies.at(-1)
  request(d, { kind: 'runStopHooks', event: 'StopFailure', replies: last ? [last] : [] })
}

export function onDigestSettled(state: TurnState, value: unknown): Transition {
  const d = openDraft(state)
  if (value && typeof value === 'object') emit(d, value as Message, 'tool')
  withoutDigest(d)
  afterReply(d)
  return seal(d)
}

function afterReply(d: Draft): void {
  if (d.state.stepToolCalls.length > 0) {
    runToolsFor(d)
    return
  }
  request(d, { kind: 'runStopHooks', event: 'Stop', replies: d.state.stepReplies })
}

export function onStopHandled(
  state: TurnState,
  event: Extract<TurnEvent, { type: 'stopHandled' }>,
  policies: TurnPolicies,
): Transition {
  const d = openDraft(state)
  if (event.preventContinuation) {
    finish(d, { reason: TERMINAL_STOP_HOOK_PREVENTED })
    return seal(d)
  }
  if (event.blockerRows.length > 0) {
    withoutDigest(d)
    patchState(d, {
      messages: [...state.messages, ...state.stepReplies, ...event.blockerRows],
      outputTokenCapOverride: undefined,
      inStopHook: true,
      lastContinuation: { reason: TERMINAL_STOP_HOOK_BLOCKING },
    })
    openRequest(d, policies)
    return seal(d)
  }
  // Read after the stop hooks ran: they reset the ledger, latch included.
  const ledger = state.loopLedger
  if (ledger?.pendingMaxFailuresExit) {
    finish(d, { reason: TERMINAL_MAX_FAILURES, consecutiveFailures: ledger.failureStreak, turnCount: state.k })
    return seal(d)
  }
  finish(d, { reason: TERMINAL_COMPLETED })
  return seal(d)
}

export function onCancelled(state: TurnState, event: Extract<TurnEvent, { type: 'cancelled' }>): Transition {
  if (state.phase !== 'running') return idle(state)
  const d = openDraft(state)
  const partial = event.partial
  if (partial?.type === 'toolBatchDone' || (!partial && state.stepToolCalls.length > 0)) {
    const rows = partial?.type === 'toolBatchDone'
      ? partial.updates.flatMap((u) => (u.kind === 'row' ? [u.message] : []))
      : []
    return settleToolCancellation(d, event.cause, [...state.stepResults, ...rows])
  }
  const replies = partial?.type === 'modelStreamed' || partial?.type === 'modelFailed'
    ? partial.replies
    : state.stepReplies
  return settleCancellation(d, event.cause, replies)
}

function settleCancellation(d: Draft, cause: string, replies: readonly ModelReplyRow[]): Transition {
  const answers = answerUnansweredCalls(d, replies)
  for (const row of answers) emit(d, row, 'system')
  // A follow-up prompt is about to land: it carries the user's intent, so no
  // interruption note is added.
  if (cause !== 'followUp') emit(d, interruptionRow(d, answers.length > 0), 'system')
  finish(d, { reason: TERMINAL_ABORTED })
  return seal(d)
}

function settleToolCancellation(d: Draft, cause: string, results: readonly Message[]): Transition {
  const answered = new Set(results.flatMap((row) => resultPartsOf(row).map((p) => p.toolCallId)))
  const answers = answerUnansweredCalls(d, d.state.stepReplies, answered)
  for (const row of answers) emit(d, row, 'system')
  if (cause !== 'followUp') emit(d, interruptionRow(d, true), 'system')
  const { maxTurns } = d.state.limits
  const nextK = d.state.k + 1
  if (maxTurns && nextK > maxTurns) emit(d, stepBudgetRow(d, maxTurns, nextK), 'system')
  finish(d, { reason: TERMINAL_ABORTED })
  return seal(d)
}
