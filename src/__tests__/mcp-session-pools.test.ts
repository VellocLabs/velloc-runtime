/**
 * MCP pools per top-level session (F-10): sessions get their own pool and
 * project config, descendants share their root's, a released pool closes
 * after the grace (or at once on delete), a slow server never holds a build
 * past the boot wait, idle stdio servers are parked and restart on use, and
 * calls to tools not marked read-only run one at a time per server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpBridgeOperations } from '../mcp/nativeBridge'
import type { LiveServerLink, MCPServerConfig, MCPServerConfigWithName, MCPToolDescriptor } from '../mcp/types'

const loadMCPConfig = vi.fn<(cwd: string) => Promise<MCPServerConfigWithName[]>>()

vi.mock('../mcp/config', () => ({
  loadMCPConfig: (cwd: string) => loadMCPConfig(cwd),
}))
vi.mock('../mcp/client', () => ({
  connectMCPServer: async ({ name, config }: { name: string; config?: MCPServerConfig }): Promise<LiveServerLink> => ({
    name, config, status: 'connected', tools: [],
  }),
  disconnectMCPServer: async () => {},
  invokeServerTool: async () => ({}),
}))

const {
  acquireSessionMCPPool,
  closeAllSessionMCPPools,
  closeSessionMCPPool,
  listSessionMCPPools,
  parkIdleMCPServers,
  topLevelSessionId,
  MCP_POOL_RELEASE_GRACE_MS,
  MCP_STDIO_IDLE_MS,
} = await import('../mcp/sessionPools')

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

type FakeServer = {
  transport: 'stdio' | 'http'
  tools?: MCPToolDescriptor[]
  /** Held open until resolved. */
  connectGate?: Promise<void>
}

/** A host that connects at once, unless gated; once `holdCalls()` runs, each
 *  call waits for `finish('<server>.<tool>')`, oldest first. A disconnected
 *  server answers "not connected". */
function fakeHost(servers: Record<string, FakeServer>) {
  const connects: string[] = []
  const disconnects: string[] = []
  const calls: string[] = []
  const callGates: Array<{ key: string; gate: ReturnType<typeof deferred<void>> }> = []
  const live = new Set<string>()
  let holdCalls = false
  const bridge: McpBridgeOperations = {
    async connect(id) {
      connects.push(id)
      await servers[id]?.connectGate
      live.add(id)
      return { ok: true, tools: servers[id]?.tools ?? [{ name: 'echo' }] }
    },
    async callTool(id, tool) {
      if (!live.has(id)) return { ok: false, error: `MCP server is not connected: "${id}"` }
      const key = `${id}.${tool}`
      calls.push(key)
      if (holdCalls) {
        const gate = deferred<void>()
        callGates.push({ key, gate })
        await gate.promise
      }
      return { ok: true, result: { id, tool } }
    },
    async disconnect(id) {
      disconnects.push(id)
      live.delete(id)
    },
  }
  const loadNativeServers = async () =>
    Object.entries(servers).map(([id, server]) => ({
      id,
      config: server.transport === 'stdio'
        ? { transport: 'stdio' as const, command: `${id}-mcp` }
        : { transport: 'http' as const, url: `https://${id}.example` },
    }))
  return {
    bridge,
    loadNativeServers,
    connects,
    disconnects,
    calls,
    holdCalls: () => {
      holdCalls = true
    },
    finish: (key: string) => {
      const at = callGates.findIndex(entry => entry.key === key)
      if (at < 0) throw new Error(`no held call ${key}`)
      callGates.splice(at, 1)[0]!.gate.resolve()
    },
  }
}

beforeEach(() => {
  loadMCPConfig.mockReset()
  loadMCPConfig.mockResolvedValue([])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  vi.useRealTimers()
  await closeAllSessionMCPPools()
  vi.restoreAllMocks()
})

