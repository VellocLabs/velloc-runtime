/**
 * Stop handling. `Stop` runs the dependencies' stop handling (actor cleanup,
 * the ledger reset, the settings stop hooks, memory extraction) and answers
 * with whether a hook prevented continuation and the rows of blocking hooks.
 * `StopFailure` starts the failure hooks for the failed reply and does not
 * wait for them.
 */
import type { ModelReplyRow } from '../runtime/RuntimeTypes'
import { runStopFailureHooks } from '../lifecycleHooks/sessionLifecycleHooks'
import type { TurnEffect } from './turnEffects'
import { mintRows, type EffectRunner } from './turnEnvironment'

export const runStopHooks: EffectRunner<Extract<TurnEffect, { kind: 'runStopHooks' }>> =
  async function* (effect, env, state) {
    if (effect.event === 'StopFailure') {
      const failed = effect.replies.at(-1)
      if (failed) void runStopFailureHooks(failed as ModelReplyRow, env.ctx)
      return { type: 'stopHandled', preventContinuation: false, blockerRows: [], identity: effect.identity }
    }
    const outcome = await env.deps.runTurnEndHooks({
      messages: mintRows(env, state.messages),
      assistantMessages: [...effect.replies],
      systemPrompt: state.baseInstructions,
      userContext: state.userAmbient as { [k: string]: string },
      systemContext: state.systemAmbient as { [k: string]: string },
      toolUseContext: env.ctx,
      querySource: env.input.turnCaller,
      stopHookActive: state.inStopHook ? true : undefined,
    })
    return {
      type: 'stopHandled',
      preventContinuation: outcome.preventContinuation,
      blockerRows: outcome.blockerRows,
      identity: effect.identity,
    }
  }
