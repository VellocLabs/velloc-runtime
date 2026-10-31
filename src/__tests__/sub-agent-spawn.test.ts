import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainRepoRoot } from '../utils/gitInfo'
import {
  openAgentCheckout,
  worktreeHasChanges,
  closeAgentCheckout,
} from '../utils/agentWorktree'
import {
  setSubAgentSpawner,
  getSubAgentSpawner,
  type SubAgentSpawnParams,
} from '../team/subAgentSpawner'

// Mock only the git-discovery + worktree seams so the worktree SUCCESS +
// cleanup paths are deterministic (no real git). Default = no git repo
// (`mainRepoRoot` → undefined), so every existing test keeps the
// shared-tree fallback; the worktree tests opt in per-call with
// `mockResolvedValueOnce`. `importActual` keeps the module's other exports real.
vi.mock('../utils/gitInfo', async orig => ({
  ...(await orig<typeof import('../utils/gitInfo')>()),
  mainRepoRoot: vi.fn(),
}))
vi.mock('../utils/agentWorktree', async orig => ({
  ...(await orig<typeof import('../utils/agentWorktree')>()),
  openAgentCheckout: vi.fn(),
  worktreeHasChanges: vi.fn(),
  closeAgentCheckout: vi.fn(),
}))
// Mock ONLY `launchFork` (keep save/recallForkPrefix real) so the
// inline foreground path's fork params — e.g. the tier-resolved
// `overrides.options.mainLoopModel` — are observable without booting the
// heavy query machinery. Tests that don't stub it explicitly never reach it
// (they null out the cache-safe params first).
vi.mock('../agents/forkedRun', async orig => ({
  ...(await orig<typeof import('../agents/forkedRun')>()),
  launchFork: vi.fn(),
}))
import {
  setSubAgentController,
  getSubAgentController,
  type SubAgentController,
} from '../team/subAgentController'
import { SpawnAgentTool } from '../toolkit/builtin/subagentLaunch'
import { setInternalUser } from '../utils/internalUser'
import {
  beginRoutineFireTurn,
  endRoutineFireTurn,
} from '../routines/routineTurnScope'
import {
  launchFork,
  rememberForkPrefix,
  type ForkPrefixSnapshot,
} from '../agents/forkedRun'
import {
  JobHaltTool,
  JobReadTool,
  AgentResumeTool,
  AgentListTool,
} from '../toolkit/builtin/subAgentControlTools'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import {
  subAgentsEqual,
  summarizeSubAgents,
} from '../browser/webview/backgroundSubAgents'
import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import { registerModSlot, type ModSlot } from '../mods/modSlotRegistry'
import type { ModAgentOutcome } from '../mods/modAgents'
import { formatTaskNotifications } from '../browser/worker/taskProjection'
import {
  processFs,
  installProcessFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'
import type { AgentRuntimeWorkerHandle } from '../browser/worker/SharedWorkerSessionManager'
import type { AgentRuntimeWorkerOptions } from '../browser/worker/AgentRuntimeWorker'
import type { AgentWorkerOutboundMessage } from '../browser/worker/workerProtocol'
import {
  acknowledgeBackgroundShellResult,
  setBackgroundShellResultAcknowledger,
} from '../toolkit/run/backgroundShellSink'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'

afterEach(() => setSubAgentSpawner(null))
afterEach(() => setInternalUser(false))
afterEach(() => setSubAgentController(null))
afterEach(() => setBackgroundShellResultAcknowledger(null))
afterEach(() => rememberForkPrefix(null))
afterEach(() => resetSessionModelSettingsSnapshot())

const ALLOW = async () => ({ behavior: 'allow' as const })
const PARENT = {
  type: 'assistant',
  uuid: 'a-1',
  message: { role: 'assistant', content: [] },
} as never

function ctx(sessionId = 'parent-1') {
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId,
  })
}

// Phase-2b helpers: `spawnSubAgentSession` now returns the PUBLIC `a…` taskId,
// but the unified `tasks`/`finishedTasks` maps are keyed by the NATIVE sessionId.
// Resolve public → native via the manager's `taskIdToNative` index (fallback to
// the id itself for directly-seeded native ids).
function nativeOf(manager: SharedWorkerSessionManager, publicId: string): string {
  const idx = (
    manager as unknown as { taskRegistry: { resolveNative(id: string): string } }
  ).taskRegistry
  return idx.resolveNative(publicId)
}
function hasLiveTask(
  manager: SharedWorkerSessionManager,
  publicId: string,
): boolean {
  return (
    manager as unknown as { taskRegistry: { hasLive(id: string): boolean } }
  ).taskRegistry.hasLive(nativeOf(manager, publicId))
}
function liveTask(
  manager: SharedWorkerSessionManager,
  publicId: string,
): { depth?: number } | undefined {
  return (
    manager as unknown as { taskRegistry: { getLive(id: string): { depth?: number } | undefined } }
  ).taskRegistry.getLive(nativeOf(manager, publicId))
}

/** Minimal SubAgentController for the SpawnAgentTool foreground-middle-layer tests. */
function fakeController(
  overrides: Partial<SubAgentController>,
): SubAgentController {
  return {
    getSnapshot: () => null,
    waitForCompletion: async () => null,
    stop: () => ({ status: 'not_found' }),
    resume: () => ({ ok: false, reason: 'not_found' }),
    list: () => [],
    acknowledgeResult: () => {},
    ...overrides,
  }
}

// ===========================================================================
// Leaf indirection
// ===========================================================================
describe('subAgentSpawner leaf', () => {
  it('set/get round-trips, defaults null', () => {
    expect(getSubAgentSpawner()).toBeNull()
    const fn: (p: SubAgentSpawnParams) => string | null = () => 'x'
    setSubAgentSpawner(fn)
    expect(getSubAgentSpawner()).toBe(fn)
  })
})

// ===========================================================================
// SpawnAgentTool.call — the worker-hosted background spawn branch (replaces fork)
// ===========================================================================
describe('SpawnAgentTool — background sub-agent spawn', () => {
  it('spawns a background sub-agent, returns the ack, forwards params — and does NOT block', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-abc'
    })
    const r = await SpawnAgentTool.call(
      {
        description: 'find config',
        prompt: 'locate the loader',
        run_in_background: true,
      },
      ctx('parent-9'),
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('Launched background sub-agent')
    expect(r.data).toContain('find config')
    expect(r.data).toContain('subagent-abc')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      spawnerSessionId: 'parent-9',
      prompt: 'locate the loader',
      description: 'find config',
    })
    // Omitted subagent_type → the general-purpose agent (an ISOLATED worker),
    // NOT a fork: its identity + system prompt are forwarded (resolved via the
    // BUILT_IN_AGENTS fallback since the noop ctx seeds an empty activeAgents);
    // no fork-context seeding.
    expect(calls[0]!.agentType).toBe('general-purpose')
    expect(typeof calls[0]!.systemPrompt).toBe('string')
    expect((calls[0]!.systemPrompt ?? '').length).toBeGreaterThan(0)
    expect(calls[0]!.model).toBeUndefined()
    expect(calls[0]!.forkSeedMessages).toBeUndefined()
    expect(calls[0]!.forkExactTools).toBeUndefined()
    // Ordinary user-driven turn → no routine provenance to carry.
    expect(calls[0]!.routineOriginId).toBeUndefined()
  })

  // --- Routine provenance (recursion guard across the spawn boundary) ---
  // A worker-hosted sub-agent boots a fresh session from the UI init template,
  // so nothing about the spawning turn reaches it unless it is passed
  // explicitly. Without this the `Agent` tool was a one-hop bypass of the
  // routine recursion guard. See routine-recursion-subagent.test.ts for the
  // denial half.

  it('forwards the routine origin of a headless routine turn to the sub-agent spawn', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-routine'
    })
    const c = ctx('routine-session-1')
    // The context a routine fire's worker runs in.
    Object.assign(
      c.options as unknown as { isHeadless?: boolean; routineId?: string },
      { isHeadless: true, routineId: 'cron-7' },
    )
    await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    expect(calls[0]!.routineOriginId).toBe('cron-7')
  })

  it('forwards the origin of a SESSION-delivered fire (turn marker) to the spawn', async () => {
    // Composition with routine-session-delivery: a session fire is a marked
    // TURN in the user's own session — no isHeadless, no routineOriginId on
    // the options. `routineOriginIdOf` reads the turn-scope marker by session
    // id, so the Agent spawn made during the fired turn still stamps its
    // sub-agent and the recursion guard holds one level down.
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-turn-fire'
    })
    const c = ctx('user-session-9')
    beginRoutineFireTurn('user-session-9', 'cron-9')
    try {
      await SpawnAgentTool.call(
        { description: 'd', prompt: 'p', run_in_background: true },
        c,
        ALLOW,
        PARENT,
      )
    } finally {
      endRoutineFireTurn('user-session-9')
    }
    expect(calls[0]!.routineOriginId).toBe('cron-9')
  })

  it('propagates an INHERITED origin transitively (a routine sub-agent spawning its own)', async () => {
    // The nested case: this parent is itself a sub-agent, so it has no
    // isHeadless/routineId — only the origin it inherited. Reading just
    // isHeadless here would lose the provenance one level down.
    // A sub-agent spawning its own sub-agent is INTERNAL-mode behavior —
    // external (the default) rejects the spawn at call time before the
    // origin stamping this test asserts is ever reached.
    setInternalUser(true)
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-nested'
    })
    const c = ctx('subagent-outer')
    Object.assign(c.options as unknown as { routineOriginId?: string }, {
      routineOriginId: 'cron-7',
    })
    await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    expect(calls[0]!.routineOriginId).toBe('cron-7')
  })

  it('resolves subagent_type → forwards the agent system prompt + model', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-x'
    })
    const c = ctx('parent-2')
    // The noop context seeds an empty activeAgents — push a fake agent so
    // findAgentDefinition resolves it.
    ;(c.options.agentDefinitions.enabledAgents as unknown[]).push({
      name: 'Explore',
      description: 'explorer',
      systemPrompt: 'You are a file search specialist',
      model: 'opus',
      disallowedTools: ['Write', 'Edit'],
      source: 'builtin',
    })
    const r = await SpawnAgentTool.call(
      {
        description: 'explore',
        prompt: 'find X',
        subagent_type: 'Explore',
        run_in_background: true,
      },
      c,
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('(Explore)')
    expect(calls[0]).toMatchObject({
      agentType: 'Explore',
      systemPrompt: 'You are a file search specialist',
      model: 'opus',
      // Milestone 2: the agent's tool allow/deny lists are forwarded for the
      // worker-side filter.
      disallowTools: ['Write', 'Edit'],
    })
  })

  it('errors on an unknown subagent_type', async () => {
    setSubAgentSpawner(() => 'x')
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', subagent_type: 'Nope', run_in_background: true },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/unknown subagent_type/i)
  })

  it('model tier resolves against the parent provider and forwards the {model, modelProviderId} pair', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-tier-1'
    })
    const c = ctx('parent-tier')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    const r = await SpawnAgentTool.call(
      { description: 'tier check', prompt: 'p', model: 'fast', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    // anthropic's fastModel (provider config) resolved against the parent's
    // provider, paired so the worker takes the exact requestedSelection path.
    expect(calls[0]).toMatchObject({
      model: 'claude-haiku-4-5',
      modelProviderId: 'anthropic',
    })
    // Honored request → no warn suffix.
    expect(r.data).not.toContain('[model note:')
  })

  it('tool-call model tier beats the agent frontmatter model', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-tier-2'
    })
    const c = ctx('parent-tier-2')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    ;(c.options.agentDefinitions.enabledAgents as unknown[]).push({
      name: 'Explore',
      description: 'explorer',
      systemPrompt: 'You are a file search specialist',
      model: 'opus',
      source: 'builtin',
    })
    await SpawnAgentTool.call(
      {
        description: 'explore',
        prompt: 'p',
        subagent_type: 'Explore',
        model: 'fast',
        run_in_background: true,
      },
      c,
      ALLOW,
      PARENT,
    )
    expect(calls[0]).toMatchObject({
      model: 'claude-haiku-4-5',
      modelProviderId: 'anthropic',
    })
    // Param absent → frontmatter still wins (existing behavior, asserted by
    // the 'resolves subagent_type' test above).
  })

  it('model tier matching the parent model passes NO override (exact-selection inherit)', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-tier-3'
    })
    const c = ctx('parent-tier-3')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-haiku-4-5'
    const r = await SpawnAgentTool.call(
      { description: 'tier check', prompt: 'p', model: 'fast', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    // The tier maps to the parent's current model → leave `model` undefined so
    // spawnSubAgentSession inherits the parent's exact live selection
    // (provider + model + thinkingTier).
    expect(calls[0]!.model).toBeUndefined()
    expect(calls[0]!.modelProviderId).toBeUndefined()
    expect(r.data).not.toContain('[model note:')
  })

  it('unrecognized model tier value warns + inherits (defensive: schema enums are soft at runtime)', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-tier-bad'
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await SpawnAgentTool.call(
        {
          description: 'tier check',
          prompt: 'p',
          model: 'super' as never,
          run_in_background: true,
        },
        ctx('parent-tier-bad'),
        ALLOW,
        PARENT,
      )
      expect(calls[0]!.model).toBeUndefined()
      expect(calls[0]!.modelProviderId).toBeUndefined()
      expect(r.data).toContain('[model note:')
      expect(r.data).toContain('not recognized')
    } finally {
      warn.mockRestore()
    }
  })

  it('model tier with no active provider id warns + inherits', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-tier-nop'
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The noop ctx carries no mainLoopProviderId — the tier cannot resolve.
      const r = await SpawnAgentTool.call(
        { description: 'tier check', prompt: 'p', model: 'fast', run_in_background: true },
        ctx('parent-tier-nop'),
        ALLOW,
        PARENT,
      )
      expect(calls[0]!.model).toBeUndefined()
      expect(calls[0]!.modelProviderId).toBeUndefined()
      expect(r.data).toContain('[model note:')
      expect(r.data).toContain('no active provider id')
    } finally {
      warn.mockRestore()
    }
  })

  it('foreground named tier override reaches the INLINE fork options (degraded no-manager path)', async () => {
    setSubAgentSpawner(null) // no manager → named foreground degrades to inline
    rememberForkPrefix({
      systemPrompt: ['sys'] as never,
      userContext: {},
      systemContext: {},
      toolUseContext: {
        options: { mainLoopModel: 'claude-fable-5', tools: [] },
      } as never,
      forkSeedRows: [],
    } as ForkPrefixSnapshot)
    vi.mocked(launchFork).mockResolvedValueOnce({ messages: [] } as never)

    const c = ctx('parent-inline-tier')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    ;(c.options.agentDefinitions.enabledAgents as unknown[]).push({
      name: 'Explore',
      description: 'explorer',
      systemPrompt: 'You are a file search specialist',
      model: 'opus', // frontmatter would win WITHOUT the tier param
      source: 'builtin',
    })
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', subagent_type: 'Explore', model: 'fast' },
      c,
      ALLOW,
      PARENT,
    )
    expect(vi.mocked(launchFork)).toHaveBeenCalledTimes(1)
    const forkParams = vi.mocked(launchFork).mock.calls[0]![0]!
    // Tier beats frontmatter on the inline route too — now via the ordered
    // modelLadder candidates (head = the tier pair, tail = the parent
    // failure fallback) so the fork gets provider forwarding + retry-once;
    // the options override deliberately stays on the parent model.
    expect(forkParams.modelLadder).toEqual([
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
      { providerId: 'anthropic', modelId: 'claude-fable-5' },
    ])
    expect(forkParams.overrides?.options?.mainLoopModel).toBe('claude-fable-5')
    expect(forkParams.omitParentContext).toBe(true)
    expect(r.data).not.toContain('[model note:')
  })

  it('session-model policy: a hard `specific` pin beats the call-time tier and surfaces a [model note:]', async () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        agent_tool: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          thinkingTier: 'high',
        },
      },
    })
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-policy-pin'
    })
    const c = ctx('parent-policy-pin')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', model: 'fast', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    // The pin's full triple rides the spawn — cross-provider pair + the
    // user's declared effort — and the model is told its tier lost.
    expect(calls[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      modelProviderId: 'deepseek',
      modelThinkingTier: 'high',
    })
    expect(r.data).toContain('[model note:')
    expect(r.data).toContain('overridden by the user')
  })

  it('session-model policy: `same-as-parent` forces the exact-selection inherit against a call-time tier', async () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'same-as-parent' } },
    })
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-policy-sap'
    })
    const c = ctx('parent-policy-sap')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', model: 'fast', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    // No override → spawnSubAgentSession inherits the parent's exact live
    // selection (provider + model + thinkingTier).
    expect(calls[0]!.model).toBeUndefined()
    expect(calls[0]!.modelProviderId).toBeUndefined()
    expect(r.data).toContain('[model note:')
  })

  it('session-model policy: the soft `tier` route fills in when the call has no tier, and yields to an explicit one', async () => {
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: { agent_tool: { mode: 'tier', tier: 'balanced' } },
    })
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return `subagent-policy-tier-${calls.length}`
    })
    const c = ctx('parent-policy-tier')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    // No call-time tier → the policy's 'balanced' resolves via the ladder.
    const soft = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    expect(calls[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      modelProviderId: 'anthropic',
    })
    expect(soft.data).not.toContain('[model note:')
    // Explicit call-time tier → the per-call judgment wins over the soft route.
    await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', model: 'fast', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    expect(calls[1]).toMatchObject({
      model: 'claude-haiku-4-5',
      modelProviderId: 'anthropic',
    })
  })

  it('a global dictionary pin redefines a call-time tier CROSS-PROVIDER', async () => {
    setSessionModelSettingsSnapshot({
      modelTiers: {
        fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      },
    })
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-dict-pin'
    })
    const c = ctx('parent-dict-pin')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', model: 'fast', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    // The dictionary defines what 'fast' MEANS — everywhere, any provider.
    expect(calls[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      modelProviderId: 'deepseek',
    })
    expect(r.data).not.toContain('[model note:')
  })

  it('a hard `specific` policy beats the agent FRONTMATTER model (policy > frontmatter > inherit)', async () => {
    // No call-time tier here — this isolates the policy-vs-frontmatter
    // precedence: the named agent declares its own `model`, but the user's
    // hard pin must win. (Call-time-tier-vs-policy is covered separately.)
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        agent_tool: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
        },
      },
    })
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-policy-vs-fm'
    })
    const c = ctx('parent-policy-vs-fm')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    ;(c.options.agentDefinitions.enabledAgents as unknown[]).push({
      name: 'Explore',
      description: 'explorer',
      systemPrompt: 'You are a file search specialist',
      model: 'opus', // frontmatter — must LOSE to the hard policy
      source: 'builtin',
    })
    await SpawnAgentTool.call(
      {
        description: 'explore',
        prompt: 'p',
        subagent_type: 'Explore',
        run_in_background: true,
      },
      c,
      ALLOW,
      PARENT,
    )
    // The policy pin wins; the frontmatter `opus` is never consulted.
    expect(calls[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      modelProviderId: 'deepseek',
    })
  })

  it('the `fork` route IGNORES a configured policy (forced to inherit, no note)', async () => {
    // A hard specific policy is set, but the fork route must still inherit
    // the parent model so the prompt cache is reused — the tier resolution is
    // forced to `none` for non-named routes regardless of policy. This
    // asymmetry with skill_fork/hook_agent is DELIBERATE (fork = the model
    // continuing ITS OWN cached context; a different model can't reuse that
    // cache and would break the self-continuation).
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        agent_tool: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
        },
      },
    })
    rememberForkPrefix({
      systemPrompt: ['sys'] as never,
      userContext: {},
      systemContext: {},
      toolUseContext: {
        options: { mainLoopModel: 'opus-test', tools: [] },
      } as never,
      forkSeedRows: [],
    } as ForkPrefixSnapshot)
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-fork-ignores-policy'
    })
    const r = await SpawnAgentTool.call(
      {
        description: 'review',
        prompt: 'review the work above',
        subagent_type: 'fork',
        run_in_background: true,
        model: 'fast',
      },
      ctx('parent-fork-policy'),
      ALLOW,
      PARENT,
    )
    // Parent model, no provider pair, no override note — the policy did not
    // touch the fork.
    expect(calls[0]).toMatchObject({ agentType: 'fork', model: 'opus-test' })
    expect(calls[0]!.modelProviderId).toBeUndefined()
    expect(r.data).not.toContain('[model note:')
  })

  it('a hard `specific` policy reaches the INLINE fork (degraded no-manager path) via modelLadder', async () => {
    // No spawner → the named foreground route degrades to inline. The policy
    // must still apply, riding launchFork's [pin, parent] candidate list
    // (the inline mirror of the worker path's modelFallbackSelection).
    setSubAgentSpawner(null)
    setSessionModelSettingsSnapshot({
      sessionModelPolicy: {
        agent_tool: {
          mode: 'specific',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-flash',
        },
      },
    })
    rememberForkPrefix({
      systemPrompt: ['sys'] as never,
      userContext: {},
      systemContext: {},
      toolUseContext: {
        options: { mainLoopModel: 'claude-fable-5', tools: [] },
      } as never,
      forkSeedRows: [],
    } as ForkPrefixSnapshot)
    // Reset so `mock.calls[0]` is unambiguously THIS test's spawn (mock.calls
    // accumulate across tests in this file — clearMocks isn't configured).
    vi.mocked(launchFork).mockReset()
    vi.mocked(launchFork).mockResolvedValueOnce({ messages: [] } as never)

    const c = ctx('parent-inline-policy')
    c.options.mainLoopProviderId = 'anthropic'
    c.options.mainLoopModel = 'claude-fable-5'
    // The named route must resolve — register the built-in Explore agent
    // (an unregistered subagent_type errors out and never reaches the fork).
    ;(c.options.agentDefinitions.enabledAgents as unknown[]).push({
      name: 'Explore',
      description: 'explorer',
      systemPrompt: 'You are a file search specialist',
      source: 'builtin',
    })
    await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', subagent_type: 'Explore', model: 'fast' },
      c,
      ALLOW,
      PARENT,
    )
    expect(vi.mocked(launchFork)).toHaveBeenCalledTimes(1)
    const forkParams = vi.mocked(launchFork).mock.calls[0]![0]!
    // Head = the policy pin (cross-provider), tail = the parent fallback.
    expect(forkParams.modelLadder).toEqual([
      { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      { providerId: 'anthropic', modelId: 'claude-fable-5' },
    ])
    // The overrides object stays on the parent model — modelLadder owns
    // the selection (+ its retry-once fallback).
    expect(forkParams.overrides?.options?.mainLoopModel).toBe('claude-fable-5')
  })

  it('middle-layer inline result carries the [model note:] suffix when the tier is unresolvable', async () => {
    setSubAgentSpawner(() => 'subagent-fg-note')
    const waitForCompletion = vi.fn(async () => ({
      sessionId: 'subagent-fg-note',
      status: 'success' as const,
      description: 'd',
      taskType: 'local_agent' as const,
      output: 'the answer',
      startedAt: 0,
    }))
    setSubAgentController(
      fakeController({ waitForCompletion, acknowledgeResult: vi.fn() }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const c = ctx('parent-fg-note')
      c.options.mainLoopProviderId = 'ollama' // no tier fields → unresolvable
      c.options.mainLoopModel = 'llama3'
      const r = await SpawnAgentTool.call(
        { description: 'd', prompt: 'p', model: 'best' },
        c,
        ALLOW,
        PARENT,
      )
      // The sub-agent's answer still comes back inline, and the model is told
      // its tier request was not honored.
      expect(r.data).toContain('the answer')
      expect(r.data).toContain('[model note:')
    } finally {
      warn.mockRestore()
    }
  })

  it('unresolvable model tier warns + inherits the parent model (never a third model)', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-tier-4'
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const c = ctx('parent-tier-4')
      // ollama declares no tier fields → 'best' cannot resolve.
      c.options.mainLoopProviderId = 'ollama'
      c.options.mainLoopModel = 'llama3'
      const r = await SpawnAgentTool.call(
        { description: 'tier check', prompt: 'p', model: 'best', run_in_background: true },
        c,
        ALLOW,
        PARENT,
      )
      expect(calls[0]!.model).toBeUndefined()
      expect(calls[0]!.modelProviderId).toBeUndefined()
      // The model-facing surface: the launch ack carries the note.
      expect(r.data).toContain('[model note:')
      expect(r.data).toContain('not configured for provider "ollama"')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('subagent_type:"fork" + run_in_background copies the parent context (seed messages + exact tools + model) for cache reuse', async () => {
    const seedMessages = [
      { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'prior turn' } },
    ] as never[]
    // The fork route reads the turn's captured cache-safe prefix.
    rememberForkPrefix({
      systemPrompt: ['sys'] as never,
      userContext: {},
      systemContext: {},
      toolUseContext: {
        options: { mainLoopModel: 'opus-test', tools: [] },
      } as never,
      forkSeedRows: seedMessages,
    } as ForkPrefixSnapshot)

    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-fork-1'
    })
    const r = await SpawnAgentTool.call(
      {
        description: 'review work',
        prompt: 'review the parser changes above',
        subagent_type: 'fork',
        run_in_background: true,
        // The tier param is IGNORED on the fork route (a fork keeps the
        // parent's model so the prompt cache is reused) — asserted below.
        model: 'fast',
      },
      ctx('parent-fork'),
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('subagent-fork-1')
    // Fork ack reflects context inheritance, not isolation.
    expect(r.data).toContain('continues your conversation')
    // Ignored silently — no warn suffix either.
    expect(r.data).not.toContain('[model note:')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      agentType: 'fork',
      model: 'opus-test',
      forkExactTools: true,
    })
    expect(calls[0]!.modelProviderId).toBeUndefined()
    // The parent's conversation prefix is forwarded verbatim (same reference).
    expect(calls[0]!.forkSeedMessages).toBe(seedMessages)
    // A fork inherits the parent's prompt — no named-agent systemPrompt override.
    expect(calls[0]!.systemPrompt).toBeUndefined()
  })

  it('subagent_type:"fork" + run_in_background errors (no fallback) when no cache-safe params were captured', async () => {
    rememberForkPrefix(null)
    setSubAgentSpawner(() => 'x')
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', subagent_type: 'fork', run_in_background: true },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/cache-safe parameters/i)
  })

  it('reports unavailable when no spawner is registered', async () => {
    setSubAgentSpawner(null)
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/unavailable/i)
  })

  it('reports deferred when the spawner returns null', async () => {
    setSubAgentSpawner(() => null)
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/deferred/i)
  })

  // --- Foreground middle layer (named/isolated = always-background) ---
  // A DEFAULT (general-purpose = named/isolated) foreground Agent call is now
  // spawned as a background worker task and the tool blocks up to the budget so it
  // looks foreground. `fork` KEEPS its inline exact-cache continuation.

  it('DEFAULT (named/isolated) foreground uses the middle layer: spawns a background worker + returns inline when it finishes within budget', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-fg'
    })
    const ack = vi.fn()
    const waitForCompletion = vi.fn(
      async (_id: string, _budget: number, _signal?: AbortSignal) => ({
        sessionId: 'subagent-fg',
        status: 'success' as const,
        description: 'd',
        taskType: 'local_agent' as const,
        output: 'the answer',
        startedAt: 0,
      }),
    )
    setSubAgentController(fakeController({ waitForCompletion, acknowledgeResult: ack }))
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p' },
      ctx('parent-fg'),
      ALLOW,
      PARENT,
    )
    // It DID spawn a background worker (no longer the inline fork path), then the
    // middle layer waited up to the foreground budget (120s) and returned the finished
    // answer INLINE + acknowledged it (suppressing the duplicate delivery turn).
    expect(calls).toHaveLength(1)
    expect(calls[0]!.agentType).toBe('general-purpose')
    // Waited on the just-spawned session with the 120s budget; the 3rd arg is the
    // turn's abort signal (a Stop during the wait stops the sub-agent).
    expect(waitForCompletion).toHaveBeenCalledTimes(1)
    const [waitedId, waitedBudget] = waitForCompletion.mock.calls[0]!
    expect(waitedId).toBe('subagent-fg')
    expect(waitedBudget).toBe(120_000)
    expect(ack).toHaveBeenCalledWith('subagent-fg')
    expect(r.data).toBe('(task id subagent-fg)\n\nthe answer')
  })

  it('foreground named sub-agent still running after budget → returns the launch ack (auto-promoted), NOT acknowledged', async () => {
    setSubAgentSpawner(() => 'subagent-slow')
    const ack = vi.fn()
    const waitForCompletion = vi.fn(async () => ({
      sessionId: 'subagent-slow',
      status: 'running' as const,
      description: 'long task',
      taskType: 'local_agent' as const,
      output: '',
      startedAt: 0,
    }))
    setSubAgentController(fakeController({ waitForCompletion, acknowledgeResult: ack }))
    const r = await SpawnAgentTool.call(
      { description: 'long task', prompt: 'p' },
      ctx('parent-slow'),
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('Launched background sub-agent')
    expect(r.data).toContain('subagent-slow')
    // Not acknowledged → the manager delivers it exactly once later.
    expect(ack).not.toHaveBeenCalled()
  })

  it('subagent_type:"fork" foreground STAYS inline — does NOT spawn a background worker', async () => {
    let spawned = false
    setSubAgentSpawner(() => {
      spawned = true
      return 'x'
    })
    // The inline fork path needs cache-safe params; the noop ctx has none, so it
    // degrades — but crucially a foreground fork takes the INLINE path and does
    // NOT consult the background spawner (fork keeps exact-cache continuation).
    rememberForkPrefix(null)
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', subagent_type: 'fork' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(spawned, 'a foreground fork must NOT spawn a background sub-agent').toBe(false)
    expect(r.data).toMatch(/cache-safe parameters/i)
  })

  it("subagent_type:'fork' reads THIS runtime's cache-safe snapshot, never a sibling runtime's (shared-realm isolation)", async () => {
    // The SharedWorker hosts every runtime in one realm. Before the
    // per-runtime keying, `recallForkPrefix()` was one module slot that
    // `engine/turnLoop.ts` rewrote before EVERY runtime's tool batch — a fork could
    // pick up whichever runtime wrote last and fork the SIBLING's
    // conversation (with, since fast-call-scope-binding, the sibling's
    // scope-bound transport). Here runtime B (a sibling — think a background
    // sub-agent's runtime) wrote the last snapshot; runtime A never captured
    // one. A's fork must NOT fork B's conversation.
    setSubAgentSpawner(() => 'unused')
    const runtimeA = new DefaultRuntimeConfig()
    const runtimeB = new DefaultRuntimeConfig()
    rememberForkPrefix(null) // keyless slot empty too — no fallback anywhere
    rememberForkPrefix(
      {
        systemPrompt: ['sibling B system prompt'] as never,
        userContext: {},
        systemContext: {},
        toolUseContext: {
          options: { mainLoopModel: 'sibling-b-model', tools: [] },
        } as never,
        forkSeedRows: [
          { type: 'user', uuid: 'b-1', message: { role: 'user', content: 'B secret' } },
        ] as never,
      } as ForkPrefixSnapshot,
      runtimeB,
    )
    // (On the pre-fix tree the slot is keyless: the write above lands in
    // the one global slot and A's read below returns B's snapshot — so this
    // case fails there for the real reason: A forks B's conversation.)
    vi.mocked(launchFork).mockClear()
    vi.mocked(launchFork).mockResolvedValue({ messages: [] } as never)

    const c = ctx('parent-a')
    c.options.runtimeConfig = runtimeA
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', subagent_type: 'fork' },
      c,
      ALLOW,
      PARENT,
    )
    // No snapshot for runtime A → the inline fork degrades (and says so)
    // instead of forking runtime B's conversation.
    expect(vi.mocked(launchFork)).not.toHaveBeenCalled()
    expect(r.data).toMatch(/cache-safe parameters/i)

    // And once runtime A captures its own snapshot, its fork uses THAT one.
    rememberForkPrefix(
      {
        systemPrompt: ['runtime A system prompt'] as never,
        userContext: {},
        systemContext: {},
        toolUseContext: {
          options: { mainLoopModel: 'runtime-a-model', tools: [] },
        } as never,
        forkSeedRows: [],
      } as ForkPrefixSnapshot,
      runtimeA,
    )
    vi.mocked(launchFork).mockResolvedValueOnce({ messages: [] } as never)
    await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', subagent_type: 'fork' },
      c,
      ALLOW,
      PARENT,
    )
    expect(vi.mocked(launchFork)).toHaveBeenCalledTimes(1)
    const forkParams = vi.mocked(launchFork).mock.calls[0]![0]!
    expect(forkParams.forkPrefix.systemPrompt).toEqual(['runtime A system prompt'])
    rememberForkPrefix(null, runtimeA)
    rememberForkPrefix(null, runtimeB)
    vi.mocked(launchFork).mockReset()
  })

  it('foreground named sub-agent with NO manager falls back to the inline fork path (no spawn)', async () => {
    setSubAgentSpawner(null) // no manager → useMiddleLayer is false
    rememberForkPrefix(null) // inline path degrades with the cache-safe message
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/cache-safe parameters/i)
  })

  it('foreground named sub-agent falls back to the inline run when the spawner DEFERS (null) instead of silently dropping the work', async () => {
    // Regression: a NAMED foreground sub-agent routes through the depth-capped
    // background spawner. When spawn() returns null — no active UI session yet,
    // or MAX_SUBAGENT_DEPTH reached — the tool must DEGRADE to an inline
    // in-context run this turn, NOT reply "spawn deferred" and silently never
    // run the delegated work.
    let spawnCalls = 0
    setSubAgentSpawner(() => {
      spawnCalls++
      return null // deferred: no session / depth cap
    })
    // The inline fallback needs cache-safe params; with none captured it degrades
    // with the cache-safe message — which PROVES the inline path was taken (a
    // "spawn deferred" reply would prove the work was dropped instead).
    rememberForkPrefix(null)
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p' }, // default general-purpose = named foreground
      ctx('parent-defer-fg'),
      ALLOW,
      PARENT,
    )
    // The middle layer DID attempt the background spawn first (the depth-capped
    // path), then fell back to the inline run rather than deferring.
    expect(spawnCalls).toBe(1)
    expect(r.data).toMatch(/cache-safe parameters/i)
    expect(r.data).not.toMatch(/deferred/i)
  })

  it('isolation:"worktree" still spawns — degrades to the shared tree when not a git repo (M3)', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-wt'
    })
    // The noop test context has no git repo, so worktree setup falls through
    // (best-effort, caught) and the sub-agent spawns without a projectRoot
    // override — but it MUST still spawn (not error / not block).
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', isolation: 'worktree' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('Launched background sub-agent')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.projectRoot).toBeUndefined()
  })

  it('isolation:"worktree" in a git repo anchors projectRoot on the REPO ROOT and moves only cwd to the worktree (no orphan projects dir)', async () => {
    // Regression: a worktree sub-agent must NOT set projectRoot = the worktree
    // path. If it did, `prepareWorkerStorage`/`defaultMemoryDir` would create
    // an orphan `~/.velloc/projects/<projectFolderKey(worktree)>/` group keyed on the
    // throwaway worktree (the git worktree is removed on cleanup; the storage
    // group is not). projectRoot stays on the canonical repo root; only cwd moves.
    const repoRoot = '/repo'
    const checkoutDir = '/repo/.velloc/worktrees/general-purpose_abc'
    vi.mocked(mainRepoRoot).mockResolvedValueOnce(repoRoot)
    vi.mocked(openAgentCheckout).mockResolvedValueOnce({
      checkoutDir,
      branch: 'nexus-agent-general-purpose_abc',
      baseCommit: 'deadbeef',
    })
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-wt2'
    })
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', isolation: 'worktree' },
      ctx('parent-wt'),
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('Launched background sub-agent')
    expect(calls).toHaveLength(1)
    // The storage/memory anchor is the repo root — NOT the worktree (the bug).
    expect(calls[0]!.projectRoot).toBe(repoRoot)
    expect(calls[0]!.projectRoot).not.toContain('worktrees')
    // Only the working directory moved into the worktree.
    expect(calls[0]!.cwd).toBe(checkoutDir)
  })

  it('isolation:"worktree": a DEFERRED spawn (no session) cleans up the just-created worktree instead of orphaning it', async () => {
    // Regression: the worktree is created BEFORE spawn(); its cleanup closure is
    // only handed to the manager via a SUCCESSFUL spawn. If spawn() returns null
    // (no UI session / max nesting depth) the tool must run cleanup itself, else
    // the checkout + branch leak on disk (only reclaimable by `git worktree
    // prune`).
    const repoRoot = '/repo'
    const worktree = {
      checkoutDir: '/repo/.velloc/worktrees/general-purpose_def',
      branch: 'nexus-agent-general-purpose_def',
      baseCommit: 'deadbeef',
    }
    vi.mocked(mainRepoRoot).mockResolvedValueOnce(repoRoot)
    vi.mocked(openAgentCheckout).mockResolvedValueOnce(worktree)
    // Just-created worktree has no changes → cleanup removes it.
    vi.mocked(worktreeHasChanges).mockResolvedValueOnce(false)
    vi.mocked(closeAgentCheckout).mockResolvedValueOnce(undefined)
    // Spawner returns null → the deferral path (no session spawned).
    setSubAgentSpawner(() => null)
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', isolation: 'worktree' },
      ctx('parent-defer'),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/spawn deferred/i)
    // The orphan guard: cleanup ran for THIS worktree.
    expect(vi.mocked(closeAgentCheckout)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(closeAgentCheckout)).toHaveBeenCalledWith(
      expect.anything(),
      repoRoot,
      worktree,
    )
  })

  it('subagent_type:"fork" + run_in_background is REJECTED when requested from inside a fork (depth >= 1) — symmetric with the sync branch', async () => {
    // Regression: the background branch must pass the in-process query depth to
    // resolveSubagentRoute so a fork-inside-a-fork is rejected with
    // FORK_NESTED_ERROR, exactly like the synchronous branch. A synchronous fork
    // runs in THIS process at depth >= 1 and can reach the background branch by
    // setting run_in_background.
    setSubAgentSpawner(() => 'should-not-be-reached')
    const nested = ctx('parent-nested')
    ;(nested as unknown as { turnChain?: { depth: number } }).turnChain = {
      depth: 1,
    }
    const r = await SpawnAgentTool.call(
      {
        description: 'd',
        prompt: 'p',
        subagent_type: 'fork',
        run_in_background: true,
      },
      nested,
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/inside a forked sub-agent/i)
  })
})

