// `{{IF_TOOL:<Name>}}` line gates in holder prose, and the step-list section
// (F-41) following the visible tool set: prose naming a tool whose schema the
// loop was not sent is the failure these tests pin.

import { describe, expect, it } from 'vitest'
import type { ToolContract, ToolContractList } from '../toolkit/toolContract'
import { applyToolLineGates, loadSystemPromptHolders } from '../prompting/systemPromptLoader'

describe('applyToolLineGates — {{IF_TOOL:<Name>}} line gate', () => {
  const prose = '# Using your tools\n - keep\n{{IF_TOOL:TodoWrite}} - Use TodoWrite to plan.'

  it('keeps the line, byte for byte minus the marker, when the tool is visible', () => {
    expect(applyToolLineGates(prose, new Set(['TodoWrite']))).toBe(
      '# Using your tools\n - keep\n - Use TodoWrite to plan.',
    )
  })

  it('drops the whole line — and no dangling newline — when it is not', () => {
    expect(applyToolLineGates(prose, new Set(['Read']))).toBe('# Using your tools\n - keep')
  })

  it('drops a mid-section line without leaving a blank one', () => {
    const mid = ' - a\n{{IF_TOOL:TodoWrite}} - todo\n - b\n'
    expect(applyToolLineGates(mid, new Set())).toBe(' - a\n - b\n')
    expect(applyToolLineGates(mid, new Set(['TodoWrite']))).toBe(' - a\n - todo\n - b\n')
  })

  it('handles CRLF prose and leaves ungated text untouched', () => {
    expect(applyToolLineGates(' - a\r\n{{IF_TOOL:X}} - x\r\n - b', new Set())).toBe(' - a\r\n - b')
    const plain = 'no gate here\n'
    expect(applyToolLineGates(plain, new Set())).toBe(plain)
  })
})

describe('loadSystemPromptHolders — the step-list section follows the visible tool set', () => {
  const SET_PLAN = 'mcp__session_turn__set_plan'
  const stub = (name: string) => ({ name }) as unknown as ToolContract
  const TOOLS = [stub('Read'), stub(SET_PLAN)] as unknown as ToolContractList

  const sections = (templateType: string, visibleToolNames: string[]): Promise<string[]> =>
    loadSystemPromptHolders({ tools: TOOLS, visibleToolNames, templateType })

  for (const type of ['code', 'agent', 'team', 'safe_code']) {
    it(`${type}: the section is present when set_plan is visible and gone whole when it is not`, async () => {
      const withTool = await sections(type, ['Read', SET_PLAN])
      const section = withTool.find(part => part.startsWith('# Step list and closing'))
      expect(section, `${type} lists the turn_board holder`).toBeDefined()
      expect(section).toContain(SET_PLAN)
      expect(section).toContain('mcp__session_turn__close')
      expect(withTool.join(' ')).not.toContain('{{IF_TOOL')

      // A loop under the session (a sub-agent) shares the type but not the tools.
      const without = await sections(type, ['Read'])
      expect(without.join(' ')).not.toContain('session_turn')
      expect(without.join(' ')).not.toContain('{{IF_TOOL')
      expect(without.some(part => part.startsWith('# Tools'))).toBe(true)
    })
  }

  it('chat has no step-list section even with the tool visible', async () => {
    const parts = await sections('chat', ['Read', SET_PLAN])
    expect(parts.join(' ')).not.toContain('session_turn')
  })
})
