/**
 * Gathers context rows by IO at three points of a turn: turn start (saved-memory notice), after a
 * compaction (ledgers emptied, plan rows and read-file restore rebuilt, prompt re-rendered), and after
 * a tool step (instruction files and rules for files read; recalled memories only if already finished).
 */
import type { Message } from '../runtime/RuntimeTypes'
import { createGeneratedUserMessage, makeNoticeRow } from '../messages/messageFactories'
import { takeSavedMemoryPaths } from '../memory/extract/extractionRunner'
import { buildConditionalRuleInjection } from '../memory/conditionalRuleInjection'
import {
  collectPostCompactPlanRows,
  createPostCompactReadRestoreMessage,
} from '../messages/contextAttachments'
import type { RefreshedInstructions, TurnEffect } from './turnEffects'
import { mintRows, type EffectRunner, type TurnEnvironment } from './turnEnvironment'

function savedMemoryNotice(env: TurnEnvironment): Message[] {
  const config = env.input.runtimeConfig
  if (!config) return []
  const paths = takeSavedMemoryPaths(config)
  if (!paths || paths.length === 0) return []
  const names = paths.map((p) => p.split(/[/\\]/).pop() ?? p).join(', ')
  return [makeNoticeRow(config, `Saved memory: ${names}`, 'memory_saved')]
}

async function compactionRestores(env: TurnEnvironment): Promise<Message[]> {
  const ctx = env.ctx
  const readBefore = new Map(ctx.fileReadLedger)
  ctx.nestedMemoryPathsSeen?.clear()
  ctx.fileReadLedger.clear?.()
  const restore = await createPostCompactReadRestoreMessage({
    readPaths: ctx.recentReadPaths,
    readFileState: readBefore,
    toolUseContext: ctx,
  })
  const plan = await collectPostCompactPlanRows(ctx, env.input.runtimeConfig)
  return [...plan, ...(restore ? [restore] : [])]
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

/** The prompt rendered again after a compaction: the instruction files are
 *  read from disk anew. A failed render keeps the turn's prompt. */
async function instructionsAfterCompaction(
  env: TurnEnvironment,
  messages: readonly Message[],
): Promise<RefreshedInstructions | undefined> {
  const render = env.input.renderPromptAfterCompaction
  if (!render) return undefined
  try {
    const parts = await render(mintRows(env, messages))
    return {
      baseInstructions: parts.defaultSystemPrompt,
      userAmbient: parts.userContext,
      systemAmbient: parts.systemContext,
    }
  } catch {
    return undefined
  }
}

export const gatherRows: EffectRunner<Extract<TurnEffect, { kind: 'gatherRows' }>> =
  async function* (effect, env) {
    if (effect.stage === 'afterCompaction') {
      const rows = await compactionRestores(env)
      const instructions = await instructionsAfterCompaction(env, [...effect.messages, ...rows])
      return {
        type: 'rowsGathered',
        stage: effect.stage,
        rows,
        ...(instructions ? { instructions } : {}),
        identity: effect.identity,
      }
    }
    const rows = effect.stage === 'turnStart'
      ? savedMemoryNotice(env)
      : [...(await nestedRules(env)), ...(await recalledMemories(env))]
    return { type: 'rowsGathered', stage: effect.stage, rows, identity: effect.identity }
  }
