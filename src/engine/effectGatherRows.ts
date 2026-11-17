/**
 * Gathers context rows by IO at three points of a turn through `rows.gather`: turn start and after a
 * tool step (feature modules contribute; the engine adds none), and after a compaction (ledgers
 * emptied, plan rows and read-file restore rebuilt, then the prompt re-rendered over every row).
 */
import type { Message } from '../runtime/RuntimeTypes'
import { nativeHooksOf } from '../toolkit/nativeHooks'
import { NATIVE_EVENTS, type RowsGatherEvent } from '../toolkit/nativeHookEvents'
import {
  collectPostCompactPlanRows,
  createPostCompactReadRestoreMessage,
} from '../messages/contextAttachments'
import { collectPostCompactSkillDiscoveryRows } from '../messages/postCompactSkillDiscovery'
import type { RefreshedInstructions, TurnEffect } from './turnEffects'
import { mintRows, type EffectRunner, type TurnEnvironment } from './turnEnvironment'

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
  const skills = collectPostCompactSkillDiscoveryRows(ctx, env.input.runtimeConfig)
  return [...plan, ...skills, ...(restore ? [restore] : [])]
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
    const e: RowsGatherEvent = { stage: effect.stage }
    const hooks = nativeHooksOf(env.ctx)
    if (effect.stage === 'afterCompaction') {
      const rows = (await hooks.around(NATIVE_EVENTS.rowsGather, e, env, () => compactionRestores(env))) as Message[]
      const instructions = await instructionsAfterCompaction(env, [...effect.messages, ...rows])
      return {
        type: 'rowsGathered',
        stage: effect.stage,
        rows,
        ...(instructions ? { instructions } : {}),
        identity: effect.identity,
      }
    }
    const rows = (await hooks.around(NATIVE_EVENTS.rowsGather, e, env, async () => [])) as Message[]
    return { type: 'rowsGathered', stage: effect.stage, rows, identity: effect.identity }
  }