// ===========================================================================
// External-mode nesting guard (external mode strips Agent from sub-agent
// pools; a fork KEEPS the tool so its prompt cache matches the parent's, and
// is rejected at call time instead). The guard
// sits at the TOP of SpawnAgentTool.call so no route — including the null-spawn
// inline fallback — can run a nested agent from inside a sub-agent.
// ===========================================================================
describe('SpawnAgentTool external-mode nesting guard', () => {
  it('EXTERNAL (default): an IN-PROCESS sub-agent (context.agentId set) is rejected at call time, spawner untouched', async () => {
    // The fork-child case: deriveChildToolContext always mints an agentId, and
    // a fork keeps the full parent tool pool — this call-time reject is its
    // ONLY nesting guard.
    let spawnCalls = 0
    setSubAgentSpawner(() => {
      spawnCalls++
      return 'subagent-should-not-exist'
    })
    const c = ctx('parent-1')
    ;(c as unknown as { agentId?: string }).agentId = 'fork_deadbeef_x1'
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p' },
      c,
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/not available inside a sub-agent/i)
    expect(spawnCalls).toBe(0)
  })

  it('EXTERNAL (default): a WORKER-HOSTED sub-agent runtime (subagent-… sessionId, agentId unset) is rejected too', async () => {
    // A background sub-agent runs a fresh engine (agentId undefined, depth 0);
    // the manager-stamped `subagent-` sessionId is the caller signal there.
    let spawnCalls = 0
    setSubAgentSpawner(() => {
      spawnCalls++
      return 'subagent-should-not-exist'
    })
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      ctx('subagent-abc123'),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/not available inside a sub-agent/i)
    expect(spawnCalls).toBe(0)
  })

  it('EXTERNAL (default): the MAIN agent is unaffected — its background spawn proceeds', async () => {
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-ok'
    })
    const r = await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      ctx('parent-main'),
      ALLOW,
      PARENT,
    )
    expect(calls.length).toBe(1)
    expect(String(r.data)).not.toMatch(/not available inside a sub-agent/i)
  })

  it('INTERNAL mode: the same sub-agent contexts spawn nested agents again (pre-flag behavior)', async () => {
    setInternalUser(true)
    const calls: SubAgentSpawnParams[] = []
    setSubAgentSpawner(p => {
      calls.push(p)
      return 'subagent-nested-ok'
    })
    // In-process sub-agent (agentId set).
    const c = ctx('parent-1')
    ;(c as unknown as { agentId?: string }).agentId = 'fork_deadbeef_x1'
    await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      c,
      ALLOW,
      PARENT,
    )
    // Worker-hosted sub-agent runtime (subagent-… sessionId).
    await SpawnAgentTool.call(
      { description: 'd', prompt: 'p', run_in_background: true },
      ctx('subagent-outer'),
      ALLOW,
      PARENT,
    )
    expect(calls.length).toBe(2)
  })

  it('the guard reads the mode LAZILY — a flip changes the very next call, no reload', async () => {
    let spawnCalls = 0
    setSubAgentSpawner(() => {
      spawnCalls++
      return 'subagent-lazy'
    })
    const makeCtx = () => {
      const c = ctx('parent-1')
      ;(c as unknown as { agentId?: string }).agentId = 'fork_lazy_1'
      return c
    }
    const input = { description: 'd', prompt: 'p', run_in_background: true }
    const r1 = await SpawnAgentTool.call(input, makeCtx(), ALLOW, PARENT)
    expect(r1.data).toMatch(/not available inside a sub-agent/i)
    setInternalUser(true)
    await SpawnAgentTool.call(input, makeCtx(), ALLOW, PARENT)
    expect(spawnCalls).toBe(1)
    setInternalUser(false)
    const r3 = await SpawnAgentTool.call(input, makeCtx(), ALLOW, PARENT)
    expect(r3.data).toMatch(/not available inside a sub-agent/i)
    expect(spawnCalls).toBe(1)
  })
})

// ===========================================================================
// Manager delivery registry — spawn → emit → deliver into the parent turn.
// Uses a fake worker so completion is driven deterministically (no timers).
// ===========================================================================

type FakeWorker = {
  worker: AgentRuntimeWorkerHandle
  submits: string[]
}

/** A fake worker that records submitMessage prompts. `submitBlocks` makes the
 *  submit promise pend until `releaseSubmit()` (mirrors the real worker, whose
 *  submit resolves only after worker.completed). */
function makeFakeWorker(opts: { submitBlocks?: boolean } = {}): FakeWorker & {
  releaseSubmit: () => void
} {
  const submits: string[] = []
  let release = () => {}
  const submitGate = opts.submitBlocks
    ? new Promise<void>(res => {
        release = res
      })
    : Promise.resolve()
  const worker = makeMockWorker({
    async receiveFrame(msg: { type: string; payload?: unknown }) {
      if (msg.type === 'worker.submitMessage') {
        const prompt = (msg.payload as { prompt?: string })?.prompt
        if (typeof prompt === 'string') submits.push(prompt)
        await submitGate
      }
    },
    // PR C: the Manager's sub-agent/headless/teammate drives now call
    // submitAndWait, which must block on the same gate as receiveFrame so a
    // submitBlocks worker stays "running" until releaseSubmit() is called.
    async submitAndWait(msg: { payload?: unknown }) {
      const prompt = (msg.payload as { prompt?: string })?.prompt
      if (typeof prompt === 'string') submits.push(prompt)
      await submitGate
      return { status: 'completed' as const }
    },
  } as Partial<AgentRuntimeWorkerHandle>)
  return { worker, submits, releaseSubmit: release }
}

/** Release the fake worker's submit gate and let the coordinator's single
 *  terminal authority settle: finalize now rides the submitAndWait
 *  resolution (the worker.completed/error emits only RECORD),
 *  so tests must drain the microtask chain before asserting reap/delivery. */
