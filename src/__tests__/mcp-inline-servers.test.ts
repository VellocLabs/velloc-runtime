/**
 * Which MCP servers are offered inline (F-10): a connected server that sent no
 * instructions and whose tool definitions fit the budget has its tools listed
 * from the first request, while all inline servers together fit their own
 * budget; any other server is deferred behind its Skill.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { LiveServerLink, MCPPool, MCPToolDescriptor } from '../mcp'
import {
  MCP_INLINE_SCHEMA_BUDGET_CHARS,
  MCP_INLINE_TOTAL_BUDGET_CHARS,
  buildMCPSkillCommands,
  buildMCPToolsForServer,
  isMcpServerInline,
  mcpServerSchemaChars,
  mcpSessionOffering,
} from '../mcp'
import { resolveDeferrableSkills } from '../prompting/templateRegistry'
import { createEmptyAppState } from '../runtime/testing/noopAdapters'
import { registerDeferrableSkills, shouldHideToolFromModel } from '../toolkit/run/deferredTools'

afterEach(() => {
  registerDeferrableSkills([])
})

function server(name: string, tools: MCPToolDescriptor[], instructions?: string): LiveServerLink {
  return {
    name,
    config: { type: 'http', url: 'http://example.test' },
    status: 'connected',
    tools,
    ...(instructions !== undefined ? { instructions } : {}),
  }
}

function poolWith(...servers: LiveServerLink[]): MCPPool {
  return { listServers: () => servers } as unknown as MCPPool
}

const SEARCH: MCPToolDescriptor = {
  name: 'search',
  description: 'Search the web for current information.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
}

/** One tool whose serialized definition is exactly `chars` long. */
function toolOfSize(name: string, chars: number): MCPToolDescriptor {
  const base = mcpServerSchemaChars({ tools: [{ name, description: '' }] })
  return { name, description: 'x'.repeat(chars - base) }
}

/** Registers a session's deferral units the way the runtime does. */
function registerOffering(pool: MCPPool, deferredTools?: string[]): void {
  const offering = mcpSessionOffering(pool)
  registerDeferrableSkills(
    resolveDeferrableSkills(offering.skillNames, deferredTools ? ({ deferredTools } as never) : undefined),
  )
}

function hidden(pool: MCPPool, target: LiveServerLink): boolean[] {
  return buildMCPToolsForServer(pool, target).map(tool => shouldHideToolFromModel(tool, createEmptyAppState()))
}

describe('isMcpServerInline', () => {
  it('inlines a server without instructions whose tools fit the budget', () => {
    expect(isMcpServerInline(server('web', [SEARCH]))).toBe(true)
  })

  it('defers a server that sent instructions, however small', () => {
    expect(isMcpServerInline(server('web', [SEARCH], 'Use search for news.'))).toBe(false)
  })

  it('takes the budget as inclusive', () => {
    expect(isMcpServerInline(server('web', [toolOfSize('a', MCP_INLINE_SCHEMA_BUDGET_CHARS)]))).toBe(true)
    expect(isMcpServerInline(server('web', [toolOfSize('a', MCP_INLINE_SCHEMA_BUDGET_CHARS + 1)]))).toBe(false)
  })

  it('sums every tool of the server', () => {
    const half = toolOfSize('a', MCP_INLINE_SCHEMA_BUDGET_CHARS / 2)
    expect(isMcpServerInline(server('web', [half, { ...half, name: 'b' }]))).toBe(true)
    expect(isMcpServerInline(server('web', [half, { ...half, name: 'b' }, { name: 'c' }]))).toBe(false)
  })
})

describe('the session offering', () => {
  it('lists an inline server\'s tools and defers the others', () => {
    const web = server('web', [SEARCH])
    const box = server('box', [SEARCH], 'Sandbox notes.')
    const big = server('big', [toolOfSize('huge', MCP_INLINE_SCHEMA_BUDGET_CHARS + 1)])
    const pool = poolWith(web, box, big)
    expect(mcpSessionOffering(pool).skillNames.sort()).toEqual(['mcp__big', 'mcp__box'])

    registerOffering(pool)
    expect(hidden(pool, web)).toEqual([false])
    expect(hidden(pool, box)).toEqual([true])
    expect(hidden(pool, big)).toEqual([true])
  })

  it('offers inline servers in name order while their summed definitions fit; the rest are deferred', () => {
    const per = Math.floor(MCP_INLINE_SCHEMA_BUDGET_CHARS * 0.9)
    const count = Math.floor(MCP_INLINE_TOTAL_BUDGET_CHARS / per) + 2
    const servers = Array.from({ length: count }, (_, i) => server(`w${i}`, [toolOfSize('t', per)]))
    const deferred = mcpSessionOffering(poolWith(...[...servers].reverse())).skillNames.sort()
    const inline = Math.floor(MCP_INLINE_TOTAL_BUDGET_CHARS / per)
    expect(deferred).toEqual(servers.slice(inline).map(s => `mcp__${s.name}`))
    // Reordering the pool does not change the split.
    expect(mcpSessionOffering(poolWith(...servers)).skillNames.sort()).toEqual(deferred)
  })

  it('still defers an inline-eligible server the template names in deferredTools', () => {
    const web = server('web', [SEARCH])
    const pool = poolWith(web)
    registerOffering(pool, ['mcp__web'])
    expect(hidden(pool, web)).toEqual([true])
  })
})

describe('the Skill description of a deferred server without instructions', () => {
  it('names its tools and leads with the first tool description', () => {
    const big = server('big', [{ name: 'list' }, SEARCH, toolOfSize('huge', MCP_INLINE_SCHEMA_BUDGET_CHARS + 1)])
    const [command] = buildMCPSkillCommands(poolWith(big))
    expect(command!.description).toBe(
      'Loads the tools of the "big" MCP server. Tools: list, search, huge. Search the web for current information.',
    )
  })

  it('elides tool names past the eighth', () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}` }))
    const [command] = buildMCPSkillCommands(poolWith(server('many', tools)))
    expect(command!.description).toBe(
      'Loads the tools of the "many" MCP server. Tools: t0, t1, t2, t3, t4, t5, t6, t7, ….',
    )
  })
})
