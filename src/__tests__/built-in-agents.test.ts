import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILT_IN_AGENTS,
  READONLY_SEARCH_AGENT,
  DEFAULT_WORKER_AGENT,
  PLAN_AGENT,
  resolveSubagentRoute,
  withBuiltInAgents,
} from '../agents/builtInAgents'
import type { AgentDefinitionFull } from '../agents/agentRegistry'
import { SpawnAgentTool } from '../toolkit/builtin/subagentLaunch'
import { filterSubAgentTools } from '../agents/subAgentToolScope'
import {
  CHILD_AGENT_DENYLIST,
  getAllAgentDisallowedTools,
} from '../toolkit/builtin/toolGroups'
import { setInternalUser } from '../utils/internalUser'

const READ_ONLY_DENY = ['Agent', 'ExitPlanMode', 'Edit', 'Write', 'NotebookEdit']

describe('filterSubAgentTools — CHILD_AGENT_DENYLIST strip', () => {
  const t = (name: string) => ({ name })
  const SET = [
    t('Read'),
    t('Write'),
    t('EnterPlanMode'),
    t('ExitPlanMode'),
    t('Agent'),
    t('AskUserQuestion'),
    t('TaskOutput'),
    t('TaskStop'),
    t('AgentResume'),
    t('AgentList'),
    t('TodoWrite'),
  ]
  const names = (ts: { name: string }[]) => ts.map(x => x.name)

  // Default mode is EXTERNAL (internalUser=false); tests that exercise the
  // internal-build behavior flip the flag and MUST restore it.
  afterEach(() => setInternalUser(false))

  it('names the subagent exclusion set: plan tools + AskUserQuestion + task-control tools', () => {
    expect(CHILD_AGENT_DENYLIST).toContain('EnterPlanMode')
    expect(CHILD_AGENT_DENYLIST).toContain('ExitPlanMode')
    expect(CHILD_AGENT_DENYLIST).toContain('AskUserQuestion')
    expect(CHILD_AGENT_DENYLIST).toContain('TaskOutput')
    expect(CHILD_AGENT_DENYLIST).toContain('TaskStop')
    // The rest of the task-control family.
    expect(CHILD_AGENT_DENYLIST).toContain('AgentResume')
    expect(CHILD_AGENT_DENYLIST).toContain('AgentList')
    // Deliberately KEPT for subagents: TodoWrite (async agents included).
    // `Agent` is absent from the CONST (the unconditional
    // core) — its strip is MODE-GATED via getAllAgentDisallowedTools().
    expect(CHILD_AGENT_DENYLIST).not.toContain('TodoWrite')
    expect(CHILD_AGENT_DENYLIST).not.toContain('Agent')
  })

  it('getAllAgentDisallowedTools: EXTERNAL (default) adds Agent; INTERNAL matches the const', () => {
    // `Agent` is in the set unless internal-user mode is on. External is the
    // default audience.
    expect(getAllAgentDisallowedTools()).toContain('Agent')
    setInternalUser(true)
    expect(getAllAgentDisallowedTools()).not.toContain('Agent')
    expect(getAllAgentDisallowedTools()).toEqual(CHILD_AGENT_DENYLIST)
  })

  it('strips the main-thread-only tools from a no-scope agent (general-purpose / custom with no lists) — external default also strips Agent', () => {
    // This is the leak the previous "both empty → return unchanged" shortcut allowed.
    // Agent is stripped too: external mode allows no sub-agent nesting.
    expect(names(filterSubAgentTools(SET, undefined, undefined))).toEqual([
      'Read',
      'Write',
      'TodoWrite',
    ])
  })

  it('internal-user mode keeps Agent in a no-scope agent pool (nesting allowed)', () => {
    setInternalUser(true)
    expect(names(filterSubAgentTools(SET, undefined, undefined))).toEqual([
      'Read',
      'Write',
      'Agent',
      'TodoWrite',
    ])
  })

  it('the mode is read LAZILY — a /debug internal flip changes the very next filter call', () => {
    // Guards against re-introducing a module-init capture of the disallow set:
    // the same filter call site must see both behaviors across a flip.
    expect(names(filterSubAgentTools(SET, undefined, undefined))).not.toContain('Agent')
    setInternalUser(true)
    expect(names(filterSubAgentTools(SET, undefined, undefined))).toContain('Agent')
    setInternalUser(false)
    expect(names(filterSubAgentTools(SET, undefined, undefined))).not.toContain('Agent')
  })

  it('strips a disallowed tool even when the agent explicitly allowlists it', () => {
    expect(
      names(
        filterSubAgentTools(SET, ['ExitPlanMode', 'AskUserQuestion', 'TaskOutput', 'Read'], undefined),
      ),
    ).toEqual(['Read'])
  })

  it('an allowlist naming TaskOutput by its retired BashOutput ALIAS cannot re-admit it', () => {
    // toolMatchesName matches aliases, so the allowlist entry 'BashOutput' DOES
    // select the TaskOutput tool — but the unconditional strip runs first and
    // still removes it. Guards against alias-based re-admission.
    const withAlias = [
      { name: 'Read' },
      { name: 'TaskOutput', aliases: ['BashOutput'] },
    ]
    expect(
      names(filterSubAgentTools(withAlias, ['BashOutput', 'Read'], undefined)),
    ).toEqual(['Read'])
  })

  it('applies the allowlist / denylist alongside the unconditional strip', () => {
    expect(names(filterSubAgentTools(SET, undefined, ['Write']))).toEqual([
      'Read',
      'TodoWrite',
    ])
  })
})

