import { describe, expect, it } from 'vitest'
import { dropDeniedTools } from '../toolkit/toolContract'
import { emptyPermissionRuleSet } from '../toolkit/permissionVerdict'

const tools = [
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'mcp__github__search', mcpInfo: { serverName: 'github', toolName: 'search' } },
  { name: 'mcp__linear__list', mcpInfo: { serverName: 'linear', toolName: 'list' } },
]
const ctx = (deny: string[]) => ({
  ...emptyPermissionRuleSet(),
  denyRuleBook: { userSettings: deny },
})
const names = (deny: string[]) => dropDeniedTools(tools, ctx(deny)).map(t => t.name)

describe('filterToolsByDenyRules', () => {
  it('keeps every tool when nothing is denied', () => {
    expect(names([])).toEqual(tools.map(t => t.name))
  })
  it('a blanket deny removes the tool from the pool', () => {
    expect(names(['Bash'])).not.toContain('Bash')
    expect(names(['Bash()'])).not.toContain('Bash')
    expect(names(['Bash(*)'])).not.toContain('Bash')
    expect(names(['Bash'])).toContain('Read')
  })
  it('a rule with content only narrows calls, so the tool stays offered', () => {
    expect(names(['Bash(rm:*)'])).toContain('Bash')
  })
  it('mcp__<server> removes that server\'s tools only', () => {
    expect(names(['mcp__github'])).toEqual(['Bash', 'Read', 'mcp__linear__list'])
  })
  it('does not mutate its input', () => {
    const before = [...tools]
    dropDeniedTools(tools, ctx(['Bash']))
    expect(tools).toEqual(before)
  })
})
