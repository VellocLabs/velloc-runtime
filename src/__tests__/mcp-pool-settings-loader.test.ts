import { describe, expect, it, vi } from 'vitest'
import { MCPPool } from '../mcp/pool'
import type {
  McpBridgeOperations,
  NexusMcpServerLaunchConfig,
} from '../mcp/nativeBridge'

/**
 * Poll a predicate until it returns true. Used to give the pool's
 * async init/refresh microtask chain time to land at a known state
 * before asserting. Throws (rather than hangs) on timeout so a
 * regression that breaks the wait surface as a test failure with a
 * useful line number, not a 5-second vitest timeout.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  if (!predicate()) {
    throw new Error('waitFor: predicate never became true within ' + timeoutMs + 'ms')
  }
}

/**
 * The pool reads its settings-configured servers from `loadNativeServers` and forwards each inline config through
 * `bridge.connect(id, config)`: boot-time discovery, additions picked up by refreshNativeServers, and a failed
 * loadNativeServers degrading to no servers without throwing.
 */

function makeStubBridge() {
  const calls: Array<{
    method: 'connect'
    args: unknown[]
  }> = []
  const tools = [{ name: 'echo' }]
  const bridge: McpBridgeOperations = {
    async connect(serverId, config) {
      calls.push({ method: 'connect', args: [serverId, config] })
      return { ok: true, tools }
    },
    async callTool() {
      return { ok: true, result: { content: [] } }
    },
    async disconnect() {
      return
    },
  }
  return { bridge, calls }
}

