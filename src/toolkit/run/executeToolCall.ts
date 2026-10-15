/**
 * Contract: one tool call as a list of stages (F-26), run directly or as the core
 * of `tool.call` when an extension is loaded, the call was admitted and the tool
 * does not halt. Stages, in order: admit, checkInput, verdict, extensionCheck, ask,
 * denyGate, beforeHooks, haltForUser, invoke, shape, afterHooks. A stage that throws
 * after admission yields `Tool execution error: …` and the PostToolUseFailure
 * hooks; a throw before admission propagates.
 */
import type {
  QueryRuntimeDeps,
  QueryToolUseBlock,
} from '../../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow, Message } from '../../runtime/RuntimeTypes'
import type { AgentToolMeta, ToolContract, ToolOutcome } from '../toolContract'
import { emptyPermissionRuleSet, type PermissionDecider, type ToolPermissionResult } from '../permissionVerdict'
import type { ToolCallContext } from '../toolCallContext'
import {
  toolCallArgsOf,
  type ModToolInfo,
  type ToolCallMods,
  type ToolCheckResult,
} from '../../mods/toolCallEvent'
import type { DispatchContext } from '../../mods/modTypes'
import { createGeneratedUserMessage } from '../../messages/messageFactories'
import {
  callToolThroughMods,
  raisesToolCall,
  runToolUseThroughMods,
  type ToolCallSeam,
} from './toolCallThroughMods'
import { checkToolThroughMods, toolCheckResultOf } from './toolCheckThroughMods'
import { admitStage, admitToolCall, checkInputStage, isToolOffered } from './toolCallAdmission'
import {
  askStage,
  decideToolPermission,
  denyGateStage,
  extensionCheckStage,
  filePathSafetyAsk,
  verdictStage,
  type ToolPermissionVerdict,
} from './toolPermissionGate'
import { haltForUserStage } from './interactiveHalt'
import {
  invokeStage,
  readToolResultMessage,
  serializeToolResult,
  shapeStage,
  toolOutcomeMessage,
  toolResultContent,
} from './toolResultShaping'
import { afterHooksStage, beforeHooksStage, failureHooks } from './toolLifecycleHooks'

/** A call the loop is suspended on; its answer arrives by another path. */
export type PendingToolUse = {
  toolUseId: string
  toolName: string
}

/** One update a call yields: a message, a context patch to apply, a halt,
 *  and the host tool's agent metadata. */
export type DeferredMessageUpdate<M extends Message = Message> = {
  message?: M
  contextPatch?: {
    toolUseID: string
    modifyContext: (context: ToolCallContext) => ToolCallContext
  }
  pendingToolUse?: PendingToolUse
  /** Host-tool metadata (post-action url, focus target, action hashes) read
   *  by the batch runner's telemetry. */
  agentMeta?: AgentToolMeta
}

/** The state one call carries through its stages. */
export type ToolCallRun = {
  readonly block: QueryToolUseBlock
  readonly modelReply: ModelReplyRow
  readonly decidePermission: PermissionDecider
  readonly callContext: ToolCallContext
  readonly deps: QueryRuntimeDeps
  /** The model's arguments. */
  readonly rawInput: Record<string, unknown>
  /** Set by admission. */
  tool?: ToolContract
  verdict?: ToolPermissionVerdict
  /** The answer the call runs under (its `updatedInput` is the input). */
  gateVerdict?: ToolPermissionResult
  runInput?: Record<string, unknown>
  startedAtMs?: number
  outcome?: ToolOutcome<unknown>
}

/** A run past admission. */
export type AdmittedRun = ToolCallRun & { tool: ToolContract }

export type StageStep = 'continue' | 'stop'

export type ToolCallStage = {
  readonly name: string
  readonly run: (run: ToolCallRun) => AsyncGenerator<DeferredMessageUpdate, StageStep>
}

/** A stage that runs only once the call was admitted. */
export function admittedStage(
  name: string,
  body: (run: AdmittedRun) => AsyncGenerator<DeferredMessageUpdate, StageStep>,
): ToolCallStage {
  return { name, run: run => body(run as AdmittedRun) }
}

