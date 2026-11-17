/**
 * Session activity on the native hook tier (F-26): the session registry learns
 * when a tool starts and ends (the topbar pill, the session-list summary, the
 * per-tool counter in meta.json) and when a submission streams. Outer links: they
 * see every call, whatever a mod answers. These are not the settings lifecycle
 * hooks.
 */
import type { NativeHookRegistration } from '../../toolkit/nativeHooks'
import type { ToolCallContext } from '../../toolkit/toolCallContext'
import {
  NATIVE_EVENTS,
  type ToolSettledEvent,
  type ToolStartedEvent,
  type TurnStreamEvent,
} from '../../toolkit/nativeHookEvents'
import type { AgentToolKind as ToolKind } from './AgentTurnState'
import { getActiveSessionManager } from './SharedWorkerSessionManager'

export const SESSION_ACTIVITY_MODULE = 'sessionActivity'

const MCP_TOOL_NAME_PREFIX = 'mcp__'

function inferToolKind(toolName: string): ToolKind {
  if (toolName.startsWith(MCP_TOOL_NAME_PREFIX)) return 'mcp'
  // Browser tools are per-action (`BrowserNavigate`, `BrowserClick`, …) and
  // share the `Browser` prefix.
  if (toolName.startsWith('Browser')) return 'browser'
  return 'local'
}

function extractActionType(toolName: string, toolInput: unknown): string | undefined {
  if (toolName !== 'browser_actions') return undefined
  if (!toolInput || typeof toolInput !== 'object') return undefined
  const input = toolInput as Record<string, unknown>
  // Single form: { action: { type } }.
  const action = input.action
  if (action && typeof action === 'object') {
    const t = (action as Record<string, unknown>).type
    if (typeof t === 'string') return t
  }
  // Batched form: { actions: [{ type }, …] }; the first stands for the batch.
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

function markToolStarted(e: unknown, live: unknown): void {
  const { toolName, input } = e as ToolStartedEvent
  const sessionId = (live as ToolCallContext).options?.sessionId
  if (!sessionId) return
  const manager = getActiveSessionManager()
  if (!manager) return
  manager.markToolStart(sessionId, toolName, inferToolKind(toolName), extractActionType(toolName, input))
}

async function markToolSettled(e: unknown, live: unknown): Promise<void> {
  const { succeeded } = e as ToolSettledEvent
  const sessionId = (live as ToolCallContext).options?.sessionId
  const manager = getActiveSessionManager()
  if (sessionId && manager) await manager.markToolEnd(sessionId, succeeded)
}

function markStream(edge: 'start' | 'end') {
  return (e: unknown) => {
    const { sessionId } = e as TurnStreamEvent
    if (!sessionId) return
    const manager = getActiveSessionManager()
    if (edge === 'start') manager?.markStreamStart(sessionId)
    else manager?.markStreamEnd(sessionId)
  }
}

export function sessionActivityHooks(): NativeHookRegistration[] {
  const base = { module: SESSION_ACTIVITY_MODULE, scope: 'all' } as const
  return [
    { ...base, event: NATIVE_EVENTS.toolStarted, position: 'outer', observe: markToolStarted },
    { ...base, event: NATIVE_EVENTS.toolSettled, position: 'outer', observe: markToolSettled },
    { ...base, event: NATIVE_EVENTS.turnStreamStart, observe: markStream('start') },
    { ...base, event: NATIVE_EVENTS.turnStreamEnd, observe: markStream('end') },
  ]
}
