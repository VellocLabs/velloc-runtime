/**
 * Contract: the ten terminal reasons of a turn and its phase (F-26); types only. `reason` strings and
 * payloads match the loop's `TERMINAL_*` values (`'awaiting_user_interaction'`, `'aborted_streaming'`).
 */
import type {
  TERMINAL_ABORTED,
  TERMINAL_API_ERROR,
  TERMINAL_AWAITING_USER,
  TERMINAL_COMPLETED,
  TERMINAL_MAX_FAILURES,
  TERMINAL_MAX_OUTPUT_TOKENS,
  TERMINAL_MAX_TURNS,
  TERMINAL_PROMPT_REJECTED,
  TERMINAL_PROMPT_TOO_LONG,
  TERMINAL_STOP_HOOK_PREVENTED,
} from '../runtime/VercelModelConstants'
import type { PendingToolUse } from '../toolkit/run/executeToolCall'

/** No tool calls and the stop hooks allowed the end (L2.8). */
export type CompletedOutcome = { readonly reason: typeof TERMINAL_COMPLETED }

/** A tool call halted for the user (L2.15); the halts are kept for the resume. */
export type AwaitingUserOutcome = {
  readonly reason: typeof TERMINAL_AWAITING_USER
  readonly pendingToolUses: readonly PendingToolUse[]
}

/** Cancelled in the stream (L2.6) or during the tool batch (L2.11). */
export type AbortedOutcome = { readonly reason: typeof TERMINAL_ABORTED }

/** A UserPromptSubmit hook blocked the prompt (L2.A). */
export type PromptRejectedOutcome = { readonly reason: typeof TERMINAL_PROMPT_REJECTED }

/** Over the blocking limit after fitting (L2.4), or the model said so (L2.6). */
export type PromptTooLongOutcome = {
  readonly reason: typeof TERMINAL_PROMPT_TOO_LONG
  readonly turnCount: number
}

/** Truncated after the escalation and the three resumes (L2.6). */
export type OutputCapOutcome = {
  readonly reason: typeof TERMINAL_MAX_OUTPUT_TOKENS
  readonly turnCount: number
  /** E2 addition: the resumes spent (the recorded terminal carries it). */
  readonly recoveryCount: number
}

/** Retries spent (L4.4 → L2.6). `error` is the assistant row's error text. */
export type ApiErrorOutcome = {
  readonly reason: typeof TERMINAL_API_ERROR
  readonly turnCount: number
  readonly error?: string
}

/** A Stop hook prevented continuation (L2.8). Counted as a successful end. */
export type StopHookPreventedOutcome = { readonly reason: typeof TERMINAL_STOP_HOOK_PREVENTED }

/** The failure limit latched and the forced final step ended (L2.8), or the
 *  recovery step still called tools (L2.14). */
export type FailureLimitOutcome = {
  readonly reason: typeof TERMINAL_MAX_FAILURES
  readonly consecutiveFailures: number
  readonly turnCount: number
}

/** The step budget was reached (L2.16). `turnCount` is the step that would
 *  have come next. Counted as a successful end. */
export type StepBudgetOutcome = {
  readonly reason: typeof TERMINAL_MAX_TURNS
  readonly turnCount: number
}

/** The ten terminal reasons. Closed: no other exists, every turn has one. */
export type TurnOutcome =
  | CompletedOutcome
  | AwaitingUserOutcome
  | AbortedOutcome
  | PromptRejectedOutcome
  | PromptTooLongOutcome
  | OutputCapOutcome
  | ApiErrorOutcome
  | StopHookPreventedOutcome
  | FailureLimitOutcome
  | StepBudgetOutcome

export type TurnOutcomeReason = TurnOutcome['reason']

/**
 * Where a turn is. `running` is the only non-terminal phase; the move from it
 * to any other happens in exactly one transition, the one that emits
 * `commitTerminal`.
 */
export type TurnPhase = 'running' | 'awaiting_user' | 'completed' | 'failed' | 'aborted'

export type TerminalPhase = Exclude<TurnPhase, 'running'>

/**
 * The terminal phase each outcome lands in. Decided here so the mapping is
 * part of the frozen contract (the spec names the phases, not the mapping):
 * the three ends the result row reports as `success` are `completed`; a halt
 * is `awaiting_user`; a cancellation is `aborted`; every `error_*` end is
 * `failed`. A crash (thrown error) has no outcome and is also `failed`.
 */
export type PhaseOfOutcome<R extends TurnOutcomeReason> =
  R extends typeof TERMINAL_COMPLETED | typeof TERMINAL_STOP_HOOK_PREVENTED | typeof TERMINAL_MAX_TURNS
    ? 'completed'
    : R extends typeof TERMINAL_AWAITING_USER
      ? 'awaiting_user'
      : R extends typeof TERMINAL_ABORTED
        ? 'aborted'
        : 'failed'

/**
 * What `commitTerminal` commits: one of the ten outcomes, or a crash. A crash
 * keeps the outcome set closed — it is not an eleventh reason; it is the
 * `failed` phase with the thrown error, rethrown after the commit (F-26).
 */
export type TurnConclusion =
  | { readonly kind: 'outcome'; readonly phase: TerminalPhase; readonly outcome: TurnOutcome }
  | { readonly kind: 'crash'; readonly phase: 'failed'; readonly error: unknown }
