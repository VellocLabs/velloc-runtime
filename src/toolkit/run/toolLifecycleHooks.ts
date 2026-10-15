/**
 * Settings lifecycle hooks around one tool call (F-26). PreToolUse can block
 * (`Hook blocked: <text>`) but not rewrite input; PostToolUse / PostToolUseFailure
 * blocks and context reach the model as meta messages. Tests inject fakes via
 * `toolRunSeams`.
 */
import type { ToolCallContext } from '../toolCallContext'
import { traceLine } from '../../utils/debugLog'
import { toolCallEventOf } from '../../mods/toolCallEvent'
import {
  executePostToolFailureHooks,
  fireAfterToolCall,
  fireBeforeToolCall,
} from '../../lifecycleHooks/runHooks'
import { buildHookInput } from '../../lifecycleHooks/hookInput'
import { runClassicHooks } from '../../lifecycleHooks/classicThroughMods'
import { createBashHookCommandRunner } from '../../lifecycleHooks/hookCommandRunner'
import { createModelHookPromptRunner } from '../../lifecycleHooks/hookPromptRunner'
import { createForkedAgentHookRunner } from '../../lifecycleHooks/hookAgentRunner'
import { createNetworkHookHttpRunner } from '../../lifecycleHooks/hookHttpRunner'
import { createGeneratedUserMessage } from '../../messages/messageFactories'
import { resolveHeadlessPermissionDecision } from './toolPermissionGate'
import { toolOutcomeMessage } from './toolResultShaping'
import type { AdmittedRun, DeferredMessageUpdate, StageStep } from './executeToolCall'

/** The settings-hook executors the stages call. */
export type ToolHookExecutors = {
  pre: typeof fireBeforeToolCall
  post: typeof fireAfterToolCall
  failure: typeof executePostToolFailureHooks
}

/** The gates a nested step passes through. */
export type NestedToolGates = {
  preHooks: typeof runNestedPreToolHooks
  postHooks: typeof runNestedPostToolHooks
  headlessDecision: typeof resolveHeadlessPermissionDecision
}

/** What a call context may override in the tool-run path. */
export type ToolRunSeams = {
  hooks?: Partial<ToolHookExecutors>
  nested?: Partial<NestedToolGates>
}

function hookExecutorsOf(callContext: ToolCallContext): ToolHookExecutors {
  const injected = callContext.toolRunSeams?.hooks
  return {
    pre: injected?.pre ?? fireBeforeToolCall,
    post: injected?.post ?? fireAfterToolCall,
    failure: injected?.failure ?? executePostToolFailureHooks,
  }
}

/** The nested-step gates for `callContext`: injected ones, else production. */
export function nestedToolGatesOf(callContext: ToolCallContext): NestedToolGates {
  const injected = callContext.toolRunSeams?.nested
  return {
    preHooks: injected?.preHooks ?? runNestedPreToolHooks,
    postHooks: injected?.postHooks ?? runNestedPostToolHooks,
    headlessDecision: injected?.headlessDecision ?? resolveHeadlessPermissionDecision,
  }
}

/** The runner fields every settings-hook execution takes. */
function hookRunners(callContext: ToolCallContext, sessionId: string, toolName: string) {
  return {
    toolName,
    sessionId,
    appState: callContext.readAppState(),
    setAppState: callContext.writeAppState,
    signal: callContext.cancelSource.signal,
    commandRunner: createBashHookCommandRunner(callContext),
    promptRunner: createModelHookPromptRunner(callContext),
    agentRunner: createForkedAgentHookRunner(callContext),
    httpRunner: createNetworkHookHttpRunner(callContext),
  }
}

function hookPayload(
  callContext: ToolCallContext,
  callRef: string,
  toolInput: Record<string, unknown>,
  extra: { toolResponse?: unknown } = {},
) {
  return {
    cwd: callContext.options.cwd,
    projectRoot: callContext.options.projectRoot,
    permissionMode: callContext.readAppState().permissionRules?.mode,
    toolInput,
    ...('toolResponse' in extra ? { toolResponse: extra.toolResponse } : {}),
    toolUseId: callRef,
  }
}

/** PreToolUse for one nested step. A context without a session has no
 *  hooks: not blocked. */
export async function runNestedPreToolHooks(
  toolName: string,
  input: Record<string, unknown>,
  callRef: string,
  callContext: ToolCallContext,
): Promise<{ blocked: boolean; message: string }> {
  const sessionId = callContext.options.sessionId
  if (!sessionId) return { blocked: false, message: '' }
  const hookResult = await hookExecutorsOf(callContext).pre({
    ...hookRunners(callContext, sessionId, toolName),
    hookInput: hookPayload(callContext, callRef, input),
  })
  return {
    blocked: hookResult.blocked,
    message: hookResult.errors.length
      ? hookResult.errors.join('\n')
      : `Tool use blocked by a PreToolUse hook (${toolName}).`,
  }
}

/** PostToolUse for one nested step: the note to append to the step's text
 *  (a block and any extra context), or '' when there is none. */
export async function runNestedPostToolHooks(
  toolName: string,
  input: Record<string, unknown>,
  toolReply: unknown,
  callRef: string,
  callContext: ToolCallContext,
): Promise<string> {
  const sessionId = callContext.options.sessionId
  if (!sessionId) return ''
  const post = await hookExecutorsOf(callContext).post({
    ...hookRunners(callContext, sessionId, toolName),
    hookInput: hookPayload(callContext, callRef, input, { toolResponse: toolReply }),
  })
  const parts: string[] = []
  if (post.blocked) {
    parts.push(
      `[PostToolUse hook blocked: ${toolName}]\n${
        post.errors.length ? post.errors.join('\n') : 'Tool result flagged by a PostToolUse hook.'
      }`,
    )
  }
  parts.push(...post.additionalContext, ...post.systemMessages)
  return parts.join('\n')
}