describe('MCPPool.onServersChanged', () => {
  it('fires when a server settles or is removed and when the pool shuts down; not for parking', async () => {
    vi.useFakeTimers({ now: 1_000 })
    const servers: Record<string, FakeServer> = { gh: { transport: 'stdio' } }
    const host = fakeHost(servers)
    const { pool } = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers,
    })
    let changes = 0
    const stop = pool.onServersChanged(() => {
      changes += 1
    })

    servers.lin = { transport: 'http' }
    await pool.refreshNativeServers()
    expect(changes).toBe(1)
    expect(pool.listServers().map(server => server.name).sort()).toEqual(['gh', 'lin'])

    delete servers.gh
    await pool.refreshNativeServers()
    expect(changes).toBe(2)

    servers.st = { transport: 'stdio' }
    await pool.refreshNativeServers()
    expect(changes).toBe(3)
    vi.setSystemTime(1_000 + MCP_STDIO_IDLE_MS + 1)
    expect(await pool.parkIdleStdioServers(MCP_STDIO_IDLE_MS)).toEqual(['st'])
    expect(changes).toBe(3)

    await pool.shutdown()
    expect(changes).toBe(4)
    stop()
    servers.again = { transport: 'http' }
    await pool.refreshNativeServers()
    expect(changes).toBe(4)
  })
})

describe('acquireSessionMCPPool', () => {
  it('gives each top-level session its own pool, reading its own project config', async () => {
    const a = await acquireSessionMCPPool({ sessionId: 's1', cwd: '/p1' })
    const b = await acquireSessionMCPPool({ sessionId: 's2', cwd: '/p2' })
    expect(a.pool).not.toBe(b.pool)
    expect(loadMCPConfig.mock.calls.map(call => call[0])).toEqual(['/p1', '/p2'])
    expect(listSessionMCPPools()).toHaveLength(2)
  })

  it('sub-agents, nested sub-agents and teammates share the root pool and its connections', async () => {
    const host = fakeHost({ gh: { transport: 'stdio' } })
    const base = { cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers }
    const root = await acquireSessionMCPPool({ sessionId: 's1', ...base })
    const sub = await acquireSessionMCPPool({ sessionId: 'subagent-a', parentSessionId: 's1', ...base })
    const nested = await acquireSessionMCPPool({ sessionId: 'subagent-b', parentSessionId: 'subagent-a', ...base })
    const mate = await acquireSessionMCPPool({ sessionId: 'teammate-x', parentSessionId: 's1', ...base })
    expect(sub.pool).toBe(root.pool)
    expect(nested.pool).toBe(root.pool)
    expect(mate.pool).toBe(root.pool)
    expect(nested.topLevelSessionId).toBe('s1')
    expect(topLevelSessionId('subagent-b')).toBe('s1')
    expect(host.connects).toEqual(['gh'])
    expect(listSessionMCPPools()).toHaveLength(1)
  })

  it('concurrent acquires of one session share a single init', async () => {
    const [a, b] = await Promise.all([
      acquireSessionMCPPool({ sessionId: 's1', cwd: '/p' }),
      acquireSessionMCPPool({ sessionId: 's1', cwd: '/p' }),
    ])
    expect(a.pool).toBe(b.pool)
    expect(loadMCPConfig).toHaveBeenCalledTimes(1)
  })

  it('a thrown init leaves the pool open and the next build inits again', async () => {
    loadMCPConfig.mockRejectedValueOnce(new Error('disk'))
    const first = await acquireSessionMCPPool({ sessionId: 's1', cwd: '/p' })
    const second = await acquireSessionMCPPool({ sessionId: 's1', cwd: '/p' })
    expect(second.pool).toBe(first.pool)
    expect(loadMCPConfig).toHaveBeenCalledTimes(2)
  })

  it('a slow server does not hold the build past the boot wait and joins the pool later', async () => {
    const gate = deferred()
    const host = fakeHost({
      fast: { transport: 'stdio' },
      slow: { transport: 'stdio', connectGate: gate.promise },
    })
    const lease = await acquireSessionMCPPool({
      sessionId: 's1',
      cwd: '/p',
      nativeBridge: host.bridge,
      loadNativeServers: host.loadNativeServers,
      bootWaitMs: 5,
    })
    expect(lease.pool.getServer('fast')?.status).toBe('connected')
    expect(lease.pool.getServer('slow')).toBeUndefined()
    gate.resolve()
    await flush()
    expect(lease.pool.getServer('slow')?.status).toBe('connected')
  })
})

