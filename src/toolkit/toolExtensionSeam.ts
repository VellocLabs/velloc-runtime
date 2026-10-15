/**
 * Contract: what the tool path asks of a session's extensions (F-26): the
 * `tool.call`, `tool.check`, `tool.describe` seams and the classic hooks beneath
 * them. Every method is required; `noToolExtensions()` answers false to `has*`.
 */
import type { DispatchContext } from '../mods/modTypes'
import type { ToolDescribeInput } from '../mods/describeEvents'
import type {
  ClassicMods,
  ToolCallCore,
  ToolCallEvent,
  ToolCallSettlement,
  ToolCheckCore,
  ToolCheckEvent,
  ToolCheckSettlement,
} from '../mods/toolCallEvent'

/** Seam scheduling: `around` wraps the core and may change the result;
 *  `observe` sees it and changes nothing the engine reads. */
export type SeamMode = 'around' | 'observe'

export interface ToolCallExtensions {
  /** Settles when the session's extensions have loaded; the tool path waits
   *  on it before the first raise. */
  readonly ready: Promise<void>
  /** Set on a loop under the slot: the `agentId` its events carry. */
  readonly agentId?: string

  /** @mode around — `tool.call`, wrapping stages 1–11 of one call. */
  hasToolCallHooks(): boolean
  /** @mode around */
  toolCall(
    e: ToolCallEvent,
    core: ToolCallCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ToolCallSettlement>

  /** @mode around — `tool.check`, wrapping the engine's verdict (stage 4). */
  hasToolCheckHooks(): boolean
  /** @mode around */
  toolCheck(
    e: ToolCheckEvent,
    core: ToolCheckCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ToolCheckSettlement>

  /** @mode around — `tool.describe`, over a tool's description at render. */
  hasToolDescribeHooks(): boolean
  /** @mode around */
  toolDescribe(input: ToolDescribeInput, signal?: AbortSignal): Promise<string>

  /** @mode around — `classic.<Event>`, the settings hooks beneath the mods
   *  (PermissionRequest, PreToolUse, PostToolUse, PostToolUseFailure, …). */
  hasClassicHooks: ClassicMods['hasClassicHooks']
  /** @mode around */
  classic: ClassicMods['classic']

  /** A line for the extensions' report (an answer the engine could not
   *  honour). */
  report(line: string): void
}

/** The holder for a session with no extensions: every `has*` is false, so
 *  no seam is raised; the raise methods answer "not settled" (run the core)
 *  if called anyway. */
export function noToolExtensions(): ToolCallExtensions {
  return {
    ready: Promise.resolve(),
    hasToolCallHooks: () => false,
    toolCall: async () => ({ settled: false }),
    hasToolCheckHooks: () => false,
    toolCheck: async () => ({ settled: false }),
    hasToolDescribeHooks: () => false,
    toolDescribe: async (input) => input.description,
    hasClassicHooks: () => false,
    classic: async () => ({ settled: false }),
    report: () => {},
  }
}
