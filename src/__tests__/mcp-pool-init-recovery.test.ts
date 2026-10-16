/**
 * Pool init and per-server recovery: a thrown init runs again, a concurrent
 * init caller waits for the run in flight, failed servers are retried on
 * refresh, and one server is never connected twice at once. The per-session
 * registry: mcp-session-pools.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpBridgeOperations } from '../mcp/nativeBridge'
import type { LiveServerLink, MCPServerConfigWithName } from '../mcp/types'

type ConnectArgs = { name: string; config: LiveServerLink['config'] }

const loadMCPConfig = vi.fn<() => Promise<MCPServerConfigWithName[]>>()
const connectMCPServer = vi.fn<(o: ConnectArgs) => Promise<LiveServerLink>>()

vi.mock('../mcp/config', () => ({
  loadMCPConfig: () => loadMCPConfig(),
}))
vi.mock('../mcp/client', () => ({
  connectMCPServer: (o: ConnectArgs) => connectMCPServer(o),
  disconnectMCPServer: async () => {},
  invokeServerTool: async () => ({}),
}))

const { MCPPool } = await import('../mcp/pool')

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const tick = () => new Promise(r => setTimeout(r, 0))

const failedLink = async ({ name, config }: ConnectArgs): Promise<LiveServerLink> => ({
  name, config, status: 'failed', tools: [], error: 'refused',
})
const connectedLink = async ({ name, config }: ConnectArgs): Promise<LiveServerLink> => {
  await tick()
  return { name, config, status: 'connected', tools: [] }
}

function nativeBridge(outcomes: Array<'ok' | 'fail'>) {
  const connects: string[] = []
  let i = 0
  const bridge: McpBridgeOperations = {
    async connect(id) {
      connects.push(id)
      const outcome = outcomes[Math.min(i++, outcomes.length - 1)]
      await tick()
      return outcome === 'ok'
        ? { ok: true, tools: [{ name: 'echo' }] }
        : { ok: false, tools: [], error: `boom ${i}` }
    },
    async callTool() {
      return { ok: true, result: {} }
    },
    async disconnect() {},
  }
  return { bridge, connects }
}

const nativeList = async () => [
  { id: 'gh', config: { transport: 'stdio' as const, command: 'gh-mcp' } },
]

const httpEntry = { name: 'a', type: 'http', url: 'http://a' } as MCPServerConfigWithName

beforeEach(() => {
  loadMCPConfig.mockReset()
  connectMCPServer.mockReset()
  loadMCPConfig.mockResolvedValue([])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('MCPPool.init', () => {
  it('a concurrent second init() waits for the run in flight', async () => {
    const gate = deferred<MCPServerConfigWithName[]>()
    loadMCPConfig.mockReturnValueOnce(gate.promise)
    connectMCPServer.mockImplementation(connectedLink)
    const pool = new MCPPool({ cwd: '/w' })
    const first = pool.init()
    let secondDone = false
    const second = pool.init().then(() => {
      secondDone = true
    })
    await tick()
    expect(secondDone).toBe(false)
    gate.resolve([httpEntry])
    await Promise.all([first, second])
    expect(pool.getServer('a')?.status).toBe('connected')
    expect(loadMCPConfig).toHaveBeenCalledTimes(1)
  })

  it('a thrown init() runs again on the next call', async () => {
    loadMCPConfig.mockRejectedValueOnce(new Error('disk'))
    const pool = new MCPPool({ cwd: '/w' })
    await expect(pool.init()).rejects.toThrow('disk')
    await pool.init()
    expect(loadMCPConfig).toHaveBeenCalledTimes(2)
  })
})

describe('per-server recovery on refresh', () => {
  it('a failed native server is retried once per refresh, keeps its reason, then recovers', async () => {
    const { bridge, connects } = nativeBridge(['fail', 'fail', 'ok'])
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: nativeList })
    await pool.init()
    expect(pool.getServer('gh')?.status).toBe('failed')
    expect(pool.getServer('gh')?.error).toBe('boom 1')

    await pool.refreshNativeServers()
    expect(connects).toHaveLength(2)
    expect(pool.getServer('gh')?.error).toBe('boom 2')

    await pool.refresh()
    expect(connects).toHaveLength(3)
    expect(pool.getServer('gh')?.status).toBe('connected')
    expect(pool.getServer('gh')?.error).toBeUndefined()

    await pool.refresh()
    expect(connects).toHaveLength(3)
  })

  it('never connects the same native server twice under concurrent refreshes', async () => {
    const { bridge, connects } = nativeBridge(['fail', 'ok'])
    const pool = new MCPPool({ cwd: '/w', nativeBridge: bridge, loadNativeServers: nativeList })
    await pool.init()
    await Promise.all([pool.refresh(), pool.refresh(), pool.refreshNativeServers()])
    expect(connects).toEqual(['gh', 'gh'])
    expect(pool.getServer('gh')?.status).toBe('connected')
  })

  it('a browser server is not double-connected by refreshes racing addServer', async () => {
    loadMCPConfig.mockResolvedValue([httpEntry])
    connectMCPServer.mockImplementationOnce(failedLink).mockImplementation(connectedLink)
    const pool = new MCPPool({ cwd: '/w' })
    await pool.init()
    await Promise.all([pool.refresh(), pool.refresh(), pool.addServer(httpEntry)])
    expect(connectMCPServer).toHaveBeenCalledTimes(2)
    expect(pool.getServer('a')?.status).toBe('connected')
  })
})