describe('pool lifetime', () => {
  it('a rebuild within the grace keeps the pool; the last release closes it after the grace', async () => {
    vi.useFakeTimers()
    const host = fakeHost({ gh: { transport: 'stdio' } })
    const base = { cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers }
    const first = await acquireSessionMCPPool({ sessionId: 's1', ...base })
    first.release()
    first.release()
    await vi.advanceTimersByTimeAsync(MCP_POOL_RELEASE_GRACE_MS - 1)
    const rebuilt = await acquireSessionMCPPool({ sessionId: 's1', ...base })
    expect(rebuilt.pool).toBe(first.pool)
    await vi.advanceTimersByTimeAsync(MCP_POOL_RELEASE_GRACE_MS * 2)
    expect(host.disconnects).toEqual([])

    rebuilt.release()
    await vi.advanceTimersByTimeAsync(MCP_POOL_RELEASE_GRACE_MS)
    expect(host.disconnects).toEqual(['gh'])
    expect(listSessionMCPPools()).toEqual([])
    const next = await acquireSessionMCPPool({ sessionId: 's1', ...base })
    expect(next.pool).not.toBe(first.pool)
  })

  it('a released sub-agent does not close the pool its root still holds', async () => {
    vi.useFakeTimers()
    const host = fakeHost({ gh: { transport: 'stdio' } })
    const base = { cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers }
    await acquireSessionMCPPool({ sessionId: 's1', ...base })
    const sub = await acquireSessionMCPPool({ sessionId: 'subagent-a', parentSessionId: 's1', ...base })
    sub.release()
    await vi.advanceTimersByTimeAsync(MCP_POOL_RELEASE_GRACE_MS * 2)
    expect(host.disconnects).toEqual([])
    expect(listSessionMCPPools()).toHaveLength(1)
  })

  it('closeSessionMCPPool stops the session servers at once', async () => {
    const host = fakeHost({ gh: { transport: 'stdio' } })
    const base = { cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers }
    await acquireSessionMCPPool({ sessionId: 's1', ...base })
    await acquireSessionMCPPool({ sessionId: 'subagent-a', parentSessionId: 's1', ...base })
    await acquireSessionMCPPool({ sessionId: 's2', ...base })
    await closeSessionMCPPool('s1')
    expect(host.disconnects).toEqual(['gh'])
    expect(listSessionMCPPools()).toHaveLength(1)
  })
})

describe('idle stdio parking', () => {
  it('parks a stdio server idle past the limit, keeps its tools, and restarts it on the next call', async () => {
    const host = fakeHost({ gh: { transport: 'stdio' }, api: { transport: 'http' } })
    const { pool } = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers,
    })
    const later = Date.now() + MCP_STDIO_IDLE_MS
    await parkIdleMCPServers(later - 1)
    expect(host.disconnects).toEqual([])
    await parkIdleMCPServers(later)
    expect(host.disconnects).toEqual(['gh'])
    expect(pool.getServer('gh')?.status).toBe('connected')
    expect(pool.getServer('gh')?.tools).toEqual([{ name: 'echo' }])
    await parkIdleMCPServers(later + MCP_STDIO_IDLE_MS)
    expect(host.disconnects).toEqual(['gh'])

    await expect(pool.callTool('gh', 'echo', {})).resolves.toEqual({ id: 'gh', tool: 'echo' })
    expect(host.connects.filter(id => id === 'gh')).toHaveLength(2)
  })

  it('never parks a server with a call running', async () => {
    const host = fakeHost({ gh: { transport: 'stdio' } })
    const { pool } = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers,
    })
    host.holdCalls()
    const running = pool.callTool('gh', 'echo', {})
    await flush()
    await parkIdleMCPServers(Date.now() + MCP_STDIO_IDLE_MS * 2)
    expect(host.disconnects).toEqual([])
    host.finish('gh.echo')
    await running
  })
})

