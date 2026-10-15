import { describe, expect, it } from 'vitest'
import { renderSkillListing, skillListingBudgetChars } from '../skillLibrary/skillListing'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import { A2UI_HOSTED_SKILL } from '../toolkit/builtin/a2ui/a2uiSkill'
import { BROWSER_HOSTED_SKILL } from '../toolkit/builtin/host'
import { AGENT_TEAMS_HOSTED_SKILL } from '../toolkit/builtin/team/agentTeamsSkill'

function cmd(
  name: string,
  description: string,
  extra: Partial<ChromiumCommandMetadata> = {},
): ChromiumCommandMetadata {
  return { name, description, source: 'project', ...extra } as ChromiumCommandMetadata
}

describe('skill listing budget', () => {
  it('derives the character budget from the context window', () => {
    expect(skillListingBudgetChars()).toBe(8000)
    expect(skillListingBudgetChars(0)).toBe(8000)
    expect(skillListingBudgetChars(-5)).toBe(8000)
    expect(skillListingBudgetChars(75_000)).toBe(3000)
    expect(skillListingBudgetChars(199_999)).toBe(7999)
  })

  it('joins useWhen after the description', () => {
    expect(renderSkillListing([cmd('a', 'D', { useWhen: 'W' })])).toBe(
      '- a: D When to use: W',
    )
  })

  it('caps details at 250 characters, ellipsis only past the cap', () => {
    const exact = renderSkillListing([cmd('x', 'a'.repeat(250))])
    expect(exact).toBe('- x: ' + 'a'.repeat(250))
    const over = renderSkillListing([cmd('x', 'a'.repeat(251))])
    expect(over.length).toBe('- x: '.length + 250)
    expect(over.endsWith('…')).toBe(true)
  })

  it('shows each built-in hosted skill description whole (agent-teams sits exactly at the cap)', () => {
    for (const skill of [AGENT_TEAMS_HOSTED_SKILL, A2UI_HOSTED_SKILL, BROWSER_HOSTED_SKILL]) {
      const description = skill.description.trim()
      expect(description.length, skill.name).toBeLessThanOrEqual(250)
      expect(renderSkillListing([cmd(skill.name, description)])).toBe(`- ${skill.name}: ${description}`)
    }
  })

  it('returns a listing whose length equals the budget unchanged', () => {
    // budget 40 at 1000 tokens; two lines of 19 + newline = 39, then 40
    const a = cmd('a', 'x'.repeat(14)) // "- a: " + 14 = 19
    const b = cmd('b', 'y'.repeat(15)) // 20
    const out = renderSkillListing([a, b], 1000)
    expect(out.length).toBe(40)
    expect(out).toBe(`- a: ${'x'.repeat(14)}\n- b: ${'y'.repeat(15)}`)
  })

  it('keeps every line full when all skills are bundled', () => {
    const list = [1, 2, 3].map(i => cmd(`b${i}`, 'z'.repeat(200), { source: 'bundled' }))
    const out = renderSkillListing(list, 1000)
    expect(out.split('\n')).toEqual(list.map(c => `- ${c.name}: ${'z'.repeat(200)}`))
  })

  it('keeps input order with bundled interleaved, names-only mode', () => {
    const list = [
      cmd('p1', 'q'.repeat(200)),
      cmd('b1', 'short', { source: 'bundled' }),
      cmd('p2', 'q'.repeat(200)),
    ]
    expect(renderSkillListing(list, 1000)).toBe('- p1\n- b1: short\n- p2')
  })

  it('keeps input order with bundled interleaved, trimmed mode', () => {
    const list = [
      cmd('p1', 'q'.repeat(200)),
      cmd('b1', 'short', { source: 'bundled' }),
      cmd('p2', 'q'.repeat(200)),
    ]
    const out = renderSkillListing(list, 5000) // budget 200
    const lines = out.split('\n')
    expect(lines[1]).toBe('- b1: short')
    expect(lines[0].startsWith('- p1: ')).toBe(true)
    expect(lines[2].startsWith('- p2: ')).toBe(true)
    expect(lines[0].endsWith('…')).toBe(true)
  })

  it('switches between trimmed and names-only at 20 per-entry characters', () => {
    // one bundled "- b: x" (6+1=7); two rest names of length 1 → overhead 5+5+1 = 11
    // perEntry = floor((budget - 7 - 11) / 2)
    const list = [
      cmd('b', 'x', { source: 'bundled' }),
      cmd('p', 'q'.repeat(100)),
      cmd('r', 'q'.repeat(100)),
    ]
    // budget 58 → perEntry 20 (tokens 1450 → 58)
    const at20 = renderSkillListing(list, 1450).split('\n')
    expect(at20[0]).toBe('- b: x')
    expect(at20[1]).toBe('- p: ' + 'q'.repeat(19) + '…')
    expect(at20[2]).toBe('- r: ' + 'q'.repeat(19) + '…')
    // budget 56 → perEntry 19 (tokens 1400 → 56)
    expect(renderSkillListing(list, 1400)).toBe('- b: x\n- p\n- r')
  })

  it('lists other skills by name when bundled lines exceed the budget', () => {
    const list = [
      cmd('b', 'z'.repeat(200), { source: 'bundled' }),
      cmd('p', 'q'.repeat(50)),
    ]
    expect(renderSkillListing(list, 1000)).toBe(`- b: ${'z'.repeat(200)}\n- p`)
  })
})
