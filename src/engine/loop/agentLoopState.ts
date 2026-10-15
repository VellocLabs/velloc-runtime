// Per-conversation mutable agent-loop state, one object per engine (never shared). Pure data, no I/O:
// hashing lives C++-side; this stores and compares what `result.agentMeta` returns.

import type { AgentLoopSettings } from '../../config/agentLoopConfig'
import type { NudgeKind } from './nudges'

export type PageFingerprint = {
  url: string
  interactiveCount: number
  domHash: string
}

export type AgentLoopState = {
  /** Rolling window of action_hash strings (length capped by settings). */
  actionHashes: string[]
  /** Most recent recorded fingerprint, used to detect stagnation. */
  lastFingerprint: PageFingerprint | null
  /** Pending fingerprint stashed by the post-tool hook for the next refresh. */
  pendingFingerprint: PageFingerprint | null
  /** Number of consecutive tool calls returning the same fingerprint. */
  consecutiveStagnantPages: number
  /**
   * Consecutive tool-result errors. Failure budget is GLOBAL — we count
   * non-browser tool errors (Bash, FileEdit, …) too, because a stuck
   * non-browser chain should also trip the failure circuit.
   */
  failureStreak: number
  /** Highest-frequency action_hash currently in the window. */
  mostRepeatedHash: string | null
  /** Repeat count of `mostRepeatedHash`. */
  maxRepetitionCount: number
  /**
   * Set true when the next model call must be tools-stripped (last step
   * or max_failures recovery turn). Cleared after the loop exits.
   */
  forceFinalResponse: boolean
  /**
   * Set when the consecutive-failures circuit tripped and we're now
   * letting the model emit one done-only recovery turn before exiting.
   * The next `!needsFollowUp` completion converts to
   * `TERMINAL_MAX_FAILURES` instead of `TERMINAL_COMPLETED` so the
   * caller sees the real exit reason: a final answer after repeated
   * failures is still reported as a failure ending.
   */
  pendingMaxFailuresExit: boolean
  /** Whether the 75% budget warning has already fired this run. */
  budgetWarnFired: boolean
  /**
   * Most recent NudgeKind that fired. Used by `getNudge` to avoid
   * re-firing the same nudge level until thresholds cross again or the
   * detector is reset.
   */
  lastNudgeKind: NudgeKind | null
  /** Tool-call IDs whose error has already been counted. Dedupes. */
  countedFailureToolCallIds: Set<string>
  /** Configuration knobs. Captured at construction for stable reads. */
  settings: AgentLoopSettings
}

export function createAgentLoopState(settings: AgentLoopSettings): AgentLoopState {
  return {
    actionHashes: [],
    lastFingerprint: null,
    pendingFingerprint: null,
    consecutiveStagnantPages: 0,
    failureStreak: 0,
    mostRepeatedHash: null,
    maxRepetitionCount: 0,
    forceFinalResponse: false,
    pendingMaxFailuresExit: false,
    budgetWarnFired: false,
    lastNudgeKind: null,
    countedFailureToolCallIds: new Set(),
    settings,
  }
}

export function fingerprintsEqual(
  a: PageFingerprint | null,
  b: PageFingerprint | null,
): boolean {
  if (!a || !b) return false
  return (
    a.url === b.url &&
    a.interactiveCount === b.interactiveCount &&
    a.domHash === b.domHash
  )
}
