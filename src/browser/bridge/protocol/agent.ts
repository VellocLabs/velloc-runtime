/**
 * Bridge namespace: `agent` — the `agent` section of `~/.velloc/settings.json`,
 * owned by the SharedWorker. `snapshot` merges defaults (`source` = ever saved);
 * `setField` rejects invalid input; `setModel` writes the GLOBAL default model +
 * effort. `agent.changed` `{ values, model }` follows every write (`null` = none).
 */

export type NexusAgentSettingsKey =
  | 'maxTurns'
  | 'log'
  | 'trace'

/**
 * Snapshot result. `values` is the EFFECTIVE map — fields the user
 * has not overridden inherit the runtime default. Saves the UI a
 * merge step. `overridden` lists ids the user has explicitly set so
 * the UI can render a "reset to default" affordance.
 */
/** The global default selection as `agent.model` stores it. */
export type AgentGlobalModel = {
  providerId: string
  modelId: string
  thinkingTier?: string
}

/** The `agent.changed` payload: effective values plus the global default
 *  model as of this write (`null` = none saved). */
export type AgentChangedPayload = {
  values: { maxTurns: number; log: boolean; trace: boolean }
  model: AgentGlobalModel | null
}

export type AgentBridgeActionMap = {
  snapshot: {
    payload: Record<string, never>
    result: {
      /** Effective merged values — user overrides on top of runtime
       *  defaults. Always populated for every known key. */
      values: {
        maxTurns: number
        log: boolean
        trace: boolean
      }
      /** Sparse: only fields the user has explicitly written. The UI
       *  reads `values[k]` for the displayed value and
       *  `overridden[k]` for the "is this customised?" affordance. */
      overridden: Partial<{
        maxTurns: boolean
        log: boolean
        trace: boolean
      }>
      /** `'file'` once the settings file has an `agent` section,
       *  `'default'` before the first write. */
      source: 'file' | 'default'
      /** The GLOBAL default model + effort for new sessions — the last
       *  topbar pick (`agent.model`, written by `agent/setModel`). Absent
       *  until the user has picked once; new sessions then take the
       *  catalog default. A composer effort change is per-session and
       *  never lands here. */
      model?: AgentGlobalModel
    }
  }
  setField: {
    payload: {
      /** Sparse: only changed fields. A value of `null` clears the
       *  user's override and reverts the field to its runtime
       *  default (mirrors features' sparse-write convention). */
      patch: {
        maxTurns?: number | null
        log?: boolean | null
        trace?: boolean | null
      }
    }
    result: {
      ok: true
      /** Effective map after the patch — same shape as
       *  `snapshot.result.values`. Saves the UI one round-trip. */
      values: {
        maxTurns: number
        log: boolean
        trace: boolean
      }
    }
  }
  setModel: {
    payload: {
      /** The new global default — a topbar pick, or the host's
       *  profile-wide `session.applyAgentConfig` push. */
      model: AgentGlobalModel
    }
    result: { ok: true; model: AgentGlobalModel }
  }
}