describe('per-server write queue', () => {
  const tools: MCPToolDescriptor[] = [{ name: 'write' }, { name: 'read', readOnlyHint: true }]

  async function heldPool(servers: Record<string, FakeServer>) {
    const host = fakeHost(servers)
    const lease = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers,
    })
    host.holdCalls()
    return { host, pool: lease.pool }
  }

  it('runs calls to tools not marked read-only one at a time; read-only calls do not wait', async () => {
    const { host, pool } = await heldPool({ db: { transport: 'stdio', tools } })
    const first = pool.callTool('db', 'write', {})
    const second = pool.callTool('db', 'write', {})
    const read = pool.callTool('db', 'read', {})
    await flush()
    expect([...host.calls].sort()).toEqual(['db.read', 'db.write'])
    host.finish('db.write')
    await first
    await flush()
    expect(host.calls.filter(call => call === 'db.write')).toHaveLength(2)
    host.finish('db.write')
    host.finish('db.read')
    await Promise.all([second, read])
  })

  it('does not hold one server behind another', async () => {
    const { host, pool } = await heldPool({
      a: { transport: 'stdio', tools },
      b: { transport: 'stdio', tools },
    })
    const calls = [pool.callTool('a', 'write', {}), pool.callTool('b', 'write', {})]
    await flush()
    expect([...host.calls].sort()).toEqual(['a.write', 'b.write'])
    host.finish('a.write')
    host.finish('b.write')
    await Promise.all(calls)
  })

  it('an abort while queued rejects without calling, and the queue moves on', async () => {
    const { host, pool } = await heldPool({ db: { transport: 'stdio', tools } })
    const first = pool.callTool('db', 'write', {})
    const controller = new AbortController()
    const aborted = pool.callTool('db', 'write', {}, controller.signal)
    const third = pool.callTool('db', 'write', {})
    await flush()
    controller.abort(new Error('stopped'))
    await expect(aborted).rejects.toThrow('stopped')
    expect(host.calls).toEqual(['db.write'])
    host.finish('db.write')
    await first
    await flush()
    expect(host.calls).toEqual(['db.write', 'db.write'])
    host.finish('db.write')
    await third
  })

  it('aborting the newest queued call keeps later calls behind the running one', async () => {
    const { host, pool } = await heldPool({ db: { transport: 'stdio', tools } })
    const first = pool.callTool('db', 'write', {})
    const controller = new AbortController()
    const aborted = pool.callTool('db', 'write', {}, controller.signal)
    await flush()
    controller.abort(new Error('stopped'))
    await expect(aborted).rejects.toThrow('stopped')
    const next = pool.callTool('db', 'write', {})
    await flush()
    expect(host.calls).toEqual(['db.write'])
    host.finish('db.write')
    await first
    await flush()
    expect(host.calls).toEqual(['db.write', 'db.write'])
    host.finish('db.write')
    await next
  })
})

describe('pool sources and keys', () => {
  it('a re-acquire reads settings through the newest holder, not a released one', async () => {
    vi.useFakeTimers()
    const host = fakeHost({ gh: { transport: 'stdio' } })
    let firstDisposed = false
    const firstLoad = async () => (firstDisposed ? [] : host.loadNativeServers())
    const first = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: firstLoad,
    })
    first.release()
    firstDisposed = true
    const disposed = vi.fn(async () => [])
    const rebuilt = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers,
    })
    expect(rebuilt.pool).toBe(first.pool)
    const sub = await acquireSessionMCPPool({
      sessionId: 'subagent-a', parentSessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: disposed,
    })
    await sub.pool.refreshNativeServers()
    expect(disposed).not.toHaveBeenCalled()
    expect(host.disconnects).toEqual([])
    expect(rebuilt.pool.getServer('gh')?.status).toBe('connected')
  })

  it('the session back with another project folder gets a fresh pool', async () => {
    const host = fakeHost({ gh: { transport: 'stdio' } })
    const base = { nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers }
    const first = await acquireSessionMCPPool({ sessionId: 's1', cwd: '/workspace', ...base })
    first.release()
    const rebound = await acquireSessionMCPPool({ sessionId: 's1', cwd: '/project', ...base })
    await flush()
    expect(rebound.pool).not.toBe(first.pool)
    expect(loadMCPConfig.mock.calls.map(call => call[0])).toEqual(['/workspace', '/project'])
    expect(host.disconnects).toEqual(['gh'])
    expect(listSessionMCPPools()).toEqual([rebound.pool])
  })

  it('a descendant spawned after an intermediate agent ended still shares the root pool', async () => {
    const root = await acquireSessionMCPPool({ sessionId: 's1', cwd: '/p' })
    const a = await acquireSessionMCPPool({ sessionId: 'subagent-a', parentSessionId: 's1', cwd: '/p' })
    await acquireSessionMCPPool({ sessionId: 'subagent-b', parentSessionId: 'subagent-a', cwd: '/p' })
    a.release()
    const c = await acquireSessionMCPPool({ sessionId: 'subagent-c', parentSessionId: 'subagent-b', cwd: '/p' })
    expect(c.pool).toBe(root.pool)
    expect(c.topLevelSessionId).toBe('s1')
    expect(listSessionMCPPools()).toHaveLength(1)
  })

  it('a connect that settles after the pool closed is undone', async () => {
    const gate = deferred()
    const host = fakeHost({ slow: { transport: 'stdio', connectGate: gate.promise } })
    const lease = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers, bootWaitMs: 5,
    })
    await closeSessionMCPPool('s1')
    gate.resolve()
    await flush()
    expect(host.disconnects).toEqual(['slow'])
    expect(lease.pool.getServer('slow')).toBeUndefined()
  })
})

