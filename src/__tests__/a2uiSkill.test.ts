import { describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  A2UI_CATALOG_HOLDER,
  A2UI_HOSTED_SKILL,
  A2UI_SYSTEM_PROMPT_CATALOG,
} from '../toolkit/builtin/a2ui/a2uiSkill'
import { A2UI_SKILL_NAME, A2UI_TOOL_NAMES } from '../toolkit/builtin/a2ui/a2uiToolNames'
import { A2UI_TOOLS } from '../toolkit/builtin/a2ui/A2uiTools'
import {
  registerDeferrableSkills,
  shouldHideToolFromModel,
} from '../toolkit/run/deferredTools'

function appState(activeSkills: string[]): WorkingState {
  return { activeSkills } as unknown as WorkingState
}

describe('a2ui deferred skill', () => {
  it('is a deferred hosted skill bound to the a2ui tools', () => {
    expect(A2UI_HOSTED_SKILL.name).toBe(A2UI_SKILL_NAME)
    // No per-skill `default` marker anymore — whether a2ui defers lives SOLELY
    // in the session template's `deferredTools`.
    expect([...A2UI_HOSTED_SKILL.toolNames].sort()).toEqual([...A2UI_TOOL_NAMES].sort())
    expect(A2UI_HOSTED_SKILL.instructions.length).toBeGreaterThan(0)
    expect(A2UI_HOSTED_SKILL.description.length).toBeGreaterThan(0)
  })

  it('splits prose into 3 positions like the browser skill (catalog → system prompt)', () => {
    // Position 2 — the system-prompt catalog holds the `## A2UI tools`
    // reference (tools + component shape), under a skill.<name>.<role> holder.
    expect(A2UI_CATALOG_HOLDER).toBe('skill.a2ui.catalog')
    expect(A2UI_SYSTEM_PROMPT_CATALOG).toContain('## A2UI tools')
    expect(A2UI_SYSTEM_PROMPT_CATALOG).toContain('a2ui_create_surface')
    expect(A2UI_SYSTEM_PROMPT_CATALOG).toContain('Canonical component shape')
    // Position 3 — `instructions` is the PLAYBOOK only now; the reference moved
    // to the system-prompt catalog, so it must NOT be duplicated here.
    expect(A2UI_HOSTED_SKILL.instructions).toContain('When to USE')
    expect(A2UI_HOSTED_SKILL.instructions).not.toContain('## A2UI tools')
    expect(A2UI_HOSTED_SKILL.instructions).not.toContain('Canonical component shape')
  })

  it('every a2ui tool declares skill: a2ui so the gate matches', () => {
    for (const tool of A2UI_TOOLS) {
      expect(tool.skill).toBe(A2UI_SKILL_NAME)
    }
  })

  it('hides a2ui tools until the skill is active when its switch is on', () => {
    const tool = A2UI_TOOLS[0]!
    try {
      // a2ui switch ON (deferred) + skill not active → hidden
      registerDeferrableSkills([{ name: A2UI_SKILL_NAME, defaultDeferred: true }])
      expect(shouldHideToolFromModel(tool, appState([]))).toBe(true)
      // skill active → visible
      expect(shouldHideToolFromModel(tool, appState([A2UI_SKILL_NAME]))).toBe(false)
      // registered with defaultDeferred:false (template doesn't list a2ui in
      // deferredTools) → never hidden
      registerDeferrableSkills([{ name: A2UI_SKILL_NAME, defaultDeferred: false }])
      expect(shouldHideToolFromModel(tool, appState([]))).toBe(false)
    } finally {
      registerDeferrableSkills([]) // resets unit defaults + group-tool map
    }
  })
})
