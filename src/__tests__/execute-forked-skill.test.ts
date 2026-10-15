import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as forkedAgentModule from '../agents/forkedRun'
import { rememberForkPrefix } from '../agents/forkedRun'
import { runSkillInFork } from '../skillLibrary/executeForkedSkill'
import { DEFAULT_WORKER_AGENT } from '../agents/builtInAgents'
import { setActiveSidechainStore } from '../utils/sidechainTranscripts'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALLOW = (async () => ({ behavior: 'allow' as const, updatedInput: {} })) as any

function makeCommand(
  over: Partial<ChromiumPromptCommand> = {},
): ChromiumPromptCommand {
  return {
    type: 'prompt',
    name: 'forky',
    description: 'A forked skill',
    content: 'fork body',
    path: '/skills/forky/SKILL.md',
    loadedFrom: 'skills',
    source: 'project',
    context: 'fork',
    ...over,
  }
}

function makeContext(activeAgents: unknown[]) {
  return {
    options: {
      sessionId: 'sess-fork',
      agentDefinitions: { enabledAgents: activeAgents },
    },
    agentId: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('runSkillInFork — agent defaulting', () => {
  let runForkedAgentSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Minimal cache-safe params so runSkillInFork doesn't bail early.
    rememberForkPrefix({
      toolUseContext: { options: { tools: [], mainLoopModel: 'model-x' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    runForkedAgentSpy = vi.spyOn(forkedAgentModule, 'launchFork')
    runForkedAgentSpy.mockReset()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runForkedAgentSpy.mockResolvedValue({ messages: [], agentId: 'fork-1' } as any)
  })

  it('defaults a no-agent fork to the built-in general-purpose system prompt', async () => {
    // A `context: 'fork'` skill with no `agent:` must run under the
    // general-purpose sub-agent prompt, NOT inherit the parent session's
    // interactive prompt.
    const result = await runSkillInFork({
      command: makeCommand(),
      body: 'expanded body',
      args: undefined,
      context: makeContext([DEFAULT_WORKER_AGENT]),
      canUseTool: ALLOW,
    })

    expect(result).not.toBeNull()
    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
    const arg = runForkedAgentSpy.mock.calls[0]?.[0] as {
      systemPromptOverride?: unknown
    }
    expect(arg.systemPromptOverride).toBe(DEFAULT_WORKER_AGENT.systemPrompt)
  })

  it('resolves a bare `agent:` against the skill\'s plugin namespace', async () => {
    // Regression: a plugin skill names a sibling agent by its BARE name
    // (`agent: reviewer`), but plugin agents register plugin-namespaced
    // (`review-plugin:reviewer`). The fork must resolve within the skill's
    // plugin namespace, else no systemPromptOverride is applied and the fork
    // wrongly inherits the parent prompt (e2e nexus-skill-fork:464).
    const reviewer = {
      name: 'review-plugin:reviewer',
      description: 'reviewer',
      systemPrompt: 'REVIEWER_SYSTEM_PROMPT',
      source: 'plugin',
    }
    const result = await runSkillInFork({
      command: makeCommand({ agent: 'reviewer', pluginName: 'review-plugin' }),
      body: 'expanded body',
      args: undefined,
      context: makeContext([DEFAULT_WORKER_AGENT, reviewer]),
      canUseTool: ALLOW,
    })

    expect(result).not.toBeNull()
    const arg = runForkedAgentSpy.mock.calls[0]?.[0] as {
      systemPromptOverride?: unknown
    }
    expect(arg.systemPromptOverride).toBe('REVIEWER_SYSTEM_PROMPT')
  })

  it('resolves a bare `agent:` to a NESTED plugin sibling (subdirectory agent)', async () => {
    // Regression: plugin agents in subdirectories register with directory
    // namespace segments (`agents/team/reviewer.md` →
    // `review-plugin:team:reviewer`, agentRegistry visitMarkdownFiles). A
    // retry that only tries `<pluginName>:<name>` misses them and the fork
    // silently inherits the parent prompt — same symptom, one level deeper.
    const nested = {
      name: 'review-plugin:team:reviewer',
      description: 'nested reviewer',
      systemPrompt: 'NESTED_REVIEWER_PROMPT',
      source: 'plugin',
    }
    const result = await runSkillInFork({
      command: makeCommand({ agent: 'reviewer', pluginName: 'review-plugin' }),
      body: 'expanded body',
      args: undefined,
      context: makeContext([DEFAULT_WORKER_AGENT, nested]),
      canUseTool: ALLOW,
    })

    expect(result).not.toBeNull()
    const arg = runForkedAgentSpy.mock.calls[0]?.[0] as {
      systemPromptOverride?: unknown
    }
    expect(arg.systemPromptOverride).toBe('NESTED_REVIEWER_PROMPT')
  })

  it('prefers the plugin\'s own sibling over a bare user agent with the same name', async () => {
    // Regression: user/project agents register bare while plugin agents
    // register namespaced. With exact-match-first, a user's unrelated
    // `reviewer` agent (different prompt, potentially wider tool allowlist)
    // silently captured a plugin skill's `agent: reviewer` reference.
    const userReviewer = {
      name: 'reviewer',
      description: 'the user\'s own unrelated reviewer',
      systemPrompt: 'USER_REVIEWER_PROMPT',
      source: 'user',
    }
    const pluginReviewer = {
      name: 'review-plugin:reviewer',
      description: 'the plugin\'s sibling reviewer',
      systemPrompt: 'PLUGIN_REVIEWER_PROMPT',
      source: 'plugin',
    }
    const result = await runSkillInFork({
      command: makeCommand({ agent: 'reviewer', pluginName: 'review-plugin' }),
      body: 'expanded body',
      args: undefined,
      context: makeContext([DEFAULT_WORKER_AGENT, userReviewer, pluginReviewer]),
      canUseTool: ALLOW,
    })

    expect(result).not.toBeNull()
    const arg = runForkedAgentSpy.mock.calls[0]?.[0] as {
      systemPromptOverride?: unknown
    }
    expect(arg.systemPromptOverride).toBe('PLUGIN_REVIEWER_PROMPT')
  })

  it('falls back to general-purpose on an unknown `agent:` reference', async () => {
    // Regression: an unknown reference falls back to the general-purpose
    // agent; inheriting the parent's
    // interactive prompt + FULL tool set instead is an over-privileged fork
    // on a simple frontmatter typo.
    const result = await runSkillInFork({
      command: makeCommand({ agent: 'reviwer-typo' }),
      body: 'expanded body',
      args: undefined,
      context: makeContext([DEFAULT_WORKER_AGENT]),
      canUseTool: ALLOW,
    })

    expect(result).not.toBeNull()
    const arg = runForkedAgentSpy.mock.calls[0]?.[0] as {
      systemPromptOverride?: unknown
    }
    expect(arg.systemPromptOverride).toBe(DEFAULT_WORKER_AGENT.systemPrompt)
  })

  it('a no-agent plugin skill never binds to a plugin agent named "general-purpose"', async () => {
    // Regression: the defaulted `general-purpose` name must NOT ride the
    // plugin-namespace resolution — with the built-in absent, a plugin
    // shipping an agent literally named `general-purpose` would otherwise
    // capture forks from skills that specified no agent at all.
    const impostor = {
      name: 'my-plugin:general-purpose',
      description: 'plugin agent that happens to use the reserved name',
      systemPrompt: 'IMPOSTOR_PROMPT',
      source: 'plugin',
    }
    const result = await runSkillInFork({
      command: makeCommand({ pluginName: 'my-plugin' }),
      body: 'expanded body',
      args: undefined,
      context: makeContext([impostor]),
      canUseTool: ALLOW,
    })

    expect(result).not.toBeNull()
    const arg = runForkedAgentSpy.mock.calls[0]?.[0] as {
      systemPromptOverride?: unknown
    }
    // Built-in absent + no explicit agent → inherit (no override), never the
    // plugin's same-named agent.
    expect(arg.systemPromptOverride).toBeUndefined()
  })

  it('persists the fork through THIS session\'s sidechain store, not the realm slot', async () => {
    // Regression: the fork read the realm-global `getActiveSidechainStore()`,
    // which wraps the fs of whichever runtime booted LAST — another session's
    // (possibly disposed) fs. The caller's own store rides its context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sibling = { tag: 'sibling' } as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const own = { tag: 'own' } as any
    setActiveSidechainStore(sibling)
    try {
      const context = makeContext([DEFAULT_WORKER_AGENT])
      context.options.sidechainStore = own
      await runSkillInFork({
        command: makeCommand(),
        body: 'expanded body',
        context,
        canUseTool: ALLOW,
      })
      const arg = runForkedAgentSpy.mock.calls[0]?.[0] as {
        sidechainStore?: unknown
      }
      expect(arg.sidechainStore).toBe(own)

      // A runtime with no persistence publishes `null` — no fallback to the
      // sibling's store.
      runForkedAgentSpy.mockClear()
      context.options.sidechainStore = null
      await runSkillInFork({
        command: makeCommand(),
        body: 'expanded body',
        context,
        canUseTool: ALLOW,
      })
      const arg2 = runForkedAgentSpy.mock.calls[0]?.[0] as {
        sidechainStore?: unknown
      }
      expect(arg2.sidechainStore).toBeUndefined()
    } finally {
      setActiveSidechainStore(null)
    }
  })

  it('falls back to inline (returns null) when no cache-safe params are captured', async () => {
    rememberForkPrefix(null)
    const result = await runSkillInFork({
      command: makeCommand(),
      body: 'expanded body',
      context: makeContext([DEFAULT_WORKER_AGENT]),
      canUseTool: ALLOW,
    })
    expect(result).toBeNull()
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })
})
