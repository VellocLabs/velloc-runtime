import { afterEach, describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  activateSkills,
  isSkillDeferred,
  registerDeferrableSkills,
  shouldHideToolFromModel,
} from '../toolkit/run/deferredTools'
import {
  AGENT_TEAMS_HOSTED_SKILL,
  AGENT_TEAMS_SKILL_NAME,
  AGENT_TEAMS_TOOL_NAMES,
} from '../toolkit/builtin/team/agentTeamsSkill'
import {
  TeamOpenTool,
  BoardAddTool,
  MailTool,
  ShutdownTool,
} from '../toolkit/builtin/teamTools'

afterEach(() => {
  registerDeferrableSkills([]) // resets unit defaults + group-tool map
})

function appState(overrides: Partial<WorkingState> = {}): WorkingState {
  return { permissionRules: { mode: 'default' }, ...overrides } as WorkingState
}

// A tool the gate can evaluate — `name` is required (group-tool matching).
function t(skill: string | undefined, name = 'TeamCreate'): { name: string; skill?: string } {
  return { name, skill }
}

describe('agent-teams gating (per-skill model)', () => {
  it('the team tools all carry skill: "agent-teams"', () => {
    for (const tool of [TeamOpenTool, BoardAddTool, MailTool, ShutdownTool]) {
      expect(tool.skill).toBe(AGENT_TEAMS_SKILL_NAME)
    }
  })

  it('the skill bundles the 7 team tools and is deferrable', () => {
    // No per-skill `default` marker anymore — whether agent-teams defers lives
    // SOLELY in the session template's `deferredTools`.
    expect(AGENT_TEAMS_HOSTED_SKILL.toolNames).toEqual([...AGENT_TEAMS_TOOL_NAMES])
    expect(AGENT_TEAMS_TOOL_NAMES).toContain('TeamCreate')
    expect(AGENT_TEAMS_TOOL_NAMES).toContain('SendMessage')
    expect(AGENT_TEAMS_TOOL_NAMES).not.toContain('Agent') // Agent stays always-on
  })

  it('the skill body runs the team workflow on the IMPLICIT team — no TeamCreate step, no `team` args', () => {
    const body = AGENT_TEAMS_HOSTED_SKILL.instructions
    expect(body).toContain('Your team already exists')
    expect(body).not.toContain('**Create the team**')
    expect(body).toContain('TaskCreate({ subject, description })')
    expect(body).toContain('TaskUpdate({ task_id, owner })')
    expect(body).not.toContain('TaskCreate({ team,')
    expect(body).toContain('BEFORE spawning')
    expect(body).toContain('lowest id first')
  })

  it('says the spawn `cwd` is fixed for the teammate’s life, and that SendMessage cannot move one', () => {
    // A lead localized its bug to a SECOND repository mid-flight,
    // prepared a worktree there, and SendMessage’d its teammate to "switch
    // to" it. Every call the teammate made was refused as outside its root and
    // the lead shut it down. Nothing said a teammate is bound to one tree for
    // life, while step 5 offered SendMessage as the way to re-brief it.
    const body = AGENT_TEAMS_HOSTED_SKILL.instructions
    expect(body).toContain('FIXED for that teammate')
    expect(body).toContain('there is no re-rooting')
    expect(body).toContain('it cannot move one to another directory')
  })

  it('is HIDDEN when the template defers it (registered defaultDeferred:true)', () => {
    registerDeferrableSkills([{ name: AGENT_TEAMS_SKILL_NAME, defaultDeferred: true }])
    expect(isSkillDeferred(AGENT_TEAMS_SKILL_NAME)).toBe(true)
    expect(shouldHideToolFromModel(t(AGENT_TEAMS_SKILL_NAME), appState())).toBe(true)
  })

  it('becomes visible once the agent-teams skill is activated', () => {
    registerDeferrableSkills([{ name: AGENT_TEAMS_SKILL_NAME, defaultDeferred: true }])
    const tool = t(AGENT_TEAMS_SKILL_NAME)
    let state = appState()
    expect(shouldHideToolFromModel(tool, state)).toBe(true)
    activateSkills((f) => {
      state = f(state)
    }, [AGENT_TEAMS_SKILL_NAME])
    expect(shouldHideToolFromModel(tool, state)).toBe(false)
  })

  it('a unit registered defaultDeferred:false is visible (loaded, still activatable)', () => {
    // The template DIDN'T list it in deferredTools → loaded by default. (No
    // override switch exists anymore — the template is the sole source.)
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: false }])
    expect(isSkillDeferred('browser')).toBe(false)
    expect(shouldHideToolFromModel(t('browser', 'BrowserClick'), appState())).toBe(false)
  })

  it('a tool with no skill, or an unregistered skill, is never hidden', () => {
    registerDeferrableSkills([{ name: AGENT_TEAMS_SKILL_NAME, defaultDeferred: true }])
    expect(shouldHideToolFromModel(t(undefined, 'Read'), appState())).toBe(false)
    expect(shouldHideToolFromModel(t('unknown', 'Foo'), appState())).toBe(false)
  })

  it('a deferred GROUP unit hides its tools by name (no tool.skill needed)', () => {
    // The unified model: a tool GROUP listed in deferredTools defers its tools,
    // which have NO skill — gated by name via the unit's `toolNames`.
    registerDeferrableSkills([
      { name: 'shell', defaultDeferred: true, toolNames: ['Bash', 'PowerShell'] },
    ])
    expect(shouldHideToolFromModel(t(undefined, 'Bash'), appState())).toBe(true)
    expect(shouldHideToolFromModel(t(undefined, 'Read'), appState())).toBe(false) // not in the group
    // Activating the group surfaces its tools.
    let state = appState()
    activateSkills((f) => {
      state = f(state)
    }, ['shell'])
    expect(shouldHideToolFromModel(t(undefined, 'Bash'), state)).toBe(false)
  })
})
