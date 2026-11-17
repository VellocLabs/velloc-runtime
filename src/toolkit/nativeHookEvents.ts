/**
 * Contract: the events the engine and the toolkit raise on the native hook tier
 * (F-26), with the payload (`e`) and the live object each carries.
 */
import type { AgentToolMeta } from './toolContract'

export const NATIVE_EVENTS = Object.freeze({
  /** Outer, observe. A call of a tool batch is about to run. live: ToolCallContext. */
  toolStarted: 'tool.started',
  /** Outer, observe. That call is closed, however it ended. live: ToolCallContext. */
  toolSettled: 'tool.settled',
  /** Observe. A submission starts streaming. live: none. */
  turnStreamStart: 'turn.streamStart',
  /** Observe. That submission stopped streaming, however it ended. live: none. */
  turnStreamEnd: 'turn.streamEnd',
} as const)

export type ToolStartedEvent = { toolName: string; input: unknown }
export type ToolSettledEvent = {
  toolName: string
  agentMeta: AgentToolMeta | undefined
  succeeded: boolean
}
export type TurnStreamEvent = { sessionId: string }
