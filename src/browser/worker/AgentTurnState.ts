/**
 * Shared agent session phase and tool types.
 *
 * These types describe the execution state of a session turn.
 * They are used by both the AgentRuntimeWorker (which owns the state)
 * and the SharedWorkerSessionManager (which reads it for UI projection).
 */

export type AgentToolKind = 'browser' | 'local' | 'mcp'

export type AgentSessionToolInfo = {
  name: string
  kind: AgentToolKind
  actionType?: string
}

/**
 * Unified per-session execution state. The top level drives the composer gate (input only when
 * `idle`); `AgentRunningSubState` is display-only. A RETRY stays `running`, so the composer stays disabled.
 */
export type AgentSessionPhase =
  | { kind: 'idle' }
  | { kind: 'running'; sub: AgentRunningSubState }

/**
 * What a `running` session is doing. Display-only — never gates the composer
 * (that's `kind === 'idle'`). `tools` carries the full in-flight stack so
 * concurrent tools (executeToolCalls parallel batches) are represented; the topbar shows
 * the LAST entry, mirroring the old single-slot `inflight` display.
 */
export type AgentRunningSubState =
  | { type: 'streaming' }
  | { type: 'tools'; tools: AgentSessionToolInfo[] }
  | {
      type: 'retry'
      attempt: number
      maxRetries: number
      deadlineMs: number
      errorKind?: string
      /**
       * Catalog key of the classification title
       * (`ProviderConnectivityIssue.titleKey`, e.g. resolves to "Provider
       * rate limit reached" in `en`) — resolved by `t()` at render time.
       */
      errorTitleKey?: string
      /** Legacy pre-i18n classification text from old workers. Read-only. */
      errorTitle?: string
      /** The provider's own error text (`ProviderConnectivityIssue.detail`). */
      errorDetail?: string
    }
