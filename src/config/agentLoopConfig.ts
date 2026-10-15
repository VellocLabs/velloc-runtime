// Agent-loop runtime tunables. Single source of truth for the soft loop
// detector, multi-act guards, the action budget, and force-done
// thresholds. Wired through `QueryEngineConfig.agentLoopSettings` and
// merged with `defaultAgentLoopSettings()` at engine construction.
//
// `action_timeout_ms` is also pushed to the C++ ToolSession via the
// bridge so per-tool wall-clock enforcement happens native-side; the
// other knobs are JS-only.

/**
 * LLM-driven history compaction (F-3): fires on token pressure and folds the
 * pre-boundary history into one summary message. The threshold is per-model
 * (`foldTriggerTokens`); the summary is capped by `SUMMARY_REPLY_CAP`.
 */
export type MessageCompactionSettings = {
  /** Master switch — `false` disables autocompaction entirely. */
  enabled: boolean
  /**
   * Optional override of the token-pressure threshold (in tokens). When set,
   * the gate fires at this count instead of the model-derived
   * window − output-reserve − buffer. Used by tests to force a
   * compaction.
   */
  autoCompactTokenThreshold?: number
}

export type AgentLoopSettings = {
  /** Stop the loop after this many *consecutive* tool-result errors. */
  maxFailures: number
  /** Soft cap suggested by the system prompt. Not enforced JS-side. */
  maxActionsPerStep: number
  /** Wall-clock budget for one tool action; sent to C++. */
  actionTimeoutMs: number
  /** Rolling window for action-hash repeat counting. */
  loopDetectionWindow: number
  /** Repeat-count thresholds at which loop nudges escalate. */
  repeatThresholds: readonly [number, number, number]
  /** Consecutive-stagnant-page threshold for the stagnation nudge. */
  stagnationThreshold: number
  /** Fraction of `maxTurns` at which the budget warning fires once. */
  budgetWarnFraction: number
  /** Master switch for the soft loop detector. */
  loopDetectionEnabled: boolean
  /** Allow one done-only response after max_failures before terminating. */
  finalResponseAfterFailure: boolean
  /** Browser-use mechanism #3 — LLM-driven history compaction. */
  messageCompaction: MessageCompactionSettings
}

export function defaultMessageCompactionSettings(): MessageCompactionSettings {
  return {
    enabled: true,
  }
}

export function defaultAgentLoopSettings(): AgentLoopSettings {
  return {
    maxFailures: 5,
    maxActionsPerStep: 5,
    actionTimeoutMs: 180_000,
    loopDetectionWindow: 20,
    repeatThresholds: [5, 8, 12] as const,
    stagnationThreshold: 5,
    budgetWarnFraction: 0.75,
    loopDetectionEnabled: true,
    finalResponseAfterFailure: true,
    messageCompaction: defaultMessageCompactionSettings(),
  }
}

export function mergeAgentLoopSettings(
  overrides: Partial<AgentLoopSettings> | undefined,
): AgentLoopSettings {
  if (!overrides) {
    return defaultAgentLoopSettings()
  }
  // `messageCompaction` is a nested object — shallow spread would replace the
  // whole thing if the caller only set one field. Merge the sub-object so
  // callers can pass `{messageCompaction: {enabled: false}}` and keep the
  // other defaults.
  const merged: AgentLoopSettings = { ...defaultAgentLoopSettings(), ...overrides }
  if (overrides.messageCompaction) {
    merged.messageCompaction = {
      ...defaultMessageCompactionSettings(),
      ...overrides.messageCompaction,
    }
  }
  return merged
}
