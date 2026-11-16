/**
 * The MCP client loads on first use (F-10): a client that fails to load leaves
 * a failed server the pool shows and retries, and closing a server that never
 * connected does not go through the client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveServerLink, MCPServerConfigWithName } from '../mcp/types'

type ConnectArgs = { name: string; config: LiveServerLink['config'] }

const loadMCPConfig = vi.fn<() => Promise<MCPServerConfigWithName[]>>()
const connectMCPServer = vi.fn<(o: ConnectArgs) => Promise<LiveServerLink>>()
const disconnectMCPServer = vi.fn(async (server: LiveServerLink) => {
  server.status = 'closed'
})
const clientLoads = { fail: false }

vi.mock('../mcp/config', () => ({
  loadMCPConfig: () => loadMCPConfig(),
}))
vi.mock('../mcp/client', () => {
  if (clientLoads.fail) throw new Error('Failed to fetch dynamically imported module')
  return {
    connectMCPServer: (o: ConnectArgs) => connectMCPServer(o),
    disconnectMCPServer: (server: LiveServerLink) => disconnectMCPServer(server),
    invokeServerTool: async () => ({}),
  }
})

const { MCPPool } = await import('../mcp/pool')

const httpEntry = { name: 'a', type: 'http', url: 'http://a' } as MCPServerConfigWithName

beforeEach(() => {
  disconnectMCPServer.mockClear()
  clientLoads.fail = false
  loadMCPConfig.mockReset()
  connectMCPServer.mockReset()
  loadMCPConfig.mockResolvedValue([httpEntry])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('MCPPool with a lazily loaded client', () => {
  it('a client that fails to load leaves a failed server, and refresh retries it', async () => {
    clientLoads.fail = true
    const pool = new MCPPool({ cwd: '/w' })
    await pool.init()
    expect(pool.getServer('a')).toMatchObject({
      status: 'failed',
      error: expect.any(String),
    })

    clientLoads.fail = false
    connectMCPServer.mockImplementation(async ({ name, config }) => ({ name, config, status: 'connected', tools: [] }))
    await pool.refresh()
    expect(pool.getServer('a')?.status).toBe('connected')
  })

  it('shutting down a server that never connected closes it without the client', async () => {
    connectMCPServer.mockImplementation(async ({ name, config }) => ({ name, config, status: 'failed', tools: [], error: 'refused' }))
    const pool = new MCPPool({ cwd: '/w' })
    await pool.init()
    const server = pool.getServer('a')!
    await pool.shutdown()
    expect(disconnectMCPServer).not.toHaveBeenCalled()
    expect(server.status).toBe('closed')
  })
})
