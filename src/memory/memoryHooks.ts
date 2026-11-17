/**
 * Memory on the native hook tier (F-26): the recall prefetch at turn start, the
 * saved-memory notice, the path-scoped rules and recalled memories after a tool
 * step, and the background upkeep (extraction, consolidation) when a main-loop
 * turn ends without tools. Each needs the runtime config, which forks lack.
 */
import type { NativeHookRegistration } from '../toolkit/nativeHooks'
import {
  NATIVE_EVENTS,
  type RowsGatherEvent,
  type TurnBackgroundEvent,
  type TurnEndEvent,
} from '../toolkit/nativeHookEvents'
import type { Message } from '../runtime/RuntimeTypes'
import type { TurnEnvironment } from '../engine/turnEnvironment'
import { newestPromptText } from '../engine/effectPromptHooks'
import { createGeneratedUserMessage, makeNoticeRow } from '../messages/messageFactories'
import { beginRecallLookahead } from './relevantRecall'
import { buildConditionalRuleInjection } from './conditionalRuleInjection'
import { runMemoryExtraction, takeSavedMemoryPaths } from './extract/extractionRunner'
import { runMemoryConsolidation } from './consolidate/consolidationRunner'

export const MEMORY_MODULE = 'memory'

function startPrefetch(e: unknown, live: unknown): void {
  const { background, input } = e as TurnBackgroundEvent
  const env = live as TurnEnvironment
  if (background !== 'memoryPrefetch' || !env.input.runtimeConfig) return
  const { messages } = input as { messages: readonly Message[] }
  env.prefetch = beginRecallLookahead({
    query: newestPromptText(env.input.messages),
    messages: [...messages],
    toolUseContext: env.ctx,
    providerId: env.input.providerId,
    runtimeConfig: env.input.runtimeConfig,
    signal: env.ctx.cancelSource.signal,
  })
}

function savedMemoryNotice(env: TurnEnvironment): Message[] {
  const config = env.input.runtimeConfig
  if (!config) return []
  const paths = takeSavedMemoryPaths(config)
  if (!paths || paths.length === 0) return []
  const names = paths.map(p => p.split(/[/\\]/).pop() ?? p).join(', ')
  return [makeNoticeRow(config, `Saved memory: ${names}`, 'memory_saved')]
}

async function nestedRules(env: TurnEnvironment): Promise<Message[]> {
  const config = env.input.runtimeConfig
  const ctx = env.ctx
  const triggers = ctx.nestedMemoryCues
  if (!config || !triggers || triggers.size === 0) return []
  const readPaths = [...triggers]
  triggers.clear()
  try {
    const text = await buildConditionalRuleInjection({
      readPaths,
      loadedNestedMemoryPaths: ctx.nestedMemoryPathsSeen,
      promptInstructionPaths: ctx.promptInstructionPaths,
      cwd: ctx.options.cwd,
      projectRoot: ctx.options.projectRoot,
      homeDir: ctx.options.homeDir,
      readRoot: ctx.options.untrustedReadRoot,
      runtimeConfig: config,
      fs: ctx.options.fsOperations,
    })
    return text ? [createGeneratedUserMessage(text, { isMeta: true })] : []
  } catch {
    // Rules are an aid; failing to build them leaves the step as it is.
    return []
  }
}

async function recalledMemories(env: TurnEnvironment): Promise<Message[]> {
  const prefetch = env.prefetch
  if (!prefetch || prefetch.settledAt === null || prefetch.consumed) return []
  prefetch.consumed = true
  const text = await prefetch.promise
  return text ? [createGeneratedUserMessage(text, { isMeta: true })] : []
}

async function gatherMemoryRows(
  e: unknown,
  live: unknown,
  next: (e: unknown) => Promise<unknown>,
): Promise<unknown> {
  const { stage } = e as RowsGatherEvent
  const env = live as TurnEnvironment
  const rows = (await next(e)) as Message[]
  if (stage === 'turnStart') return [...rows, ...savedMemoryNotice(env)]
  if (stage === 'afterTools') return [...rows, ...(await nestedRules(env)), ...(await recalledMemories(env))]
  return rows
}

/** Extraction (capture what the turn taught) and consolidation (tidy the
 *  store; usually a no-op behind its own gates). Neither is awaited. */
async function startUpkeep(e: unknown, _live: unknown, next: (e: unknown) => Promise<unknown>): Promise<unknown> {
  const verdict = await next(e)
  const { params, logEvent } = e as TurnEndEvent
  const sessionId = params.toolUseContext.options.sessionId
  const input = {
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    userContext: params.userContext,
    systemContext: params.systemContext,
    toolUseContext: params.toolUseContext,
  }
  const report = (name: string) => (error: unknown) => {
    logEvent(name, { sessionId, message: error instanceof Error ? error.message : String(error) })
  }
  void runMemoryExtraction(input).catch(report('nexus_extract_memories_unhandled'))
  void runMemoryConsolidation(input).catch(report('nexus_periodic_tidy_unhandled'))
  return verdict
}

export function memoryHooks(): NativeHookRegistration[] {
  const base = { module: MEMORY_MODULE } as const
  return [
    { ...base, event: NATIVE_EVENTS.turnBackground, scope: 'all', observe: startPrefetch },
    { ...base, event: NATIVE_EVENTS.rowsGather, scope: 'all', around: gatherMemoryRows },
    { ...base, event: NATIVE_EVENTS.turnEnd, scope: 'main', around: startUpkeep },
  ]
}
