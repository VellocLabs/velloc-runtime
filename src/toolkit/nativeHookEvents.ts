/**
 * Contract: the events the engine and the toolkit raise on the native hook tier
 * (F-26), with the payload (`e`) and the live object each carries.
 */
import type { AgentToolMeta } from './toolContract'
import type { QueryRuntimeDeps, QueryStopHookParams } from '../runtime/interfaces/QueryRuntimeDeps'

export const NATIVE_EVENTS = Object.freeze({
  /** Outer, observe. A call of a tool batch is about to run. live: ToolCallContext. */
  toolStarted: 'tool.started',
  /** Outer, observe. That call is closed, however it ended. live: ToolCallContext. */
  toolSettled: 'tool.settled',
  /** Observe. A submission starts streaming. live: none. */
  turnStreamStart: 'turn.streamStart',
  /** Observe. That submission stopped streaming, however it ended. live: none. */
  turnStreamEnd: 'turn.streamEnd',
  /** Observe. The turn starts background work of `background` kind. live: the turn environment. */
  turnBackground: 'turn.background',
  /** Around, answers rows. Context rows gathered at `stage`; core answers the engine's own.
   *  live: the turn environment. */
  rowsGather: 'rows.gather',
  /** Around, answers a TurnEndVerdict. A turn ends without tool calls; core runs the
   *  loop-counter reset, the turn-end check and the Stop hooks. live: the call context. */
  turnEnd: 'turn.end',
} as const)

export type ToolStartedEvent = { toolName: string; input: unknown }
export type ToolSettledEvent = {
  toolName: string
  agentMeta: AgentToolMeta | undefined
  succeeded: boolean
}
export type TurnStreamEvent = { sessionId: string }
export type TurnBackgroundEvent = { background: string; input: unknown }
export type RowsGatherStage = 'turnStart' | 'afterTools' | 'afterCompaction'
export type RowsGatherEvent = { stage: RowsGatherStage }
export type TurnEndEvent = { params: QueryStopHookParams; logEvent: QueryRuntimeDeps['logEvent'] }