async function settleSubmit(w: { releaseSubmit: () => void }): Promise<void> {
  w.releaseSubmit()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Build a mock worker that satisfies the full AgentRuntimeWorkerHandle interface,
 *  including the phase methods the Manager calls during emit handling. */
function makeMockWorker(overrides: Partial<AgentRuntimeWorkerHandle> = {}): AgentRuntimeWorkerHandle {
  let phase: { kind: string; sub?: unknown } = { kind: 'idle' }
  let streamActive = false
  let tools: Array<{ name: string; kind: string }> = []
  const base = {
    async receiveFrame() {},
    getSnapshot: () => ({ initialized: true }),
    // Route enqueueSubmit through receiveFrame so tests that capture
    // submits via receiveFrame also see delivery-injected turns.
    enqueueSubmit(msg: unknown) { void base.receiveFrame(msg as never) },
    consumePendingAsNextSubmit() {},
    pumpSubmits() {},
    isBusy: () => phase.kind === 'running',
    isStopping: () => false,
    getPhase: () => phase,
    setPhase: (p: never) => { phase = p },
    markStreamStart() {
      streamActive = true
      if (phase.kind === 'idle') phase = { kind: 'running', sub: { type: 'streaming' } }
    },
    markStreamEnd() {
      streamActive = false
      if (phase.kind === 'running' && tools.length === 0) phase = { kind: 'idle' }
    },
    markToolStart(name: string, kind: string) {
      tools = [...tools, { name, kind }]
      phase = { kind: 'running', sub: { type: 'tools', tools } }
    },
    markToolEnd: () => {
      tools = tools.slice(0, -1)
      if (tools.length > 0) {
        phase = { kind: 'running', sub: { type: 'tools', tools } }
      } else if (streamActive) {
        phase = { kind: 'running', sub: { type: 'streaming' } }
      } else {
        phase = { kind: 'idle' }
      }
      return undefined
    },
    ...overrides,
  }
  return base as unknown as AgentRuntimeWorkerHandle
}

type ManagerInternals = {
  lastInitTemplate: Record<string, unknown> | null
  sessions: Map<string, unknown>
  pendingTaskResults: Map<string, unknown[]>
  taskRegistry: {
    registerLive(id: string, state: unknown, taskId?: string): void
    deleteLive(id: string): void
    getLive(id: string): unknown
    hasLive(id: string): boolean
    recordFinished(id: string, record: unknown): void
    getFinished(id: string): unknown
    hasFinished(id: string): boolean
    finishedSize: number
    resolveNative(id: string): string
  }
}

function seedParentSession(
  manager: SharedWorkerSessionManager,
  spawnerSessionId: string,
  parentWorker: AgentRuntimeWorkerHandle,
  streaming = false,
): void {
  // Set the worker's own phase state so isBusy() reflects the seeded state.
  if (streaming) parentWorker.markStreamStart()
  ;(manager as unknown as ManagerInternals).sessions.set(spawnerSessionId, {
    worker: parentWorker,
    ports: new Set(),
    phase: streaming
      ? { kind: 'running', sub: { type: 'streaming' } }
      : { kind: 'idle' },
    streamActive: streaming,
    model: null,
    counters: {},
  })
}

const assistantTextEvent = (text: string) => ({
  type: 'assistant',
  content: [{ type: 'text', text }],
})

describe('SharedWorkerSessionManager — background sub-agent delivery', () => {
  function setup() {
    // Capture the manager's emit closure for the spawned sub-agent worker so
    // the test can drive worker.stream / worker.completed deterministically.
    let subEmit: ((m: AgentWorkerOutboundMessage) => void) | null = null
    const subWorker = makeFakeWorker({ submitBlocks: true })
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      subEmit = o.emit
      return subWorker.worker
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    // Seed a captured init template so spawnSubAgentSession proceeds.
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    return {
      manager,
      subWorker,
      drive: (m: AgentWorkerOutboundMessage) => subEmit?.(m),
    }
  }

  it('delivers the sub-agent result into an IDLE parent as one re-activation turn', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-A', parent.worker, false)

    const sessionId = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-A',
      prompt: 'find the loader',
      description: 'find config',
      agentType: 'Explore',
    })
    expect(sessionId).toMatch(/^a/)
    expect(
      hasLiveTask(manager, sessionId!),
    ).toBe(true)

    // Drive the sub-agent's stream + completion.
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('FOUND_IT_TOKEN') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)

    // Exactly one re-activation turn injected into the idle parent, carrying
    // the sub-agent's summary.
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('<task-notification>')
    expect(parent.submits[0]).toContain('FOUND_IT_TOKEN')
    expect(parent.submits[0]).toContain('find config')
    expect(parent.submits[0]).toContain('(Explore)')
    // DEL-2: the delivery turn carries the task id so the model can correlate
    // the completion back to its spawn for AgentResume / TaskOutput.
    expect(parent.submits[0]).toContain(sessionId!)
    // Sub-agent session reaped.
    expect(
      hasLiveTask(manager, sessionId!),
    ).toBe(false)
  })

  it('defers delivery while the parent is mid-turn, flushes at the next idle boundary', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-B', parent.worker, /* streaming */ true)

    manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-B',
      prompt: 'p',
      description: 'task',
    })
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('LATER_TOKEN') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)

    // Parent was streaming → nothing injected yet; result held pending.
    expect(parent.submits).toHaveLength(0)
    expect(
      (manager as unknown as ManagerInternals).pendingTaskResults.get(
        'parent-B',
      )?.length,
    ).toBe(1)

    // Simulate the parent's active→idle boundary. The manager's
    // maybeNotifyTurnEnd is private; drive the flush via its public effect by
    // flipping streaming off and re-invoking the boundary hook.
    parent.worker.markStreamEnd()
    const sessions = (manager as unknown as ManagerInternals).sessions
    const entry = sessions.get('parent-B') as { phase: { kind: string } }
    entry.phase = { kind: 'idle' }
    ;(
      manager as unknown as {
        maybeFlushTaskResults: (id: string) => void
      }
    ).maybeFlushTaskResults('parent-B')

    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('LATER_TOKEN')
  })

  it('batches multiple completions that land while the parent is mid-turn into ONE turn', async () => {
    const createWorker = (() => {
      // Each spawn captures its own emit; track them in order.
      const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
      const workers: ReturnType<typeof makeFakeWorker>[] = []
      const fn = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
        const w = makeFakeWorker({ submitBlocks: true })
        emits.push(o.emit)
        workers.push(w)
        return w.worker
      }
      return Object.assign(fn, { emits, workers })
    })()
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-C', parent.worker, /* streaming */ true)

    manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-C',
      prompt: 'p1',
      description: 'task one',
    })
    manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-C',
      prompt: 'p2',
      description: 'task two',
    })
    // Complete both while the parent is still streaming.
    createWorker.emits.forEach((emit, i) => {
      emit({
        type: 'worker.stream',
        payload: { event: assistantTextEvent(`RESULT_${i}`) },
      } as unknown as AgentWorkerOutboundMessage)
      emit({
        type: 'worker.completed',
        payload: {},
      } as unknown as AgentWorkerOutboundMessage)
    })
    createWorker.workers.forEach(w => w.releaseSubmit())
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(parent.submits).toHaveLength(0)
    // Flip to idle + flush → ONE turn carrying BOTH results.
    parent.worker.markStreamEnd()
    const entry = (
      manager as unknown as ManagerInternals
    ).sessions.get('parent-C') as { phase: { kind: string } }
    entry.phase = { kind: 'idle' }
    ;(
      manager as unknown as {
        maybeFlushTaskResults: (id: string) => void
      }
    ).maybeFlushTaskResults('parent-C')

    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('RESULT_0')
    expect(parent.submits[0]).toContain('RESULT_1')
    expect(parent.submits[0]).toContain('task one')
    expect(parent.submits[0]).toContain('task two')
  })

  it('flushes a deferred result through markStreamEnd even when the parent is NOT the focused session', async () => {
    // Regression: the deferred flush must NOT depend on maybeNotifyTurnEnd
    // (which only fires for a session some client is viewing). A
    // parent that was mid-turn at completion AND is not the focused session
    // would otherwise strand its sub-agent result forever.
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    // Parent is mid-turn (streaming) and NOT the current session
    // (currentSessionId defaults to null → never equals 'parent-D').
    seedParentSession(manager, 'parent-D', parent.worker, /* streaming */ true)

    manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-D',
      prompt: 'p',
      description: 'task',
    })
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('UNFOCUSED_TOKEN') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    subWorker.releaseSubmit()

    // Deferred (parent streaming) — nothing injected yet.
    expect(parent.submits).toHaveLength(0)

    // The parent's turn ends. markStreamEnd is the focus-independent idle
    // signal; it must flush even though the parent isn't focused. The dispatch
    // is deferred one macrotask (DEL-1: let the worker's isBusy clear first).
    manager.markStreamEnd('parent-D')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('UNFOCUSED_TOKEN')
  })

  it('serializes submits and runs user input ahead of a queued sub-agent delivery (DEL-4)', async () => {
    const { manager } = setup()
    const internals = manager as unknown as {
      enqueueWorkerSubmit: (
        id: string,
        msg: { type: string; sessionId: string; payload: { prompt: string } },
        prio: number,
      ) => void
    }
    // A parent worker that records dispatch order. The FIRST turn blocks (as a
    // real turn does) so the next two queue behind it; a worker that drops a
    // concurrent submit (worker_busy) would lose them — the queue must not let
    // that happen.
    const order: string[] = []
    let releaseFirst = (): void => {}
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let calls = 0
    const queue: Array<{ msg: unknown; priority: number; seq: number }> = []
    let seq = 0
    let pumping = false
    const parentWorker = makeMockWorker({
      async receiveFrame(msg: { type: string; payload?: { prompt?: string } }) {
        if (msg.type !== 'worker.submitMessage') return
        order.push(msg.payload?.prompt ?? '')
        if (++calls === 1) await firstGate // only the first turn is in flight
      },
      enqueueSubmit(msg: unknown, priority: number) {
        queue.push({ msg, priority, seq: seq++ })
        if (!pumping) {
          pumping = true
          const pump = async () => {
            while (queue.length > 0) {
              // Sort by priority (lower = higher), then by seq (FIFO within priority)
              queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
              const next = queue.shift()!
              await parentWorker.receiveFrame(next.msg as never)
            }
            pumping = false
          }
          void pump()
        }
      },
    } as Partial<AgentRuntimeWorkerHandle>)
    seedParentSession(manager, 'P-q', parentWorker, /* streaming */ false)

    const sub = (prompt: string) => ({
      type: 'worker.submitMessage' as const,
      sessionId: 'P-q',
      payload: { prompt },
    })
    // Start a (blocking) first turn, then — while it's in flight — a low-priority
    // sub-agent delivery AND a high-priority user message arrive.
    parentWorker.enqueueSubmit(sub('FIRST'), 0 /* user */)
    parentWorker.enqueueSubmit(sub('DELIVERY'), 2 /* delivery */)
    parentWorker.enqueueSubmit(sub('USER'), 0 /* user */)

    // Only the first ran; the other two are queued — neither was rejected.
    expect(order).toEqual(['FIRST'])

    releaseFirst()
    await new Promise(resolve => setTimeout(resolve, 0))

    // The queued USER turn (priority 0) runs ahead of the DELIVERY (priority 2).
    expect(order).toEqual(['FIRST', 'USER', 'DELIVERY'])
  })

  it('suppresses the duplicate delivery turn after a finished result is acknowledged via TaskOutput (CS-1)', async () => {
    const { manager, subWorker, drive } = setup()
    const internals = manager as unknown as ManagerInternals & {
      acknowledgeSubAgentResult: (id: string) => void
    }
    const parent = makeFakeWorker()
    // Parent is mid-turn (the model is active and reads the run via TaskOutput).
    seedParentSession(manager, 'parent-ack', parent.worker, /* streaming */ true)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-ack',
      prompt: 'p',
      description: 'task',
    })!
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    // Deferred while the parent is mid-turn → queued for auto-delivery.
    expect(internals.pendingTaskResults.get('parent-ack')?.length).toBe(1)

    // The model reads the TERMINAL result with TaskOutput → acknowledge drops
    // the pending auto-delivery, so it isn't delivered twice.
    internals.acknowledgeSubAgentResult(sid)
    expect(internals.pendingTaskResults.has('parent-ack')).toBe(false)

    // Turn ends — the deferred boundary flush finds nothing, so NO duplicate
    // [Background sub-agent results] turn is injected.
    manager.markStreamEnd('parent-ack')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(parent.submits).toHaveLength(0)
  })

  it('a held result is not delivered to an idle parent; the waiter that consumes it leaves nothing to deliver', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-held', parent.worker, false)
    const sid = manager.spawnSubAgentSession({ spawnerSessionId: 'parent-held', prompt: 'p', description: 'held task' })!
    const release = getSubAgentController()!.holdResult!(sid)
    expect(release).toBeTypeOf('function')
    drive({ type: 'worker.stream', payload: { event: assistantTextEvent('HELD_TOKEN') } } as unknown as AgentWorkerOutboundMessage)
    drive({ type: 'worker.completed', payload: {} } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    expect(parent.submits).toHaveLength(0)
    expect(getSubAgentController()!.getSnapshot(sid)).toMatchObject({ status: 'success', output: 'HELD_TOKEN' })
    release!(true)
    release!(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(parent.submits).toHaveLength(0)
  })

  it('a held result no waiter consumed is delivered once, when the last hold is released', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-dropped', parent.worker, false)
    const sid = manager.spawnSubAgentSession({ spawnerSessionId: 'parent-dropped', prompt: 'p', description: 'dropped task' })!
    const first = getSubAgentController()!.holdResult!(sid)!
    const second = getSubAgentController()!.holdResult!(sid)!
    drive({ type: 'worker.stream', payload: { event: assistantTextEvent('DROPPED_TOKEN') } } as unknown as AgentWorkerOutboundMessage)
    drive({ type: 'worker.completed', payload: {} } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    first(false)
    expect(parent.submits).toHaveLength(0)
    second(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('DROPPED_TOKEN')
    // A finished run has nothing left to hold.
    expect(getSubAgentController()!.holdResult!(sid)).toBeUndefined()
  })

  it("raises agent.complete once on the parent's mod slot, for a finished run and a stopped one", async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-mods', parent.worker, false)
    const seen: ModAgentOutcome[] = []
    const unregister = registerModSlot('parent-mods', { agentComplete: (e: ModAgentOutcome) => seen.push(e) } as unknown as ModSlot)
    try {
      const done = manager.spawnSubAgentSession({ spawnerSessionId: 'parent-mods', prompt: 'p', description: 'done task', agentType: 'Explore' })!
      drive({ type: 'worker.stream', payload: { event: assistantTextEvent('DONE_TOKEN') } } as unknown as AgentWorkerOutboundMessage)
      drive({ type: 'worker.completed', payload: {} } as unknown as AgentWorkerOutboundMessage)
      await settleSubmit(subWorker)
      const stopped = manager.spawnSubAgentSession({ spawnerSessionId: 'parent-mods', prompt: 'p', description: 'stopped task' })!
      getSubAgentController()!.stop(stopped)
      expect(seen).toEqual([
        { agentId: done, status: 'completed', text: 'DONE_TOKEN', description: 'done task', type: 'Explore' },
        expect.objectContaining({ agentId: stopped, status: 'killed', description: 'stopped task', type: 'general-purpose' }),
      ])
    } finally {
      unregister()
    }
  })

  it('keeps background sub-agent sessions out of the user-facing list/summary (F3)', () => {
    const { manager } = setup()
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-list',
      prompt: 'p',
      description: 'task',
    })!
    // The sub-agent has a live worker session (it's in `this.sessions`), but it
    // is NOT a user-facing session — it has its own read-only surface, so it
    // must not appear in the sidebar list/summary as a parentless top-level row.
    const internals = manager as unknown as {
      feed: {
        buildSummaryPayload(): { sessions: Array<{ sessionId: string }> }
      }
      buildSessionInfoList: () => Array<{ sessionId: string }>
    }
    expect(
      internals.feed.buildSummaryPayload().sessions.some(s => s.sessionId === sid),
    ).toBe(false)
    expect(
      internals.buildSessionInfoList().some(s => s.sessionId === sid),
    ).toBe(false)
  })

  it('broadcasts a session.summary on background sub-agent activity (UI-F1 / G5 liveness)', async () => {
    const { manager, drive } = setup()
    const received: Array<{
      type: string
      payload?: { subAgents?: NexusTaskSummaryRow[] }
    }> = []
    const port = {
      postMessage: (m: unknown) =>
        received.push(
          m as { type: string; payload?: { subAgents?: NexusTaskSummaryRow[] } },
        ),
    } as unknown as MessagePort
    // Register an all-sessions subscriber (the sidebar's live feed).
    ;(
      manager as unknown as {
        handleSubscribe: (p: MessagePort, all: boolean, ids?: string[]) => void
      }
    ).handleSubscribe(port, true)

    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-live',
      prompt: 'p',
      description: 'task',
    })!
    received.length = 0 // ignore subscribe/spawn priming; watch the stream-driven flush

    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('A') },
    } as unknown as AgentWorkerOutboundMessage)

    // The summary flush is debounced (SUMMARY_COALESCE_MS = 100ms) — let it fire.
    await new Promise(resolve => setTimeout(resolve, 150))

    // Pre-fix, NO sub-agent path scheduled a flush, so the bar's update count
    // was frozen — no session.summary would arrive here at all.
    const summaries = received.filter(m => m.type === 'session.summary')
    expect(summaries.length).toBeGreaterThan(0)
    const row = summaries[summaries.length - 1].payload?.subAgents?.find(
      s => s.sessionId === sid,
    )
    expect(row?.updates).toBe(1)
  })

  it('caps background sub-agent nesting at MAX_SUBAGENT_DEPTH (RT-1)', () => {
    const { manager } = setup()
    const internals = manager as unknown as {
      tasks: Map<string, { depth: number }>
    }
    // A top-level UI parent is depth 0 → its sub-agent is depth 1.
    const d1 = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-depth',
      prompt: 'p',
      description: 'd1',
    })!
    expect(liveTask(manager, d1)?.depth).toBe(1)
    // A sub-agent spawning a sub-agent: spawnerSessionId is a LIVE subagent run.
    const d2 = manager.spawnSubAgentSession({
      spawnerSessionId: nativeOf(manager, d1),
      prompt: 'p',
      description: 'd2',
    })!
    expect(liveTask(manager, d2)?.depth).toBe(2)
    const d3 = manager.spawnSubAgentSession({
      spawnerSessionId: nativeOf(manager, d2),
      prompt: 'p',
      description: 'd3',
    })!
    expect(liveTask(manager, d3)?.depth).toBe(3)
    // depth 3 is the cap (MAX_SUBAGENT_DEPTH=3) → a 4th nesting level is rejected.
    const d4 = manager.spawnSubAgentSession({
      spawnerSessionId: nativeOf(manager, d3),
      prompt: 'p',
      description: 'd4',
    })
    expect(d4).toBeNull()
  })

  it('finalizes a sub-agent worker.error as an error result and delivers it (RT-8)', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-err', parent.worker, /* streaming */ false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-err',
      prompt: 'p',
      description: 'task',
    })!
    drive({
      type: 'worker.error',
      payload: { code: 'boom', message: 'kaboom' },
    } as unknown as AgentWorkerOutboundMessage)
    // The recorded worker.error outranks the clean settle when the
    // single finalizer (submitAndWait resolution) runs.
    await settleSubmit(subWorker)

    // The terminal record is readable with status 'error' (TaskOutput path).
    const snap = manager.getSubAgentSnapshot(sid)
    expect(snap?.status).toBe('error')
    expect(snap?.output).toContain('kaboom')
    // Delivered into the idle parent as a FAILED result, one turn.
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('<status>failed</status>')
  })

  it('a worker.error mid-run only RECORDS — no finalize until the turn settles (B7)', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-live', parent.worker, /* streaming */ false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-live',
      prompt: 'p',
      description: 'task',
    })!
    drive({
      type: 'worker.error',
      payload: { code: 'worker_busy', message: 'transient' },
    } as unknown as AgentWorkerOutboundMessage)

    // The submit gate is still held — the emit path must NOT have reaped the
    // run or delivered anything. Pre-B7 it finalized right here, killing the
    // run for ANY emitError code (including non-terminal ones like
    // worker_busy) while executeSubmit was still unwinding.
    expect(hasLiveTask(manager, sid)).toBe(true)
    expect(parent.submits).toHaveLength(0)

    await settleSubmit(subWorker)
    // The single terminal authority consumed the recorded error at settle.
    expect(hasLiveTask(manager, sid)).toBe(false)
    expect(manager.getSubAgentSnapshot(sid)?.status).toBe('error')
    expect(parent.submits).toHaveLength(1)
  })

  it('the FIRST worker.error wins — follow-on errors cannot overwrite the root cause (B7)', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-first', parent.worker, /* streaming */ false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-first',
      prompt: 'p',
      description: 'task',
    })!
    drive({
      type: 'worker.error',
      payload: { code: 'root_cause', message: 'the real failure' },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.error',
      payload: { code: 'cascade', message: 'follow-on noise' },
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)

    const snap = manager.getSubAgentSnapshot(sid)
    expect(snap?.status).toBe('error')
    expect(snap?.output).toContain('the real failure')
    expect(snap?.output).not.toContain('follow-on noise')
  })

  it('flushes a result deferred behind an in-flight tool at markToolEnd (RT-2)', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-tool', parent.worker, /* streaming */ false)
    // Stream already ended, but a tool is still in flight — the delivery must
    // defer until the tool end (the other focus-independent idle boundary).
    parent.worker.markStreamStart()
    parent.worker.markToolStart('Bash', 'local')
    parent.worker.markStreamEnd() // stream ends, tool still in flight
    const entry = (manager as unknown as ManagerInternals).sessions.get(
      'parent-tool',
    ) as { phase: { kind: string; sub?: unknown } }
    entry.phase = { kind: 'running', sub: { type: 'tools', tools: [{ name: 'Bash', kind: 'local' }] } }

    manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-tool',
      prompt: 'p',
      description: 'task',
    })
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('TOOL_TOKEN') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    // Deferred — a tool is still inflight.
    expect(parent.submits).toHaveLength(0)

    // Tool ends → the true idle boundary → the deferred result is delivered.
    await manager.markToolEnd('parent-tool', true)
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('TOOL_TOKEN')
  })

  it('stays busy until the LAST of N concurrent tools ends — single markToolEnd must not flip idle (CONC-1)', async () => {
    const { manager, subWorker, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-conc', parent.worker, /* streaming */ false)

    // Two concurrency-safe tools run in parallel (e.g. `Sleep` + `ToolSearch`
    // via executeToolCalls parallel batches), each firing its own markToolStart. A single
    // `inflight` slot can't represent both; the stack must.
    manager.markToolStart('parent-conc', 'Sleep', 'local')
    manager.markToolStart('parent-conc', 'ToolSearch', 'local')

    // A finished sub-agent result is deferred while the parent is mid-turn.
    manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-conc',
      prompt: 'p',
      description: 'task',
    })
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('CONC_TOKEN') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    expect(parent.submits).toHaveLength(0) // deferred — tools in flight

    // ONE tool ends — a peer (Sleep) is still running. Pre-fix the single slot
    // went null here, flipping the session to idle: derivePhase → idle AND the
    // DEL-4 pump dispatched the deferred delivery into a still-busy worker. The
    // session MUST stay busy and the delivery MUST stay deferred.
    await manager.markToolEnd('parent-conc', true)
    expect(parent.worker.getPhase().kind).toBe('running')
    expect(parent.submits).toHaveLength(0)

    // The LAST tool ends → true idle boundary → the deferred result delivers.
    await manager.markToolEnd('parent-conc', true)
    expect(parent.worker.getPhase().kind).toBe('idle')
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('CONC_TOKEN')
  })

  it('tool end clears inflight and pumps queued delivery even if counter persistence never resolves', async () => {
    const { manager } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-counter-hang', parent.worker, false)

    manager.markToolStart('parent-counter-hang', 'TodoWrite', 'local')
    const internals = manager as unknown as ManagerInternals
    const entry = internals.sessions.get('parent-counter-hang') as {
      counters: Record<string, number>
      conversationStore?: { updateSessionMetadata: (patch: unknown) => Promise<unknown> }
      phase: { kind: string }
    }
    entry.counters = { tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 }
    entry.conversationStore = {
      updateSessionMetadata: vi.fn(() => new Promise<never>(() => {})),
    }
    internals.pendingTaskResults.set('parent-counter-hang', [
      {
        type: 'local_bash',
        taskId: 'shell-counter-hang',
        shellId: 'shell-counter-hang',
        command: 'echo done',
        outputFilePath: null,
        status: 'success',
        summary: 'done',
      },
    ])

    const result = await Promise.race([
      manager.markToolEnd('parent-counter-hang', true).then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 25)),
    ])

    expect(result).toBe('resolved')
    expect(entry.phase.kind).toBe('idle')
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('<task-notification>')
    expect(parent.submits[0]).toContain('done')
  })

  it('FIFO-evicts the oldest finished record past the cap and degrades gracefully (RT-3)', () => {
    const { manager } = setup()
    const internals = manager as unknown as ManagerInternals & {
      finishedTasks: Map<string, unknown>
      // Terminal-record retention lives on the SubAgentCoordinator.
      subAgents: { recordFinishedSubAgent: (rec: Record<string, unknown>) => void }
      resumeSubAgent: (id: string, p: string) => unknown
    }
    const mkRec = (i: number) => ({
      type: 'local_agent',
      sessionId: `subagent-${i}`,
      agentId: `a${i}`,
      spawnerSessionId: 'P',
      description: `t${i}`,
      status: 'success',
      summary: 's',
      startedAt: i,
      finishedAt: i,
      depth: 1,
    })
    // MAX_FINISHED_SUBAGENTS = 100 → recording 101 evicts the oldest (subagent-0).
    for (let i = 0; i < 101; i++) internals.subAgents.recordFinishedSubAgent(mkRec(i))
    expect(internals.taskRegistry.finishedSize).toBe(100)
    expect(internals.taskRegistry.hasFinished('subagent-0')).toBe(false)
    expect(internals.taskRegistry.hasFinished('subagent-100')).toBe(true)
    // The evicted id degrades gracefully — not a crash.
    expect(manager.getSubAgentSnapshot('subagent-0')).toBeNull()
    expect(internals.resumeSubAgent('subagent-0', 'go')).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('threads the original agent identity into the resumed init payload (RT-4)', () => {
    const inits: Array<Record<string, unknown>> = []
    const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      emits.push(o.emit)
      return makeMockWorker({
        async receiveFrame(msg: { type: string; payload?: Record<string, unknown> }) {
          if (msg.type === 'worker.init') inits.push(msg.payload ?? {})
        },
      } as Partial<AgentRuntimeWorkerHandle>)
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }

    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
      agentType: 'Explore',
      systemPrompt: 'CUSTOM_SYS',
      model: 'custom-model',
      allowTools: ['Read', 'Grep'],
      disallowTools: ['Write'],
      projectRoot: '/wt',
    })!
    emits[0]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)

    ;(
      manager as unknown as { resumeSubAgent: (id: string, p: string) => unknown }
    ).resumeSubAgent(sid, 'continue')

    // The resume's worker.init carries the ORIGINAL identity (rehydrated from the
    // finished record), so the resumed run is the same agent.
    const resumed = inits[inits.length - 1]
    expect(resumed.customSystemPrompt).toBe('CUSTOM_SYS')
    expect(resumed.userSpecifiedModel).toBe('custom-model')
    expect(resumed.subAgentAllowTools).toEqual(['Read', 'Grep'])
    expect(resumed.subAgentDisallowTools).toEqual(['Write'])
    expect(resumed.projectRoot).toBe('/wt')
    // No routine in play → the provenance field stays clear.
    expect(resumed.routineOriginId).toBeUndefined()
  })

  it('stamps the routine origin on the sub-agent init payload and keeps it across a resume (recursion guard)', () => {
    // The hole this closes: the payload below deliberately clears
    // `isHeadless`/`routineId` (a sub-agent is not a routine SESSION), and the
    // sub-agent runs under its own sessionId — so before `routineOriginId`
    // nothing in its context said "this work belongs to a routine" and
    // CronCreate/ScheduleCron/RemoteTrigger.register were callable from it.
    const inits: Array<Record<string, unknown>> = []
    const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      emits.push(o.emit)
      return makeMockWorker({
        async receiveFrame(msg: { type: string; payload?: Record<string, unknown> }) {
          if (msg.type === 'worker.init') inits.push(msg.payload ?? {})
        },
      } as Partial<AgentRuntimeWorkerHandle>)
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }

    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'routine-session-1',
      prompt: 'p',
      description: 'task',
      routineOriginId: 'cron-7',
    })!
    expect(inits[0]!.routineOriginId).toBe('cron-7')
    // The two session-identity fields stay cleared — provenance travels, the
    // "I am a headless routine session" identity does not (that would hand the
    // sub-agent RoutineSignal and the headless boot branches).
    expect(inits[0]!.isHeadless).toBeUndefined()
    expect(inits[0]!.routineId).toBeUndefined()

    emits[0]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    ;(
      manager as unknown as { resumeSubAgent: (id: string, p: string) => unknown }
    ).resumeSubAgent(sid, 'continue')

    // AgentResume re-launches from the finished RECORD (the spawning turn is
    // long gone), so the origin has to survive that round-trip too.
    expect(inits[inits.length - 1]!.routineOriginId).toBe('cron-7')
  })

  it('an ordinary spawn leaves the routine origin unset', () => {
    const inits: Array<Record<string, unknown>> = []
    const createWorker = (): AgentRuntimeWorkerHandle =>
      makeMockWorker({
        async receiveFrame(msg: { type: string; payload?: Record<string, unknown> }) {
          if (msg.type === 'worker.init') inits.push(msg.payload ?? {})
        },
      } as Partial<AgentRuntimeWorkerHandle>)
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }

    manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
    })
    expect(inits[0]!.routineOriginId).toBeUndefined()
  })

  it('inherits the PARENT session LIVE model when the agent omits one (stale-template guard, RT-4c)', () => {
    // Regression: a named / general-purpose sub-agent (e.g. Explore) omits
    // `model`, so it must run on the parent's CURRENT selection. The spawn used
    // to inherit purely from `lastInitTemplate`, which freezes the BOOT model — a
    // live model switch updates the session entry (`setModel`) but never re-fires
    // `worker.init`. So a parent that booted on an access-gated default and then
    // switched to a usable model would still spawn sub-agents on the gated boot
    // model → the provider rejects them (`worker_submit_failed`).
    const inits: Array<Record<string, unknown>> = []
    const createWorker = (): AgentRuntimeWorkerHandle =>
      makeMockWorker({
        async receiveFrame(msg: {
          type: string
          payload?: Record<string, unknown>
        }) {
          if (msg.type === 'worker.init') inits.push(msg.payload ?? {})
        },
      } as Partial<AgentRuntimeWorkerHandle>)
    const manager = new SharedWorkerSessionManager({ createWorker })
    // Template froze the gated boot model; a live switch never refreshed it.
    ;(manager as unknown as ManagerInternals).lastInitTemplate = {
      cwd: '/x',
      userSpecifiedProviderId: 'anthropic',
      userSpecifiedModel: 'claude-fable-5',
    }
    // The parent's CURRENT (post-switch) selection, tracked on the entry.
    ;(manager as unknown as ManagerInternals).sessions.set('P', {
      // Callable worker stub: the spawned run auto-finalizes (non-blocking
      // fake) and delivers its result into this parent, which calls
      // `worker.receiveFrame`. A bare `{}` would throw there.
      worker: makeMockWorker(),
      ports: new Set(),
      streaming: false,
      inflight: null,
      model: { providerId: 'openai', modelId: 'gpt-5.5', thinkingTier: 'high' },
      counters: {},
    })

    manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'review',
      description: 'spec review',
      agentType: 'Explore', // built-in → omits `model`
    })

    const init = inits[0]!
    expect(init.userSpecifiedModel).toBe('gpt-5.5')
    expect(init.userSpecifiedProviderId).toBe('openai')
    expect(init.userSpecifiedThinkingTier).toBe('high')
  })

  it('keeps an explicit agent/fork model override instead of the parent selection (RT-4d)', () => {
    const inits: Array<Record<string, unknown>> = []
    const createWorker = (): AgentRuntimeWorkerHandle =>
      makeMockWorker({
        async receiveFrame(msg: {
          type: string
          payload?: Record<string, unknown>
        }) {
          if (msg.type === 'worker.init') inits.push(msg.payload ?? {})
        },
      } as Partial<AgentRuntimeWorkerHandle>)
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    ;(manager as unknown as ManagerInternals).sessions.set('P', {
      // Callable worker stub: the spawned run auto-finalizes (non-blocking
      // fake) and delivers its result into this parent, which calls
      // `worker.receiveFrame`. A bare `{}` would throw there.
      worker: makeMockWorker(),
      ports: new Set(),
      streaming: false,
      inflight: null,
      model: { providerId: 'openai', modelId: 'gpt-5.5' },
      counters: {},
    })

    manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
      agentType: 'custom',
      model: 'custom-model',
    })

    const init = inits[0]!
    expect(init.userSpecifiedModel).toBe('custom-model')
    // The explicit model resolves by id — the parent's provider is NOT forced.
    expect(init.userSpecifiedProviderId).toBeUndefined()
  })

  it('tier-resolved spawn carries the provider pair + the parent selection as modelFallbackSelection (RT-4e)', () => {
    const inits: Array<Record<string, unknown>> = []
    const createWorker = (): AgentRuntimeWorkerHandle =>
      makeMockWorker({
        async receiveFrame(msg: {
          type: string
          payload?: Record<string, unknown>
        }) {
          if (msg.type === 'worker.init') inits.push(msg.payload ?? {})
        },
      } as Partial<AgentRuntimeWorkerHandle>)
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    ;(manager as unknown as ManagerInternals).sessions.set('P', {
      worker: makeMockWorker(),
      ports: new Set(),
      streaming: false,
      inflight: null,
      model: { providerId: 'anthropic', modelId: 'claude-fable-5' },
      counters: {},
    })

    manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
      agentType: 'general-purpose',
      // A tier-resolved spawn (Agent tool model:'fast') sets BOTH fields.
      model: 'claude-haiku-4-5',
      modelProviderId: 'anthropic',
    })

    const init = inits[0]!
    // The exact pair rides the init → the worker takes the requestedSelection
    // path instead of the bare catalog id-match.
    expect(init.userSpecifiedModel).toBe('claude-haiku-4-5')
    expect(init.userSpecifiedProviderId).toBe('anthropic')
    // The parent's live selection rides along: if the requested pair isn't
    // enabled in the live catalog, resolution falls back to the PARENT's
    // model — never catalog.defaultSelection.
    expect(init.modelFallbackSelection).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
    })
  })

  it('setModel refreshes a live run effectiveModel to the worker-applied selection (RT-4g)', () => {
    // Regression target: effectiveModel is a spawn-time guess (`model ??
    // parentSelection.modelId`). When the worker's catalog resolution lands
    // somewhere else (tier pair disabled → parent fallback), the worker
    // reports the APPLIED selection via applyModelSelection → manager.setModel
    // — the drawer's Model line must follow the truth.
    const createWorker = (): AgentRuntimeWorkerHandle =>
      makeMockWorker()
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }

    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
      agentType: 'general-purpose',
      model: 'claude-haiku-4-5',
      modelProviderId: 'anthropic',
    })!
    const nativeId = nativeOf(manager, sid)
    // Spawn-time guess: the requested tier model.
    const run = () =>
      (
        manager as unknown as {
          taskRegistry: { getLive(id: string): { effectiveModel?: string } | undefined }
        }
      ).taskRegistry.getLive(nativeId)
    expect(run()?.effectiveModel).toBe('claude-haiku-4-5')

    // The worker resolved elsewhere (fallback) and reports what it applied.
    manager.setModel(nativeId, {
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
    })
    expect(run()?.effectiveModel).toBe('claude-fable-5')
  })

  it('resume re-injects a tier-resolved provider pair (RT-4f)', () => {
    const inits: Array<Record<string, unknown>> = []
    const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      emits.push(o.emit)
      return makeMockWorker({
        async receiveFrame(msg: { type: string; payload?: Record<string, unknown> }) {
          if (msg.type === 'worker.init') inits.push(msg.payload ?? {})
        },
      } as Partial<AgentRuntimeWorkerHandle>)
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }

    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
      agentType: 'general-purpose',
      model: 'claude-haiku-4-5',
      modelProviderId: 'anthropic',
    })!
    emits[0]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)

    ;(
      manager as unknown as { resumeSubAgent: (id: string, p: string) => unknown }
    ).resumeSubAgent(sid, 'continue')

    // The resumed worker boots on the exact same selection the tier resolved
    // to at spawn time (pair retained on the finished record).
    const resumed = inits[inits.length - 1]!
    expect(resumed.userSpecifiedModel).toBe('claude-haiku-4-5')
    expect(resumed.userSpecifiedProviderId).toBe('anthropic')
  })

  it('threads a worktree cwd as cwdOverride DISTINCT from the repo-root projectRoot (RT-4b)', () => {
    const inits: Array<Record<string, unknown>> = []
    const createWorker = (): AgentRuntimeWorkerHandle =>
      makeMockWorker({
        async receiveFrame(msg: {
          type: string
          payload?: Record<string, unknown>
        }) {
          if (msg.type === 'worker.init') inits.push(msg.payload ?? {})
        },
      } as Partial<AgentRuntimeWorkerHandle>)
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }

    manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
      projectRoot: '/repo', // canonical repo root — storage/memory anchor
      cwd: '/repo/.velloc/worktrees/general-purpose_abc', // worktree — cwd only
    })

    const init = inits[inits.length - 1]!
    // projectRoot stays on the repo → prepareWorkerStorage groups under
    // projects/<repo-slug>/, NOT projects/<worktree-slug>/ (no orphan dir).
    expect(init.projectRoot).toBe('/repo')
    // cwd rides as a DISTINCT cwdOverride (createBrowserRuntime resolves it to
    // the session cwd; host tools re-anchor via applyWorktreeIsolation).
    expect(init.cwdOverride).toBe('/repo/.velloc/worktrees/general-purpose_abc')
  })

  describe('inherits the PARENT session\u2019s project binding, not the last UI init', () => {
    // `lastInitTemplate` is whichever UI session booted LAST. With repo A and
    // repo B both open, a sub-agent spawned from A inherited B's projectRoot
    // and templateType from the template and ran in the wrong project.
    type Init = { via: 'ui' | 'spawn'; payload: Record<string, unknown> }

    function bindingHarness() {
      const inits: Init[] = []
      const createWorker = (): AgentRuntimeWorkerHandle =>
        makeMockWorker({
          // UI sessions boot through `reinitialize`; its `effectiveInit` is
          // what the manager commits as `lastInitTemplate`.
          async reinitialize(payload: Record<string, unknown>) {
            inits.push({ via: 'ui', payload })
            return {
              status: 'ready' as const,
              generation: 1,
              effectiveInit: {
                templateType: payload.templateType as string | undefined,
                projectRoot: payload.projectRoot as string | undefined,
              },
            }
          },
          // Background runs boot through a plain `worker.init`.
          async receiveFrame(msg: { type: string; payload?: Record<string, unknown> }) {
            if (msg.type === 'worker.init') inits.push({ via: 'spawn', payload: msg.payload ?? {} })
          },
          async submitAndWait() {
            return new Promise<never>(() => {})
          },
        } as unknown as Partial<AgentRuntimeWorkerHandle>)
      const manager = new SharedWorkerSessionManager({ createWorker })
      let onMessage: ((event: MessageEvent) => void) | null = null
      const port = {
        addEventListener: (_type: string, handler: (event: MessageEvent) => void) => {
          onMessage = handler
        },
        start: () => {},
        postMessage: () => {},
      } as unknown as MessagePort
      manager.handleConnect(port)
      const initUi = async (sessionId: string, projectRoot: string, templateType: string) => {
        onMessage!({
          data: {
            type: 'worker.init',
            sessionId,
            payload: { cwd: '/host', sessionId, projectRoot, templateType },
          },
        } as MessageEvent)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const spawnInits = () => inits.filter(i => i.via === 'spawn').map(i => i.payload)
      return { manager, initUi, spawnInits }
    }

    it('a spawn from session A runs in A\u2019s project on A\u2019s template after B booted last', async () => {
      const { manager, initUi, spawnInits } = bindingHarness()
      await initUi('session-A', '/repoA', 'code')
      await initUi('session-B', '/repoB', 'agent')
      // The template now says B.
      expect((manager as unknown as ManagerInternals).lastInitTemplate).toMatchObject({
        projectRoot: '/repoB',
        templateType: 'agent',
      })

      expect(
        manager.spawnSubAgentSession({ spawnerSessionId: 'session-A', prompt: 'p', description: 'from A' }),
      ).toMatch(/^a/)
      const fromA = spawnInits().at(-1)!
      expect(fromA.projectRoot).toBe('/repoA')
      expect(fromA.templateType).toBe('code')
      // No worktree: the parent's own cwd is its project root, so nothing
      // moves the child's cwd off the project (no worktree-isolation flip).
      expect(fromA.cwdOverride).toBeUndefined()

      // …and B's sub-agent still gets B's.
      manager.spawnSubAgentSession({ spawnerSessionId: 'session-B', prompt: 'p', description: 'from B' })
      const fromB = spawnInits().at(-1)!
      expect(fromB.projectRoot).toBe('/repoB')
      expect(fromB.templateType).toBe('agent')
    })

    it('an explicit worktree projectRoot still wins over the parent\u2019s', async () => {
      const { manager, initUi, spawnInits } = bindingHarness()
      await initUi('session-A', '/repoA', 'code')
      manager.spawnSubAgentSession({
        spawnerSessionId: 'session-A',
        prompt: 'p',
        description: 'wt',
        projectRoot: '/canonical-repo',
        cwd: '/canonical-repo/.velloc/worktrees/x',
      })
      const init = spawnInits().at(-1)!
      expect(init.projectRoot).toBe('/canonical-repo')
      expect(init.cwdOverride).toBe('/canonical-repo/.velloc/worktrees/x')
      expect(init.templateType).toBe('code')
    })

    it('an UNBOUND parent does not inherit another session\u2019s folder from the template', async () => {
      const { manager, initUi, spawnInits } = bindingHarness()
      // A has no folder of its own; B (bound) booted last.
      await initUi('session-A', undefined as unknown as string, 'chat')
      await initUi('session-B', '/repoB', 'code')
      manager.spawnSubAgentSession({ spawnerSessionId: 'session-A', prompt: 'p', description: 'unbound' })
      const init = spawnInits().at(-1)!
      expect(init.projectRoot).toBeUndefined()
      expect(init.templateType).toBe('chat')
    })

    it('a sub-agent of a ROUTINE run inherits the binding the run booted on', async () => {
      // The headless entry was registered with no binding, so the routine's
      // parent binding read a non-null `{}` and its sub-agent booted unbound
      // on the default template while the routine worked in the project.
      const { manager, initUi, spawnInits } = bindingHarness()
      await initUi('session-A', '/repoA', 'code')
      const routines = (manager as unknown as {
        routines: {
          spawnHeadlessSession(p: {
            sessionId: string
            routine: Record<string, unknown>
            abortSignal: AbortSignal
          }): Promise<unknown>
        }
      }).routines
      void routines.spawnHeadlessSession({
        sessionId: 'routine-run-1',
        routine: { id: 'r1', name: 'nightly', prompt: 'go' },
        abortSignal: new AbortController().signal,
      })
      await new Promise(resolve => setTimeout(resolve, 5))
      manager.spawnSubAgentSession({ spawnerSessionId: 'routine-run-1', prompt: 'p', description: 'from routine' })
      const init = spawnInits().at(-1)!
      expect(init.projectRoot).toBe('/repoA')
      expect(init.templateType).toBe('code')
    })

    it('a sub-agent of a TEAMMATE inherits the teammate’s project, not undefined', async () => {
      // The teammate entry carried only `templateType`, so its sub-agent got
      // `projectRoot: undefined` written over the template's.
      const { manager, initUi, spawnInits } = bindingHarness()
      await initUi('session-A', '/repoA', 'code')
      const teammateId = manager.spawnTeammateSession({
        teamName: 'session-A',
        teammateName: 'worker',
        prompt: 'do it',
        spawnerSessionId: 'session-A',
      })!
      expect(teammateId).toBeTruthy()
      await new Promise(resolve => setTimeout(resolve, 5))
      manager.spawnSubAgentSession({ spawnerSessionId: teammateId, prompt: 'p', description: 'from teammate' })
      const init = spawnInits().at(-1)!
      expect(init.projectRoot).toBe('/repoA')
      expect(init.templateType).toBe('code')
    })
  })

  it('does NOT re-arm worktree cleanup on resume (RT-5)', async () => {
    const { manager, subWorker, drive } = setup()
    let cleaned = 0
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-r5',
      prompt: 'p',
      description: 'task',
      projectRoot: '/wt',
      onCleanup: () => {
        cleaned++
      },
    })!
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    expect(cleaned).toBe(1)

    // Resume continues the SAME logical run; the onCleanup closure was not
    // persisted on the finished record, so finishing again must NOT re-fire it
    // (documented G7 divergence — its worktree is reclaimed by prune instead).
    ;(
      manager as unknown as { resumeSubAgent: (id: string, p: string) => unknown }
    ).resumeSubAgent(sid, 'go')
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    expect(cleaned).toBe(1)
  })

  it('preserves co-waiters when one TaskOutput(block) waiter times out (RT-6)', async () => {
    const { manager, drive, subWorker } = setup()
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-w',
      prompt: 'p',
      description: 'task',
    })!
    // Two blocking waiters on the SAME run; the first times out fast, the second
    // keeps waiting — exercising the `remaining.length > 0` eviction branch.
    const fast = manager.waitForSubAgentCompletion(sid, 5)
    const slow = manager.waitForSubAgentCompletion(sid, 10_000)
    const fastSnap = await fast
    expect(fastSnap?.status).toBe('running') // timed out → current snapshot, not null

    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('R6_TOKEN') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    subWorker.releaseSubmit()

    // The surviving waiter resolves on completion (it was not dropped with the
    // timed-out one).
    const slowSnap = await slow
    expect(slowSnap?.status).toBe('success')
    expect(slowSnap?.output).toContain('R6_TOKEN')
  })

  it('aborts a blocking TaskOutput(block) wait AND stops the awaited sub-agent on Stop (RT-6b)', async () => {
    // Regression: a TaskOutput(block) blocking on a still-running sub-agent used
    // to ignore the parent turn's abort, so clicking Stop left the main turn
    // "running" for the sub-agent's full run or the (model-settable, up-to-10-min)
    // timeout. The wait now threads `TaskOutput`'s `context.abortController.signal`,
    // and on Stop it stops the awaited sub-agent — which resolves the waiter — so
    // Stop completes within a tick.
    const { manager } = setup()
    const internals = manager as unknown as ManagerInternals & {
      subAgents: { hasWaiters(id: string): boolean }
      finishedTasks: Map<string, { status?: string }>
    }
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-stop',
      prompt: 'p',
      description: 'task',
    })!
    // A LONG timeout, so only the parent-turn abort (Stop) — not the timer — can
    // resolve the wait quickly. This is exactly TaskOutput(block, timeout=…)
    // wiring its turn's abort signal through.
    const ac = new AbortController()
    const waiterPromise = manager.waitForSubAgentCompletion(sid, 600_000, ac.signal)
    expect(internals.subAgents.hasWaiters(nativeOf(manager, sid))).toBe(true)
    expect(
      hasLiveTask(manager, sid),
    ).toBe(true)

    // The user clicks Stop → the parent turn's abortController fires.
    const start = Date.now()
    ac.abort()
    const snap = await waiterPromise

    // Resolved on Stop (≈0ms), NOT after the 600s timeout — and with the awaited
    // sub-agent stopped + reaped.
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(snap?.status).toBe('stopped')
    expect((internals.taskRegistry.getFinished(nativeOf(manager, sid)) as { status?: string })?.status).toBe('stopped')
    expect(internals.subAgents.hasWaiters(nativeOf(manager, sid))).toBe(false)
  })

  it('rejects spawn/resume when no UI session has booted (no lastInitTemplate) (RT-7)', () => {
    const createWorker = (): AgentRuntimeWorkerHandle => makeFakeWorker().worker
    const manager = new SharedWorkerSessionManager({ createWorker })
    // lastInitTemplate deliberately NOT seeded.
    expect(
      manager.spawnSubAgentSession({
        spawnerSessionId: 'P',
        prompt: 'p',
        description: 't',
      }),
    ).toBeNull()
    // A finished record exists but the runtime template doesn't → 'unavailable'
    // (the distinct branch from 'not_found').
    const internals = manager as unknown as {
      // Terminal-record retention lives on the SubAgentCoordinator.
      subAgents: { recordFinishedSubAgent: (rec: Record<string, unknown>) => void }
      resumeSubAgent: (id: string, p: string) => unknown
    }
    internals.subAgents.recordFinishedSubAgent({
      type: 'local_agent',
      sessionId: 'subagent-x',
      agentId: 'x',
      spawnerSessionId: 'P',
      description: 't',
      status: 'success',
      summary: 's',
      startedAt: 0,
      finishedAt: 0,
      depth: 1,
    })
    expect(internals.resumeSubAgent('subagent-x', 'go')).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('does not queue the same sub-agent result twice (DEL-6)', () => {
    const { manager } = setup()
    const parent = makeFakeWorker()
    // Parent mid-turn so the batch stays pending (not dispatched) for inspection.
    seedParentSession(manager, 'P-dup', parent.worker, /* streaming */ true)
    const internals = manager as unknown as ManagerInternals & {
      deliverTaskResult: (
        pid: string,
        r: {
          type: string
          taskId: string
          agentId: string
          description: string
          status: string
          summary: string
        },
      ) => void
    }
    const r = {
      type: 'local_agent',
      taskId: 'a-dup',
      agentId: 'd',
      description: 'task',
      status: 'success',
      summary: 'done',
    }
    internals.deliverTaskResult('P-dup', r)
    internals.deliverTaskResult('P-dup', r) // duplicate — must be ignored
    expect(internals.pendingTaskResults.get('P-dup')?.length).toBe(1)
  })

  it('tears down in-flight sub-agents when the parent session is closed (cascade)', () => {
    const { manager, subWorker } = setup()
    const internals = manager as unknown as ManagerInternals & {
      // Per-run aborts live on the SubAgentCoordinator.
      subAgents: { hasAbort(id: string): boolean }
      cascadeSubAgentsOnParentClose: (id: string) => void
    }
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
    })!
    expect(hasLiveTask(manager, sid)).toBe(true)
    expect(internals.subAgents.hasAbort(nativeOf(manager, sid))).toBe(true)
    expect(internals.sessions.has(nativeOf(manager, sid))).toBe(true)

    internals.cascadeSubAgentsOnParentClose('P')

    // All bookkeeping reaped + the worker interrupted (abort fired).
    expect(hasLiveTask(manager, sid)).toBe(false)
    expect(internals.subAgents.hasAbort(sid)).toBe(false)
    expect(internals.sessions.has(sid)).toBe(false)
    // Letting the now-orphaned turn settle must not throw or re-deliver.
    expect(() => subWorker.releaseSubmit()).not.toThrow()
  })

  it('drops pending results for a closed parent (cascade)', async () => {
    const { manager, subWorker, drive } = setup()
    const internals = manager as unknown as ManagerInternals & {
      cascadeSubAgentsOnParentClose: (id: string) => void
    }
    const parent = makeFakeWorker()
    seedParentSession(manager, 'P2', parent.worker, /* streaming */ true)
    manager.spawnSubAgentSession({
      spawnerSessionId: 'P2',
      prompt: 'p',
      description: 'task',
    })
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('X') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    // Parent mid-turn → deferred → result is pending.
    expect(internals.pendingTaskResults.get('P2')?.length).toBe(1)

    internals.cascadeSubAgentsOnParentClose('P2')

    expect(internals.pendingTaskResults.has('P2')).toBe(false)
    expect(parent.submits).toHaveLength(0) // never delivered to the closed parent
  })

  it('drops the result (no throw) when the parent session is gone', () => {
    const { manager, subWorker, drive } = setup()
    // No parent session seeded.
    manager.spawnSubAgentSession({
      spawnerSessionId: 'ghost',
      prompt: 'p',
      description: 'orphan',
    })
    expect(() => {
      drive({
        type: 'worker.completed',
        payload: {},
      } as unknown as AgentWorkerOutboundMessage)
      subWorker.releaseSubmit()
    }).not.toThrow()
    expect(
      (manager as unknown as ManagerInternals).pendingTaskResults.has(
        'ghost',
      ),
    ).toBe(false)
  })

  it('fires onCleanup for an in-flight worktree sub-agent on parent-close cascade (G7-2)', async () => {
    const { manager } = setup()
    const internals = manager as unknown as ManagerInternals & {
      cascadeSubAgentsOnParentClose: (id: string) => Promise<void>
    }
    let cleaned = 0
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-wt-cascade',
      prompt: 'p',
      description: 'wt task',
      projectRoot: '/wt',
      onCleanup: () => {
        cleaned++
      },
    })!
    expect(hasLiveTask(manager, sid)).toBe(true)

    // The cascade now sequences each worktree cleanup AFTER
    // its child's teardown (worker dispose) so the removal can't race
    // in-flight tool writes — hence the await (the cascade resolves when
    // every child's teardown + cleanup chain settles).
    await internals.cascadeSubAgentsOnParentClose('P-wt-cascade')

    // The worktree's keep-if-changed cleanup runs on the cascade path too —
    // not just finalize/stop — so closing a parent mid-run can't orphan it.
    expect(cleaned).toBe(1)
    expect(hasLiveTask(manager, sid)).toBe(false)
  })

  it('resolves + reaps a parked TaskOutput(block) waiter on cascade (F2)', async () => {
    const { manager } = setup()
    const internals = manager as unknown as ManagerInternals & {
      subAgents: { hasWaiters(id: string): boolean }
      cascadeSubAgentsOnParentClose: (id: string) => void
    }
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-wait-cascade',
      prompt: 'p',
      description: 'task',
    })!
    // Park a blocking waiter with a long timeout, so only the cascade (not the
    // waiter's own timer) can resolve it.
    const waiterPromise = manager.waitForSubAgentCompletion(sid, 60_000)
    expect(internals.subAgents.hasWaiters(nativeOf(manager, sid))).toBe(true)

    internals.cascadeSubAgentsOnParentClose('P-wait-cascade')

    // The waiter map entry (and its timeout timer) are reaped, and the promise
    // settles promptly instead of hanging for the full 60s.
    expect(internals.subAgents.hasWaiters(nativeOf(manager, sid))).toBe(false)
    await expect(waiterPromise).resolves.toBeNull()
  })

  it('scrubs finished sub-agent records for the closed parent on cascade (F4)', async () => {
    const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
    const workers: ReturnType<typeof makeFakeWorker>[] = []
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      const w = makeFakeWorker({ submitBlocks: true })
      emits.push(o.emit)
      workers.push(w)
      return w.worker
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    const internals = manager as unknown as ManagerInternals & {
      finishedTasks: Map<string, unknown>
      cascadeSubAgentsOnParentClose: (id: string) => void
    }
    const a = manager.spawnSubAgentSession({
      spawnerSessionId: 'P-scrub',
      prompt: 'p',
      description: 'alpha',
    })!
    // Finish it → retained terminal record under P-scrub.
    emits[0]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(workers[0]!)
    expect(internals.taskRegistry.hasFinished(nativeOf(manager, a))).toBe(true)

    internals.cascadeSubAgentsOnParentClose('P-scrub')

    // Dead weight for a vanished parent is dropped rather than riding the
    // human-surface summary tail until FIFO eviction.
    expect(internals.taskRegistry.hasFinished(nativeOf(manager, a))).toBe(false)
  })
})

