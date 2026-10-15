// Wire types for the C++-side `session` capability hosted by
// `NexusSessionBridgeAdapter`.

import type { OnStopReason } from '../../../runtime/interfaces/PlatformCapabilities'
import type { BrowserLlmSelection } from './nexus_llm'

// Per-session metadata carried alongside lifecycle calls. Mirrors
// `BrowserHostedToolExecutionContext` but kept here-local because the
// session capability owns its own typed wire contract.
export type SessionExecutionContext = {
  sessionId?: string
  providerId?: string
  modelId?: string
}

export type SessionBridgeCapabilityMap = {
  session: {
    // Notify the host that an LLM session has stopped. Idempotent: a second call
    // for the same `sessionId` returns `stopped: false`. Only `'session_deleted'`
    // erases the ToolSession (closing its tagged tabs).
    onStop: {
      payload: {
        // Typed reason — see `OnStopReason` in PlatformCapabilities.ts.
        // Empty / missing falls through to 'user_stopped' on the C++
        // side via `nexus::ParseOnStopReason`.
        reason?: OnStopReason
        executionContext?: SessionExecutionContext
        // Legacy top-level field. Older guests may not carry an
        // `executionContext` block. The C++ adapter accepts both
        // shapes; new code paths always populate `executionContext`.
        sessionId?: string
      }
      result: {
        ok: true
        // True iff the session was live before this call ran.
        // Useful for distinguishing "actually stopped something"
        // from "no-op (session already absent)".
        stopped: boolean
      }
    }
    // Push agent-loop runtime tunables onto the matching
    // `ToolSession`. Forward-compatible: an older C++ build without
    // the handler returns a not-found error which the only JS caller
    // (`QueryEngine.pushAgentLoopSettingsToHost`) silently swallows.
    //
    // Phase 12f: moved off the manual `browser.setAgentLoopSettings`
    // handler in `tools_adapter.cc` onto this codegen-driven
    // capability. The wire shape is unchanged.
    setAgentLoopSettings: {
      payload: {
        // Per-action wall-clock budget (ms). Default 180000.
        actionTimeoutMs?: number
        // Optional default cwd for shell-style tools (Bash / Glob /
        // Grep / Read / Write / Edit). Must be absolute; relative
        // paths are silently ignored on the C++ side.
        cwd?: string
        // Clear native Read/Edit/Write read-state after /compact or /clear.
        clearReadState?: boolean
        // T0-c new-guest handshake: allow the host to short-circuit an
        // unchanged browser observation to an `{unchanged, count}` stub.
        // Sent on every push; an old host ignores the unknown field.
        browserObservationDiffOptIn?: boolean
        // T0-c staleness signal: mark the browser observation cache stale
        // so the next observation is re-sent full. Sent on the first settings
        // push of each QueryEngine instance (session open / restore / fork),
        // and from /clear, /compact and autocompact. Not from Try-again,
        // which resumes in place.
        clearBrowserObservationCache?: boolean
        executionContext?: SessionExecutionContext
        sessionId?: string
      }
      result: {
        ok: true
        // Echoed back so JS can confirm what the host actually applied
        // after C++-side clamping / validation.
        appliedActionTimeoutMs?: number
        appliedCwd?: string
      }
    }
    // Report the active chat session (boot + every switch); the host foregrounds one
    // of its tabs in the kNexus window, never creating a ToolSession or stealing focus
    // across windows. Not `setActive`: C++ codegen already owns `SetActiveInput`.
    setActiveSession: {
      payload: { sessionId: string }
      result: {
        ok: true
        // True iff a kNexus-window tab was brought to the foreground.
        activated: boolean
        // Session-owned tabs hosted in the kNexus window — the count
        // that gates webview_area visibility.
        nexusTabCount: number
        // All session-owned tabs across this profile's windows.
        totalTabCount: number
      }
    }
  }
}

/**
 * Host-pushed `browser.sessionTabsChanged` event payload, emitted whenever a
 * session's tab counts change. Subscribe via `subscribeSessionTabsChanged`.
 */
export type SessionTabsChangedEvent = {
  sessionId: string
  nexusTabCount: number
  totalTabCount: number
}

// Re-export BrowserLlmSelection so consumers that import from this module
// don't have to drill into nexus_llm.
export type { BrowserLlmSelection }
