import type { BrowserNetworkOperations } from '../../utils/BrowserNetworkOperations'

// Snapshot-only carrier types, kept because `BrowserContextSnapshot` names them.
// `session.onStop` reasons, mirroring C++ `nexus::OnStopReason` (unknown
// strings parse as `kUserStopped`): 'completed' and 'user_stopped' keep the
// ToolSession warm; 'session_deleted' erases it and closes its tabs.
export type OnStopReason = 'completed' | 'user_stopped' | 'session_deleted'

export type BrowserTab = {
  id: string
  windowId?: string
  url?: string
  title?: string
  active?: boolean
}

export type DOMSnapshotResult = {
  tabId?: string
  selector?: string
  content: string
}

export type AccessibilitySnapshotResult = {
  tabId?: string
  nodes: Array<Record<string, unknown>>
}

export interface PlatformCapabilities {
  // C++ `browser` capability (`ToolsAdapter`): `callTool` dispatches one
  // model-facing browser tool and returns `{ data, agent_meta }`. Optional.
  browser?: {
    callTool(params: {
      name: string
      args: Record<string, unknown>
      executionContext?: { sessionId?: string; providerId?: string; modelId?: string }
      onProgress?: (progress: unknown) => void
    }): Promise<unknown>
  }
  // C++ `session` capability: `onStop({sessionId, reason})` runs the idempotent
  // OnStop cascade; `setAgentLoopSettings` pushes per-session budgets
  // (best-effort; an older host's not-found is ignored). Optional.
  session?: {
    onStop(params: {
      sessionId?: string
      reason?: OnStopReason
    }): Promise<{ ok: true; stopped: boolean }>
    setAgentLoopSettings?(params: {
      actionTimeoutMs?: number
      cwd?: string
      clearReadState?: boolean
      browserObservationDiffOptIn?: boolean
      clearBrowserObservationCache?: boolean
      executionContext?: { sessionId?: string }
    }): Promise<{
      ok: true
      appliedActionTimeoutMs?: number
      appliedCwd?: string
    }>
  }
  // C++ `network` capability, WebFetch's fetch surface, reached on the runtime's
  // own host bridge, never a module-global slot. Optional; WebFetch reports it
  // missing.
  network?: BrowserNetworkOperations
  // Whether the host's LLM bridge takes a `document` part at the top level of
  // a message (the bootstrap manifest's `llmDocumentParts`). The @-mention
  // step inlines a small PDF only when this is true; an older binary rejects
  // the part and would fail the whole turn. Optional: absent means no.
  supportsLlmDocumentParts?(): boolean
  // The browser process's own environment variables (`shell.env`: any names,
  // read-only, null = unset) — what `process.env` is to a Node process. NOT the
  // host shell's environment, which is the safe allowlist
  // (`SafeCommandPolicy::InheritedEnvNames`). Rejects with
  // `NativePrimitiveUnsupportedError` on a host that predates `shell.env`.
  // Optional: tests / non-browser runtimes have no host process.
  readHostEnv?(names: string[]): Promise<Record<string, string | null>>
}
