/**
 * One model request, wrapped by the extensions' `turn.step` when a hook
 * selects it. Every streamed row is yielded as it arrives; the answer holds
 * the replies and the tool calls they asked for.
 */
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow } from '../runtime/RuntimeTypes'
import { isAssistantMessage } from '../runtime/VercelModelConstants'
import { callModelThroughTurnStep } from './turn/turnStepThroughMods'
import type { TurnEffect } from './turnEffects'
import { mintRows, type EffectRunner } from './turnEnvironment'
import { toolCallsOf } from './turnRows'

export const requestModel: EffectRunner<Extract<TurnEffect, { kind: 'requestModel' }>> =
  async function* (effect, env) {
    const { deps, input } = env
    const messages = mintRows(env, effect.messages)
    env.ctx = { ...env.ctx, messages }
    const ctx = env.ctx
    const index = env.stepIndex++
    const replies: ModelReplyRow[] = []
    const toolCalls: QueryToolUseBlock[] = []
    const stream = callModelThroughTurnStep(
      (req) => deps.callModel(req),
      {
        messages,
        baseInstructions: effect.baseInstructions,
        userContext: effect.userAmbient as { [k: string]: string },
        systemAmbient: effect.systemAmbient as { [k: string]: string },
        callContext: ctx,
        providerId: input.providerId,
        backupModel: input.backupModel,
        querySource: input.turnCaller,
        outputTokenCapOverride: effect.outputTokenCapOverride,
        thinkingTier: input.thinkingTier,
        noCacheWrite: input.noCacheWrite,
        taskBudget: input.spendBudget,
        forceFinalResponse: effect.finalResponse,
        ...(env.idsThroughMods ? { rowUuid: () => env.ambient.ids.message() } : {}),
        modStep: {
          turnId: env.stepTurnId,
          index,
          ...(ctx.options.mods?.agentId !== undefined ? { agentId: ctx.options.mods.agentId } : {}),
        },
      },
      {
        turnId: env.stepTurnId,
        index,
        transcriptLength: messages.length,
        ...(ctx.options.mods?.agentId !== undefined ? { agentId: ctx.options.mods.agentId } : {}),
      },
      ctx.options.mods,
      {
        uuid: () => env.ambient.ids.message(),
        timestamp: () => new Date(env.ambient.clock.now()).toISOString(),
      },
    )
    for await (const row of stream) {
      yield row
      if (!isAssistantMessage(row)) continue
      const reply = row as ModelReplyRow
      replies.push(reply)
      toolCalls.push(...toolCallsOf(reply))
    }
    return { type: 'modelStreamed', replies, toolCalls, identity: effect.identity }
  }