describe('MCPPool with loadNativeServers', () => {
  it('reads native servers from loadNativeServers and forwards inline config to connect()',
      async () => {
    const { bridge, calls } = makeStubBridge()
    const loadNativeServers = vi.fn().mockResolvedValue([
      {
        id: 'github',
        config: {
          transport: 'http' as const,
          url: 'https://api.github.example',
          headers: { Authorization: 'Bearer secret-from-settings-json' },
        },
      },
    ])
    const pool = new MCPPool({
      cwd: '/work',
      nativeBridge: bridge,
      loadNativeServers,
    })
    await pool.init()

    expect(loadNativeServers).toHaveBeenCalledTimes(1)
    // connect was called with the FULL inline config (including the
    // Authorization header — secrets-in-settings.json is the contract).
    const connectCall = calls.find(c => c.method === 'connect')
    expect(connectCall).toBeDefined()
    expect(connectCall!.args[0]).toBe('github')
    expect(connectCall!.args[1]).toEqual({
      transport: 'http',
      url: 'https://api.github.example',
      headers: { Authorization: 'Bearer secret-from-settings-json' },
    })
    // The connected server lands in the pool.
    expect(pool.listServers().map(s => s.name)).toContain('github')
  })

  it('refreshNativeServers picks up an addition after init', async () => {
    const { bridge, calls } = makeStubBridge()
    const servers: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = [
      { id: 'first', config: { transport: 'stdio', command: 'first-cmd' } },
    ]
    const loadNativeServers = vi.fn(() => Promise.resolve([...servers]))
    const pool = new MCPPool({
      cwd: '/work',
      nativeBridge: bridge,
      loadNativeServers,
    })
    await pool.init()
    expect(pool.listServers().map(s => s.name).sort()).toEqual(['first'])

    // Simulate a user adding a second server via the settings page
    // (new entry materialises in settings.json on disk).
    servers.push({
      id: 'second',
      config: { transport: 'stdio', command: 'second-cmd' },
    })
    await pool.refreshNativeServers()
    expect(pool.listServers().map(s => s.name).sort()).toEqual([
      'first', 'second',
    ])
    expect(loadNativeServers).toHaveBeenCalledTimes(2)
    // connect was called for 'second' WITH its inline config.
    const secondConnect = calls.find(
      c => c.method === 'connect' && c.args[0] === 'second')
    expect(secondConnect).toBeDefined()
    expect(secondConnect!.args[1]).toEqual({
      transport: 'stdio', command: 'second-cmd',
    })
  })

  it('degrades gracefully when loadNativeServers throws', async () => {
    const { bridge, calls } = makeStubBridge()
    const loadNativeServers = vi.fn().mockRejectedValue(
      new Error('disk read failed'))
    const pool = new MCPPool({
      cwd: '/work',
      nativeBridge: bridge,
      loadNativeServers,
    })
    // Must NOT throw — pool init swallows the loader failure (the
    // user sees zero native servers but the rest of the runtime
    // keeps working).
    await pool.init()
    expect(pool.listServers()).toEqual([])
    expect(calls).toEqual([])
  })

  it('connects no settings server without a loader (the host keeps no list)', async () => {
    const { bridge, calls } = makeStubBridge()
    const pool = new MCPPool({ cwd: '/work', nativeBridge: bridge })
    await pool.init()
    await pool.refreshNativeServers()
    expect(calls).toEqual([])
    expect(pool.listServers()).toEqual([])
  })

  it('refreshNativeServers DISCONNECTS + EVICTS a native server that vanished from settings.json',
      async () => {
    const { bridge, calls } = makeStubBridge()
    const disconnect = vi.fn(async () => {})
    bridge.disconnect = disconnect
    const servers: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = [
      { id: 'doomed', config: { transport: 'stdio', command: 'echo' } },
      { id: 'survivor', config: { transport: 'stdio', command: 'cat' } },
    ]
    const loadNativeServers = vi.fn(() => Promise.resolve([...servers]))
    const pool = new MCPPool({
      cwd: '/work',
      nativeBridge: bridge,
      loadNativeServers,
    })
    await pool.init()
    expect(pool.listServers().map(s => s.name).sort()).toEqual([
      'doomed', 'survivor',
    ])

    // User removes 'doomed' in the settings UI — next disk read
    // returns only the survivor.
    servers.splice(0, 1)
    await pool.refreshNativeServers()

    // Bridge.disconnect must have been called for the removed id.
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith('doomed')
    // And the pool no longer carries the removed server.
    expect(pool.listServers().map(s => s.name).sort()).toEqual(['survivor'])
    // Survivor was NOT re-connected (no replace) — its only connect
    // call is the init one.
    const survivorConnects = calls.filter(
      c => c.method === 'connect' && c.args[0] === 'survivor')
    expect(survivorConnects).toHaveLength(1)
  })

  it('refreshNativeServers detects a config drift and RECONNECTS with the new config',
      async () => {
    const { bridge, calls } = makeStubBridge()
    const disconnect = vi.fn(async () => {})
    bridge.disconnect = disconnect
    const servers: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = [
      {
        id: 'github',
        config: {
          transport: 'http',
          url: 'https://api.github.example/v1',
          headers: { Authorization: 'Bearer OLD' },
        },
      },
    ]
    const loadNativeServers = vi.fn(() => Promise.resolve(
      servers.map(s => ({ id: s.id, config: { ...s.config } })),
    ))
    const pool = new MCPPool({
      cwd: '/work',
      nativeBridge: bridge,
      loadNativeServers,
    })
    await pool.init()

    // User rotates the token via the settings UI — same id, fresh
    // header value.
    servers[0]!.config.headers = { Authorization: 'Bearer NEW' }
    await pool.refreshNativeServers()

    // Disconnect fired for the drifted server, then a fresh connect
    // ran with the NEW headers.
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith('github')
    const githubConnects = calls.filter(
      c => c.method === 'connect' && c.args[0] === 'github')
    // Two connects total: init + the post-drift reconnect.
    expect(githubConnects).toHaveLength(2)
    expect(githubConnects[1]!.args[1]).toMatchObject({
      headers: { Authorization: 'Bearer NEW' },
    })
    // Still exactly one server entry — the reconnect REPLACED, not
    // duplicated.
    expect(pool.listServers().map(s => s.name)).toEqual(['github'])
  })

  it('refreshNativeServers is a NO-OP when nothing changed',
      async () => {
    const { bridge, calls } = makeStubBridge()
    const disconnect = vi.fn(async () => {})
    bridge.disconnect = disconnect
    const servers: Array<{ id: string; config: NexusMcpServerLaunchConfig }> = [
      { id: 'stable', config: { transport: 'stdio', command: 'cat' } },
    ]
    const loadNativeServers = vi.fn(() => Promise.resolve(
      servers.map(s => ({ id: s.id, config: { ...s.config } })),
    ))
    const pool = new MCPPool({
      cwd: '/work',
      nativeBridge: bridge,
      loadNativeServers,
    })
    await pool.init()
    const connectsAfterInit = calls.filter(c => c.method === 'connect').length

    await pool.refreshNativeServers()
    // No disconnects, no new connects.
    expect(disconnect).not.toHaveBeenCalled()
    expect(
      calls.filter(c => c.method === 'connect').length,
    ).toBe(connectsAfterInit)
  })

  it('serialises concurrent refreshNativeServers calls so two interleaved diffs cannot race',
      async () => {
    const { bridge, calls } = makeStubBridge()
    // Each load call gets its own resolver, captured in order. The
    // serialisation contract under test is "two refreshes in the
    // same tick share ONE loader call" — so we expect exactly two
    // total (init + the one shared refresh), and `resolvers[1]` is
    // what we await on for the refresh's loader.
    const resolvers: Array<
      (v: Array<{ id: string; config: NexusMcpServerLaunchConfig }>) => void
    > = []
    const loadNativeServers = vi.fn(() => {
      return new Promise<Array<{ id: string; config: NexusMcpServerLaunchConfig }>>(
        resolve => { resolvers.push(resolve) },
      )
    })
    const pool = new MCPPool({
      cwd: '/work',
      nativeBridge: bridge,
      loadNativeServers,
    })
    // Bootstrap the pool with init's loader resolved. `init` first
    // awaits `loadMCPConfig` (the project `.velloc/mcp.json` reader)
    // and only then reaches `connectNativeServers`, so the loader
    // call lands a few microtasks in. Poll until it shows up rather
    // than guessing a fixed flush count.
    const initPromise = pool.init()
    await waitFor(() => resolvers.length === 1)
    resolvers[0]!([])
    await initPromise

    // Fire two refreshes in the same tick. Only ONE should reach the
    // loader because the second awaits the first's in-flight promise.
    const a = pool.refreshNativeServers()
    const b = pool.refreshNativeServers()
    // Poll for the refresh loader call. If serialisation is broken
    // this resolves with `resolvers.length === 3` and the assertion
    // below catches it.
    await waitFor(() => resolvers.length >= 2)
    expect(resolvers).toHaveLength(2)  // init + one shared refresh, NOT two
    resolvers[1]!([
      { id: 'newcomer', config: { transport: 'stdio', command: 'cat' } },
    ])
    await Promise.all([a, b])
    expect(pool.listServers().map(s => s.name)).toEqual(['newcomer'])
    // Exactly one connect for 'newcomer' — the second refresh did
    // NOT issue its own diff pass.
    const newcomerConnects = calls.filter(
      c => c.method === 'connect' && c.args[0] === 'newcomer')
    expect(newcomerConnects).toHaveLength(1)
  })

  it('refreshNativeServers never touches browser-transport servers',
      async () => {
    const { bridge, calls } = makeStubBridge()
    const disconnect = vi.fn(async () => {})
    bridge.disconnect = disconnect
    const loadNativeServers = vi.fn(() => Promise.resolve([]))
    const pool = new MCPPool({
      cwd: '/work',
      nativeBridge: bridge,
      loadNativeServers,
      // Browser-transport server contributed by a plugin extra.
      extraServers: [
        { name: 'plugin-server', type: 'http', url: 'https://example/' },
      ],
    })
    // We don't want connectMCPServer to actually open a transport in
    // the test — the connect() path it takes goes through the real
    // @modelcontextprotocol/sdk client. The pool catches its
    // failure and keeps the registry; we only care that the entry
    // exists with `nativeServerId === undefined`.
    await pool.init().catch(() => {})
    // Force-register a browser-transport survivor so the assertion
    // below has something to compare against, regardless of whether
    // the real connect succeeded inside the unit test environment.
    // (The pool's public surface doesn't expose direct injection, so
    // we reach in via the same Map listServers() returns.)
    const inserted = (pool as unknown as {
      servers: Map<string, { name: string; nativeServerId?: string }>
    }).servers
    if (!inserted.has('plugin-server')) {
      inserted.set('plugin-server', { name: 'plugin-server' })
    }

    await pool.refreshNativeServers()

    // The plugin-server has no nativeServerId — refresh ignored it
    // entirely. No disconnect fired.
    expect(disconnect).not.toHaveBeenCalled()
    expect(pool.listServers().map(s => s.name)).toContain('plugin-server')
  })
})
