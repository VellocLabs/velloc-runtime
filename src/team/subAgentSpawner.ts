/**
 * Leaf indirection (avoids an import cycle) for background sub-agent spawning:
 * the manager registers via `setSubAgentSpawner`; the tool reads
 * `getSubAgentSpawner()`, null when none is registered.
 */

import type { Message } from '../runtime/RuntimeTypes'

export type SubAgentSpawnParams = {
  /** The session that launched the sub-agent — the delivery target for its
   *  result (injected as a later parent turn). */
  spawnerSessionId: string
  /** The directive handed to the sub-agent as its first (and usually only)
   *  turn's prompt. The sub-agent runs in a fresh isolated context, so this
   *  must be self-contained. */
  prompt: string
  /** 3-5 word task label — shown to the user and echoed on result delivery. */
  description: string
  /** Resolved `subagent_type`, or undefined for a plain fork. */
  agentType?: string
  /** The agent's own system prompt (REPLACES the default template prompt);
   *  set only when a `subagent_type` resolved to a registered agent. */
  systemPrompt?: string
  /** The agent's model override, when its definition specifies one. */
  model?: string
  /**
   * Provider to pair with `model` when it was resolved from a TIER (the Agent
   * tool's `model: 'fast'|'balanced'|'best'` param) against the parent's
   * provider. Makes the worker take the exact requestedSelection path instead
   * of the bare catalog id-match. Absent for frontmatter-model spawns, which
   * keep the historical id-match resolution.
   */
  modelProviderId?: string
  /**
   * Thinking tier a USER PIN declared for the resolved model (a `specific`
   * session-model policy or a tier-dictionary pin with an effort). Rides the
   * init payload as `userSpecifiedThinkingTier`. Absent for plain tier
   * spawns — those boot the model's catalog default tier.
   */
  modelThinkingTier?: string
  /** The agent's tool allowlist (`agent.tools`) — keep only these tools. */
  allowTools?: string[]
  /** The agent's tool denylist (`agent.disallowedTools`) — drop these. Applied
   *  worker-side after the dynamic tool set is built (read-only Explore/Plan). */
  disallowTools?: string[]
  /** Worktree-isolation projectRoot override (`isolation:'worktree'`) — the
   *  storage/memory anchor. Set to the canonical REPO ROOT (not the worktree),
   *  so the sub-agent's transcript/memory co-locate with the real project and no
   *  orphan worktree-keyed `projects/<slug>/` dir is created. Undefined = shared
   *  tree (inherit the parent's projectRoot). */
  projectRoot?: string
  /** Worktree-isolation cwd override (`isolation:'worktree'`) — the sub-agent's
   *  own git checkout. Moves ONLY the working directory into the worktree; host
   *  file/shell tools re-anchor there via `applyWorktreeIsolation` (which fires
   *  because `cwd !== projectRoot`). Undefined = cwd follows projectRoot. */
  cwd?: string
  /**
   * Optional worktree-cleanup callback, invoked ONCE when the sub-agent
   * reaches a terminal state. The closure captures the SPAWNING tool's
   * `ToolUseContext` (whose host bridge outlives the turn), so it — unlike the
   * manager — can run git to remove the worktree when it has no changes.
   * Best-effort: failures fall to `git worktree
   * prune`. Only set for `isolation:'worktree'` spawns in a git repo. */
  onCleanup?: () => void | Promise<void>
  /**
   * Background fork only: the parent's messages, seeded as the worker's initial
   * messages so the fork continues the parent's context with a cache-compatible
   * prefix.
   */
  forkSeedMessages?: Message[]
  /**
   * Background FORK: skip the sub-agent tool-scope strip so the worker keeps the
   * parent's EXACT tool pool (a fork inherits everything, including the plan
   * tools), keeping its serialized tools array aligned with the parent's for
   * prompt-cache reuse. Set only for the fork route.
   */
  forkExactTools?: boolean
  /**
   * The routine this spawn's work originates from (`routineOriginIdOf` on the
   * spawning turn's context), stamped onto the sub-agent's init payload.
   */
  routineOriginId?: string
}

/** Returns the new sub-agent sessionId, or null if it couldn't spawn (no UI
 *  session has booted yet, or the sub-agent nesting depth cap was reached). */
export type SubAgentSpawner = (params: SubAgentSpawnParams) => string | null

let spawner: SubAgentSpawner | null = null

export function setSubAgentSpawner(fn: SubAgentSpawner | null): void {
  spawner = fn
}

export function getSubAgentSpawner(): SubAgentSpawner | null {
  return spawner
}
