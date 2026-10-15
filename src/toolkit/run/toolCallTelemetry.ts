// Tool-call telemetry: the bracket around each call in a batch.
//
// Before a call, the session registry marks the tool in flight (the topbar
// pill and the session-list summary read it). After it, the registry records
// the end and its success, and the host tool's agent metadata feeds the
// action-loop detector and the page fingerprint the next step compares.
// These are not the settings lifecycle hooks (`toolLifecycleHooks.ts`).

import type { AgentToolMeta } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { recordAction } from '../../engine/loop/actionLoopDetector'
import { getActiveSessionManager } from '../../browser/worker/SharedWorkerSessionManager'
import type { AgentToolKind as ToolKind } from '../../browser/worker/AgentTurnState'

const MCP_TOOL_NAME_PREFIX = 'mcp__'

function inferToolKind(toolName: string): ToolKind {
  if (toolName.startsWith(MCP_TOOL_NAME_PREFIX)) return 'mcp'
  // Browser tools are per-action (`BrowserNavigate`, `BrowserClick`, …) and
  // share the `Browser` prefix.
  if (toolName.startsWith('Browser')) return 'browser'
  return 'local'
}

function extractActionType(
  toolName: string,
  toolInput: unknown,
): string | undefined {
  if (toolName !== 'browser_actions') return undefined
  if (!toolInput || typeof toolInput !== 'object') return undefined
  const input = toolInput as Record<string, unknown>
  // Pattern A: { action: { type: '...' } } — used by the bridge form.
  const action = input.action
  if (action && typeof action === 'object') {
    const t = (action as Record<string, unknown>).type
    if (typeof t === 'string') return t
  }
  // Pattern B: { actions: [{ type: '...' }, ...] } — batched form. We
  // surface the first action's type as a representative label.
  const actions = input.actions
  if (Array.isArray(actions) && actions.length > 0) {
    const first = actions[0]
    if (first && typeof first === 'object') {
      const t = (first as Record<string, unknown>).type
      if (typeof t === 'string') return t
    }
  }
  return undefined
}

/**
 * PreToolUse — fired immediately before a tool's `call()` is invoked.
 * Sets the registry's inflight tool, which drives the topbar pill via
 * `nexusCurrentSessionState`.
 */
export async function executePreToolUseHook(
  callContext: ToolCallContext,
  toolName: string,
  toolInput?: unknown,
): Promise<void> {
  const sessionId = callContext.options?.sessionId
  if (!sessionId) return
  const manager = getActiveSessionManager()
  if (!manager) return
  const kind = inferToolKind(toolName)
  const actionType = extractActionType(toolName, toolInput)
  manager.markToolStart(sessionId, toolName, kind, actionType)
}

/**
 * PostToolUse: clears the inflight tool and bumps its counter (persisted via
 * `meta.json`), records the host's `actionHashes` in the soft loop detector, and
 * stashes `pageFingerprint` on `state.pendingFingerprint`.
 */
export async function executePostToolUseHook(
  callContext: ToolCallContext,
  _toolName: string,
  agentMeta: AgentToolMeta | undefined,
  success: boolean,
): Promise<void> {
  const sessionId = callContext.options?.sessionId
  const manager = getActiveSessionManager()
  if (sessionId && manager) {
    await manager.markToolEnd(sessionId, success)
  }

  const state = callContext.agentLoopState
  if (!state) return
  if (!agentMeta) return

  if (agentMeta.actionHashes) {
    for (const hash of agentMeta.actionHashes) {
      recordAction(state, hash)
    }
  }
  if (agentMeta.pageFingerprint) {
    state.pendingFingerprint = agentMeta.pageFingerprint
  }
}