describe('BUILT_IN_AGENTS', () => {
  it('ships Explore, Plan, and general-purpose', () => {
    expect(BUILT_IN_AGENTS.map(a => a.name)).toEqual([
      'Explore',
      'Plan',
      'general-purpose',
    ])
  })

  it('marks every built-in with source "built-in" and a system prompt', () => {
    for (const agent of BUILT_IN_AGENTS) {
      expect(agent.source).toBe('built-in')
      expect(agent.systemPrompt.length).toBeGreaterThan(0)
    }
  })

  it('gives the read-only agents a denylist and no allowlist', () => {
    for (const agent of [READONLY_SEARCH_AGENT, PLAN_AGENT]) {
      expect(agent.disallowedTools).toEqual(READ_ONLY_DENY)
      // No allowlist — they inherit the dynamic tool set minus the denylist.
      expect(agent.tools).toBeUndefined()
    }
  })

  it('leaves general-purpose unrestricted (no allowlist, no denylist)', () => {
    expect(DEFAULT_WORKER_AGENT.tools).toBeUndefined()
    expect(DEFAULT_WORKER_AGENT.disallowedTools).toBeUndefined()
  })

  it('omits a model override so forks inherit the parent model', () => {
    for (const agent of BUILT_IN_AGENTS) {
      expect(agent.model).toBeUndefined()
    }
  })
})

describe('withBuiltInAgents', () => {
  it('appends the built-ins when no custom agents are supplied', () => {
    expect(withBuiltInAgents(undefined).map(a => a.name)).toEqual([
      'Explore',
      'Plan',
      'general-purpose',
    ])
    expect(withBuiltInAgents([]).map(a => a.name)).toEqual([
      'Explore',
      'Plan',
      'general-purpose',
    ])
  })

  it('keeps custom agents and adds the built-ins after them', () => {
    const custom: AgentDefinitionFull = {
      name: 'reviewer',
      description: 'Reviews code',
      systemPrompt: 'Review.',
      source: 'plugin',
    }
    const names = withBuiltInAgents([custom]).map(a => a.name)
    expect(names).toEqual(['reviewer', 'Explore', 'Plan', 'general-purpose'])
  })

  it('lets a custom agent override a built-in of the same name (first wins)', () => {
    const customExplore: AgentDefinitionFull = {
      name: 'Explore',
      description: 'Custom explore',
      systemPrompt: 'Custom.',
      source: 'user',
    }
    const merged = withBuiltInAgents([customExplore])
    const explore = merged.find(a => a.name === 'Explore') as AgentDefinitionFull
    expect(explore.source).toBe('user')
    expect(explore.systemPrompt).toBe('Custom.')
    // Still exactly one Explore, and the other built-ins remain.
    expect(merged.filter(a => a.name === 'Explore')).toHaveLength(1)
    expect(merged.map(a => a.name)).toContain('Plan')
    expect(merged.map(a => a.name)).toContain('general-purpose')
  })

  it('reserves the name "fork" — a custom agent named fork is dropped', () => {
    const customFork: AgentDefinitionFull = {
      name: 'fork',
      description: 'tries to claim the reserved fork name',
      systemPrompt: 'should never be selectable',
      source: 'user',
    }
    const merged = withBuiltInAgents([customFork])
    expect(merged.find(a => a.name === 'fork')).toBeUndefined()
    // The built-ins are untouched.
    expect(merged.map(a => a.name)).toEqual([
      'Explore',
      'Plan',
      'general-purpose',
    ])
  })
})

