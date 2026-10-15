/**
 * The effects that need no answer of their own: host settings pushes (not
 * waited for), a delay, the persist request (rows are stored by the caller
 * as they are yielded, so nothing is written here) and the terminal commit
 * (the driver returns its conclusion).
 */
import type { TurnEffect } from './turnEffects'
import type { EffectRunner } from './turnEnvironment'

export const pushHostSettings: EffectRunner<Extract<TurnEffect, { kind: 'pushHostSettings' }>> =
  async function* (effect, env) {
    const ctx = env.ctx
    void ctx.platformCapabilities.session?.setAgentLoopSettings?.({
      ...effect.fields,
      executionContext: { sessionId: ctx.options.sessionId },
    } as never)
    return { type: 'effectDone', identity: effect.identity }
  }

export const delay: EffectRunner<Extract<TurnEffect, { kind: 'delay' }>> = async function* (effect, env) {
  await env.ambient.clock.sleep(effect.ms, env.ctx.cancelSource.signal)
  return { type: 'timerElapsed', identity: effect.identity }
}

export const acknowledge: EffectRunner<Extract<TurnEffect, { kind: 'persistRows' | 'commitTerminal' }>> =
  async function* (effect) {
    return { type: 'effectDone', identity: effect.identity }
  }
