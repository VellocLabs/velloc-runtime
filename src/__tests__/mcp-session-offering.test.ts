/**
 * The MCP session offering (F-10): what a session takes from its pool, how
 * its tools are told apart in a tool list, and the engine swap that lets the
 * offering follow a plugin reload.
 */
import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { LiveServerLink, MCPPool } from '../mcp'
import { isMcpSessionTool, mcpSessionOffering } from '../mcp'
import { READ_MCP_RESOURCE_TOOL_NAME, RESOURCE_INDEX_TOOL_ID } from '../mcp/resourceTools'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  NoopUserInputPipeline,
  createEmptyAppState,
  createMemoryFileStateCache,
} from '../runtime/testing/noopAdapters'
import { declareTool, type ToolContract } from '../toolkit/toolContract'

function server(name: string, status: LiveServerLink['status'] = 'connected'): LiveServerLink {
  return {
    name,
    config: { type: 'http', url: 'http://example.test' },
    status,
    tools: [{ name: 'echo', description: 'Echoes' }],
    instructions: 'Usage notes.',
  }
}

function poolWith(...servers: LiveServerLink[]): MCPPool {
  return { listServers: () => servers } as unknown as MCPPool
}

function plainTool(name: string): ToolContract {
  return declareTool({
    name,
    argsSchema: { type: 'object', properties: {} },
    description: async () => `${name} tool`,
    parallelSafe: () => true,
    readsOnly: () => true,
    call: async () => ({ result: 'ok' }),
  } as never) as unknown as ToolContract
}

function makeEngine(tools: ToolContract[]) {
  const runtimeConfig = new DefaultRuntimeConfig()
  let appState: WorkingState = createEmptyAppState()
  return new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools,
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appState,
    writeAppState: updater => {
      appState = updater(appState)
    },
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, {
      callModel: (async function* () {}) as never,
    }),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore('offering'),
    userInputPipeline: new NoopUserInputPipeline(runtimeConfig, true),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    titleServices: { generateName: async () => null },
  })
}

describe('mcpSessionOffering', () => {
  it('takes the connected servers alone: their tools, one deferral unit and one Skill each, the names', () => {
    const offering = mcpSessionOffering(poolWith(server('files'), server('down', 'failed'), server('kit')))
    expect([...offering.servers].sort()).toEqual(['files', 'kit'])
    expect(offering.skillNames.sort()).toEqual(['mcp__files', 'mcp__kit'])
    expect(offering.commands.map(command => command.name).sort()).toEqual(['mcp__files', 'mcp__kit'])
    const names = offering.tools.map(tool => tool.name)
    expect(names).toContain('mcp__files__echo')
    expect(names).toContain('mcp__kit__echo')
    expect(names).not.toContain('mcp__down__echo')
    expect(names).toContain(RESOURCE_INDEX_TOOL_ID)
    expect(names).toContain(READ_MCP_RESOURCE_TOOL_NAME)
  })

  it('is empty for a pool with nothing connected', () => {
    const offering = mcpSessionOffering(poolWith(server('down', 'failed')))
    expect(offering.tools).toEqual([])
    expect(offering.skillNames).toEqual([])
    expect(offering.commands).toEqual([])
    expect(offering.servers.size).toBe(0)
  })
})

describe('isMcpSessionTool', () => {
  it('knows the server tools and the resource tools, and nothing else', () => {
    const offering = mcpSessionOffering(poolWith(server('files')))
    for (const tool of offering.tools) expect(isMcpSessionTool(tool), tool.name).toBe(true)
    expect(isMcpSessionTool(plainTool('Read'))).toBe(false)
    expect(isMcpSessionTool(plainTool('mcp__looks_like_one'))).toBe(false)
  })
})

describe('ConversationEngine.replaceTools', () => {
  it('swaps the matched tools for the new set and keeps the rest', () => {
    const before = mcpSessionOffering(poolWith(server('files')))
    const engine = makeEngine([plainTool('Read'), ...before.tools, plainTool('Skill')])
    const after = mcpSessionOffering(poolWith(server('kit')))
    const now = engine.replaceTools(isMcpSessionTool, after.tools).map(tool => tool.name)
    expect(now).toContain('Read')
    expect(now).toContain('Skill')
    expect(now).toContain('mcp__kit__echo')
    expect(now).not.toContain('mcp__files__echo')
    expect(now.filter(name => name === RESOURCE_INDEX_TOOL_ID)).toHaveLength(1)
  })

  it('with nothing to add, leaves the list without MCP tools', () => {
    const before = mcpSessionOffering(poolWith(server('files')))
    const engine = makeEngine([plainTool('Read'), ...before.tools])
    expect(engine.replaceTools(isMcpSessionTool, []).map(tool => tool.name)).toEqual(['Read'])
  })
})
