import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCPPool } from '../mcp/pool'
import { buildMCPToolsFromPool } from '../mcp'
import type {
  McpBridgeOperations,
  NexusMcpServerLaunchConfig,
} from '../mcp/nativeBridge'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
} from '../utils/fs/runtimeFs'
import type { MCPServerConfigWithName } from '../mcp/types'

// loadMCPConfig reads `.velloc/mcp.json`; with the unsupported fs its
// readFile throws and the loader returns [] — so these tests exercise
// the native path in isolation (no browser-transport servers).
function stubEmptyFs() {
  installProcessFs(unconfiguredFs)
}

function fakeBridge(
  overrides: Partial<McpBridgeOperations> = {},
): McpBridgeOperations {
  return {
    connect: vi.fn(async () => ({ ok: true, tools: [] })),
    callTool: vi.fn(async () => ({ ok: true, result: undefined })),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  }
}

afterEach(() => resetProcessFs())

const STDIO: NexusMcpServerLaunchConfig = { transport: 'stdio', command: 'srv' }
const HTTP: NexusMcpServerLaunchConfig = { transport: 'http', url: 'https://mcp.example.test' }

/** The settings.json reader (`MCPPool.loadNativeServers`) returning `ids`. */
function servers(...entries: Array<string | [string, NexusMcpServerLaunchConfig]>) {
  return vi.fn(async () =>
    entries.map(entry =>
      typeof entry === 'string' ? { id: entry, config: STDIO } : { id: entry[0], config: entry[1] },
    ),
  )
}

