/**
 * Raises `turn.continue` over what the next step would add first, and turns
 * the chain's answer back into rows: a message the engine handed out is its
 * row again, one a hook built is a user row with a fresh id. A chain that
 * failed, or handed back a message the engine never gave, continues with
 * the pending rows as they were (reported).
 */
import type { Message } from '../runtime/RuntimeTypes'
import { MSG_TYPE_USER, ROLE_USER } from '../runtime/VercelModelConstants'
import type { ToolCallMods } from '../mods/toolCallEvent'
import { pendingOf, pendingRowsOf, type ContinueMessage, type TurnContinueInput } from '../mods/turnContinueEvent'
import type { TurnEffect } from './turnEffects'
import { mintRow, type EffectRunner, type TurnEnvironment } from './turnEnvironment'

type ContinueMods = Pick<Partial<ToolCallMods>, 'turnContinue' | 'report'> & { agentId?: string }

function builtRow(env: TurnEnvironment, message: ContinueMessage): Message {
  return {
    type: MSG_TYPE_USER,
    uuid: env.ambient.ids.message(),
    timestamp: env.ambient.clock.timestamp(),
    message: { role: ROLE_USER, content: message.text },
    ...(message.isMeta === true ? { isMeta: true } : {}),
  } as Message
}

export const raiseTurnContinue: EffectRunner<Extract<TurnEffect, { kind: 'raiseTurnContinue' }>> =
  async function* (effect, env) {
    const unchanged = { type: 'turnContinued' as const, pending: effect.pending, stop: false, identity: effect.identity }
    const mods = env.ctx.options.mods as ContinueMods | undefined
    if (!mods?.turnContinue) return unchanged
    // The rows a hook may keep carry their minted ids, as they will be kept.
    const rows = {
      queuedInput: effect.pending.queuedInput.map((row) => mintRow(env, row)),
      ...(effect.pending.nudge ? { nudge: mintRow(env, effect.pending.nudge) } : {}),
      attachments: effect.pending.attachments.map((row) => mintRow(env, row)),
    }
    const { pending, byHandle } = pendingOf(rows)
    const e: TurnContinueInput = {
      turnId: env.stepTurnId,
      index: effect.k,
      pending,
      outcomeSoFar: { ...effect.outcomeSoFar },
      ...(mods.agentId !== undefined ? { agentId: mods.agentId } : {}),
    }
    let settled
    try {
      settled = await mods.turnContinue(e, env.ctx.cancelSource.signal)
    } catch {
      return unchanged
    }
    if ('stop' in settled) return { ...unchanged, stop: true }
    const resolved = pendingRowsOf(settled.pending, byHandle, (message) => builtRow(env, message))
    if ('refused' in resolved) {
      mods.report?.(`mods: turn.continue: ${resolved.refused}; the turn continues as the engine decided`)
      return unchanged
    }
    return { ...unchanged, pending: resolved.rows }
  }
