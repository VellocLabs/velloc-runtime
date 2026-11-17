/**
 * The shapes a hook sees, per raised event (F-25): `e` and what a hook may
 * return. Types only: the mod API declaration written beside a dev mod is
 * generated from this table (`npm run mods:api-shapes`). Every key is a
 * raised event; an event raised but absent here is declared with a loose `e`.
 */

import type { AgentOfferInput, AgentOfferResult, AgentSpawnInput, AgentSpawnDecision } from './agentEvents'
import type { CommandDescribeInput, CommandDescribeResult, ToolDescribeInput, ToolDescribeResult } from './describeEvents'
import type { IdsNextInput, IdsNextResult } from './idsEvent'
import type { CommandRunEvent, CommandRunResult } from './modCommands'
import type { ConfigDescribeInput, ConfigDescribeResult } from './modConfig'
import type { PromptComposeInput, PromptContextInput } from './promptEvents'
import type { PromptMentionInput } from './promptMentionEvent'
import type { SessionAppendInput, SessionAppendResult } from './sessionAppendEvent'
import type { SessionCompactInput, SessionCompactResult } from './sessionCompactEvent'
import type { SessionReceiveInput, SessionSendInput, SessionSendResult } from './sessionMessageEvents'
import type { ToolCallEvent, ToolCheckEvent, ToolCheckResult } from './toolCallEvent'
import type { TurnContinueInput } from './turnContinueEvent'
import type { TurnRecoverDecision, TurnRecoverInput } from './turnRecoverEvent'
import type { TurnRequestInput } from './turnRequestEvent'
import type { TurnStepInput, TurnStepResult } from './turnStepEvent'
import type {
  AbovePromptRenderProps,
  AssistantMessageRenderProps,
  CommandOutputRenderProps,
  PaneRenderProps,
  PromptHintRenderProps,
  RENDER_SURFACE,
  RenderViewport,
  ToolGroupRenderProps,
  ToolResultRenderProps,
  ToolUseRenderProps,
  UserMessageRenderProps,
} from './modRender'
import type { AbovePromptListRenderProps } from './bandArrangement'
import type { PlacedRenderProps } from './modPlaces'
import type { BackdropRenderProps } from './modTheme'

/** One event's `e` and the value its hooks return (`unknown`: not declared). */
type Shape<E, R = unknown> = { e: E; result: R }

/** The events whose shapes are declared, by name. */
export type ModEventShapes = {
  'tool.call': Shape<ToolCallEvent>
  'tool.check': Shape<ToolCheckEvent, ToolCheckResult>
  'tool.describe': Shape<ToolDescribeInput, ToolDescribeResult>
  'command.describe': Shape<CommandDescribeInput, CommandDescribeResult>
  'command.run': Shape<CommandRunEvent, CommandRunResult>
  'config.describe': Shape<ConfigDescribeInput, ConfigDescribeResult>
  'ids.next': Shape<IdsNextInput, IdsNextResult>
  'prompt.compose': Shape<PromptComposeInput>
  'prompt.context': Shape<PromptContextInput>
  'prompt.mention': Shape<PromptMentionInput>
  'session.append': Shape<SessionAppendInput, SessionAppendResult>
  'session.compact': Shape<SessionCompactInput, SessionCompactResult>
  'session.send': Shape<SessionSendInput, SessionSendResult>
  'session.receive': Shape<SessionReceiveInput>
  'agent.offer': Shape<AgentOfferInput, AgentOfferResult>
  'agent.spawn': Shape<AgentSpawnInput, AgentSpawnDecision>
  'turn.request': Shape<TurnRequestInput>
  'turn.continue': Shape<TurnContinueInput>
  'turn.recover': Shape<TurnRecoverInput, TurnRecoverDecision>
  'turn.step': Shape<TurnStepInput, TurnStepResult>
}

/** `ui.render`'s props, per drawing site (`RENDER_SITES`). */
export type ModRenderProps = {
  Pane: PaneRenderProps
  AbovePrompt: AbovePromptRenderProps
  AbovePromptList: AbovePromptListRenderProps
  UserMessage: UserMessageRenderProps
  AssistantMessage: AssistantMessageRenderProps
  CommandOutput: CommandOutputRenderProps
  ToolUse: ToolUseRenderProps
  ToolResult: ToolResultRenderProps
  ToolGroup: ToolGroupRenderProps
  PromptHint: PromptHintRenderProps
  Placed: PlacedRenderProps
  Backdrop: BackdropRenderProps
}

/** What every `ui.render` event carries besides its site's props. */
export type ModRenderFrame = {
  surface: typeof RENDER_SURFACE
  requestId: string
  viewport?: RenderViewport
}