describe('native restart on a call', () => {
  it('a failed relaunch marks the server failed with its reason', async () => {
    const host = fakeHost({ gh: { transport: 'stdio' } })
    const { pool } = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers,
    })
    let changes = 0
    pool.onServersChanged(() => {
      changes += 1
    })
    await parkIdleMCPServers(Date.now() + MCP_STDIO_IDLE_MS)
    host.bridge.connect = async () => ({ ok: false, tools: [], error: 'SECRET_UNAVAILABLE' })
    await expect(pool.callTool('gh', 'echo', {})).rejects.toThrow('SECRET_UNAVAILABLE')
    expect(pool.getServer('gh')?.status).toBe('failed')
    expect(changes).toBe(1)
  })

  it('a server being removed is not relaunched by a call', async () => {
    const servers: Record<string, FakeServer> = { gh: { transport: 'stdio' } }
    const host = fakeHost(servers)
    const { pool } = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers,
    })
    const closing = deferred()
    const disconnect = host.bridge.disconnect
    host.bridge.disconnect = async id => {
      await closing.promise
      await disconnect(id)
    }
    delete servers.gh
    const refresh = pool.refreshNativeServers()
    await flush()
    await expect(pool.callTool('gh', 'echo', {})).rejects.toThrow('not connected')
    closing.resolve()
    await refresh
    expect(host.connects).toEqual(['gh'])
    expect(pool.getServer('gh')).toBeUndefined()
  })
})

describe('plugin server changes', () => {
  const http = (name: string, url: string): MCPServerConfigWithName => ({ name, type: 'http', url })

  it('setExtraServers drops removed servers, connects new ones and leaves project names alone', async () => {
    loadMCPConfig.mockResolvedValue([http('shared', 'https://project.example')])
    const { pool } = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p',
      extraServers: [http('old', 'https://old.example'), http('shared', 'https://plugin.example')],
    })
    expect([...pool.projectServerNames]).toEqual(['shared'])
    await pool.setExtraServers([http('new', 'https://new.example'), http('shared', 'https://plugin2.example')])
    expect(pool.listServers().map(server => server.name).sort()).toEqual(['new', 'shared'])
    expect(pool.getServer('shared')?.config).toMatchObject({ url: 'https://project.example' })
  })

  it('followPluginReload takes the new native list and relaunches a server whose stored secret changed', async () => {
    const servers: Record<string, FakeServer> = { gh: { transport: 'stdio' }, dropped: { transport: 'stdio' } }
    const host = fakeHost(servers)
    let secretRef = ''
    const loadNativeServers = async () =>
      (await host.loadNativeServers()).map(entry =>
        entry.id === 'gh' ? { ...entry, config: { ...entry.config, env: { TOKEN: secretRef } } } : entry,
      )
    secretRef = '{{secret:plugin:p/env/token}}'
    const { pool } = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers,
    })
    delete servers.dropped
    servers.added = { transport: 'http' }
    await pool.followPluginReload([], new Set(['plugin:p/env/token']))
    expect(pool.listServers().map(server => server.name).sort()).toEqual(['added', 'gh'])
    expect(host.disconnects.sort()).toEqual(['dropped', 'gh'])
    expect(host.connects.filter(id => id === 'gh')).toHaveLength(2)

    await pool.followPluginReload([], new Set(['plugin:other/env/x']))
    expect(host.connects.filter(id => id === 'gh')).toHaveLength(2)
  })

  it('restartNativeServers relaunches with the recorded config', async () => {
    const host = fakeHost({ gh: { transport: 'stdio' } })
    const { pool } = await acquireSessionMCPPool({
      sessionId: 's1', cwd: '/p', nativeBridge: host.bridge, loadNativeServers: host.loadNativeServers,
    })
    await pool.restartNativeServers(['gh', 'missing'])
    expect(host.disconnects).toEqual(['gh'])
    expect(host.connects).toEqual(['gh', 'gh'])
    expect(pool.getServer('gh')?.status).toBe('connected')
  })
})