// ===========================================================================
// Background shells (`local_bash` tasks) — register → poll `shell.status` →
// finalize; Stop → `shell.kill`. The manager owns the registry + the direct
// bridge, so these are unit-testable with a fake transport (no host build).
// ===========================================================================

type ShellManagerInternals = {
  registerBackgroundShell: (l: {
    shellId: string
    taskId?: string
    command: string
    spawnerSessionId?: string
    outputFilePath?: string
    superShellTaskId?: string
  }) => void
  recoverBashRowsFromTranscript: (sessionId: string, messages: unknown[]) => void
  loadTaskInfoWithOutput: (
    id: string,
  ) => Promise<{
    type?: string
    task?: string
    summary?: string
    outputFilePath?: string
    outputText?: string
  } | null>
  shells: {
    stop(
      id: string,
    ): Promise<'stopped' | 'not_found' | 'already_finished' | 'stop_failed' | 'stop_pending'>
    finalizeForTest(
      id: string,
      status: 'success' | 'error' | 'stopped',
      summary: string,
    ): void
  }
  cascadeSubAgentsOnParentClose: (id: string) => void
  // The summary feed lives on the SessionFeedPublisher.
  feed: {
    buildSummaryPayload(): {
      sessions?: Array<{ sessionId: string; running: boolean }>
      subAgents?: NexusTaskSummaryRow[]
    }
  }
  loadSubAgentInfo: (
    id: string,
  ) => { type?: string; task?: string; summary?: string } | null
  bridgeRouter: { directTransport: unknown }
  sessions: Map<string, unknown>
  pendingTaskResults: Map<string, unknown[]>
  maybeFlushTaskResults: (id: string) => void
  // Kind-agnostic control surface the model-facing TaskOutput / TaskStop tools
  // reach through getSubAgentController() — must resolve background shells too.
  getSubAgentSnapshot: (
    id: string,
  ) =>
    | {
        taskType?: string
        status?: string
        description?: string
        output?: string
        exitCode?: number | null
      }
    | null
  stopSubAgent: (id: string) => { status: string; description?: string }
  acknowledgeSubAgentResult: (id: string) => void
}

