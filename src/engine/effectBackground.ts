/**
 * Background work. `startBackground` raises `turn.background` for the turn-start
 * prefetch (the memory module starts it) or starts the tool-step digest (only
 * when the runtime gates ask for digests) and answers at once.
 * `awaitBackground` waits for the digest the machine asked for.
 */
import type { Message } from '../runtime/RuntimeTypes'
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow } from '../runtime/RuntimeTypes'
import { nativeHooksOf } from '../toolkit/nativeHooks'
import { NATIVE_EVENTS, type TurnBackgroundEvent } from '../toolkit/nativeHookEvents'
import type { TurnEffect } from './turnEffects'
import type { EffectRunner } from './turnEnvironment'

type DigestInput = { calls: readonly QueryToolUseBlock[]; replies: readonly ModelReplyRow[] }

export const startBackground: EffectRunner<Extract<TurnEffect, { kind: 'startBackground' }>> =
  async function* (effect, env) {
    const { deps } = env
    if (effect.background === 'memoryPrefetch') {
      const e: TurnBackgroundEvent = { background: effect.background, input: effect.input }
      await nativeHooksOf(env.ctx).observe(NATIVE_EVENTS.turnBackground, e, env)
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
