/**
 * Security: the step-list tools (F-41) belong to the main conversation. A loop
 * under the session — a sub-agent, a fork that keeps the parent's exact tool
 * list, a teammate — may still list them; each call it makes is denied at the
 * permission gate, so the tool never runs and the board is never written.
 * The server's own nested-caller check stays as the second line.
 */
import type { ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { NESTED_CALLER_NOTE, isNestedCaller } from '../sessions/sessionTurnServer'
import { TURN_BOARD_TOOL_NAMES } from '../toolkit/builtin/toolGroups'

const TURN_BOARD_TOOLS: ReadonlySet<string> = new Set(TURN_BOARD_TOOL_NAMES)

/** The denial text for `tool` called from `context`, or null when the call may go on. */
export function nestedTurnBoardDenial(tool: ToolContract, context: ToolCallContext): string | null {
  if (!TURN_BOARD_TOOLS.has(tool.name)) return null
  return isNestedCaller(context) ? NESTED_CALLER_NOTE : null
}
