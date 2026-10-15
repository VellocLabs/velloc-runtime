/**
 * A turn ending without tool calls: diagnostic, host told the turn completed (main agent), counters
 * reset, Stop / SubagentStop hooks, then background memory work. A blocking hook failure becomes a meta
 * user message the turn answers once more.
 */
import type {
  QueryRuntimeDeps,
  QueryStopHookParams,
  TurnEndVerdict,
} from '../../runtime/interfaces/QueryRuntimeDeps'
import { reset as resetAgentLoopState } from '../loop/actionLoopDetector'
import {
  fireTurnEnd,
  executeSubagentStopHooks,
} from '../../lifecycleHooks/runHooks'
import { buildHookInput } from '../../lifecycleHooks/hookInput'
import { runClassicHooks } from '../../lifecycleHooks/classicThroughMods'
import { createBashHookCommandRunner } from '../../lifecycleHooks/hookCommandRunner'
import { createModelHookPromptRunner } from '../../lifecycleHooks/hookPromptRunner'
import { createForkedAgentHookRunner } from '../../lifecycleHooks/hookAgentRunner'
import { createNetworkHookHttpRunner } from '../../lifecycleHooks/hookHttpRunner'
import { runMemoryExtraction } from '../../memory/extract/extractionRunner'
import { runMemoryConsolidation } from '../../memory/consolidate/consolidationRunner'
import { createGeneratedUserMessage } from '../../messages/messageFactories'

type StopEventLogger = QueryRuntimeDeps['logEvent']
type StopSessionKey = QueryStopHookParams['toolUseContext']['options']['sessionId']

/** The caller tag of the main conversation loop. */
const MAIN_LOOP_CALLER = 'sdk'

function tallyPendingToolCalls(messages: QueryStopHookParams['assistantMessages']): number {
  return (messages ?? []).reduce((total: number, msg) => {
    const content = (msg as { message?: { content?: unknown } })?.message?.content
    if (!Array.isArray(content)) return total
    return total + content.filter(
      (b: unknown) =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool-call',
    ).length
  }, 0)
}

/**
 * Stop handling should only run once the model stopped asking for tools. If
 * tool calls are still present, something upstream misjudged the turn; warn
 * with a stack so the call site can be found. Silent on every normal turn.
 */
function warnIfToolCallsRemain(params: QueryStopHookParams, sessionId: StopSessionKey): void {
  try {
    const toolCalls = tallyPendingToolCalls(params.assistantMessages)
    if (toolCalls === 0) return
    const assistantCount = Array.isArray(params.assistantMessages)
      ? params.assistantMessages.length
      : 0
    const stack = new Error('runTurnEndHooks call site').stack ?? '(no stack)'
    console.warn(
      `[runTurnEndHooks] BUG: firing with ${toolCalls} ` +
        `tool-call block(s) reason=completed sessionId=${sessionId} ` +
        `querySource=${params.querySource} ` +
        `assistantCount=${assistantCount} ` +
        `stopHookActive=${params.stopHookActive} — turn loop set ` +
        `needsFollowUp incorrectly OR firing from unexpected path.\n` +
        `Stack:\n${stack}`,
    )
  } catch (logError) {
    console.warn('[runTurnEndHooks] diagnostic-log threw:', logError)
  }
}

/**
 * Tell the host the conversation turn completed so it stops the browser actor
 * and frees the tab for the user. Only for the main agent's main-loop turn: a
 * fork shares the parent's session id, and a side call (title naming, memory
 * recall) may finish while a main-loop tool is still running — stopping the
 * session then would drop that tool. Failures are logged and ignored.
 */
async function notifyHostTurnCompleted(
  params: QueryStopHookParams,
  sessionId: StopSessionKey,
  logEvent: StopEventLogger,
): Promise<void> {
  const capabilities = params.toolUseContext.platformCapabilities
  const onStop = capabilities?.session?.onStop
  if (typeof onStop !== 'function') return
  if (params.toolUseContext.agentId) return
  if (params.querySource !== MAIN_LOOP_CALLER) return
  try {
    const result = await onStop.call(capabilities!.session, { sessionId, reason: 'completed' })
    logEvent('browser_stop_hook_actor_stopped', {
      sessionId,
      stopped: result.stopped,
      querySource: params.querySource,
    })
  } catch (error: unknown) {
    logEvent('browser_stop_hook_actor_stop_failed', {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
      querySource: params.querySource,
    })
  }
}

