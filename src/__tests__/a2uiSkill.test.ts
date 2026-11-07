import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { A2UI_HOSTED_SKILL, A2UI_INSTRUCTIONS } from '../toolkit/builtin/a2ui/a2uiSkill'
import { A2UI_SKILL_NAME } from '../toolkit/builtin/a2ui/a2uiToolNames'
import { allBundledTools } from '../toolkit/toolRegistry'

const expressPrompt = readFileSync(
  resolve(__dirname, '../toolkit/builtin/a2ui/prompts/a2ui-express.md'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('a2ui skill', () => {
  it('is a hosted skill with no tools', () => {
    expect(A2UI_HOSTED_SKILL.name).toBe(A2UI_SKILL_NAME)
    expect(A2UI_HOSTED_SKILL.toolNames).toEqual([])
    expect(A2UI_HOSTED_SKILL.description).toContain('<a2ui>')
  })

  it('teaches the playbook first, then the generated Express contract', () => {
    expect(A2UI_HOSTED_SKILL.instructions).toBe(A2UI_INSTRUCTIONS)
    expect(A2UI_INSTRUCTIONS.indexOf('How Velloc reads a block')).toBeGreaterThan(-1)
    expect(A2UI_INSTRUCTIONS.indexOf('How Velloc reads a block')).toBeLessThan(
      A2UI_INSTRUCTIONS.indexOf('A2UI Express DSL Output Contract'),
    )
    expect(A2UI_INSTRUCTIONS.endsWith(expressPrompt.trimEnd())).toBe(true)
  })

  it('no longer offers the a2ui_* command tools', () => {
    for (const preset of ['default', 'nexus', 'glic'] as const) {
      expect(allBundledTools(preset).some(tool => tool.name.startsWith('a2ui_'))).toBe(false)
    }
  })
})
