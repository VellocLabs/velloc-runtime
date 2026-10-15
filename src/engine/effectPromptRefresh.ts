/**
 * Refreshes the prompt context between steps through the caller's callback
 * (page context after a browser step, the agent-loop nudges). A failed
 * refresh keeps the last known context.
 */
import type { TurnEffect, TurnEvent } from './turnEffects'
import { mintRows, type EffectRunner } from './turnEnvironment'

export const refreshPromptContext: EffectRunner<Extract<TurnEffect, { kind: 'refreshPromptContext' }>> =
  async function* (effect, env) {
    const unchanged: TurnEvent = { type: 'promptContextRefreshed', injected: [], identity: effect.identity }
    const refresh = env.input.refreshPromptContext
    if (!refresh) return unchanged
    try {
      const refreshed = await refresh(mintRows(env, effect.messages), effect.toolCalls, effect.k)
      if (!refreshed) return unchanged
      const parts = refreshed.promptParts
      return {
        type: 'promptContextRefreshed',
        ...(parts
          ? {
              instructions: {
                baseInstructions: parts.defaultSystemPrompt,
                userAmbient: parts.userContext,
                systemAmbient: parts.systemContext,
              },
            }
          : {}),
        injected: refreshed.injectedMessages ?? [],
        identity: effect.identity,
      }
    } catch {
      return unchanged
    }
  }