/** The stage list. Adding a stage, or a seam before or after one, is an edit
 *  to this list. */
export const TOOL_CALL_STAGES: readonly ToolCallStage[] = [
  { name: 'admit', run: admitStage },
  admittedStage('checkInput', checkInputStage),
  admittedStage('verdict', verdictStage),
  admittedStage('extensionCheck', extensionCheckStage),
  admittedStage('ask', askStage),
  admittedStage('denyGate', denyGateStage),
  admittedStage('beforeHooks', beforeHooksStage),
  admittedStage('haltForUser', haltForUserStage),
  admittedStage('invoke', invokeStage),
  admittedStage('shape', shapeStage),
  admittedStage('afterHooks', afterHooksStage),
]

/**
 * The engine's own behaviour for one call — `tool.call`'s core: the stages
 * in order. `stages` is the injection point for tests.
 */
export async function* executeToolCallStages(
  block: QueryToolUseBlock,
  modelReply: ModelReplyRow,
  decidePermission: PermissionDecider,
  callContext: ToolCallContext,
  deps: QueryRuntimeDeps,
  stages: readonly ToolCallStage[] = TOOL_CALL_STAGES,
): AsyncGenerator<DeferredMessageUpdate, void> {
  const run: ToolCallRun = {
    block,
    modelReply,
    decidePermission,
    callContext,
    deps,
    rawInput: (block.args ?? {}) as Record<string, unknown>,
  }
  try {
    for (const stage of stages) {
      if ((yield* stage.run(run)) === 'stop') return
    }
  } catch (error) {
    if (!run.tool) throw error
    yield* failureHooks(run as AdmittedRun, error)
  }
}

/**
 * A tool call. With no `tool.call` extension loaded this is the stage list;
 * with one, the extensions run around it.
 */
export async function* executeToolCall(
  block: QueryToolUseBlock,
  modelReply: ModelReplyRow,
  decidePermission: PermissionDecider,
  callContext: ToolCallContext,
  deps: QueryRuntimeDeps,
  stages: readonly ToolCallStage[] = TOOL_CALL_STAGES,
): AsyncGenerator<DeferredMessageUpdate, void> {
  const mods = callContext.options.mods
  // Settled long before a model calls a tool (the first prompt waited for
  // it); a session without extensions does not wait at all.
  if (mods?.ready) await mods.ready
  const runStages = (call: QueryToolUseBlock, context: ToolCallContext) =>
    executeToolCallStages(call, modelReply, decidePermission, context, deps, stages)
  if (mods?.hasToolCallHooks?.() === true && mods.toolCall) {
    const admission = admitToolCall(block, callContext)
    if (!admission.refusal && raisesToolCall(admission.tool)) {
      const tool = admission.tool
      const callRef = block.toolCallId
      yield* runToolUseThroughMods({
        mods: mods as ToolCallSeam,
        ...(mods.agentId ? { agentId: mods.agentId } : {}),
        toolUse: block,
        tool,
        callContext,
        runCore: runStages,
        readResultMessage: message => readToolResultMessage(message, callRef),
        buildResultMessage: async answer => {
          // An extension's result is shaped the way a tool's is.
          const asResult = { data: answer.data } as ToolOutcome<unknown>
          return toolOutcomeMessage({
            content: await toolResultContent(asResult),
            toolUseResultText: serializeToolResult(asResult),
            callRef,
            modelReply,
            deps,
            toolName: tool.name,
            toolArgs: answer.args,
            toolResultData: answer.data,
            isError: answer.isError,
          })
        },
        buildContextMessage: text => createGeneratedUserMessage(text, { isMeta: true }),
      })
      return
    }
  }
  yield* runStages(block, callContext)
}

/** `$.tool.list()`: the tools the model can call now, in the order it sees
 *  them (withheld and inactive deferred tools left out). */
export async function listToolsForMods(callContext: ToolCallContext): Promise<ModToolInfo[]> {
  const listed: ModToolInfo[] = []
  for (const tool of callContext.options.tools) {
    if (!isToolOffered(tool, callContext)) continue
    let description = ''
    try {
      description = await tool.description({} as never, {
        isNonInteractiveSession: true,
        permissionRules:
          callContext.readAppState().permissionRules ?? emptyPermissionRuleSet(),
        tools: callContext.options.tools,
      } as never)
    } catch {
      description = ''
    }
    listed.push({
      name: tool.name,
      description: typeof description === 'string' ? description : '',
      mcp: tool.fromMcpServer === true,
    })
  }
  return listed
}