/** Run the user's Stop hooks, or SubagentStop (matched on the agent id) for a fork. */
async function runUserStopHooks(params: QueryStopHookParams, sessionId: StopSessionKey) {
  const ctx = params.toolUseContext
  const runners = {
    sessionId,
    appState: ctx.readAppState(),
    setAppState: ctx.writeAppState,
    signal: ctx.cancelSource.signal,
    commandRunner: createBashHookCommandRunner(ctx),
    promptRunner: createModelHookPromptRunner(ctx),
    agentRunner: createForkedAgentHookRunner(ctx),
    httpRunner: createNetworkHookHttpRunner(ctx),
    hookInput: {
      cwd: ctx.options.cwd,
      projectRoot: ctx.options.projectRoot,
      permissionMode: ctx.readAppState().permissionRules?.mode,
      stopHookActive: false,
    },
  }
  const forkAgentId = ctx.agentId
  const event = forkAgentId ? 'SubagentStop' : 'Stop'
  return runClassicHooks(
    ctx.options.mods,
    event,
    () =>
      buildHookInput({
        event,
        sessionId,
        cwd: runners.hookInput.cwd,
        permissionMode: runners.hookInput.permissionMode,
        stopHookActive: false,
        ...(forkAgentId ? { toolName: forkAgentId } : {}),
      }),
    () =>
      forkAgentId
        ? executeSubagentStopHooks({ ...runners, agentId: forkAgentId })
        : fireTurnEnd(runners),
    ctx.cancelSource.signal,
  )
}

/**
 * Start background memory upkeep for the main agent: extraction (capture what
 * the turn taught) and consolidation (tidy the store; usually a no-op behind
 * its own gates). Neither is awaited; failures are logged.
 */
function startMemoryUpkeep(
  params: QueryStopHookParams,
  sessionId: StopSessionKey,
  logEvent: StopEventLogger,
): void {
  const input = {
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    userContext: params.userContext,
    systemContext: params.systemContext,
    toolUseContext: params.toolUseContext,
  }
  const report = (name: string) => (error: unknown) => {
    logEvent(name, {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
  void runMemoryExtraction(input).catch(report('nexus_extract_memories_unhandled'))
  void runMemoryConsolidation(input).catch(report('nexus_periodic_tidy_unhandled'))
}

/** The default `runTurnEndHooks`; `logEvent` receives its diagnostics. */
export function createStopHandler(
  logEvent: StopEventLogger,
): (params: QueryStopHookParams) => Promise<TurnEndVerdict> {
  return async function runTurnEndHooks(params) {
    // Already answering a blocking Stop hook: do not run them again.
    if (params.stopHookActive) {
      return { preventContinuation: false, blockerRows: [] }
    }
    const sessionId = params.toolUseContext.options.sessionId
    warnIfToolCallsRemain(params, sessionId)
    await notifyHostTurnCompleted(params, sessionId, logEvent)
    // A new user message starts with fresh loop counters. The forced-final
    // flag is left to the loop, which may still be in a recovery turn.
    if (params.toolUseContext.agentLoopState) {
      resetAgentLoopState(params.toolUseContext.agentLoopState)
    }
    const hookResult = await runUserStopHooks(params, sessionId)
    if (!params.toolUseContext.agentId) startMemoryUpkeep(params, sessionId, logEvent)
    if (hookResult.errors.length === 0) {
      return { preventContinuation: false, blockerRows: [] }
    }
    return {
      preventContinuation: false,
      blockerRows: hookResult.errors.map(err =>
        createGeneratedUserMessage(`[Stop hook]: ${err}`, { isMeta: true }),
      ),
    }
  }
}