describe('MCPPool settings-configured servers', () => {
  it('discovers, connects, and surfaces native servers + their tools', async () => {
    stubEmptyFs()
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({
        ok: true,
        tools: [
          { name: 'create_issue', description: 'Open an issue' },
          { name: 'list_repos' },
        ],
      })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers('github') })
    await pool.init()

    expect(bridge.connect).toHaveBeenCalledWith('github', STDIO)
    const server = pool.getServer('github')
    expect(server?.status).toBe('connected')
    expect(server?.nativeServerId).toBe('github')
    expect(server?.config).toBeUndefined()
    expect(server?.tools.map(t => t.name)).toEqual([
      'create_issue',
      'list_repos',
    ])
    expect(pool.listAllTools().map(t => t.tool.name)).toEqual([
      'create_issue',
      'list_repos',
    ])
  })

  it('routes callTool through the bridge and unwraps the result', async () => {
    stubEmptyFs()
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({
        ok: true,
        tools: [{ name: 'create_issue' }],
      })),
      callTool: vi.fn(async () => ({ ok: true, result: { id: 42 } })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers('github') })
    await pool.init()

    const result = await pool.callTool('github', 'create_issue', {
      title: 'bug',
    })
    expect(result).toEqual({ id: 42 })
    expect(bridge.callTool).toHaveBeenCalledWith('github', 'create_issue', {
      title: 'bug',
    }, undefined)
  })

  it('throws when the bridge reports a tool failure', async () => {
    stubEmptyFs()
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({
        ok: true,
        tools: [{ name: 'create_issue' }],
      })),
      callTool: vi.fn(async () => ({ ok: false, error: 'rate limited' })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers('github') })
    await pool.init()

    await expect(
      pool.callTool('github', 'create_issue', {}),
    ).rejects.toThrow('rate limited')
  })

  it('reconnects a native server the current host port does not know, then retries the call once', async () => {
    // The runtime's host port can be replaced (a newer window); a server
    // connected on the old port service is unknown to the new one.
    stubEmptyFs()
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'MCP server is not connected: github' })
      .mockResolvedValueOnce({ ok: true, result: { content: 'done' } })
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({ ok: true, tools: [{ name: 'create_issue' }] })),
      callTool,
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers('github') })
    await pool.init()

    await expect(pool.callTool('github', 'create_issue', { title: 'x' })).resolves.toEqual({ content: 'done' })
    expect(bridge.connect).toHaveBeenCalledTimes(2)
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it('does not retry a call the server itself failed', async () => {
    stubEmptyFs()
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({ ok: true, tools: [{ name: 'create_issue' }] })),
      callTool: vi.fn(async () => ({ ok: false, error: 'rate limited' })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers('github') })
    await pool.init()

    await expect(pool.callTool('github', 'create_issue', {})).rejects.toThrow('rate limited')
    expect(bridge.connect).toHaveBeenCalledTimes(1)
    expect(bridge.callTool).toHaveBeenCalledTimes(1)
  })

  it('records a connect failure as a failed server without throwing', async () => {
    stubEmptyFs()
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({
        ok: false,
        tools: [],
        error: 'spawn ENOENT',
      })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers('broken') })
    await pool.init()

    const server = pool.getServer('broken')
    expect(server?.status).toBe('failed')
    expect(server?.error).toBe('spawn ENOENT')
    // A failed server contributes no tools.
    expect(pool.listAllTools()).toEqual([])
  })

  it('skips a native server whose name collides with an existing one', async () => {
    stubEmptyFs()
    const extra: MCPServerConfigWithName = {
      name: 'github',
      type: 'http',
      url: 'http://example.test',
    }
    const bridge = fakeBridge({
    })
    const pool = new MCPPool({
      cwd: '/w',
      extraServers: [extra],
      nativeBridge: bridge,
      loadNativeServers: servers('github'),
    })
    await pool.init()

    // The browser-transport server wins the name; native connect is
    // never attempted for the duplicate.
    expect(bridge.connect).not.toHaveBeenCalled()
    expect(pool.getServer('github')?.config?.type).toBe('http')
  })

  it('survives a settings-reader failure', async () => {
    stubEmptyFs()
    const bridge = fakeBridge()
    const pool = new MCPPool({
      cwd: '/w',
      nativeBridge: bridge,
      loadNativeServers: vi.fn(async () => {
        throw new Error('settings.json unreadable')
      }),
    })
    await expect(pool.init()).resolves.toBeUndefined()
    expect(pool.listServers()).toEqual([])
    expect(bridge.connect).not.toHaveBeenCalled()
  })

  it('treats native http servers the same as stdio', async () => {
    stubEmptyFs()
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({
        ok: true,
        tools: [{ name: 'search_issues' }],
      })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers(['linear', HTTP]) })
    await pool.init()

    const server = pool.getServer('linear')
    expect(server?.status).toBe('connected')
    expect(server?.nativeServerId).toBe('linear')
    expect(server?.tools.map(t => t.name)).toEqual(['search_issues'])
  })

  it('exposes native tools as mcp__ tools that invoke the bridge', async () => {
    stubEmptyFs()
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({
        ok: true,
        tools: [{ name: 'create_issue', description: 'Open an issue' }],
      })),
      callTool: vi.fn(async () => ({
        ok: true,
        result: { content: [{ type: 'text', text: 'created #42' }] },
      })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers('github') })
    await pool.init()

    // The tool adapter must produce a model-facing tool whose call()
    // routes through the pool → native bridge (the full JS path the agent
    // exercises when it invokes an MCP tool).
    const tool = buildMCPToolsFromPool(pool).find(
      t => t.name === 'mcp__github__create_issue',
    )
    expect(tool).toBeDefined()
    expect(tool!.fromMcpServer).toBe(true)

    const out = (await tool!.call(
      { title: 'bug' },
      { cancelSource: new AbortController() } as never,
      (async () => ({ behavior: 'allow' })) as never,
      {} as never,
    )) as { data: unknown }
    // The tool call's abort signal reaches the server operations.
    expect(bridge.callTool).toHaveBeenCalledWith('github', 'create_issue', {
      title: 'bug',
    }, expect.any(AbortSignal))
    expect(out.data).toEqual({
      content: [{ type: 'text', text: 'created #42' }],
    })
  })

  it('disconnects native servers via the bridge on shutdown', async () => {
    stubEmptyFs()
    const bridge = fakeBridge({
      connect: vi.fn(async () => ({ ok: true, tools: [] })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: servers('github') })
    await pool.init()
    await pool.shutdown()
    expect(bridge.disconnect).toHaveBeenCalledWith('github')
    expect(pool.listServers()).toEqual([])
  })

  it('refreshNativeServers connects a server added after init (new-session path)', async () => {
    stubEmptyFs()
    // The second read (a later session) sees a server the user just added.
    const loadNativeServers = servers('github')
    loadNativeServers.mockResolvedValueOnce([{ id: 'github', config: STDIO }])
    loadNativeServers.mockResolvedValueOnce([
      { id: 'github', config: STDIO },
      { id: 'linear', config: HTTP },
    ])
    const bridge = fakeBridge({
      connect: vi.fn(async (name: string) => ({
        ok: true,
        tools: [{ name: `${name}_tool` }],
      })),
    })
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers })
    await pool.init()
    expect(pool.getServer('linear')).toBeUndefined()

    await pool.refreshNativeServers()

    // The newly-added server is connected; the already-present one is NOT
    // reconnected (connect fired once for github at init, once for linear).
    expect(pool.getServer('linear')?.status).toBe('connected')
    expect(pool.getServer('linear')?.tools.map(t => t.name)).toEqual([
      'linear_tool',
    ])
    expect(bridge.connect).toHaveBeenCalledTimes(2)
    expect(bridge.connect).toHaveBeenLastCalledWith('linear', HTTP)
  })

  it('refreshNativeServers disconnects + evicts a server that vanished from the settings source', async () => {
    stubEmptyFs()
    // Two reads: init sees the server, the refresh sees an empty list (the
    // user removed it). settings.json is authoritative for these servers;
    // leaving a phantom alive past its config record would let the catalog
    // and runtime disagree on what exists.
    const loadNativeServers = servers('github')
    loadNativeServers.mockResolvedValueOnce([{ id: 'github', config: STDIO }])
    loadNativeServers.mockResolvedValueOnce([])
    const bridge = fakeBridge()
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers })
    await pool.init()
    expect(pool.getServer('github')).toBeDefined()

    await pool.refreshNativeServers()

    // Gone from the pool, and the server operations were told to clean up
    // their end of the connection. Concurrent sessions whose tool calls
    // were in flight against this server will surface a tool error
    // — documented contract under `MCPPool.refreshNativeServers`.
    expect(pool.getServer('github')).toBeUndefined()
    expect(bridge.disconnect).toHaveBeenCalledTimes(1)
    expect(bridge.disconnect).toHaveBeenCalledWith('github')
  })
})
