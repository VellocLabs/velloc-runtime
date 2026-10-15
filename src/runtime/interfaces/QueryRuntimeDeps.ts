import type {
  Message,
  InstructionText,
} from '../RuntimeTypes'
import type {
  AutoCompactResult,
  AutoCompactLedger,
  QueryCompactionContext,
  QueryModelCallParams,
} from '../../engine/turn/modelCallTypes'
import type { ToolCallContext } from '../../toolkit/toolCallContext'
import type { AutoCompactWindowSettings } from '../../context/compaction/windowSettings'
import { PART_TOOL_CALL } from '../VercelModelConstants'

export type TurnOrigin = string

// The model-call and compaction shapes live in `engine/turn/modelCallTypes.ts`
// (the tool-call context needs them too); re-exported here for callers of this
// interface.
export type {
  AutoCompactResult,
  AutoCompactLedger,
  QueryCompactionContext,
  QueryModelCallParams,
} from '../../engine/turn/modelCallTypes'

export type LightTrimOutcome = {
  messages: Message[]
  trimNotes?: Record<string, unknown>
  strippedToolCallIds?: Map<string, string>
}

export type TurnEndVerdict = {
  preventContinuation: boolean
  blockerRows: Message[]
}

export type QueryStopHookParams = {
  messages: Message[]
  assistantMessages: Message[]
  systemPrompt: InstructionText
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolCallContext
  querySource: TurnOrigin
  stopHookActive?: boolean
}

export type QueryToolUseBlock = {
  type: typeof PART_TOOL_CALL
  toolCallId: string
  toolName: string
  args?: unknown
  [key: string]: unknown
}

export type QueuedAttachmentProviderParams = {
  messages: Message[]
  assistantMessages: Message[]
  toolResults: Message[]
  toolUseContext: ToolCallContext
  querySource: TurnOrigin
}

export type ToolUseSummaryParams = {
  assistantMessages: Message[]
  toolUseBlocks: QueryToolUseBlock[]
  toolResults: Message[]
  toolUseContext: ToolCallContext
}

export type QueryRuntimeGatesSnapshot = {
  emitToolUseSummaries: boolean
  enableQueuedAttachments: boolean
}

export interface QueryRuntimeDeps {
  callModel(
    params: QueryModelCallParams,
  ): AsyncGenerator<Message, void, unknown>
  microcompact(
    messages: Message[],
    toolUseContext: ToolCallContext,
    querySource: TurnOrigin,
  ): Promise<LightTrimOutcome>
  autocompact(
    messages: Message[],
    toolUseContext: ToolCallContext,
    context: QueryCompactionContext,
    querySource: TurnOrigin,
    tracking?: AutoCompactLedger,
  ): Promise<AutoCompactResult>
  /**
   * `/compact [instructions]`: ungated, synchronous compaction returning the
   * boundary + summary messages, or `{ error }`. Optional (no transport in tests).
   */
  forceCompact?: (params: {
    messages: Message[]
    mainLoopModel: string
    customInstructions?: string
    providerId?: string
  }) => Promise<
    { boundaryMarker: Message; summaryMessages: Message[] } | { error: string }
  >
  /** The user's auto-compact switch and windows. Published on the call
   *  context so `/autocompact` reads and saves through the same reader the
   *  trigger uses. Absent in test runtimes without settings. */
  autoCompactWindows?: AutoCompactWindowSettings
  uuid(): string
  runTurnEndHooks(params: QueryStopHookParams): Promise<TurnEndVerdict>
  getQueuedAttachments(
    params: QueuedAttachmentProviderParams,
  ): AsyncGenerator<Message, void, unknown>
  createToolUseSummary(
    params: ToolUseSummaryParams,
  ): Promise<Message | null>
  logEvent(name: string, metadata?: Record<string, unknown>): void
  getRuntimeGatesSnapshot(
    toolUseContext: ToolCallContext,
  ): QueryRuntimeGatesSnapshot
  saveStrippedResults?(strippedResults: Map<string, string>): Promise<void>
}
