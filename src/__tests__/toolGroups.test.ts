import { describe, expect, it } from 'vitest'
import { TOOL_GROUPS, expandGroups, isToolGroup } from '../toolkit/builtin/toolGroups'
import { JobReadTool } from '../toolkit/builtin/subAgentControlTools'

describe('toolGroups', () => {
  it('expands a group name to its tool wire names', () => {
    expect([...expandGroups(['read'])]).toEqual(['Read', 'Glob', 'Grep'])
    // `BashOutput` is NOT a shell tool: background-shell output is read via the
    // kind-agnostic `TaskOutput`, so it no longer sits here.
    expect([...expandGroups(['shell'])]).toEqual(['Bash', 'PowerShell'])
    expect([...expandGroups(['edit'])]).toEqual(['Write', 'Edit', 'NotebookEdit'])
  })

  it('TaskOutput aliases the retired BashOutput tool for back-compat', () => {
    expect(JobReadTool.aliases).toContain('BashOutput')
  })

  it('keeps an unknown name verbatim (an individual tool name)', () => {
    expect([...expandGroups(['TodoWrite'])]).toEqual(['TodoWrite'])
    // Skill-backed groups are NOT registry groups — passed through verbatim.
    expect([...expandGroups(['browser'])]).toEqual(['browser'])
  })

  it('mixes groups + individual names and de-duplicates', () => {
    // edit ⊇ NotebookEdit; read ⊇ Read — the duplicates collapse.
    expect(expandGroups(['edit', 'NotebookEdit', 'read', 'Read'])).toEqual(
      new Set(['Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep']),
    )
  })

  it('isToolGroup recognizes only registered group names', () => {
    expect(isToolGroup('read')).toBe(true)
    expect(isToolGroup('skills')).toBe(true)
    expect(isToolGroup('Read')).toBe(false) // a tool name, not a group
    expect(isToolGroup('browser')).toBe(false) // skill-backed, not a registry group
  })

  it('every group is non-empty with unique tool names', () => {
    for (const [name, tools] of Object.entries(TOOL_GROUPS)) {
      expect(tools.length, `${name} is empty`).toBeGreaterThan(0)
      expect(new Set(tools).size, `${name} has a duplicate`).toBe(tools.length)
    }
  })

  it('no tool name appears in two groups (groups are disjoint)', () => {
    const seen = new Map<string, string>()
    for (const [group, tools] of Object.entries(TOOL_GROUPS)) {
      for (const tool of tools) {
        expect(
          seen.has(tool),
          `"${tool}" is in both "${seen.get(tool)}" and "${group}"`,
        ).toBe(false)
        seen.set(tool, group)
      }
    }
  })
})
