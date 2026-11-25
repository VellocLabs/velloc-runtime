/**
 * One model request, wrapped by the extensions' `turn.step` when a hook
 * selects it. Every streamed row is yielded as it arrives; the answer holds
 * the replies and the tool calls they asked for. A turn that follows the
 * session's selection sends the request again when an attempt failed after
 * the selection moved: to the provider and model the selection now names,
 * where the rest of the turn then goes too (F-26).
 */
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import type { InstructionText, ModelReplyRow } from '../runtime/RuntimeTypes'
import { isAssistantMessage } from '../runtime/VercelModelConstants'
import { callModelThroughTurnStep } from './turn/turnStepThroughMods'
import type { TurnEffect } from './turnEffects'
import {
  instructionsOf,
  mintRows,
  providerOf,
  thinkingTierOf,
  type EffectRunner,
  type LiveSelection,
  type TurnEnvironment,
  type TurnTarget,
} from './turnEnvironment'
import { toolCallsOf } from './turnRows'

/** Where the turn's requests go now. */
function targetOf(env: TurnEnvironment): TurnTarget & { model: string } {
  return { providerId: providerOf(env), model: env.ctx.options.mainLoopModel, thinkingTier: thinkingTierOf(env) }
}

function sameTarget(live: TurnTarget, sent: TurnTarget): boolean {
  return live.providerId === sent.providerId
    && (live.model ?? sent.model) === sent.model
    && live.thinkingTier === sent.thinkingTier
}

/** Fires once the selection is no longer what the turn sends with; already
 *  fired when it moved before this request. */
function supersededSignal(live: LiveSelection, env: TurnEnvironment): AbortSignal {
  const changed = live.changed()
  if (changed.aborted || sameTarget(live.read(), targetOf(env))) return changed
  return AbortSignal.abort()
}

/** Moves the turn to the selection as it stands: the call context names the
 *  new provider and model, and the new model's instructions stand in for the
 *  ones the turn holds. A render that fails keeps the held instructions. */
async function followSelection(env: TurnEnvironment, live: LiveSelection, held: InstructionText): Promise<void> {
  const next = live.read()
  if (sameTarget(next, targetOf(env))) return
  const model = next.model ?? env.ctx.options.mainLoopModel
  let rendered: InstructionText | undefined
  try {
    rendered = await env.input.renderSystemPromptForModel?.({ providerId: next.providerId, modelId: model })
  } catch {
    rendered = undefined
  }
  env.ctx = {
    ...env.ctx,
    options: {
      ...env.ctx.options,
      mainLoopModel: model,
      mainLoopProviderId: next.providerId,
      userSpecifiedProviderId: next.providerId,
    },
  }
  env.moved = {
    providerId: next.providerId,
    thinkingTier: next.thinkingTier,
    ...(rendered !== undefined ? { instructions: { from: held, to: rendered } } : {}),
  }
}

export const requestModel: EffectRunner<Extract<TurnEffect, { kind: 'requestModel' }>> =
  async function* (effect, env) {
    const { deps, input } = env
    const messages = mintRows(env, effect.messages)
    env.ctx = { ...env.ctx, messages }
    const live = input.liveSelection
    const index = env.stepIndex++
    const replies: ModelReplyRow[] = []
    const toolCalls: QueryToolUseBlock[] = []
    for (;;) {
      const ctx = env.ctx
      const superseded = live ? supersededSignal(live, env) : undefined
      const stream = callModelThroughTurnStep(
        (req) => deps.callModel(req),
        {
          messages,
          baseInstructions: instructionsOf(env, effect.baseInstructions),
          userContext: effect.userAmbient as { [k: string]: string },
          systemAmbient: effect.systemAmbient as { [k: string]: string },
          callContext: ctx,
          providerId: providerOf(env),
          backupModel: input.backupModel,
          querySource: input.turnCaller,
          outputTokenCapOverride: effect.outputTokenCapOverride,
          thinkingTier: thinkingTierOf(env),
          noCacheWrite: input.noCacheWrite,
          taskBudget: input.spendBudget,
          forceFinalResponse: effect.finalResponse,
          ...(superseded ? { superseded } : {}),
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
      // A call that ended with no reply after the selection moved was given
      // up for the selection's sake: it is sent again where that points.
      if (!live || !superseded?.aborted || replies.length > 0 || ctx.cancelSource.signal.aborted) break
      await followSelection(env, live, effect.baseInstructions)
    }
    return { type: 'modelStreamed', replies, toolCalls, identity: effect.identity }
  }