/** The error a `$.tool.*` helper rejects with for a refused call. */
function refusedHelperCall(
  helper: string,
  name: string,
  admission: { tool?: ToolContract; refusal: { data: string } },
  callContext: ToolCallContext,
  abortText: string,
): Error {
  if (callContext.cancelSource.signal.aborted) {
    const error = new Error(abortText)
    error.name = 'AbortError'
    return error
  }
  return new Error(
    admission.tool
      ? `${helper}: ${name} cannot be called now — ${admission.refusal.data}`
      : `${helper}: no tool is named "${name}"`,
  )
}

/**
 * `$.tool.call(input)`: an extension's own call of a tool, raised as `tool.call`
 * under its own call id (every hook but the caller's, the permission check and
 * its dialog, then the tool). Nothing is yielded to the conversation.
 */
export async function callToolForMod(params: {
  input: Record<string, unknown>
  mods: ToolCallMods
  context: DispatchContext
  canUseTool: PermissionDecider
  callContext: ToolCallContext
  deps: QueryRuntimeDeps
}): Promise<unknown> {
  const { input, deps } = params
  const callContext = params.callContext
  const name = String(input.tool)
  const block = {
    type: 'tool-call',
    toolCallId: `modtool_${deps.uuid()}`,
    toolName: name,
    // `tool_use_id`, `agentId` and `consent` may ride along and are dropped.
    args: toolCallArgsOf(input, {}),
  } as QueryToolUseBlock
  const admission = admitToolCall(block, callContext)
  if (admission.refusal) {
    throw refusedHelperCall('$.tool.call', name, admission, callContext, 'the tool call was aborted')
  }
  const tool = admission.tool
  if (!raisesToolCall(tool)) {
    const error = new Error(
      `$.tool.call cannot run ${name}: it waits for the user, and its answer does not come back through the call`,
    )
    error.name = 'NotSupportedError'
    throw error
  }
  // `tool.check` inside this call is the extension's own question.
  callContext.modCallContext = params.context
  const modelReply = {
    type: 'assistant',
    uuid: deps.uuid(),
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: block.toolCallId, toolName: name, args: block.args }],
    },
  } as unknown as ModelReplyRow
  return callToolThroughMods({
    mods: params.mods,
    context: params.context,
    toolUse: block,
    tool,
    callContext,
    runCore: (call, context) =>
      executeToolCallStages(call, modelReply, params.canUseTool, context, deps),
    readResultMessage: message => readToolResultMessage(message, block.toolCallId),
  })
}

/**
 * `$.tool.check`: the engine's verdict for `{ tool, input }` through the
 * `tool.check` chain (the calling hook skipped). Nothing runs, no dialog
 * opens, no PreToolUse hook is asked. Rejects like `$.tool.call`.
 */
export async function checkToolForMod(params: {
  input: { tool: string; input: unknown }
  mods: ToolCallMods
  context: DispatchContext
  callContext: ToolCallContext
}): Promise<ToolCheckResult> {
  const callContext = params.callContext
  const name = params.input.tool
  const raw = params.input.input
  const args =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const block = { type: 'tool-call', toolCallId: 'modcheck', toolName: name, args } as QueryToolUseBlock
  const admission = admitToolCall(block, callContext)
  if (admission.refusal) {
    throw refusedHelperCall('$.tool.check', name, admission, callContext, 'the tool check was aborted')
  }
  const tool = admission.tool
  const verdict = await decideToolPermission(tool, args, callContext)
  const settled = await checkToolThroughMods({
    mods: params.mods,
    tool,
    input: args,
    verdict,
    signal: callContext.cancelSource.signal,
    context: params.context,
    always: true,
    safetyAsk: () =>
      filePathSafetyAsk(tool, args, callContext, callContext.readAppState().permissionRules, false),
  })
  return toolCheckResultOf(settled)
}
