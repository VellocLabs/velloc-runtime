/**
 * Stage 1 (F-26). Refused with a recoverable error: an unknown name; a tool withheld
 * from this turn's model; a deferred-and-inactive or sealed owner (same inputs as
 * the schema serializer); an interrupted turn. Also decides whether `tool.call` is
 * raised.
 */
import type { QueryToolUseBlock } from '../../runtime/interfaces/QueryRuntimeDeps'
import { resolveToolByName, type ToolContract } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { traceLine } from '../../utils/debugLog'
import { isToolWithheldForModel, withheldToolCallMessage } from '../../utils/todoTools'
import {
  augmentedAppStateForDeferral,
  deferralKeyFromContext,
  hiddenToolCallMessage,
  isExtensionToolUnit,
  shouldHideToolFromModel,
} from './deferredTools'
import { toolOutcomeMessage } from './toolResultShaping'
import type { AdmittedRun, DeferredMessageUpdate, StageStep, ToolCallRun } from './executeToolCall'

export type ToolCallAdmission =
  | { tool: ToolContract; refusal?: undefined }
  | { tool?: ToolContract; refusal: { content: string; data: string } }

/** Whether `tool` is one the model can call now (withheld or deferred
 *  tools are not). */
export function isToolOffered(tool: ToolContract, callContext: ToolCallContext): boolean {
  return !(
    isToolWithheldForModel(
      tool.name,
      callContext.options.mainLoopModel,
      callContext.options.mainLoopProviderId,
    ) ||
    shouldHideToolFromModel(
      tool,
      augmentedAppStateForDeferral(callContext),
      deferralKeyFromContext(callContext),
    )
  )
}

/** A server's own notes name its tools by their short names: the refusal for
 *  such a name gives the full names behind it and how to load each. */
function mcpShortNameHint(shortName: string, callContext: ToolCallContext): string | undefined {
  const matches = callContext.options.tools.filter(tool => tool.mcpInfo?.toolName === shortName)
  if (matches.length === 0) return undefined
  const named = matches.map(tool => {
    const server = `server "${tool.mcpInfo!.serverName}"`
    const skill = typeof tool.skill === 'string' ? tool.skill : undefined
    return isToolOffered(tool, callContext) || !skill
      ? `"${tool.name}" (${server})`
      : `"${tool.name}" (${server}; not loaded yet: call Skill "${skill}" or ToolSearch "select:${tool.name}" first)`
  })
  return `Unknown tool: ${shortName}. MCP tools are called by their full name: ${named.join('; ')}.`
}

/** `fromExtension`: an extension's own `$.tool.call` / `$.tool.check`, which
 *  reaches a registered tool still waiting behind ToolSearch — the wait hides
 *  it from the model only. */
export function admitToolCall(
  block: QueryToolUseBlock,
  callContext: ToolCallContext,
  options: { fromExtension?: boolean } = {},
): ToolCallAdmission {
  const tool = resolveToolByName(callContext.options.tools, block.toolName)
  if (!tool) {
    traceLine(`[tool] model called unknown tool "${block.toolName}"`, { level: 'warn' })
    return {
      refusal: {
        content:
          mcpShortNameHint(block.toolName, callContext) ??
          `Unknown tool: ${block.toolName}. Available browser tools: ${callContext.options.tools.map(t => t.name).join(', ')}`,
        data: `Unknown tool: ${block.toolName}`,
      },
    }
  }
  if (
    isToolWithheldForModel(
      tool.name,
      callContext.options.mainLoopModel,
      callContext.options.mainLoopProviderId,
    )
  ) {
    const withheld = withheldToolCallMessage(tool.name)
    return { tool, refusal: { content: withheld, data: withheld } }
  }
  if (
    !(options.fromExtension && isExtensionToolUnit(tool.name, deferralKeyFromContext(callContext))) &&
    shouldHideToolFromModel(
      tool,
      augmentedAppStateForDeferral(callContext),
      deferralKeyFromContext(callContext),
    )
  ) {
    const notLoaded = hiddenToolCallMessage(tool, deferralKeyFromContext(callContext))
    return { tool, refusal: { content: notLoaded, data: notLoaded } }
  }
  if (callContext.cancelSource.signal.aborted) {
    return { tool, refusal: { content: 'Interrupted by user', data: 'Interrupted by user' } }
  }
  return { tool }
}

/** Stage 1. */
export async function* admitStage(run: ToolCallRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const admission = admitToolCall(run.block, run.callContext)
  if (admission.refusal) {
    yield {
      message: toolOutcomeMessage({
        content: admission.refusal.content,
        callRef: run.block.toolCallId,
        modelReply: run.modelReply,
        deps: run.deps,
        toolName: admission.tool?.name ?? run.block.toolName,
        toolArgs: run.rawInput,
        toolResultData: admission.refusal.data,
        isError: true,
      }),
    }
    return 'stop'
  }
  run.tool = admission.tool
  return 'continue'
}

/** Stage 2: the tool's own input check. */
export async function* checkInputStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool } = run
  if (!tool.checkInput) return 'continue'
  const check = await tool.checkInput(run.rawInput, run.callContext)
  if (check.result) return 'continue'
  traceLine(`[tool] ${tool.name} rejected invalid input: ${check.message}`, { level: 'info' })
  yield {
    message: toolOutcomeMessage({
      content: `Invalid input: ${check.message}`,
      callRef: run.block.toolCallId,
      modelReply: run.modelReply,
      deps: run.deps,
      toolName: tool.name,
      toolArgs: run.rawInput,
      toolResultData: `Invalid input: ${check.message}`,
      isError: true,
    }),
  }
  return 'stop'
}