describe('resolveSubagentRoute', () => {
  const explore: AgentDefinitionFull = {
    name: 'Explore',
    description: 'explorer',
    systemPrompt: 'explore',
    source: 'built-in',
  }

  it('Case 1: omitted → the general-purpose agent (built-in fallback on empty activeAgents)', () => {
    const route = resolveSubagentRoute(undefined, [])
    expect(route.kind).toBe('named')
    if (route.kind === 'named') expect(route.agent.name).toBe('general-purpose')
  })

  it('Case 2: an explicit name → that named agent', () => {
    const route = resolveSubagentRoute('Explore', [explore])
    expect(route.kind).toBe('named')
    if (route.kind === 'named') expect(route.agent.name).toBe('Explore')
  })

  it('Case 3: "fork" → the fork route (always — no gate)', () => {
    expect(resolveSubagentRoute('fork', []).kind).toBe('fork')
    expect(resolveSubagentRoute('fork', [explore]).kind).toBe('fork')
  })

  it('Case 4: "fork" at depth ≥ 1 → error (fork-inside-fork nesting guard)', () => {
    const route = resolveSubagentRoute('fork', [], { depth: 1 })
    expect(route.kind).toBe('error')
    if (route.kind === 'error') {
      expect(route.message).toMatch(/inside a forked sub-agent/i)
    }
  })

  it('Case 4b: "fork" at depth 0 / undefined → allowed (a top-level fork is NOT nested)', () => {
    // SpawnAgentTool feeds queryTracking.depth here. A top-level query keeps depth 0
    // across ALL turns (engine/turnLoop.ts computes it once per query() now, not per
    // turn), so a `fork` requested on any turn — not just turn 1 — must route to
    // fork, never FORK_NESTED_ERROR. Guards the route contract; the load-bearing
    // per-turn regression lives in query-prompt-context-refresh.test.ts.
    expect(resolveSubagentRoute('fork', [], { depth: 0 }).kind).toBe('fork')
    expect(resolveSubagentRoute('fork', [], {}).kind).toBe('fork')
    expect(resolveSubagentRoute('fork', []).kind).toBe('fork')
  })

  it('Case 5: a custom agent named "fork" never shadows the fork route', () => {
    const sneaky: AgentDefinitionFull = {
      name: 'fork',
      description: 'x',
      systemPrompt: 'x',
      source: 'user',
    }
    // The route intercepts "fork" BEFORE the named lookup → still the fork path.
    expect(resolveSubagentRoute('fork', [sneaky]).kind).toBe('fork')
  })

  it('unknown subagent_type → error, with "fork" excluded from the available list', () => {
    const route = resolveSubagentRoute('Nope', [explore])
    expect(route.kind).toBe('error')
    if (route.kind === 'error') {
      expect(route.message).toMatch(/unknown subagent_type "Nope"/i)
      expect(route.message).toContain('Explore')
      expect(route.message).not.toContain('fork')
    }
  })
})

describe('SpawnAgentTool.description advertises available agents', () => {
  async function describeWith(agents: AgentDefinitionFull[]): Promise<string> {
    return SpawnAgentTool.description({} as never, {
      isNonInteractiveSession: true,
      permissionRules: { mode: 'default' } as never,
      tools: [],
      agents,
    })
  }

  it('renders each agent as a "- name: description (Tools: ...)" line', async () => {
    const desc = await describeWith(BUILT_IN_AGENTS)
    expect(desc).toContain('Available agent types')
    // Denylist agents render as "All tools except ...".
    expect(desc).toContain(
      '- Explore: Read-only scout for a codebase:',
    )
    expect(desc).toContain(
      '(Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)',
    )
    // Unrestricted agent renders as "All tools".
    expect(desc).toContain('- general-purpose:')
    expect(desc).toContain('(Tools: All tools)')
  })

  it('renders an allowlist agent as the explicit tool list', async () => {
    const desc = await describeWith([
      {
        name: 'reviewer',
        description: 'Reviews code',
        systemPrompt: 'Review.',
        tools: ['Read', 'Grep'],
        source: 'plugin',
      },
    ])
    expect(desc).toContain('- reviewer: Reviews code (Tools: Read, Grep)')
  })

  it('omits the agent-list section when there are no agents', async () => {
    const desc = await describeWith([])
    expect(desc).not.toContain('Available agent types')
    // The static guidance is still present.
    expect(desc).toContain('subagent_type')
  })
})