function shellManager(): ShellManagerInternals {
  const createWorker = (): AgentRuntimeWorkerHandle => makeFakeWorker().worker
  const manager = new SharedWorkerSessionManager({ createWorker })
  return manager as unknown as ShellManagerInternals
}

/** One observation of a shell, in the shape these tests script: what the
 *  child's record says plus what its log holds (stdout, then stderr). */
type ScriptedShellStatus = {
  found: boolean
  running: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  exitCode?: number
  signal?: number
  timedOut?: boolean
  killed?: boolean
}
type ScriptedResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }
/** The test's script: asked `('observe', shellId)` for one observation of a
 *  shell, or `('kill', shellId)` for a `shell.persistentKill` answer. */
type ShellScript = (
  op: 'observe' | 'kill',
  shellId: string,
) => ScriptedResponse | Promise<ScriptedResponse>

/**
 * Stand in for the host the worker's background-shell registry talks to
 * (B3): `shell.persistentList` lists one record per live `local_bash` run
 * from the script's observation, and `fs.stat` / `fs.readRange` serve that
 * observation's output as the run's log. A run with no output file gets one,
 * so its log can be read. `routes` records every call the registry made.
 */
function installShellHost(
  manager: ShellManagerInternals,
  script: ShellScript,
): { routes: Array<{ capability: string; action: string; payload: unknown }> } {
  const routes: Array<{ capability: string; action: string; payload: unknown }> = []
  const logs = new Map<string, { text: string; truncated: boolean }>()
  const registry = (manager as unknown as {
    taskRegistry: { liveByType(type: string): Iterable<{ shellId: string; taskId: string; outputFilePath: string | null }> }
  }).taskRegistry
  manager.bridgeRouter.directTransport = {
    request: async (req: { route: { capability: string; action: string }; payload: unknown }) => {
      routes.push({ ...req.route, payload: req.payload })
      const key = `${req.route.capability}.${req.route.action}`
      if (key === 'shell.persistentList') {
        const shells: unknown[] = []
        for (const run of Array.from(registry.liveByType('local_bash'))) {
          const answer = await script('observe', run.shellId)
          if (!answer.ok) return answer
          const s = answer.result as ScriptedShellStatus
          if (!s.found) continue
          if (!run.outputFilePath) run.outputFilePath = `/test/tasks/${run.taskId}.output`
          logs.set(run.outputFilePath, {
            text: [s.stdout, s.stderr].filter(Boolean).join('\n'),
            truncated: s.stdoutTruncated || s.stderrTruncated,
          })
          shells.push({
            id: run.shellId,
            command: 'bash -c x',
            logPath: run.outputFilePath,
            startedMs: 0,
            running: s.running,
            ...(s.running
              ? {}
              : {
                  ...(typeof s.exitCode === 'number' ? { exitCode: s.exitCode } : {}),
                  ...(typeof s.signal === 'number' ? { signal: s.signal } : {}),
                  killed: Boolean(s.killed),
                  timedOut: Boolean(s.timedOut),
                }),
          })
        }
        return { ok: true, result: { shells } }
      }
      if (key === 'shell.persistentKill') {
        return script('kill', (req.payload as { id: string }).id)
      }
      const path = (req.payload as { path?: string }).path ?? ''
      const log = logs.get(path) ?? { text: '', truncated: false }
      const bytes = new TextEncoder().encode(log.text)
      // A cut log is bigger than the tail the registry reads.
      const size = log.truncated ? bytes.length + 100_000 : bytes.length
      if (key === 'fs.stat') return { ok: true, result: { size } }
      if (key === 'fs.readRange') return { ok: true, result: { data: bytes, bytesRead: bytes.length } }
      return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: key } }
    },
  }
  return { routes }
}

/** A script that answers every observation with `status`. */
function always(status: ScriptedShellStatus): ShellScript {
  return () => ({ ok: true, result: status })
}

function bashRow(
  manager: ShellManagerInternals,
  shellId: string,
): NexusTaskSummaryRow | undefined {
  return (manager.feed.buildSummaryPayload().subAgents ?? []).find(
    r => r.sessionId === shellId,
  )
}

