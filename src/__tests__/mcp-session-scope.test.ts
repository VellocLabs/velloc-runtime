/**
 * The MCP scope of a session type (F-25): `plugin` keeps the owner's servers
 * and registered tools alone, `none` keeps nothing, `all` keeps every source
 * — in the pure source filters and in the engine's registered-tool list.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import {
  modToolsInScope,
  pluginMcpOwnersInScope,
  pluginMcpServersInScope,
  pluginNativeMcpServersInScope,
  sessionMcpScopeOf,
  type SessionMcpScope,
} from '../mcp/sessionMcpScope'
import type { PluginMcpServerOwner } from '../mcp/serverOrigin'
import type { MCPServerConfigWithName } from '../mcp/types'
import { buildModTool, type ModRegisteredTool } from '../mods/modRegisteredTools'
import { __resetPluginTypesForTest, getTemplate, registerPluginType } from '../prompting/templateRegistry'
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
import type { EngineExtensions } from '../engine/engineConfig'

const ALL: SessionMcpScope = { kind: 'all' }
const NONE: SessionMcpScope = { kind: 'none' }
const ACME: SessionMcpScope = { kind: 'plugin', plugin: 'acme' }

afterEach(() => {
  __resetPluginTypesForTest()
})

describe('sessionMcpScopeOf', () => {
  it('names the owning plugin for an mcp: plugin type, none for noExecution, all otherwise', async () => {
    await registerPluginType('acme:x', [
      ['acme:x/template.md', '---\ntype: acme:x\nmcp: plugin\nskills: []\ntools: [read]\n---\n\n## prompt\nX\n'],
    ])
    expect(sessionMcpScopeOf('acme:x', getTemplate('acme:x')?.config)).toEqual(ACME)
    expect(sessionMcpScopeOf('safe_code', getTemplate('safe_code')?.config)).toEqual(NONE)
    expect(sessionMcpScopeOf('agent', getTemplate('agent')?.config)).toEqual(ALL)
    // A type with no manifest keeps every source.
    expect(sessionMcpScopeOf('unknown', undefined)).toEqual(ALL)
  })
})

describe('the source filters', () => {
  const owners: PluginMcpServerOwner[] = [
    { name: 'acme-http', plugin: 'acme', track: 'browser' },
    { name: 'acme-stdio', plugin: 'acme', track: 'native' },
    { name: 'other-http', plugin: 'other', track: 'browser' },
    { name: 'other-stdio', plugin: 'other', track: 'native' },
  ]
  const browser: MCPServerConfigWithName[] = [
    { name: 'acme-http', type: 'http', url: 'http://acme' } as MCPServerConfigWithName,
    { name: 'other-http', type: 'http', url: 'http://other' } as MCPServerConfigWithName,
    { name: 'orphan', type: 'http', url: 'http://orphan' } as MCPServerConfigWithName,
  ]
  const native = [
    { id: 'acme-stdio', config: { transport: 'stdio' as const, command: 'acme-mcp' } },
    { id: 'other-stdio', config: { transport: 'stdio' as const, command: 'other-mcp' } },
  ]

  it('plugin: the owner\'s servers alone; a server with no known owner is out', () => {
    expect(pluginMcpServersInScope(ACME, browser, owners).map(s => s.name)).toEqual(['acme-http'])
    expect(pluginNativeMcpServersInScope(ACME, native, owners).map(s => s.id)).toEqual(['acme-stdio'])
    expect(pluginMcpOwnersInScope(ACME, owners).map(o => o.name)).toEqual(['acme-http', 'acme-stdio'])
    // A server that merely shares a name on the other track is not the owner's.
    expect(
      pluginMcpServersInScope(ACME, [{ name: 'acme-stdio', type: 'http', url: 'http://x' } as MCPServerConfigWithName], owners),
    ).toEqual([])
  })

  it('none: nothing; all: everything, orphans included', () => {
    expect(pluginMcpServersInScope(NONE, browser, owners)).toEqual([])
    expect(pluginNativeMcpServersInScope(NONE, native, owners)).toEqual([])
    expect(pluginMcpOwnersInScope(NONE, owners)).toEqual([])
    expect(pluginMcpServersInScope(ALL, browser, owners)).toEqual(browser)
    expect(pluginNativeMcpServersInScope(ALL, native, owners)).toEqual(native)
    expect(pluginMcpOwnersInScope(ALL, owners)).toEqual(owners)
  })

  it('modToolsInScope keeps the owner\'s registered tools; no scope reads as all', () => {
    const tools: ModRegisteredTool[] = [
      buildModTool('acme', { name: 'a', description: 'A.', inputSchema: { type: 'object' } }),
      buildModTool('other', { name: 'b', description: 'B.', inputSchema: { type: 'object' } }),
    ]
    expect(modToolsInScope(tools, ACME).map(t => t.name)).toEqual(['mcp__acme__a'])
    expect(modToolsInScope(tools, NONE)).toEqual([])
    expect(modToolsInScope(tools, ALL).map(t => t.name)).toEqual(['mcp__acme__a', 'mcp__other__b'])
    expect(modToolsInScope(tools, undefined).map(t => t.name)).toEqual(['mcp__acme__a', 'mcp__other__b'])
  })
})

describe('registered tools through the engine', () => {
  const passThrough = (): EngineExtensions =>
    ({
      ready: Promise.resolve(),
      promptSubmit: async (text: string) => ({ entered: true, text, context: [] }),
      hasToolCallHooks: () => false,
    }) as unknown as EngineExtensions

  function makeEngine(scope: SessionMcpScope | undefined, told: string[][] | undefined) {
    const runtimeConfig = new DefaultRuntimeConfig()
    let appState: WorkingState = createEmptyAppState()
    return new ConversationEngine({
      cwd: '/workspace',
      projectRoot: '/workspace',
      tools: [],
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
      conversationStore: new MemoryConversationStore('scope'),
      userInputPipeline: new NoopUserInputPipeline(runtimeConfig, true),
      systemInitEmitter: new NoopSystemInitEmitter(),
      runtimeConfig,
      mods: passThrough(),
      ...(told ? { onModToolsChanged: (tools: readonly ModRegisteredTool[]) => told.push(tools.map(tool => tool.name)) } : {}),
      ...(scope ? { modToolScope: scope } : {}),
    })
  }

  const registerBoth = (engine: ConversationEngine) => {
    engine.modTools.register!({ name: 'a', description: 'A.', inputSchema: { type: 'object' } }, 'acme')
    engine.modTools.register!({ name: 'b', description: 'B.', inputSchema: { type: 'object' } }, 'other')
  }
  const listed = async (engine: ConversationEngine) => (await engine.modTools.list()).map(tool => tool.name)

  it('plugin: lists and publishes the owner\'s tools alone', async () => {
    const told: string[][] = []
    const engine = makeEngine(ACME, told)
    registerBoth(engine)
    expect(await listed(engine)).toEqual(['mcp__acme__a'])
    expect(told).toEqual([['mcp__acme__a'], ['mcp__acme__a']])
  })

  it('none: lists no registered tool at all', async () => {
    const told: string[][] = []
    const engine = makeEngine(NONE, told)
    registerBoth(engine)
    expect(await listed(engine)).toEqual([])
    expect(told).toEqual([[], []])
  })

  it('all, and no scope given: lists both', async () => {
    for (const scope of [ALL, undefined]) {
      const told: string[][] = []
      const engine = makeEngine(scope, told)
      registerBoth(engine)
      expect(await listed(engine)).toEqual(['mcp__acme__a', 'mcp__other__b'])
      expect(told.at(-1)).toEqual(['mcp__acme__a', 'mcp__other__b'])
    }
  })

  it('lists the tools with no listener set', async () => {
    const engine = makeEngine(ACME, undefined)
    registerBoth(engine)
    expect(await listed(engine)).toEqual(['mcp__acme__a'])
  })

  it('a loop under a slot inherits only the tools in its own scope', async () => {
    const inherited = [
      buildModTool('acme', { name: 'a', description: 'A.', inputSchema: { type: 'object' } }),
      buildModTool('other', { name: 'b', description: 'B.', inputSchema: { type: 'object' } }),
    ]
    const scoped = makeEngine(ACME, [])
    scoped.inheritModTools(inherited)
    expect(await listed(scoped)).toEqual(['mcp__acme__a'])
    const closed = makeEngine(NONE, [])
    closed.inheritModTools(inherited)
    expect(await listed(closed)).toEqual([])
  })
})
