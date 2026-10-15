/**
 * `agent.offer` and `agent.spawn` through the session's mods (F-25): the helpers the Agent tool and the tool-schema render call. Never
 * reject: a holder without the method, or a chain that fails, offers the
 * agent and spawns as decided.
 */

import type { AgentOfferInput, AgentSpawnDecision, AgentSpawnInput, AgentSpawnSettlement } from '../mods/agentEvents'
import { ENGINE_PROVIDER, spawnDecisionOf } from '../mods/agentEvents'
import type { AgentEventMods } from '../mods/toolCallEvent'
import type { AgentProfile } from '../runtime/RuntimeTypes'

/** An agent definition as `agent.offer` describes it. */
export function describeAgentForOffer(agent: AgentProfile): AgentOfferInput {
  const description =
    typeof agent.useWhen === 'string'
      ? agent.useWhen
      : typeof agent.description === 'string'
        ? agent.description
        : ''
  return {
    agent: agent.name ?? '',
    description,
    source: typeof agent.source === 'string' ? agent.source : 'built-in',
    provider: ENGINE_PROVIDER,
  }
}

/** Whether the model is offered `agent` — true without a holder or a hook. */
export async function agentOfferedThroughMods(
  mods: Partial<AgentEventMods> | undefined,
  agent: AgentProfile,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!mods?.agentOffer || mods.hasAgentOfferHooks?.() === false) return true
  try {
    return await mods.agentOffer(describeAgentForOffer(agent), signal)
  } catch {
    return true
  }
}

/** The agents of `agents` the model is offered, in order. */
export async function offeredAgentsThroughMods(
  mods: Partial<AgentEventMods> | undefined,
  agents: readonly AgentProfile[],
  signal?: AbortSignal,
): Promise<AgentProfile[]> {
  if (!mods?.agentOffer || mods.hasAgentOfferHooks?.() === false) return [...agents]
  const kept: AgentProfile[] = []
  for (const agent of agents) {
    if (await agentOfferedThroughMods(mods, agent, signal)) kept.push(agent)
  }
  return kept
}

/** The spawn as the chain settled it: the decision to run with, or a deny. */
export async function agentSpawnThroughMods(
  mods: Partial<AgentEventMods> | undefined,
  input: AgentSpawnInput,
  core: (e: AgentSpawnInput) => Promise<{ model: string }> | { model: string },
  signal?: AbortSignal,
): Promise<AgentSpawnSettlement> {
  if (!mods?.agentSpawn || mods.hasAgentSpawnHooks?.() === false) return spawnDecisionOf(input)
  try {
    return await mods.agentSpawn(input, core, signal)
  } catch {
    return spawnDecisionOf(input)
  }
}

export type { AgentSpawnDecision }