describe('SharedWorkerSessionManager — background shells (local_bash)', () => {
  it('registerBackgroundShell surfaces a running local_bash row with its command', () => {
    const manager = shellManager()
    manager.registerBackgroundShell({
      shellId: 'shell-1',
      command: 'npm run build',
      spawnerSessionId: 'P-bash',
    })
    const row = bashRow(manager, 'shell-1')
    expect(row).toBeDefined()
    expect(row?.type).toBe('local_bash')
    expect(row?.status).toBe('running')
    expect(row?.command).toBe('npm run build')
    expect(row?.spawnerSessionId).toBe('P-bash')
    // loadSubAgentInfo carries the command as the detail-panel "task".
    expect(manager.loadSubAgentInfo('shell-1')).toMatchObject({
      type: 'local_bash',
      task: 'npm run build',
    })
    // Clean up the dangling poll timer (no transport → it would reschedule).
    manager.shells.finalizeForTest('shell-1', 'success', 'done')
  })

  it('a SuperShell step keeps its invocation id on its row, running and finished; a shell the model ran carries none', () => {
    const manager = shellManager()
    manager.registerBackgroundShell({
      shellId: 'shell-step',
      taskId: 'bstep0001',
      command: 'npx tsc --noEmit',
      spawnerSessionId: 'P-ss',
      superShellTaskId: 'hrun00001',
    })
    manager.registerBackgroundShell({
      shellId: 'shell-own',
      taskId: 'bown00001',
      command: 'git status',
      spawnerSessionId: 'P-ss',
    })
    expect(bashRow(manager, 'bstep0001')).toMatchObject({
      type: 'local_bash',
      status: 'running',
      command: 'npx tsc --noEmit',
      superShellTaskId: 'hrun00001',
    })
    expect(bashRow(manager, 'bown00001')).not.toHaveProperty('superShellTaskId')

    manager.shells.finalizeForTest('shell-step', 'error', 'exit 2')
    manager.shells.finalizeForTest('shell-own', 'success', 'clean')
    // The finished tail keeps it — that is what files the step under its run.
    expect(bashRow(manager, 'bstep0001')).toMatchObject({
      status: 'error',
      superShellTaskId: 'hrun00001',
    })
    expect(bashRow(manager, 'bown00001')).not.toHaveProperty('superShellTaskId')
  })

  it('a SuperShell loop of many steps does not evict the shell the model ran itself', () => {
    const manager = shellManager()
    manager.registerBackgroundShell({
      shellId: 'shell-own-cap',
      taskId: 'bowncap01',
      command: 'npm run dev',
      spawnerSessionId: 'P-cap',
    })
    manager.shells.finalizeForTest('shell-own-cap', 'success', 'ok')
    // More settled steps than the finished-shell cap (40) or the summary tail.
    for (let i = 0; i < 45; i++) {
      manager.registerBackgroundShell({
        shellId: `shell-step-cap-${i}`,
        taskId: `bstepcap${String(i).padStart(2, '0')}`,
        command: `echo ${i}`,
        spawnerSessionId: 'P-cap',
        superShellTaskId: 'hcaprun01',
      })
      manager.shells.finalizeForTest(`shell-step-cap-${i}`, 'success', String(i))
    }
    expect(bashRow(manager, 'bowncap01')).toMatchObject({ status: 'success', command: 'npm run dev' })
  })

  it('a SuperShell row is keyed by its tool call id, which also opens its detail', async () => {
    const manager = shellManager()
    const { superShells } = manager as unknown as {
      superShells: {
        register: (start: Record<string, unknown>) => string
        finish: (finish: Record<string, unknown>) => void
      }
    }
    const withCall = superShells.register({
      spawnerSessionId: 'P-ss-row',
      toolCallId: 'toolu_row1',
      description: 'Build and test',
      code: 'await bash("make")',
      startedAt: Date.now(),
      progress: () => 'Steps:\n✓ make  exit 0  1.0s',
      stop: () => {},
    })
    const withoutCall = superShells.register({
      spawnerSessionId: 'P-ss-row',
      description: 'No call id',
      code: 'await bash("true")',
      startedAt: Date.now(),
      progress: () => '',
      stop: () => {},
    })
    const rows = () =>
      (manager.feed.buildSummaryPayload().subAgents ?? []).filter(
        r => r.type === 'local_supershell',
      )
    expect(rows().map(r => [r.sessionId, r.status])).toEqual([
      ['toolu_row1', 'running'],
      // No resolvable call id → the public id stays the handle.
      [withoutCall, 'running'],
    ])
    await expect(manager.loadTaskInfoWithOutput('toolu_row1')).resolves.toMatchObject({
      type: 'local_supershell',
      outputText: 'Steps:\n✓ make  exit 0  1.0s',
    })

    superShells.finish({ taskId: withCall, status: 'success', resultText: 'ALL_GREEN', finishedAt: Date.now(), deliver: false })
    expect(rows().find(r => r.sessionId === 'toolu_row1')).toMatchObject({ status: 'success' })
    await expect(manager.loadTaskInfoWithOutput('toolu_row1')).resolves.toMatchObject({
      outputText: 'ALL_GREEN',
    })
    superShells.finish({ taskId: withoutCall, status: 'success', resultText: 'x', finishedAt: Date.now(), deliver: false })
  })

  it('registerBackgroundShell adopts no owner when the launch names none — there is no current session', () => {
    const manager = shellManager()

    manager.registerBackgroundShell({
      shellId: 'shell-current-owner',
      command: 'npm run test',
    })

    expect(bashRow(manager, 'shell-current-owner')?.spawnerSessionId).toBe('')
    manager.shells.finalizeForTest('shell-current-owner', 'stopped', 'cleanup')
  })

  it('polls its persistent child (record + log) and finalizes the row when the shell exits', async () => {
    const manager = shellManager()
    const { routes } = installShellHost(manager, always({
      found: true,
      running: false,
      stdout: 'built ok',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
    }))
    manager.registerBackgroundShell({
      shellId: 'shell-2',
      command: 'ls',
      spawnerSessionId: 'P',
    })
    // The immediate poll (setTimeout 0) + its async status request settle here.
    await new Promise(r => setTimeout(r, 50))
    const row = bashRow(manager, 'shell-2')
    expect(row?.type).toBe('local_bash')
    expect(row?.status).toBe('success')
    // B3: the worker's registry observes its persistent child — the record,
    // then the log — and never asks the retired C++ registry.
    expect(routes.some(r => r.capability === 'shell' && r.action === 'persistentList')).toBe(true)
    expect(routes.some(r => r.capability === 'fs' && r.action === 'readRange')).toBe(true)
    expect(routes.some(r => r.capability === 'shell' && r.action === 'status')).toBe(false)
    // Output is captured into the detail summary.
    expect(manager.loadSubAgentInfo('shell-2')?.summary).toContain('built ok')
    // The exit code is surfaced on the terminal snapshot so the foreground
    // middle layer can return the raw `{output, exit_code}` Exec shape.
    expect(manager.getSubAgentSnapshot('shell-2')?.exitCode).toBe(0)
  })

  it('poller classifies a KILLED shell as stopped despite the kill exit code (Stop race)', async () => {
    // A host `shell.kill` (user Stop) exits nonzero as the kill's mechanics, not a failure: a poller that sees the
    // terminal first must still finalize the shell as stopped.
    const manager = shellManager()
    installShellHost(manager, always({
      found: true,
      running: false,
      stdout: 'partial output',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      killed: true,
      exitCode: -1,
      signal: 9,
    }))
    manager.registerBackgroundShell({
      shellId: 'shell-race',
      command: 'sleep 99',
      spawnerSessionId: 'P',
    })
    // The immediate poll (setTimeout 0) observes the killed terminal directly
    // — the poller-wins side of the race.
    await new Promise(r => setTimeout(r, 50))
    expect(bashRow(manager, 'shell-race')?.status).toBe('stopped')
  })

  it('queues a background-shell completion delivery turn when the parent is idle', async () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-deliver',
      parent.worker,
      false,
    )
    installShellHost(manager, always({
      found: true,
      running: false,
      stdout: 'shell done',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
    }))

    manager.registerBackgroundShell({
      shellId: 'shell-deliver',
      command: 'npm test',
      spawnerSessionId: 'P-deliver',
    })
    await new Promise(r => setTimeout(r, 50))

    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('<task-notification>')
    expect(parent.submits[0]).toContain('<task-id>shell-deliver</task-id>')
    expect(parent.submits[0]).toContain('npm test')
    expect(parent.submits[0]).toContain('shell done')
  })

  it('an IDLE session with a running background task reports running:true on the sessions summary', () => {
    // Regression: `running` was phase-only (streaming/tool inflight), so a
    // settled turn with live background tasks read as fully done — the
    // sidebar row's spinner/shimmer stopped even though the session will
    // still receive the task's notification turn. Busy must be
    // phase-non-idle OR has-running-background-tasks.
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-busy',
      parent.worker,
      false, // idle phase — not streaming, no inflight tool
    )
    const sessionRow = () =>
      manager.feed
        .buildSummaryPayload()
        .sessions?.find(r => r.sessionId === 'P-busy')
    expect(sessionRow()?.running).toBe(false)

    manager.registerBackgroundShell({
      shellId: 'shell-busy',
      command: 'npm run build',
      spawnerSessionId: 'P-busy',
    })
    expect(sessionRow()?.running).toBe(true)

    manager.shells.finalizeForTest('shell-busy', 'success', 'done')
    expect(sessionRow()?.running).toBe(false)
  })

  it('a finished shell row carries finishedAt so the drawer can show the run span', () => {
    const manager = shellManager()
    manager.registerBackgroundShell({
      shellId: 'shell-span',
      command: 'npm run build',
      spawnerSessionId: 'P-span',
    })
    // Running → no finishedAt yet.
    expect(bashRow(manager, 'shell-span')?.finishedAt).toBeUndefined()
    manager.shells.finalizeForTest('shell-span', 'success', 'done')
    const row = bashRow(manager, 'shell-span')
    expect(row?.status).toBe('success')
    expect(typeof row?.finishedAt).toBe('number')
    expect(typeof row?.startedAt).toBe('number')
    expect(row!.finishedAt!).toBeGreaterThanOrEqual(row!.startedAt!)
  })

  it('loadTaskInfoWithOutput reads the output file into info.outputText (best-effort)', async () => {
    const manager = shellManager()
    const files = new Map<string, string>([
      ['/tasks/shell-out.output', 'FULL FILE OUTPUT\nBUILD OK'],
    ])
    const prevFs = processFs()
    installProcessFs({
      ...prevFs,
      mkdir: async () => {},
      writeFile: async (path: string, data: string | Uint8Array) => {
        files.set(path, String(data))
      },
      readFile: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
    } as RuntimeFs)
    try {
      manager.registerBackgroundShell({
        shellId: 'shell-out',
        command: 'npm run build',
        spawnerSessionId: 'P-out',
        outputFilePath: '/tasks/shell-out.output',
      })
      // Registration fire-and-forgets an empty mirror write — let it settle,
      // then re-seed so the read deterministically sees the file content.
      await new Promise(r => setTimeout(r, 0))
      files.set('/tasks/shell-out.output', 'FULL FILE OUTPUT\nBUILD OK')
      const info = await manager.loadTaskInfoWithOutput('shell-out')
      expect(info?.type).toBe('local_bash')
      expect(info?.outputFilePath).toBe('/tasks/shell-out.output')
      expect(info?.outputText).toContain('FULL FILE OUTPUT')

      // Unreadable file → info still returns, just without outputText.
      files.delete('/tasks/shell-out.output')
      const fallback = await manager.loadTaskInfoWithOutput('shell-out')
      expect(fallback?.type).toBe('local_bash')
      expect(fallback?.outputText).toBeUndefined()
      manager.shells.finalizeForTest('shell-out', 'success', 'done')
    } finally {
      installProcessFs(prevFs)
    }
  })

  // --- restart recovery (transcript-derived rows survive an app restart) -----

  /** A completed background-shell launch + its `<task-notification>` turn. */
  function recoveredBashTranscript(
    taskId: string,
    command: string,
    outputFile: string,
  ): unknown[] {
    const callId = `call-${taskId}`
    return [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: callId, toolName: 'Bash', args: { command } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              result: { task_id: taskId, status: 'running', output_file: outputFile, message: `with ID: ${taskId}` },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `<task-notification>\n<task-id>${taskId}</task-id>\n<task-type>local_bash</task-type>` +
                `\n<output-file>${outputFile}</output-file>\n<status>completed</status>\n` +
                `<summary>Background command "${command}" completed</summary>\n</task-notification>`,
            },
          ],
        },
      },
    ]
  }

  it('recovers a shell detail from the transcript after a restart (no registry record) and reads its log', async () => {
    // The user's report: after a browser restart the drawer's shell rows are
    // gone. The registry record died with the worker, but the transcript keeps
    // the command + output-file path, so the row + its LOG are recoverable
    // (read-only — the process is long dead). This pins the log read.
    const manager = shellManager()
    const files = new Map<string, string>([
      ['/tasks/b-restore.output', 'RECOVERED BUILD LOG\nDONE'],
    ])
    const prevFs = processFs()
    installProcessFs({
      ...prevFs,
      readFile: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
    } as RuntimeFs)
    try {
      manager.recoverBashRowsFromTranscript(
        'S-restart',
        recoveredBashTranscript('b-restore', 'npm run build', '/tasks/b-restore.output'),
      )
      // The row is published (read-only history).
      const row = bashRow(manager, 'b-restore')
      expect(row).toBeDefined()
      expect(row?.type).toBe('local_bash')
      expect(row?.status).toBe('success')
      expect(row?.command).toBe('npm run build')
      // Its detail resolves with NO registry record — via the recovered map —
      // and reads the persisted output file lazily.
      const info = await manager.loadTaskInfoWithOutput('b-restore')
      expect(info?.type).toBe('local_bash')
      expect(info?.task).toBe('npm run build')
      expect(info?.outputFilePath).toBe('/tasks/b-restore.output')
      expect(info?.outputText).toContain('RECOVERED BUILD LOG')
    } finally {
      installProcessFs(prevFs)
    }
  })

  it('handleRecoverBackground rebuilds shell + run_js rows from storage, marks sidecar errors, and guards once', async () => {
    const manager = shellManager()
    // The sidecar lookup (isError) starts at the session being recovered.
    // Persisted transcript: a completed foreground shell (`{shell_id,status}`)
    // and a SuperEdit run_js whose tool-result part carries NO isError (it lives
    // in the sidecar). Both actually FAILED per their sidecars.
    const transcript: unknown[] = [
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'c-sh', toolName: 'Bash', args: { command: 'make' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'c-sh', result: { shell_id: 'b-sh', status: 'completed' } },
      ] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'c-js', toolName: 'SuperEdit', args: { description: 'rename' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c-js' }] } },
    ]
    let loadCalls = 0
    const mockStorage = {
      load: async () => {
        loadCalls++
        return transcript
      },
      loadToolCallDetail: async (_sid: string, callId: string) =>
        callId === 'c-sh' || callId === 'c-js'
          ? { toolName: callId === 'c-sh' ? 'Bash' : 'SuperEdit', isError: true, result: {} }
          : null,
    }
    Object.defineProperty(manager, 'storage', { get: () => mockStorage, configurable: true })
    const recover = (manager as unknown as {
      handleRecoverBackground(sessionId: string): Promise<void>
    }).handleRecoverBackground.bind(manager)

    await recover('S1')
    expect(loadCalls).toBe(1)
    // Shell row recovered AND upgraded to error from its sidecar (not green).
    expect(bashRow(manager, 'b-sh')).toMatchObject({
      type: 'local_bash',
      command: 'make',
      status: 'error',
    })
    // run_js row recovered AND upgraded to error too.
    const rows = manager.feed.buildSummaryPayload().subAgents ?? []
    expect(rows.find(r => r.type === 'local_js')?.status).toBe('error')

    // Idempotent: a second open does NOT re-load the transcript.
    await recover('S1')
    expect(loadCalls).toBe(1)
  })

  it('handleRecoverBackground leaves the guard unset on an empty load so a later open retries', async () => {
    const manager = shellManager()
    let ready = false
    let loadCalls = 0
    const mockStorage = {
      load: async () => {
        loadCalls++
        return ready
          ? [
              { type: 'assistant', message: { role: 'assistant', content: [
                { type: 'tool-call', toolCallId: 'c1', toolName: 'Bash', args: { command: 'ls' } },
              ] } },
              { type: 'user', message: { role: 'user', content: [
                { type: 'tool-result', toolCallId: 'c1', result: { shell_id: 'b1', status: 'completed' } },
              ] } },
            ]
          : []
      },
      loadToolCallDetail: async () => null,
    }
    Object.defineProperty(manager, 'storage', { get: () => mockStorage, configurable: true })
    const recover = (manager as unknown as {
      handleRecoverBackground(sessionId: string): Promise<void>
    }).handleRecoverBackground.bind(manager)

    // Storage "not ready yet" → empty → nothing recovered, guard NOT committed.
    await recover('S2')
    expect(bashRow(manager, 'b1')).toBeUndefined()
    // A later open retries (guard was released) and recovers the row.
    ready = true
    await recover('S2')
    expect(loadCalls).toBe(2)
    expect(bashRow(manager, 'b1')).toMatchObject({ status: 'success' })
  })

  /** A session that ran SuperShell three ways, as persisted: inline; continued
   *  in the background and delivered at the idle boundary (string content); and
   *  continued in the background and read finished with TaskOutput (no
   *  notification). The delivered run started a `background: true` step whose
   *  own completion arrived mid-turn; the model also ran one Bash itself. */
  function superShellSession() {
    const call = (id: string, toolName: string, args?: unknown) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, ...(args ? { args } : {}) }] },
    })
    const result = (id: string, extra: Record<string, unknown> = {}) => ({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: id, ...extra }] },
    })
    const handOff = (taskId: string, progress: string) =>
      `SuperShell is still running after 120s and continues in the background with ID: ${taskId}. ` +
      `You will be notified when it completes.\n\nProgress so far:\n${progress}`
    const transcript: unknown[] = [
      call('ss-inline', 'SuperShell', { description: 'Inline run' }),
      result('ss-inline'),
      call('ss-notified', 'SuperShell', { description: 'Delivered run' }),
      result('ss-notified'),
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'task-notification',
          prompt:
            '<task-notification>\n<task-id>b-step</task-id>\n<task-type>local_bash</task-type>\n' +
            '<status>completed</status>\n<summary>Background command "npx vite" completed</summary>\n</task-notification>',
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: formatTaskNotifications([
            { type: 'local_supershell', taskId: 'h-notified', description: 'Delivered run', status: 'success', summary: 'DELIVERED_RESULT' },
          ]),
        },
      },
      call('ss-read', 'SuperShell', { description: 'Awaited run' }),
      result('ss-read'),
      call('to-read', 'TaskOutput'),
      result('to-read'),
      call('c-sh', 'Bash', { command: 'make' }),
      result('c-sh', { result: { shell_id: 'b-model', status: 'completed' } }),
    ]
    const details: Record<string, unknown> = {
      'ss-inline': { toolName: 'SuperShell', args: { code: 'return 1', description: 'Inline run' }, result: 'INLINE_RESULT\n\nNo commands were run.' },
      'ss-notified': {
        toolName: 'SuperShell',
        args: { code: "await bash('npx vite', { background: true })", description: 'Delivered run' },
        result: handOff('h-notified', 'Steps:\n▶ npx vite  background task b-step'),
      },
      'ss-read': { toolName: 'SuperShell', args: { code: "await bash('make')", description: 'Awaited run' }, result: handOff('h-read', 'No command has finished yet.') },
      'to-read': {
        toolName: 'TaskOutput',
        args: { task_id: 'h-read', block: true },
        result: 'SuperShell script "Awaited run" [error] — failed.\n\nSuperShell error: AWAITED_RESULT',
      },
      'c-sh': { toolName: 'Bash', result: { output: 'ok', exit_code: 0 } },
    }
    return { transcript, details }
  }

  it('handleRecoverBackground rebuilds Super Shell rows from the transcript and each call’s sidecar, and keeps their steps out of Shell', async () => {
    const manager = shellManager()
    const { transcript, details } = superShellSession()
    Object.defineProperty(manager, 'storage', {
      get: () => ({
        load: async () => transcript,
        loadToolCallDetail: async (_sid: string, callId: string) => details[callId] ?? null,
      }),
      configurable: true,
    })
    const recover = (manager as unknown as {
      handleRecoverBackground(sessionId: string): Promise<void>
    }).handleRecoverBackground.bind(manager)

    await recover('S-ss')
    const rows = manager.feed.buildSummaryPayload().subAgents ?? []
    expect(
      rows.filter(r => r.type === 'local_supershell').map(r => [r.sessionId, r.spawnerSessionId, r.description, r.status]),
    ).toEqual([
      ['ss-inline', 'S-ss', 'Inline run', 'success'],
      ['ss-notified', 'S-ss', 'Delivered run', 'success'],
      ['ss-read', 'S-ss', 'Awaited run', 'error'],
    ])
    // The delivered run's background step is part of that run, not a Shell
    // row; the shell the model ran itself still is one.
    expect(bashRow(manager, 'b-step')).toBeUndefined()
    expect(bashRow(manager, 'b-model')).toMatchObject({ type: 'local_bash', command: 'make', status: 'success' })

    // A detached run's detail shows the run's result, not the hand-off its call
    // returned — from its notification, or from the TaskOutput call that read it.
    expect(await manager.loadTaskInfoWithOutput('ss-notified')).toMatchObject({ type: 'local_supershell', outputText: 'DELIVERED_RESULT' })
    expect(await manager.loadTaskInfoWithOutput('ss-read')).toMatchObject({ outputText: 'SuperShell error: AWAITED_RESULT' })
    expect(await manager.loadTaskInfoWithOutput('ss-inline')).toMatchObject({ outputText: 'INLINE_RESULT\n\nNo commands were run.' })
  })

  it('a Super Shell detail loaded while the recovery is still reading waits for it', async () => {
    const manager = shellManager()
    const { transcript, details } = superShellSession()
    let releaseLoad!: () => void
    const loaded = new Promise<void>(resolve => (releaseLoad = resolve))
    Object.defineProperty(manager, 'storage', {
      get: () => ({
        load: async () => {
          await loaded
          return transcript
        },
        loadToolCallDetail: async (_sid: string, callId: string) => details[callId] ?? null,
      }),
      configurable: true,
    })
    const recover = (manager as unknown as {
      handleRecoverBackground(sessionId: string): Promise<void>
    }).handleRecoverBackground.bind(manager)

    // The card's jump: the drawer opens (recovery starts) and asks for the detail.
    const recovery = recover('S-ss2')
    const detail = manager.loadTaskInfoWithOutput('ss-notified')
    releaseLoad()
    await recovery
    expect(await detail).toMatchObject({ outputText: 'DELIVERED_RESULT' })
  })

  it('a still-live shell of the same task id wins over its recovered row (no duplicate)', () => {
    // Registry-known ids are fresher than the transcript scan: the recovered
    // row is dropped at read time. The recovered row carries the PUBLIC task
    // id, so the publisher must resolve it to the native shell_id first.
    const manager = shellManager()
    manager.registerBackgroundShell({
      shellId: 'shell-dup',
      taskId: 'b-dup',
      command: 'npm run watch',
      spawnerSessionId: 'S-dup',
    })
    manager.recoverBashRowsFromTranscript(
      'S-dup',
      recoveredBashTranscript('b-dup', 'npm run watch', '/tasks/b-dup.output'),
    )
    const matching = (manager.feed.buildSummaryPayload().subAgents ?? []).filter(
      r => r.sessionId === 'b-dup',
    )
    expect(matching).toHaveLength(1)
    expect(matching[0]!.status).toBe('running')
    manager.shells.finalizeForTest('shell-dup', 'stopped', 'cleanup')
  })

  it('marks host-capped shell output with an elision marker so a partial view is not misread', async () => {
    // Regression: the host caps status-read output (keeping the tail); the
    // truncated flags were dropped here, so a capped build log read as "the
    // command stopped early" — the model re-ran a whole Chromium build over
    // it. The marker must reach the summary the
    // model sees.
    const manager = shellManager()
    installShellHost(manager, always({
      found: true,
      running: false,
      stdout: '…tail of a long build log\nBUILD SUCCESSFUL',
      stderr: '',
      stdoutTruncated: true,
      stderrTruncated: false,
      exitCode: 0,
    }))

    manager.registerBackgroundShell({
      shellId: 'shell-truncated',
      command: 'autoninja chrome',
      spawnerSessionId: 'P-trunc',
    })
    await new Promise(r => setTimeout(r, 50))

    const summary = manager.loadSubAgentInfo('shell-truncated')?.summary ?? ''
    expect(summary).toContain('[earlier output omitted]')
    expect(summary).toContain('BUILD SUCCESSFUL')
    // Untruncated reads must NOT carry the marker (guarded by the flags).
    expect(summary.indexOf('[earlier output omitted]')).toBe(0)
  })

  it('strips ANSI color/control codes from automatic background-shell delivery', async () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-shell-ansi',
      parent.worker,
      false,
    )
    installShellHost(manager, always({
      found: true,
      running: false,
      stdout: '\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv4.1.2 \u001b[39m\u001b[90mD:/work/repo/app\u001b[39m',
      stderr: '\u001b]0;title\u0007done',
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
    }))

    manager.registerBackgroundShell({
      shellId: 'shell-ansi',
      command: 'npm test',
      spawnerSessionId: 'P-shell-ansi',
    })
    await new Promise(r => setTimeout(r, 50))

    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('RUN  v4.1.2 D:/work/repo/app')
    expect(parent.submits[0]).toContain('done')
    expect(parent.submits[0]).not.toContain('\u001b')
  })

  it('defers background-shell delivery while the parent is active and flushes when idle', async () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-shell-busy',
      parent.worker,
      true,
    )
    installShellHost(manager, always({
      found: true,
      running: false,
      stdout: 'late shell done',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
    }))

    manager.registerBackgroundShell({
      shellId: 'shell-busy',
      command: 'slow build',
      spawnerSessionId: 'P-shell-busy',
    })
    await new Promise(r => setTimeout(r, 50))

    expect(parent.submits).toHaveLength(0)
    expect(manager.pendingTaskResults.get('P-shell-busy')).toHaveLength(1)

    parent.worker.markStreamEnd()
    const entry = manager.sessions.get('P-shell-busy') as { phase: { kind: string } }
    entry.phase = { kind: 'idle' }
    manager.maybeFlushTaskResults('P-shell-busy')

    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('late shell done')
  })

  describe('mid-turn drain of queued task notifications', () => {
    type DrainInternals = Omit<ShellManagerInternals, 'sessions'> & {
      drainMidTurnTaskNotifications: (
        sessionId: string,
        opts: { includeLater: boolean },
      ) => { prompt: string; enqueuedAt: number } | null
      deliverTaskResult: (spawnerSessionId: string, result: unknown) => void
      maybeFlushTaskResults: (id: string) => void
      pendingTaskResults: Map<string, unknown[]>
      sessions: Map<string, { phase: { kind: string } }>
    }

    const drainText = (
      manager: DrainInternals,
      id: string,
      opts: { includeLater: boolean },
    ): string | null => manager.drainMidTurnTaskNotifications(id, opts)?.prompt ?? null

    function busyParent(id: string) {
      const manager = shellManager() as unknown as DrainInternals
      const parent = makeFakeWorker()
      seedParentSession(
        manager as unknown as SharedWorkerSessionManager,
        id,
        parent.worker,
        true,
      )
      const goIdle = () => {
        parent.worker.markStreamEnd()
        manager.sessions.get(id)!.phase = { kind: 'idle' }
        manager.maybeFlushTaskResults(id)
      }
      return { manager, parent, goIdle }
    }

    function finishShell(manager: DrainInternals, parentId: string, shellId: string, summary: string) {
      manager.registerBackgroundShell({ shellId, command: `cmd ${shellId}`, spawnerSessionId: parentId })
      manager.shells.finalizeForTest(shellId, 'success', summary)
    }

    const agentResult = (taskId: string, summary: string) => ({
      type: 'local_agent',
      taskId,
      agentId: `agent-${taskId}`,
      description: `desc ${taskId}`,
      status: 'success',
      summary,
    })

    it('a shell finishing mid-turn is drained once and is NOT re-delivered as the idle turn', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-1')
      finishShell(manager, 'P-mid-1', 'shell-mid-1', 'MID_SHELL_DONE')

      const prompt = drainText(manager, 'P-mid-1', { includeLater: false })
      expect(prompt).toContain('<task-notification>')
      expect(prompt).toContain('MID_SHELL_DONE')
      // A later round drains nothing more.
      expect(drainText(manager, 'P-mid-1', { includeLater: true })).toBeNull()

      goIdle()
      goIdle()
      expect(parent.submits).toHaveLength(0)
    })

    it('with no further tool round, the result is still delivered at the idle boundary — exactly once', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-2')
      finishShell(manager, 'P-mid-2', 'shell-mid-2', 'END_OF_TURN_DONE')
      // No drain happens (the turn ended with text).
      goIdle()
      goIdle()
      expect(parent.submits).toHaveLength(1)
      expect(parent.submits[0]).toContain('END_OF_TURN_DONE')
      // And a later turn's drain cannot inject it a second time.
      expect(drainText(manager, 'P-mid-2', { includeLater: true })).toBeNull()
    })

    it('a sub-agent result is NOT drained mid-turn unless the round ran Sleep; it goes out at idle once', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-3')
      manager.deliverTaskResult('P-mid-3', agentResult('a-mid-3', 'AGENT_LATER_DONE'))

      expect(drainText(manager, 'P-mid-3', { includeLater: false })).toBeNull()
      expect(manager.pendingTaskResults.get('P-mid-3')).toHaveLength(1)

      goIdle()
      expect(parent.submits).toHaveLength(1)
      expect(parent.submits[0]).toContain('AGENT_LATER_DONE')
    })

    it('a sub-agent result IS drained in a Sleep round, and then never delivered at idle', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-4')
      manager.deliverTaskResult('P-mid-4', agentResult('a-mid-4', 'AGENT_SLEEP_DONE'))

      const prompt = drainText(manager, 'P-mid-4', { includeLater: true })
      expect(prompt).toContain('AGENT_SLEEP_DONE')
      goIdle()
      expect(parent.submits).toHaveLength(0)
    })

    it('shell + sub-agent pending together: the shell is drained, the sub-agent alone arrives at idle', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-5')
      finishShell(manager, 'P-mid-5', 'shell-mid-5', 'MIXED_SHELL_DONE')
      manager.deliverTaskResult('P-mid-5', agentResult('a-mid-5', 'MIXED_AGENT_DONE'))

      const prompt = drainText(manager, 'P-mid-5', { includeLater: false })
      expect(prompt).toContain('MIXED_SHELL_DONE')
      expect(prompt).not.toContain('MIXED_AGENT_DONE')

      goIdle()
      expect(parent.submits).toHaveLength(1)
      expect(parent.submits[0]).toContain('MIXED_AGENT_DONE')
      expect(parent.submits[0]).not.toContain('MIXED_SHELL_DONE')
    })

    it('two shells finishing in different rounds are each injected once, in their own round', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-6')
      finishShell(manager, 'P-mid-6', 'shell-mid-6a', 'FIRST_DONE')
      const round1 = drainText(manager, 'P-mid-6', { includeLater: false })
      finishShell(manager, 'P-mid-6', 'shell-mid-6b', 'SECOND_DONE')
      const round2 = drainText(manager, 'P-mid-6', { includeLater: false })

      expect(round1).toContain('FIRST_DONE')
      expect(round1).not.toContain('SECOND_DONE')
      expect(round2).toContain('SECOND_DONE')
      expect(round2).not.toContain('FIRST_DONE')
      goIdle()
      expect(parent.submits).toHaveLength(0)
    })

    it('a result already read with TaskOutput (acknowledged) is never injected', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-7')
      finishShell(manager, 'P-mid-7', 'shell-mid-7', 'ACKED_DONE')
      ;(manager as unknown as { acknowledgeSubAgentResult: (id: string) => void })
        .acknowledgeSubAgentResult('shell-mid-7')

      expect(drainText(manager, 'P-mid-7', { includeLater: true })).toBeNull()
      goIdle()
      expect(parent.submits).toHaveLength(0)
    })

    it('after a user Stop nothing is drained or delivered', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-8')
      ;(manager as unknown as { taskDelivery: { suppressParent: (id: string) => void } })
        .taskDelivery.suppressParent('P-mid-8')
      finishShell(manager, 'P-mid-8', 'shell-mid-8', 'STOPPED_DONE')

      expect(drainText(manager, 'P-mid-8', { includeLater: true })).toBeNull()
      goIdle()
      expect(parent.submits).toHaveLength(0)
    })

    it('a result delivered while the parent was idle cannot be drained by the next turn', () => {
      const manager = shellManager() as unknown as DrainInternals
      const parent = makeFakeWorker()
      seedParentSession(
        manager as unknown as SharedWorkerSessionManager,
        'P-mid-9',
        parent.worker,
        false,
      )
      finishShell(manager, 'P-mid-9', 'shell-mid-9', 'IDLE_DONE')
      expect(parent.submits).toHaveLength(1)
      expect(drainText(manager, 'P-mid-9', { includeLater: true })).toBeNull()
    })

    type SuperShellInternals = {
      superShells: {
        register: (start: Record<string, unknown>) => string
        finish: (finish: Record<string, unknown>) => void
      }
    }

    it('a SuperShell run finishing in the background mid-turn is drained like a shell — once, never re-delivered at idle', () => {
      const { manager, parent, goIdle } = busyParent('P-mid-10')
      const { superShells } = manager as unknown as SuperShellInternals
      const taskId = superShells.register({
        spawnerSessionId: 'P-mid-10',
        description: 'build and test',
        code: 'await bash("make")',
        startedAt: Date.now(),
        progress: () => '',
        stop: () => {},
      })
      superShells.finish({
        taskId,
        status: 'success',
        resultText: 'SUPERSHELL_MID_DONE',
        finishedAt: Date.now(),
        deliver: true,
      })

      const prompt = drainText(manager, 'P-mid-10', { includeLater: false })
      expect(prompt).toContain('<task-notification>')
      expect(prompt).toContain('SUPERSHELL_MID_DONE')
      expect(manager.drainMidTurnTaskNotifications('P-mid-10', { includeLater: true })).toBeNull()
      goIdle()
      goIdle()
      expect(parent.submits).toHaveLength(0)
    })

    it('a shell a nested caller consumes itself (resultAcknowledged) is never drained or delivered', () => {
      // SuperShell's foreground steps: PostToolUse hooks run between the host
      // spawn and the step's own acknowledge, so a fast step must be
      // acknowledged from registration or it leaks a stray notification.
      const { manager, parent, goIdle } = busyParent('P-mid-11')
      ;(manager.registerBackgroundShell as (l: Record<string, unknown>) => void)({
        shellId: 'shell-mid-11',
        command: 'make',
        spawnerSessionId: 'P-mid-11',
        resultAcknowledged: true,
      })
      manager.shells.finalizeForTest('shell-mid-11', 'success', 'CONSUMED_STEP_DONE')

      expect(manager.drainMidTurnTaskNotifications('P-mid-11', { includeLater: true })).toBeNull()
      goIdle()
      expect(parent.submits).toHaveLength(0)
    })
  })

  it('defers background-task delivery while the parent is HALTED awaiting the user (needsAnswer), and flushes once answered', () => {
    // A background task finishing while the parent is halted on a user interaction defers its `<task-notification>`
    // batch to the next idle boundary, keyed on the live snapshot (`snapshotNeedsAnswer`), not `entry.needsAnswer`.
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-shell-awaiting',
      parent.worker,
      false, // idle — NOT streaming/inflight; the ONLY thing gating is the halt
    )
    // Drive the halted-on-user state through the worker's LIVE snapshot (the
    // source the manager now reads), toggled by the test.
    let halted = true
    ;(parent.worker as unknown as {
      getSnapshot: () => Record<string, unknown>
    }).getSnapshot = () => ({
      initialized: true,
      pendingUserInteraction: halted
          ? { call_ask_1: { toolName: 'AskUserQuestion' } }
          : {},
    })

    manager.registerBackgroundShell({
      shellId: 'shell-awaiting',
      command: 'slow build',
      spawnerSessionId: 'P-shell-awaiting',
    })
    manager.shells.finalizeForTest('shell-awaiting', 'success', 'build done')

    // Deferred, not delivered into the pending question.
    expect(manager.pendingTaskResults.get('P-shell-awaiting')).toHaveLength(1)
    expect(parent.submits).toHaveLength(0)

    // Still halted — an explicit flush attempt is a no-op.
    manager.maybeFlushTaskResults('P-shell-awaiting')
    expect(parent.submits).toHaveLength(0)

    // The user answers → the halt clears → the next idle boundary flushes.
    halted = false
    manager.maybeFlushTaskResults('P-shell-awaiting')
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('build done')
  })

  it('manual terminal BashOutput acknowledgment removes a pending shell delivery', () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-shell-ack',
      parent.worker,
      true,
    )

    manager.registerBackgroundShell({
      shellId: 'shell-ack',
      command: 'echo ack',
      spawnerSessionId: 'P-shell-ack',
    })
    manager.shells.finalizeForTest('shell-ack', 'success', 'ack output')
    expect(manager.pendingTaskResults.get('P-shell-ack')).toHaveLength(1)

    acknowledgeBackgroundShellResult('shell-ack')
    expect(manager.pendingTaskResults.has('P-shell-ack')).toBe(false)

    parent.worker.markStreamEnd()
    const entry = manager.sessions.get('P-shell-ack') as { phase: { kind: string } }
    entry.phase = { kind: 'idle' }
    manager.maybeFlushTaskResults('P-shell-ack')
    expect(parent.submits).toHaveLength(0)
  })

  // ---- Kind-agnostic TaskOutput / TaskStop over local_bash ----
  // One `TaskOutput` reads BOTH sub-agents and background shells; the manager's
  // SubAgentController methods must resolve shell ids too. Before this, these
  // returned null / no-op (shells were read only via the separate `BashOutput`
  // hosted tool).

  it('exposes a running background shell to the TaskOutput controller (getSubAgentSnapshot)', () => {
    const manager = shellManager()
    manager.registerBackgroundShell({
      shellId: 'shell-snap',
      command: 'npm run build',
      spawnerSessionId: 'P-snap',
    })
    const snap = manager.getSubAgentSnapshot('shell-snap')
    expect(snap).not.toBeNull()
    expect(snap?.taskType).toBe('local_bash')
    expect(snap?.status).toBe('running')
    expect(snap?.description).toBe('npm run build')
    // Clean up the dangling poll timer (no transport → it would reschedule).
    manager.shells.finalizeForTest('shell-snap', 'success', 'built ok')
  })

  it('reads a finished background shell + acknowledges it through the same controller entrypoint', () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-snap-ack',
      parent.worker,
      true,
    )
    manager.registerBackgroundShell({
      shellId: 'shell-snap-ack',
      command: 'echo hi',
      spawnerSessionId: 'P-snap-ack',
    })
    manager.shells.finalizeForTest('shell-snap-ack', 'success', 'hi output')

    const snap = manager.getSubAgentSnapshot('shell-snap-ack')
    expect(snap?.taskType).toBe('local_bash')
    expect(snap?.status).toBe('success')
    expect(snap?.output).toBe('hi output')
    expect(manager.pendingTaskResults.get('P-snap-ack')).toHaveLength(1)

    // TaskOutput reading the TERMINAL result suppresses the auto-delivery turn —
    // via acknowledgeSubAgentResult (the controller's acknowledgeResult), which
    // must route a shell id to the shell ack path (was a silent no-op before).
    manager.acknowledgeSubAgentResult('shell-snap-ack')
    expect(manager.pendingTaskResults.has('P-snap-ack')).toBe(false)
  })

  it('stops a running background shell through the TaskStop controller (stopSubAgent)', () => {
    const manager = shellManager()
    manager.registerBackgroundShell({
      shellId: 'shell-stop',
      command: 'sleep 100',
      spawnerSessionId: 'P-stop',
    })
    const result = manager.stopSubAgent('shell-stop')
    expect(result.status).toBe('stopped')
    expect(result.description).toBe('sleep 100')
    // No transport → the fired async kill can't finalize; clean the poll timer.
    manager.shells.finalizeForTest('shell-stop', 'stopped', 'cleanup')
  })

  // ---- Foreground middle layer support (always-background) ----

  it('polls fast during the foreground window so a quick command is observed promptly', async () => {
    const manager = shellManager()
    const { routes } = installShellHost(manager, always({
      found: true,
      running: true,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }))
    const statusCalls = () => routes.filter(r => r.action === 'persistentList').length
    manager.registerBackgroundShell({
      shellId: 'shell-fast',
      command: 'x',
      spawnerSessionId: 'P-fast',
    })
    // t=0 poll + fast (~150ms) reschedules → several within 500ms. The old flat
    // 1.5s cadence would only fire the single t=0 poll in this window, so a quick
    // command's completion wouldn't be observed until ~1.5s (laggy foreground).
    await new Promise(r => setTimeout(r, 500))
    expect(statusCalls()).toBeGreaterThanOrEqual(2)
    manager.shells.finalizeForTest('shell-fast', 'stopped', 'cleanup')
  })

  it('background completion is idle-gated: it cannot race the active turn (foreground→background handoff)', () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-race',
      parent.worker,
      true, // streaming — the turn that returned "moved to the background" is still active
    )
    manager.registerBackgroundShell({
      shellId: 'shell-race',
      command: 'slow build',
      spawnerSessionId: 'P-race',
    })
    // The command finishes WHILE the parent turn is still streaming.
    manager.shells.finalizeForTest('shell-race', 'success', 'race output')
    // Deferred, not delivered mid-turn — no interleave with the current result.
    expect(manager.pendingTaskResults.get('P-race')).toHaveLength(1)
    expect(parent.submits).toHaveLength(0)
    // Turn ends → exactly one delivery flushes.
    parent.worker.markStreamEnd()
    const entry = manager.sessions.get('P-race') as { phase: { kind: string } }
    entry.phase = { kind: 'idle' }
    manager.maybeFlushTaskResults('P-race')
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('race output')
  })

  it('reused shell ids replace stale finished records instead of hiding a fresh launch', () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-reused-shell',
      parent.worker,
      true,
    )

    manager.registerBackgroundShell({
      shellId: 'shell-reused',
      command: 'old command',
      spawnerSessionId: 'P-reused-shell',
    })
    manager.shells.finalizeForTest('shell-reused', 'success', 'old output')
    expect(manager.pendingTaskResults.get('P-reused-shell')).toHaveLength(1)
    expect(bashRow(manager, 'shell-reused')?.status).toBe('success')

    manager.registerBackgroundShell({
      shellId: 'shell-reused',
      command: 'new command',
      spawnerSessionId: 'P-reused-shell',
    })

    const row = bashRow(manager, 'shell-reused')
    expect(row?.status).toBe('running')
    expect(row?.command).toBe('new command')
    expect(manager.pendingTaskResults.has('P-reused-shell')).toBe(false)
    expect(manager.loadSubAgentInfo('shell-reused')).toMatchObject({
      type: 'local_bash',
      task: 'new command',
    })
    manager.shells.finalizeForTest('shell-reused', 'stopped', 'cleanup')
  })

  it('timed-out background shells are errors and still notify the parent', async () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-shell-timeout',
      parent.worker,
      false,
    )
    installShellHost(manager, always({
      found: true,
      running: false,
      stdout: 'started before timeout',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: true,
      killed: true,
    }))

    manager.registerBackgroundShell({
      shellId: 'shell-timeout',
      command: 'sleep 30',
      spawnerSessionId: 'P-shell-timeout',
    })
    await new Promise(r => setTimeout(r, 50))

    expect(bashRow(manager, 'shell-timeout')?.status).toBe('error')
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('<task-notification>')
    expect(parent.submits[0]).toContain('failed')
    expect(parent.submits[0]).toContain('started before timeout')
    expect(parent.submits[0]).toContain('Command timed out.')
  })

  it('terminal shell.persistentList failures finalize and notify instead of polling forever', async () => {
    const manager = shellManager()
    const parent = makeFakeWorker()
    seedParentSession(
      manager as unknown as SharedWorkerSessionManager,
      'P-shell-monitor-fail',
      parent.worker,
      false,
    )
    installShellHost(manager, () => ({
      ok: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'No handler for capability: shell',
      },
    }))

    manager.registerBackgroundShell({
      shellId: 'shell-monitor-fail',
      command: 'npm test',
      spawnerSessionId: 'P-shell-monitor-fail',
    })
    await new Promise(r => setTimeout(r, 50))

    expect(bashRow(manager, 'shell-monitor-fail')?.status).toBe('error')
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('Background shell monitor failed')
    // A host that answers NOT_IMPLEMENTED does not serve the primitive.
    expect(parent.submits[0]).toContain('shell.persistentList is not supported by this host')
  })

  it('classifies a non-zero exit as error', async () => {
    const manager = shellManager()
    installShellHost(manager, always({
      found: true,
      running: false,
      stdout: '',
      stderr: 'boom',
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 2,
    }))
    manager.registerBackgroundShell({
      shellId: 'shell-err',
      command: 'false',
      spawnerSessionId: 'P',
    })
    await new Promise(r => setTimeout(r, 50))
    expect(bashRow(manager, 'shell-err')?.status).toBe('error')
  })

  it('Stop issues shell.persistentKill and flips the row to stopped after terminal status confirmation', async () => {
    const manager = shellManager()
    const calls: Array<{ capability: string; action: string; payload: unknown }> =
      []
    let statusReads = 0
    const host = installShellHost(manager, (op) => {
      if (op === 'kill') {
        return { ok: true, result: { found: true, wasRunning: true } }
      }
      statusReads += 1
      return {
        ok: true,
        result:
          statusReads === 1
            ? {
                found: true,
                running: true,
                stdout: '',
                stderr: '',
                stdoutTruncated: false,
                stderrTruncated: false,
              }
            : {
                found: true,
                running: false,
                stdout: 'partial before stop',
                stderr: '',
                stdoutTruncated: false,
                stderrTruncated: false,
                killed: true,
                exitCode: -1,
              },
      }
    })
    manager.registerBackgroundShell({
      shellId: 'shell-3',
      command: 'sleep 99',
      spawnerSessionId: 'P',
    })
    const status = await manager.shells.stop('shell-3')
    expect(status).toBe('stopped')
    calls.push(...host.routes)
    expect(
      calls.some(
        c =>
          c.capability === 'shell' &&
          c.action === 'persistentKill' &&
          (c.payload as { id?: string }).id === 'shell-3',
      ),
    ).toBe(true)
    expect(calls.some(c => c.action === 'kill')).toBe(false)
    expect(statusReads).toBeGreaterThanOrEqual(2)
    expect(bashRow(manager, 'shell-3')?.status).toBe('stopped')
    expect(manager.loadSubAgentInfo('shell-3')?.summary).toContain(
      'partial before stop',
    )
    // Flush any dangling poll timer scheduled before the stop (no-op once gone).
    await new Promise(r => setTimeout(r, 5))
  })

  it('Stop leaves the row running when shell.persistentKill fails', async () => {
    const manager = shellManager()
    installShellHost(manager, (op) => {
      if (op === 'kill') throw new Error('kill failed')
      return {
        ok: true,
        result: {
          found: true,
          running: true,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      }
    })
    manager.registerBackgroundShell({
      shellId: 'shell-kill-fails',
      command: 'sleep 99',
      spawnerSessionId: 'P',
    })
    const status = await manager.shells.stop('shell-kill-fails')
    expect(status).toBe('stop_failed')
    expect(bashRow(manager, 'shell-kill-fails')?.status).toBe('running')
    manager.shells.finalizeForTest('shell-kill-fails', 'stopped', 'cleanup')
  })

  it('stopBackgroundShell on an unknown id reports not_found', async () => {
    const manager = shellManager()
    expect(await manager.shells.stop('nope')).toBe('not_found')
  })

  it('cascades background shells away when the parent session closes', () => {
    const manager = shellManager()
    manager.registerBackgroundShell({
      shellId: 'shell-c',
      command: 'top',
      spawnerSessionId: 'P-close',
    })
    expect(bashRow(manager, 'shell-c')?.status).toBe('running')
    manager.cascadeSubAgentsOnParentClose('P-close')
    // The run (and any finished record) for the vanished parent is dropped.
    expect(bashRow(manager, 'shell-c')).toBeUndefined()
    expect(manager.pendingTaskResults.has('P-close')).toBe(false)
  })
})

