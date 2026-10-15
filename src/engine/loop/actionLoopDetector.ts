// Soft loop detector over C++-computed action hashes and page fingerprints. `getNudge()` returns the
// highest-priority newly crossed nudge, once per level until reset. It never blocks the model.

import {
  type AgentLoopState,
  fingerprintsEqual,
  type PageFingerprint,
} from './agentLoopState'
import type { NudgeContext, NudgeKind } from './nudges'

export function recordAction(state: AgentLoopState, hash: string): void {
  if (!state.settings.loopDetectionEnabled) return
  if (!hash) return  // C++ returns empty for exempt tools (wait/done/go_back).

  state.actionHashes.push(hash)
  const overflow = state.actionHashes.length - state.settings.loopDetectionWindow
  if (overflow > 0) {
    state.actionHashes.splice(0, overflow)
  }

  // Recompute most-repeated. Window is small (≤20) so a linear scan is fine.
  const counts = new Map<string, number>()
  for (const h of state.actionHashes) {
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  let topHash: string | null = null
  let topCount = 0
  for (const [h, c] of counts) {
    if (c > topCount) {
      topHash = h
      topCount = c
    }
  }
  state.mostRepeatedHash = topHash
  state.maxRepetitionCount = topCount
}

export function recordPageFingerprint(
  state: AgentLoopState,
  fp: PageFingerprint,
): void {
  if (!state.settings.loopDetectionEnabled) return

  if (fingerprintsEqual(state.lastFingerprint, fp)) {
    state.consecutiveStagnantPages += 1
  } else {
    state.consecutiveStagnantPages = 0
  }
  state.lastFingerprint = fp
}

export function getNudge(
  state: AgentLoopState,
): { kind: NudgeKind; context: NudgeContext } | null {
  if (!state.settings.loopDetectionEnabled) return null

  const [t5, t8, t12] = state.settings.repeatThresholds
  const repCtx: NudgeContext = {
    repetitionCount: state.maxRepetitionCount,
    windowSize: state.actionHashes.length,
  }

  // Highest-priority nudge wins, but each nudge level is only emitted
  // once per "level entry" — clearing lastNudgeKind to null is the way
  // to reset.
  if (state.maxRepetitionCount >= t12 && state.lastNudgeKind !== 'LOOP_12') {
    state.lastNudgeKind = 'LOOP_12'
    return { kind: 'LOOP_12', context: repCtx }
  }
  if (
    state.maxRepetitionCount >= t8 &&
    state.maxRepetitionCount < t12 &&
    state.lastNudgeKind !== 'LOOP_8' &&
    state.lastNudgeKind !== 'LOOP_12'
  ) {
    state.lastNudgeKind = 'LOOP_8'
    return { kind: 'LOOP_8', context: repCtx }
  }
  if (
    state.maxRepetitionCount >= t5 &&
    state.maxRepetitionCount < t8 &&
    state.lastNudgeKind !== 'LOOP_5' &&
    state.lastNudgeKind !== 'LOOP_8' &&
    state.lastNudgeKind !== 'LOOP_12'
  ) {
    state.lastNudgeKind = 'LOOP_5'
    return { kind: 'LOOP_5', context: repCtx }
  }

  if (
    state.consecutiveStagnantPages >= state.settings.stagnationThreshold &&
    state.lastNudgeKind !== 'STAGNATION_5'
  ) {
    state.lastNudgeKind = 'STAGNATION_5'
    return {
      kind: 'STAGNATION_5',
      context: { stagnantPages: state.consecutiveStagnantPages },
    }
  }

  return null
}

export function reset(state: AgentLoopState): void {
  state.actionHashes = []
  state.lastFingerprint = null
  state.pendingFingerprint = null
  state.consecutiveStagnantPages = 0
  state.failureStreak = 0
  state.mostRepeatedHash = null
  state.maxRepetitionCount = 0
  state.forceFinalResponse = false
  state.pendingMaxFailuresExit = false
  state.budgetWarnFired = false
  state.lastNudgeKind = null
  state.countedFailureToolCallIds.clear()
}