type AfterHookResult = {
  blocked: boolean
  errors: string[]
  additionalContext: string[]
  systemMessages: string[]
}

/** The meta messages an after-the-fact hook leaves for the model. */
function* afterHookMessages(
  result: AfterHookResult,
  label: string,
  fallback: string,
): Generator<DeferredMessageUpdate> {
  if (result.blocked) {
    const body = result.errors.length > 0 ? result.errors.join('\n') : fallback
    yield { message: createGeneratedUserMessage(`${label}\n${body}`, { isMeta: true }) }
  }
  const context = [...result.additionalContext, ...result.systemMessages]
  if (context.length > 0) {
    yield { message: createGeneratedUserMessage(context.join('\n\n'), { isMeta: true }) }
  }
}

/** Stage 7: PreToolUse. */
export async function* beforeHooksStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool, block, callContext, rawInput } = run
  const sessionId = callContext.options.sessionId
  if (!sessionId) return 'continue'
  const hookResult = await runClassicHooks(
    callContext.options.mods,
    'PreToolUse',
    () => toolCallEventOf(tool.name, block.toolCallId, rawInput, callContext.agentId),
    () =>
      hookExecutorsOf(callContext).pre({
        ...hookRunners(callContext, sessionId, tool.name),
        hookInput: hookPayload(callContext, block.toolCallId, rawInput),
      }),
    callContext.cancelSource.signal,
  )
  if (!hookResult.blocked) return 'continue'
  const message =
    hookResult.errors.length > 0 ? hookResult.errors.join('\n') : 'Tool use blocked by a PreToolUse hook.'
  traceLine(`[tool] ${tool.name} blocked by PreToolUse hook: ${message}`, { level: 'info' })
  yield {
    message: toolOutcomeMessage({
      content: `Hook blocked: ${message}`,
      callRef: block.toolCallId,
      modelReply: run.modelReply,
      deps: run.deps,
      toolName: tool.name,
      toolArgs: rawInput,
      toolResultData: `Hook blocked: ${message}`,
      isError: true,
    }),
  }
  return 'stop'
}

/** Stage 11: PostToolUse. */
export async function* afterHooksStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool, block, callContext } = run
  const sessionId = callContext.options.sessionId
  if (!sessionId) return 'continue'
  const payload = hookPayload(callContext, block.toolCallId, run.runInput ?? run.rawInput, {
    toolResponse: run.outcome?.data,
  })
  const result = await runClassicHooks(
    callContext.options.mods,
    'PostToolUse',
    () =>
      buildHookInput({
        event: 'PostToolUse',
        sessionId,
        cwd: payload.cwd,
        permissionMode: payload.permissionMode,
        toolName: tool.name,
        toolInput: payload.toolInput,
        toolResponse: payload.toolResponse,
        toolUseId: payload.toolUseId,
      }),
    () =>
      hookExecutorsOf(callContext).post({
        ...hookRunners(callContext, sessionId, tool.name),
        hookInput: payload,
      }),
    callContext.cancelSource.signal,
  )
  yield* afterHookMessages(
    result,
    `[PostToolUse hook blocked: ${tool.name}]`,
    'Tool result flagged by a PostToolUse hook.',
  )
  return 'continue'
}

/** The failure path: the error tool_result, then PostToolUseFailure. */
export async function* failureHooks(
  run: AdmittedRun,
  error: unknown,
): AsyncGenerator<DeferredMessageUpdate, void> {
  const { tool, block, callContext, rawInput } = run
  const errorMessage = error instanceof Error ? error.message : String(error)
  traceLine(`[tool] ${tool.name} threw: ${errorMessage}`, { level: 'warn' })
  yield {
    message: toolOutcomeMessage({
      content: `Tool execution error: ${errorMessage}`,
      callRef: block.toolCallId,
      modelReply: run.modelReply,
      deps: run.deps,
      toolName: tool.name,
      toolArgs: rawInput,
      toolResultData: `Tool execution error: ${errorMessage}`,
      isError: true,
    }),
  }
  const sessionId = callContext.options.sessionId
  if (!sessionId) return
  const payload = hookPayload(callContext, block.toolCallId, rawInput, { toolResponse: errorMessage })
  const result = await runClassicHooks(
    callContext.options.mods,
    'PostToolUseFailure',
    () => ({
      ...buildHookInput({
        event: 'PostToolUseFailure',
        sessionId,
        cwd: payload.cwd,
        permissionMode: payload.permissionMode,
        toolName: tool.name,
        toolInput: payload.toolInput,
        toolResponse: payload.toolResponse,
        toolUseId: payload.toolUseId,
      }),
      error: errorMessage,
    }),
    () =>
      hookExecutorsOf(callContext).failure({
        ...hookRunners(callContext, sessionId, tool.name),
        hookInput: payload,
      }),
    callContext.cancelSource.signal,
  )
  yield* afterHookMessages(
    result,
    `[PostToolUseFailure hook blocked: ${tool.name}]`,
    'Tool failure flagged by a PostToolUseFailure hook.',
  )
}