// ===========================================================================
// Background sub-agent CONTROL surface (G1/G3/G4) — TaskStop / TaskOutput /
// AgentResume, the controller leaf, and the manager methods behind them.
// ===========================================================================

describe('subAgentController leaf', () => {
  it('set/get round-trips, defaults null', () => {
    expect(getSubAgentController()).toBeNull()
    const c = {} as SubAgentController
    setSubAgentController(c)
    expect(getSubAgentController()).toBe(c)
  })
})

describe('TaskStop / TaskOutput / AgentResume / AgentList tools', () => {
  it('degrade gracefully when no controller is registered', async () => {
    setSubAgentController(null)
    expect((await JobHaltTool.call({ task_id: 'x' }, ctx(), ALLOW, PARENT)).data).toMatch(
      /unavailable/i,
    )
    expect((await JobReadTool.call({ task_id: 'x' }, ctx(), ALLOW, PARENT)).data).toMatch(
      /unavailable/i,
    )
    expect(
      (await AgentResumeTool.call({ task_id: 'x', prompt: 'p' }, ctx(), ALLOW, PARENT)).data,
    ).toMatch(/unavailable/i)
    expect((await AgentListTool.call({}, ctx(), ALLOW, PARENT)).data).toMatch(/unavailable/i)
  })

  it('TaskStop stops a running sub-agent; ERRORS (throws) for already_finished / not_found', async () => {
    const calls: string[] = []
    setSubAgentController({
      getSnapshot: () => null,
      waitForCompletion: async () => null,
      stop: (id) => {
        calls.push(id)
        if (id === 'run') return { status: 'stopped', description: 'my task' }
        if (id === 'done') return { status: 'already_finished', description: 'old task' }
        return { status: 'not_found' }
      },
      resume: () => ({ ok: false, reason: 'not_found' }),
      list: () => [],
    })
    expect((await JobHaltTool.call({ task_id: 'run' }, ctx(), ALLOW, PARENT)).data).toMatch(
      /Stopped background sub-agent "my task"/,
    )
    // Stopping a non-running sub-agent is an ERROR (call throws → toolExecution surfaces isError), not
    // the prior success-shaped advisory the model could ignore.
    await expect(
      JobHaltTool.call({ task_id: 'done' }, ctx(), ALLOW, PARENT),
    ).rejects.toThrow(/already finished|not running/i)
    await expect(
      JobHaltTool.call({ task_id: 'ghost' }, ctx(), ALLOW, PARENT),
    ).rejects.toThrow(/No background sub-agent found/i)
    expect(calls).toEqual(['run', 'done', 'ghost'])
  })

  it('TaskStop validateInput rejects a finished / unknown sub-agent, accepts a running one', async () => {
    // The primary gate: a finished sub-agent
    // is rejected up-front (errorCode 3, "is not running"), pointing the model
    // at TaskOutput; a running one passes; an unknown id is rejected.
    setSubAgentController({
      getSnapshot: (id) =>
        id === 'done'
          ? {
              sessionId: 'done',
              status: 'success',
              description: 'old task',
              output: 'X',
              startedAt: 0,
            }
          : id === 'live'
            ? {
                sessionId: 'live',
                status: 'running',
                description: 'task',
                output: '',
                startedAt: 0,
              }
            : null,
      waitForCompletion: async () => null,
      stop: () => ({ status: 'not_found' }),
      resume: () => ({ ok: false, reason: 'not_found' }),
      list: () => [],
    })
    const finished = await JobHaltTool.checkInput!({ task_id: 'done' }, ctx())
    expect(finished.result).toBe(false)
    expect((finished as { message: string }).message).toMatch(/not running.*success/i)
    const missing = await JobHaltTool.checkInput!({ task_id: 'ghost' }, ctx())
    expect(missing.result).toBe(false)
    expect(
      (await JobHaltTool.checkInput!({ task_id: 'live' }, ctx())).result,
    ).toBe(true)
  })

  it('TaskOutput: unknown id, non-blocking partial, blocking-until-final', async () => {
    setSubAgentController({
      getSnapshot: (id) =>
        id === 'k'
          ? {
              sessionId: 'k',
              status: 'running',
              description: 'task',
              output: 'partial',
              startedAt: 0,
              updates: 4,
            }
          : null,
      waitForCompletion: async (id) => ({
        sessionId: id,
        status: 'success',
        description: 'task',
        output: 'FINAL_ANSWER',
        startedAt: 0,
      }),
      stop: () => ({ status: 'not_found' }),
      resume: () => ({ ok: false, reason: 'not_found' }),
      list: () => [],
    })
    expect((await JobReadTool.call({ task_id: 'nope' }, ctx(), ALLOW, PARENT)).data).toMatch(
      /No background task found/i,
    )
    const nb = await JobReadTool.call({ task_id: 'k', block: false }, ctx(), ALLOW, PARENT)
    expect(nb.data).toMatch(/still running/i)
    expect(nb.data).toContain('partial')
    expect(nb.data).toContain('4 updates') // G5 liveness
    const b = await JobReadTool.call({ task_id: 'k', block: true }, ctx(), ALLOW, PARENT)
    expect(b.data).toContain('FINAL_ANSWER')
    expect(b.data).toMatch(/completed/i)
  })

  it('AgentResume forwards id+prompt to the controller and acks per result', async () => {
    const calls: Array<{ id: string; prompt: string }> = []
    setSubAgentController({
      getSnapshot: () => null,
      waitForCompletion: async () => null,
      stop: () => ({ status: 'not_found' }),
      resume: (id, prompt) => {
        calls.push({ id, prompt })
        if (id === 'ok') return { ok: true, sessionId: id }
        if (id === 'live') return { ok: false, reason: 'still_running' }
        return { ok: false, reason: 'not_found' }
      },
      list: () => [],
    })
    const r = await AgentResumeTool.call({ task_id: 'ok', prompt: 'continue' }, ctx(), ALLOW, PARENT)
    expect(r.data).toMatch(/Resumed background sub-agent/i)
    expect(calls[0]).toEqual({ id: 'ok', prompt: 'continue' })
    expect(
      (await AgentResumeTool.call({ task_id: 'live', prompt: 'x' }, ctx(), ALLOW, PARENT)).data,
    ).toMatch(/still running/i)
    expect(
      (await AgentResumeTool.call({ task_id: 'gone', prompt: 'x' }, ctx(), ALLOW, PARENT)).data,
    ).toMatch(/No resumable background sub-agent/i)
  })

  it('AgentList scopes to the calling session, renders rows, and filters by status', async () => {
    let listedParent: string | null = null
    setSubAgentController({
      getSnapshot: () => null,
      waitForCompletion: async () => null,
      stop: () => ({ status: 'not_found' }),
      resume: () => ({ ok: false, reason: 'not_found' }),
      list: (spawnerSessionId) => {
        listedParent = spawnerSessionId
        return [
          {
            sessionId: 'subagent-a',
            status: 'running',
            description: 'task A',
            agentType: 'Explore',
            startedAt: 1,
            updates: 3,
          },
          {
            sessionId: 'subagent-b',
            status: 'success',
            description: 'task B',
            startedAt: 2,
            finishedAt: 9,
          },
        ]
      },
    })
    const all = await AgentListTool.call({}, ctx('parent-list'), ALLOW, PARENT)
    expect(listedParent).toBe('parent-list')
    expect(all.data).toMatch(/2, 1 running/)
    expect(all.data).toContain('subagent-a')
    expect(all.data).toContain('task A')
    expect(all.data).toContain('(Explore)')
    expect(all.data).toContain('3 updates') // G5 liveness on the running row
    expect(all.data).toContain('subagent-b')

    const onlyRunning = await AgentListTool.call(
      { status: 'running' },
      ctx('parent-list'),
      ALLOW,
      PARENT,
    )
    expect(onlyRunning.data).toContain('subagent-a')
    expect(onlyRunning.data).not.toContain('subagent-b')
  })

  it('AgentList reports an empty list cleanly', async () => {
    setSubAgentController({
      getSnapshot: () => null,
      waitForCompletion: async () => null,
      stop: () => ({ status: 'not_found' }),
      resume: () => ({ ok: false, reason: 'not_found' }),
      list: () => [],
    })
    expect((await AgentListTool.call({}, ctx(), ALLOW, PARENT)).data).toMatch(
      /No background sub-agents have been launched/i,
    )
    expect(
      (await AgentListTool.call({ status: 'error' }, ctx(), ALLOW, PARENT)).data,
    ).toMatch(/No background sub-agents in state "error"/i)
  })
})

