/**
 * Background work. `startBackground` starts the memory prefetch (once per
 * turn, chained to the turn's cancellation) or the tool-step digest (only
 * when the runtime gates ask for digests) and answers at once.
 * `awaitBackground` waits for the digest the machine asked for.
 */
import type { Message } from '../runtime/RuntimeTypes'
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow } from '../runtime/RuntimeTypes'
import { beginRecallLookahead } from '../memory/relevantRecall'
import type { TurnEffect } from './turnEffects'
import type { EffectRunner } from './turnEnvironment'
import { newestPromptText } from './effectPromptHooks'

type PrefetchInput = { messages: readonly Message[] }
type DigestInput = { calls: readonly QueryToolUseBlock[]; replies: readonly ModelReplyRow[] }

export const startBackground: EffectRunner<Extract<TurnEffect, { kind: 'startBackground' }>> =
  async function* (effect, env) {
    const { input, deps } = env
    if (effect.background === 'memoryPrefetch' && input.runtimeConfig) {
      const { messages } = effect.input as PrefetchInput
      env.prefetch = beginRecallLookahead({
        query: newestPromptText(input.messages),
        messages: [...messages],
        toolUseContext: env.ctx,
        providerId: input.providerId,
        runtimeConfig: input.runtimeConfig,
        signal: env.ctx.cancelSource.signal,
      })
    } else if (effect.background === 'toolDigest') {
      const { calls, replies } = effect.input as DigestInput
      if (calls.length > 0 && deps.getRuntimeGatesSnapshot(env.ctx).emitToolUseSummaries) {
        env.digest = deps.createToolUseSummary({
          assistantMessages: [...replies],
          toolUseBlocks: [...calls],
          toolResults: [],
          toolUseContext: env.ctx,
        })
      }
    }
    return { type: 'backgroundStarted', identity: effect.identity }
  }

export const awaitBackground: EffectRunner<Extract<TurnEffect, { kind: 'awaitBackground' }>> =
  async function* (effect, env) {
    const pending = env.digest
    env.digest = undefined
    const value = pending ? await pending : null
    return { type: 'backgroundSettled', kind: effect.background, value, identity: effect.identity }
  }
