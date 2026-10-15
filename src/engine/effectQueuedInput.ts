/**
 * Drains input that arrived during the step (typed follow-ups, task
 * notifications, team frames) through the dependencies' queue. With queued
 * attachments switched off by the runtime gates, the plan-mode attachments
 * are collected instead. `planModeAttachment` set means the queue itself
 * must stay untouched (no request follows to answer it).
 */
import type { Message } from '../runtime/RuntimeTypes'
import { collectPlanModeAttachmentMessages } from '../messages/contextAttachments'
import type { TurnEffect } from './turnEffects'
import { mintRows, type EffectRunner } from './turnEnvironment'

export const drainQueuedInput: EffectRunner<Extract<TurnEffect, { kind: 'drainQueuedInput' }>> =
  async function* (effect, env, state) {
    const { deps, input } = env
    const gates = deps.getRuntimeGatesSnapshot(env.ctx)
    const rows: Message[] = []
    if (gates.enableQueuedAttachments) {
      if (!effect.planModeAttachment) {
        for await (const row of deps.getQueuedAttachments({
          messages: mintRows(env, state.messages),
          assistantMessages: [...state.stepReplies],
          toolResults: [...state.stepResults],
          toolUseContext: env.ctx,
          querySource: input.turnCaller,
        })) {
          rows.push(row)
        }
      }
    } else if (input.runtimeConfig) {
      rows.push(...(await collectPlanModeAttachmentMessages({ context: env.ctx, runtimeConfig: input.runtimeConfig })))
    }
    return { type: 'queuedInputDrained', rows, identity: effect.identity }
  }