describe('SharedWorkerSessionManager — sub-agent control methods', () => {
  function setup() {
    let subEmit: ((m: AgentWorkerOutboundMessage) => void) | null = null
    const subWorker = makeFakeWorker({ submitBlocks: true })
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      subEmit = o.emit
      return subWorker.worker
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    return {
      manager,
      subWorker,
      drive: (m: AgentWorkerOutboundMessage) => subEmit?.(m),
    }
  }

  it('getSubAgentSnapshot returns a running snapshot with partial output', () => {
    const { manager, drive } = setup()
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'p',
      prompt: 'p',
      description: 'task',
      agentType: 'Explore',
    })!
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('PARTIAL_TOKEN') },
    } as unknown as AgentWorkerOutboundMessage)
    const snap = manager.getSubAgentSnapshot(sid)
    expect(snap?.status).toBe('running')
    expect(snap?.agentType).toBe('Explore')
    expect(snap?.output).toContain('PARTIAL_TOKEN')
    expect(manager.getSubAgentSnapshot('unknown-id')).toBeNull()
  })

  it('stopSubAgent aborts + records a stopped state and does NOT deliver to the parent', async () => {
    const { manager, drive } = setup()
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-stop', parent.worker, false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-stop',
      prompt: 'long',
      description: 'long task',
    })!
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('HALFWAY') },
    } as unknown as AgentWorkerOutboundMessage)

    const res = manager.stopSubAgent(sid)
    expect(res).toMatchObject({ status: 'stopped', description: 'long task' })
    // Stop does not self-wake the parent (the model invoked it).
    expect(parent.submits).toHaveLength(0)
    // Run reaped; the terminal snapshot is readable with the partial output.
    const internals = manager as unknown as ManagerInternals
    expect(hasLiveTask(manager, sid)).toBe(false)
    const snap = manager.getSubAgentSnapshot(sid)
    expect(snap?.status).toBe('stopped')
    expect(snap?.output).toContain('HALFWAY')
    // The transcript survives reaping: read from the retained terminal record
    // (tasks is now empty, manager has no storage), so a stopped
    // sub-agent's detail view stays populated instead of going blank.
    expect(await manager.loadSubAgentTranscript(sid)).toEqual([
      { role: 'assistant', text: 'HALFWAY', tools: [] },
    ])

    // Stopping again (now finished) reports already_finished; unknown → not_found.
    expect(manager.stopSubAgent(sid).status).toBe('already_finished')
    expect(manager.stopSubAgent('nope').status).toBe('not_found')
  })

  it('waitForSubAgentCompletion resolves on completion, on timeout, and null for unknown id', async () => {
    const { manager, subWorker, drive } = setup()
    seedParentSession(manager, 'parent-wait', makeFakeWorker().worker, false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-wait',
      prompt: 'p',
      description: 'task',
    })!

    // Timeout path: 0ms → resolves with the still-running snapshot.
    const timedOut = await manager.waitForSubAgentCompletion(sid, 0)
    expect(timedOut?.status).toBe('running')

    // Unknown id → null.
    expect(await manager.waitForSubAgentCompletion('ghost', 50)).toBeNull()

    // Completion path: the pending waiter resolves with the terminal snapshot.
    const waitP = manager.waitForSubAgentCompletion(sid, 10_000)
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('FINAL_TOKEN') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    subWorker.releaseSubmit()
    const done = await waitP
    expect(done?.status).toBe('success')
    expect(done?.output).toContain('FINAL_TOKEN')
    // Transcript captured at finalize is readable after the run is reaped — a
    // FINISHED sub-agent's detail view no longer goes blank.
    expect(await manager.loadSubAgentTranscript(sid)).toEqual([
      { role: 'assistant', text: 'FINAL_TOKEN', tools: [] },
    ])
  })

  it('prepareWorkerStorage nests a sub-agent under <spawnerSessionId>/subagents/; non-sub-agents stay at the bare project dir', () => {
    const { manager } = setup()
    const routed: Array<{ sessionId: string; dir: string }> = []
    // Seed the grouped-storage branch (setup() leaves the legacy branch).
    const sc = (
      manager as unknown as {
        storageCoordinator: {
          homeDir: string | null
          groupedStorage: unknown
          prepareWorkerStorage: (
            id: string,
            payload: { sessionStoragePath?: string },
            parent?: string,
          ) => unknown
        }
      }
    ).storageCoordinator
    sc.homeDir = '/home/u'
    sc.groupedStorage = {
      setSessionProjectDir: (sessionId: string, dir: string) =>
        routed.push({ sessionId, dir }),
      dropSessionRouting: () => {},
      // The spawn-time task.json seed reads the parent's routed dir — the
      // double must answer it so the real seed path runs.
      projectRouteOf: () => '/home/u/projects/p',
    }
    const prepare = sc.prepareWorkerStorage.bind(sc)
    const fwd = (p: string): string => p.replace(/\\/g, '/')

    // Sub-agent WITH a parent → nested under <parent>/subagents (so deleting the
    // parent session dir recursively sweeps it — the cascade-delete goal).
    const subPayload: { sessionStoragePath?: string } = {}
    prepare('subagent-explore_x', subPayload, 'parent-N')
    expect(fwd(subPayload.sessionStoragePath!)).toMatch(/\/parent-N\/subagents$/)
    expect(fwd(routed.at(-1)!.dir)).toMatch(/\/parent-N\/subagents$/)

    // Normal session (no parent) → bare project dir, NO /subagents suffix.
    const mainPayload: { sessionStoragePath?: string } = {}
    prepare('normal-session-id', mainPayload, undefined)
    expect(fwd(mainPayload.sessionStoragePath!)).not.toMatch(/subagents$/)

    // Defensive guard: a sub-agent id but NO parent stays at the bare dir.
    const orphanPayload: { sessionStoragePath?: string } = {}
    prepare('subagent-orphan_y', orphanPayload, undefined)
    expect(fwd(orphanPayload.sessionStoragePath!)).not.toMatch(/subagents$/)
  })

  it('parent-close cascade drops each background sub-agent routing entry (no zombie)', () => {
    const { manager } = setup()
    const dropped: string[] = []
    const sc = (
      manager as unknown as {
        storageCoordinator: { homeDir: string | null; groupedStorage: unknown }
      }
    ).storageCoordinator
    sc.homeDir = '/home/u'
    sc.groupedStorage = {
      setSessionProjectDir: () => {},
      dropSessionRouting: (sessionId: string) => dropped.push(sessionId),
      projectRouteOf: () => '/home/u/projects/p',
    }
    seedParentSession(manager, 'parent-cascade', makeFakeWorker().worker, false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-cascade',
      prompt: 'p',
      description: 'task',
    })!
    // Capture the native sessionId BEFORE the cascade drops the taskId index.
    const nativeSid = nativeOf(manager, sid)
    // Sub-agent is still running (submitBlocks). Closing the parent must evict
    // its routing-map entry so a later re-used id can't route to the gone dir.
    ;(
      manager as unknown as {
        cascadeSubAgentsOnParentClose: (p: string) => void
      }
    ).cascadeSubAgentsOnParentClose('parent-cascade')
    expect(dropped).toContain(nativeSid)
  })

  it('resumeSubAgent re-launches a finished sub-agent into a new run that delivers again', async () => {
    const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
    const workers: ReturnType<typeof makeFakeWorker>[] = []
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      const w = makeFakeWorker({ submitBlocks: true })
      emits.push(o.emit)
      workers.push(w)
      return w.worker
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-resume', parent.worker, false)

    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-resume',
      prompt: 'p1',
      description: 'task',
      agentType: 'Explore',
    })!
    // Finish run 1 → delivered once.
    emits[0]!({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('RUN1') },
    } as unknown as AgentWorkerOutboundMessage)
    emits[0]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(workers[0]!)
    expect(parent.submits).toHaveLength(1)
    expect(parent.submits[0]).toContain('RUN1')

    // Resume: re-launches the SAME session id as a new run.
    const res = manager.resumeSubAgent(sid, 'follow up please')
    expect(res).toEqual({ ok: true, sessionId: sid })
    // A second worker was allocated and re-registered as a live run.
    expect(workers).toHaveLength(2)
    expect(hasLiveTask(manager, sid)).toBe(true)
    // The follow-up prompt was submitted to the resumed worker (after microtasks).
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(workers[1]!.submits).toContain('follow up please')

    // While run 2 is live: resuming it again is rejected (still_running); an
    // unknown id is not_found. Neither allocates another worker.
    expect(manager.resumeSubAgent(sid, 'x')).toEqual({ ok: false, reason: 'still_running' })
    expect(manager.resumeSubAgent('never', 'x')).toEqual({ ok: false, reason: 'not_found' })
    expect(workers).toHaveLength(2)

    // Finish run 2 → delivered a SECOND time into the same parent.
    emits[1]!({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('RUN2') },
    } as unknown as AgentWorkerOutboundMessage)
    emits[1]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(workers[1]!)
    expect(parent.submits).toHaveLength(2)
    expect(parent.submits[1]).toContain('RUN2')
  })

  it('listSubAgents enumerates running + finished, scoped to the parent, running first', async () => {
    const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
    const workers: ReturnType<typeof makeFakeWorker>[] = []
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      const w = makeFakeWorker({ submitBlocks: true })
      emits.push(o.emit)
      workers.push(w)
      return w.worker
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }

    const a = manager.spawnSubAgentSession({
      spawnerSessionId: 'P1',
      prompt: 'p',
      description: 'alpha',
      agentType: 'Explore',
    })! // emits[0]
    const b = manager.spawnSubAgentSession({
      spawnerSessionId: 'P1',
      prompt: 'p',
      description: 'beta',
    })! // emits[1]
    const other = manager.spawnSubAgentSession({
      spawnerSessionId: 'P2',
      prompt: 'p',
      description: 'gamma',
    })! // emits[2]

    // Finish 'a' → it becomes a terminal record under P1 (b stays running).
    emits[0]!({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('A_DONE') },
    } as unknown as AgentWorkerOutboundMessage)
    emits[0]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(workers[0]!)

    const p1 = manager.listSubAgents('P1')
    // Running (b) sorts before finished (a); P2's sub-agent is excluded.
    expect(p1.map((e) => e.sessionId)).toEqual([b, a])
    expect(p1.find((e) => e.sessionId === b)?.status).toBe('running')
    expect(p1.find((e) => e.sessionId === a)?.status).toBe('success')
    expect(p1.some((e) => e.sessionId === other)).toBe(false)

    expect(manager.listSubAgents('P2').map((e) => e.sessionId)).toEqual([other])
    expect(manager.listSubAgents('nobody')).toEqual([])
  })

  it('surfaces liveness (G5): updates count grows with stream events', () => {
    const { manager, drive } = setup()
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
    })!
    expect(manager.getSubAgentSnapshot(sid)?.updates).toBe(0)
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('A') },
    } as unknown as AgentWorkerOutboundMessage)
    drive({
      type: 'worker.stream',
      payload: { event: assistantTextEvent('B') },
    } as unknown as AgentWorkerOutboundMessage)
    const snap = manager.getSubAgentSnapshot(sid)
    expect(snap?.updates).toBe(2)
    expect(typeof snap?.lastActivityAt).toBe('number')
    expect(manager.listSubAgents('P').find((e) => e.sessionId === sid)?.updates).toBe(2)
  })

  it('invokes the worktree onCleanup callback once on normal finalize (G7)', async () => {
    const { manager, subWorker, drive } = setup()
    seedParentSession(manager, 'parent-wt', makeFakeWorker().worker, false)
    let cleaned = 0
    manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-wt',
      prompt: 'p',
      description: 'wt task',
      projectRoot: '/wt',
      onCleanup: () => {
        cleaned++
      },
    })
    drive({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(subWorker)
    expect(cleaned).toBe(1)
  })

  it('invokes the worktree onCleanup callback when the sub-agent is stopped (G7)', async () => {
    const { manager } = setup()
    seedParentSession(manager, 'parent-wt2', makeFakeWorker().worker, false)
    let cleaned = 0
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-wt2',
      prompt: 'p',
      description: 'wt task',
      projectRoot: '/wt',
      onCleanup: () => {
        cleaned++
      },
    })!
    expect(manager.stopSubAgent(sid).status).toBe('stopped')
    // Cleanup is sequenced AFTER the async native teardown settles (the
    // stop/resume race fix), so the callback lands a tick later.
    await vi.waitFor(() => expect(cleaned).toBe(1))
  })

  it('buildSummaryPayload carries background sub-agents for the human surface (G2)', async () => {
    const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
    const workers: ReturnType<typeof makeFakeWorker>[] = []
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      const w = makeFakeWorker({ submitBlocks: true })
      emits.push(o.emit)
      workers.push(w)
      return w.worker
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }

    const a = manager.spawnSubAgentSession({
      spawnerSessionId: 'P1',
      prompt: 'p',
      description: 'alpha',
      agentType: 'Explore',
    })! // emits[0] — stays running
    const b = manager.spawnSubAgentSession({
      spawnerSessionId: 'P1',
      prompt: 'p',
      description: 'beta',
    })! // emits[1] — finish it
    emits[1]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(workers[1]!)

    const summary = (
      manager as unknown as {
        feed: { buildSummaryPayload(): { subAgents?: NexusTaskSummaryRow[] } }
      }
    ).feed.buildSummaryPayload()
    const byId = Object.fromEntries(
      (summary.subAgents ?? []).map((s) => [s.sessionId, s]),
    )
    expect(byId[a]?.status).toBe('running')
    expect(byId[a]?.spawnerSessionId).toBe('P1')
    expect(byId[a]?.agentType).toBe('Explore')
    expect(byId[b]?.status).toBe('success')
  })
})

// ===========================================================================
// Human-facing surface helpers (G2/G5) — pure selection/format used by the
// Background Tasks drawer.
// ===========================================================================

describe('background sub-agents UI helpers', () => {
  const rows: NexusTaskSummaryRow[] = [
    { sessionId: 'subagent-1', spawnerSessionId: 'P1', status: 'running', description: 'a', updates: 2 },
    { sessionId: 'subagent-2', spawnerSessionId: 'P2', status: 'success', description: 'b' },
    { sessionId: 'subagent-3', spawnerSessionId: 'P1', status: 'stopped', description: 'c' },
  ]

  it('subAgentsEqual detects length + field changes', () => {
    expect(subAgentsEqual(rows, rows)).toBe(true)
    expect(subAgentsEqual(rows, [...rows])).toBe(true)
    expect(subAgentsEqual(rows, rows.slice(0, 2))).toBe(false)
    const bumped = rows.map((r, i) => (i === 0 ? { ...r, updates: 5 } : r))
    expect(subAgentsEqual(rows, bumped)).toBe(false)
  })

  it('summarizeSubAgents headlines the running count, else the total', () => {
    const all: NexusTaskSummaryRow[] = [
      ...rows,
      {
        sessionId: 'shell-1',
        spawnerSessionId: 'P1',
        status: 'running',
        type: 'local_bash',
        description: 'npm test',
        command: 'npm test',
      },
    ]
    expect(summarizeSubAgents(rows)).toMatch(/1 background sub-agent running/)
    expect(summarizeSubAgents([rows[1]!])).toMatch(/1 background sub-agent$/)
    expect(summarizeSubAgents([rows[1]!, rows[2]!])).toMatch(/2 background sub-agents$/)
    expect(summarizeSubAgents(all)).toMatch(/2 background tasks running/)
  })
})

// ===========================================================================
// A blocking TaskOutput(block) never hangs once its sub-agent is terminal: the terminal record is injected without
// `recordFinishedSubAgent`, and the safety poll must still resolve the wait.
// ===========================================================================
describe('SharedWorkerSessionManager — waitForSubAgentCompletion poll fallback', () => {
  it('resolves a blocking wait from the terminal record even if the direct waiter resolution is missed', async () => {
    const subWorker = makeFakeWorker({ submitBlocks: true })
    const createWorker = (): AgentRuntimeWorkerHandle => subWorker.worker
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as { lastInitTemplate: unknown }).lastInitTemplate = {
      cwd: '/x',
    }
    const parent = makeFakeWorker()
    seedParentSession(manager, 'parent-poll', parent.worker, false)

    const sessionId = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-poll',
      prompt: 'compute',
      description: 'compute the answer',
    })!
    expect(sessionId).toMatch(/^a/)

    // submitBlocks → the sub never finalizes on its own, so it stays a running
    // run and the blocking wait parks a waiter.
    const waitP = manager.waitForSubAgentCompletion(sessionId, 30_000)

    // Simulate the hang's precondition: the sub-agent reached a TERMINAL record,
    // but the direct waiter resolution was missed — inject the finished record +
    // reap the run WITHOUT calling recordFinishedSubAgent (which would resolve
    // the parked waiter on the fast path).
    const internals = manager as unknown as {
      taskRegistry: {
        deleteLive(id: string): void
        recordFinished(id: string, record: unknown): void
      }
    }
    // Maps are keyed by the NATIVE sessionId; `sessionId` here is the `a…` taskId.
    const native = nativeOf(manager, sessionId)
    internals.taskRegistry.deleteLive(native)
    internals.taskRegistry.recordFinished(native, {
      type: 'local_agent',
      taskId: sessionId,
      sessionId: native,
      agentId: native.replace(/^subagent-/, ''),
      spawnerSessionId: 'parent-poll',
      description: 'compute the answer',
      status: 'success',
      summary: 'THE ANSWER',
      startedAt: 1,
      finishedAt: 2,
      depth: 0,
    })

    // The re-armed 250ms poll must catch the terminal record and resolve the
    // otherwise-hung wait (without the poll this resolves only at the 30s
    // timeout → the test would hang).
    const snap = await waitP
    expect(snap?.status).toBe('success')
    expect(snap?.output).toBe('THE ANSWER')
  })
})

// ===========================================================================
// Human port control (the Background Tasks drawer) — the webview posts
// `task.stop` / `task.resume` on the SharedWorker port; handlePortMessage
// routes them to the existing stopSubAgent / resumeSubAgent and acks the result.
// ===========================================================================

describe('SharedWorkerSessionManager — human port control (Background Tasks drawer)', () => {
  // Local manager factory (the other describes' `setup()` is block-scoped).
  function makeManager(): SharedWorkerSessionManager {
    const subWorker = makeFakeWorker({ submitBlocks: true })
    const manager = new SharedWorkerSessionManager({
      createWorker: () => subWorker.worker,
    })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    return manager
  }
  type PortAck = { type: string; payload?: Record<string, unknown> }
  function makeRecordingPort(): { port: MessagePort; sent: PortAck[] } {
    const sent: PortAck[] = []
    const port = {
      postMessage: (m: PortAck) => sent.push(m),
    } as unknown as MessagePort
    return { port, sent }
  }
  function dispatch(
    manager: SharedWorkerSessionManager,
    port: MessagePort,
    message: unknown,
  ): void {
    ;(
      manager as unknown as {
        handlePortMessage: (p: MessagePort, e: MessageEvent) => void
      }
    ).handlePortMessage(port, { data: message } as MessageEvent)
  }
  const ackOf = (sent: PortAck[], type: string): PortAck | undefined =>
    sent.find((m) => m.type === type)

  it('task.stop on a running sub-agent stops it and acks { status: "stopped" }', () => {
    const manager = makeManager()
    seedParentSession(manager, 'P', makeFakeWorker().worker, false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
    })!
    const { port, sent } = makeRecordingPort()
    dispatch(manager, port, { type: 'task.stop', sessionId: sid, requestId: 'r1' })

    expect(ackOf(sent, 'task.stopped')?.payload).toMatchObject({
      sessionId: sid,
      status: 'stopped',
      requestId: 'r1',
    })
    expect(hasLiveTask(manager, sid)).toBe(false)
    expect(manager.getSubAgentSnapshot(sid)?.status).toBe('stopped')
  })

  it('task.stop on an unknown id acks { status: "not_found" } without throwing', () => {
    const manager = makeManager()
    const { port, sent } = makeRecordingPort()
    expect(() =>
      dispatch(manager, port, { type: 'task.stop', sessionId: 'nope', requestId: 'r2' }),
    ).not.toThrow()
    expect(ackOf(sent, 'task.stopped')?.payload).toMatchObject({
      sessionId: 'nope',
      status: 'not_found',
      requestId: 'r2',
    })
  })

  it('user Stop (worker.interrupt) cascades to STOP all of THIS session\'s running background sub-agents, leaving other sessions\' alone (scenario 6)', () => {
    const manager = makeManager()
    seedParentSession(manager, 'P', makeFakeWorker().worker, false)
    seedParentSession(manager, 'Q', makeFakeWorker().worker, false)
    const a = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'a',
    })!
    const b = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'b',
    })!
    // A sub-agent of a DIFFERENT session must NOT be cascaded.
    const other = manager.spawnSubAgentSession({
      spawnerSessionId: 'Q',
      prompt: 'p',
      description: 'other',
    })!
    const internals = manager as unknown as ManagerInternals
    expect(hasLiveTask(manager, a)).toBe(true)
    expect(hasLiveTask(manager, b)).toBe(true)
    expect(hasLiveTask(manager, other)).toBe(true)

    // The user clicks Stop on session P → a worker.interrupt for P.
    const { port } = makeRecordingPort()
    dispatch(manager, port, {
      type: 'worker.interrupt',
      sessionId: 'P',
      payload: {},
    })

    // Both of P's background sub-agents are STOPPED (terminal record kept
    // readable via the drawer / TaskOutput); Q's sub-agent keeps running.
    expect(manager.getSubAgentSnapshot(a)?.status).toBe('stopped')
    expect(manager.getSubAgentSnapshot(b)?.status).toBe('stopped')
    expect(hasLiveTask(manager, a)).toBe(false)
    expect(hasLiveTask(manager, b)).toBe(false)
    expect(manager.getSubAgentSnapshot(other)?.status).toBe('running')
    expect(hasLiveTask(manager, other)).toBe(true)
  })

  it('task.resume on a finished sub-agent re-launches it and acks { ok: true }', async () => {
    const emits: Array<(m: AgentWorkerOutboundMessage) => void> = []
    const workers: ReturnType<typeof makeFakeWorker>[] = []
    const createWorker = (o: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle => {
      const w = makeFakeWorker({ submitBlocks: true })
      emits.push(o.emit)
      workers.push(w)
      return w.worker
    }
    const manager = new SharedWorkerSessionManager({ createWorker })
    ;(manager as unknown as ManagerInternals).lastInitTemplate = { cwd: '/x' }
    seedParentSession(manager, 'P', makeFakeWorker().worker, false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
    })!
    // Finish run 1 → now resumable.
    emits[0]!({
      type: 'worker.completed',
      payload: {},
    } as unknown as AgentWorkerOutboundMessage)
    await settleSubmit(workers[0]!)
    expect(hasLiveTask(manager, sid)).toBe(false)

    const { port, sent } = makeRecordingPort()
    dispatch(manager, port, {
      type: 'task.resume',
      sessionId: sid,
      prompt: 'keep going',
      requestId: 'r3',
    })
    expect(ackOf(sent, 'task.resumed')?.payload).toMatchObject({
      sessionId: sid,
      ok: true,
      requestId: 'r3',
    })
    // Re-launched: the run is live again (a new worker was created).
    expect(hasLiveTask(manager, sid)).toBe(true)
    expect(emits.length).toBe(2)
  })

  it('task.resume on a still-running id acks { ok: false, reason: "still_running" }', () => {
    const manager = makeManager()
    seedParentSession(manager, 'P', makeFakeWorker().worker, false)
    const sid = manager.spawnSubAgentSession({
      spawnerSessionId: 'P',
      prompt: 'p',
      description: 'task',
    })!
    const { port, sent } = makeRecordingPort()
    dispatch(manager, port, {
      type: 'task.resume',
      sessionId: sid,
      prompt: 'x',
      requestId: 'r4',
    })
    expect(ackOf(sent, 'task.resumed')?.payload).toMatchObject({
      sessionId: sid,
      ok: false,
      reason: 'still_running',
      requestId: 'r4',
    })
    // Still running → no relaunch.
    expect(hasLiveTask(manager, sid)).toBe(true)
  })

  it('task.transcript replies with an ack (entries null when storage is down)', async () => {
    const manager = makeManager()
    const { port, sent } = makeRecordingPort()
    dispatch(manager, port, {
      type: 'task.transcript',
      sessionId: 'subagent-x',
      requestId: 'r5',
    })
    await new Promise<void>((r) => setTimeout(r, 0)) // the handler replies async
    expect(ackOf(sent, 'task.transcript')?.payload).toMatchObject({
      sessionId: 'subagent-x',
      requestId: 'r5',
      entries: null,
    })
  })

  it('loadSubAgentTranscript projects user/assistant text + tool names, skipping meta + tool-result-only turns', async () => {
    const manager = makeManager()
    ;(
      manager as unknown as {
        storageCoordinator: {
          storage: { load: (id: string) => Promise<unknown> }
        }
      }
    ).storageCoordinator.storage = {
      load: async () => [
        { type: '__session_meta', sessionId: 's' },
        { type: 'user', message: { content: [{ type: 'text', text: 'do the thing' }] } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'working on it' },
              { type: 'tool_use', name: 'Grep', input: {} },
            ],
          },
        },
        // tool-result-only user turn → no text, no tool_use → skipped.
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      ],
    }
    const entries = await manager.loadSubAgentTranscript('subagent-x')
    expect(entries).toEqual([
      { role: 'user', text: 'do the thing', tools: [] },
      { role: 'assistant', text: 'working on it', tools: ['Grep'] },
      { role: 'assistant', text: 'done', tools: [] },
    ])
  })

  it('loadSubAgentTranscript projects the LIVE stream for a RUNNING sub-agent (storage lags mid-run)', async () => {
    const manager = makeManager()
    // Mid-run the worker hasn't flushed to disk, so storage.load returns null.
    // Pre-fix loadSubAgentTranscript read ONLY storage → null → the detail view
    // showed "No messages to show" while the sub-agent was visibly working.
    ;(
      manager as unknown as {
        storageCoordinator: {
          storage: { load: (id: string) => Promise<unknown> }
        }
      }
    ).storageCoordinator.storage = { load: async () => null }
    // The running sub-agent's `worker.stream` events accumulate in run.messages.
    ;(manager as unknown as ManagerInternals).taskRegistry.registerLive('subagent-live', {
      type: 'local_agent',
      spawnerSessionId: 'P',
      sessionId: 'subagent-live',
      agentId: 'live',
      description: 'explore',
      prompt: 'go',
      messages: [
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'investigate X' }] },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'starting' },
              { type: 'tool_use', name: 'Grep', input: {} },
            ],
          },
        },
      ],
      completed: false,
      depth: 0,
      startedAt: 1,
      lastActivityAt: 2,
    })
    const entries = await manager.loadSubAgentTranscript('subagent-live')
    expect(entries).toEqual([
      { role: 'user', text: 'investigate X', tools: [] },
      { role: 'assistant', text: 'starting', tools: ['Grep'] },
    ])
  })

  it('loadSubAgentTranscript surfaces CANONICAL tool-call turns from the LIVE stream (tool-only turn kept; stream_event skipped)', async () => {
    const manager = makeManager()
    ;(
      manager as unknown as {
        storageCoordinator: {
          storage: { load: (id: string) => Promise<unknown> }
        }
      }
    ).storageCoordinator.storage = { load: async () => null }
    // Real production live stream: complete assistant turns carry the CANONICAL
    // Vercel block shape ({ type:'tool-call', toolName }) — NOT the legacy
    // 'tool_use'/'name' the other tests fabricate. A tool-ONLY turn (no text)
    // was the case the projector silently dropped, collapsing a 141-turn Explore
    // run to just its intro + final text. run.messages also interleaves raw
    // 'stream_event' delta envelopes, which must be skipped (already represented
    // by the complete assistant Message — folding them would double-render).
    ;(manager as unknown as ManagerInternals).taskRegistry.registerLive('subagent-canon', {
      type: 'local_agent',
      spawnerSessionId: 'P',
      sessionId: 'subagent-canon',
      agentId: 'canon',
      description: 'explore',
      prompt: 'go',
      messages: [
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'investigate X' }] },
        },
        // Canonical tool-call-ONLY assistant turn — dropped pre-fix.
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'Grep', args: {} }],
          },
        },
        // Raw partial stream delta — must be skipped, not folded in.
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'foo' } },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      ],
      completed: false,
      depth: 0,
      startedAt: 1,
      lastActivityAt: 2,
    })
    const entries = await manager.loadSubAgentTranscript('subagent-canon')
    expect(entries).toEqual([
      { role: 'user', text: 'investigate X', tools: [] },
      { role: 'assistant', text: '', tools: ['Grep'] },
      { role: 'assistant', text: 'done', tools: [] },
    ])
  })

  it('loadSubAgentInfo returns model/task/summary for a RUNNING run and a FINISHED record', () => {
    const manager = makeManager()
    const internals = manager as unknown as ManagerInternals & {
      finishedTasks: Map<string, unknown>
    }
    // RUNNING: info comes from the live run — effectiveModel + prompt + the
    // partial summary extracted from the live stream (the detail panel's header).
    internals.taskRegistry.registerLive('subagent-run', {
      type: 'local_agent',
      spawnerSessionId: 'P',
      sessionId: 'subagent-run',
      agentId: 'run',
      description: 'probe',
      prompt: 'investigate the thing',
      effectiveModel: 'gpt-5.5',
      messages: [
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial so far' }] },
        },
      ],
      completed: false,
      depth: 0,
      startedAt: 1,
      lastActivityAt: 2,
    })
    expect(manager.loadSubAgentInfo('subagent-run')).toEqual({
      type: 'local_agent',
      model: 'gpt-5.5',
      task: 'investigate the thing',
      summary: 'partial so far',
    })
    // FINISHED: info comes from the retained record (prompt + effectiveModel +
    // final summary persisted at finalize/stop — without that persistence the
    // task line would be blank for a reaped run).
    internals.taskRegistry.recordFinished('subagent-fin', {
      type: 'local_agent',
      sessionId: 'subagent-fin',
      agentId: 'fin',
      spawnerSessionId: 'P',
      description: 'probe',
      status: 'success',
      summary: 'the final answer',
      prompt: 'investigate the thing',
      effectiveModel: 'claude-opus-4-8',
      startedAt: 1,
      finishedAt: 2,
      depth: 0,
    })
    expect(manager.loadSubAgentInfo('subagent-fin')).toEqual({
      type: 'local_agent',
      model: 'claude-opus-4-8',
      task: 'investigate the thing',
      summary: 'the final answer',
    })
    // Unknown id → null (a best-effort header).
    expect(manager.loadSubAgentInfo('subagent-nope')).toBeNull()
  })
})
