/**
 * `MCPPoolOptions.projectServers` (F-25): `false` keeps the project's server
 * file out of the pool — it is never read — while the plugin servers given
 * still connect; the default reads it. The per-session registry threads the
 * option through to the pool it creates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveServerLink, MCPServerConfig, MCPServerConfigWithName } from '../mcp/types'

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

const { MCPPool } = await import('../mcp/pool')
const { acquireSessionMCPPool, closeAllSessionMCPPools } = await import('../mcp/sessionPools')

const projectEntry = { name: 'from-project', type: 'http', url: 'http://project' } as MCPServerConfigWithName
const pluginEntry = { name: 'from-plugin', type: 'http', url: 'http://plugin' } as MCPServerConfigWithName

beforeEach(() => {
  loadMCPConfig.mockReset()
  loadMCPConfig.mockResolvedValue([projectEntry])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  await closeAllSessionMCPPools()
  vi.restoreAllMocks()
})

describe('MCPPool.projectServers', () => {
  it('false: the project file is not read, the plugin servers connect, no project name is recorded', async () => {
    const pool = new MCPPool({ cwd: '/p', extraServers: [pluginEntry], projectServers: false })
    await pool.init()
    expect(loadMCPConfig).not.toHaveBeenCalled()
    expect(pool.listServers().map(server => server.name)).toEqual(['from-plugin'])
    expect(pool.projectServerNames.size).toBe(0)
    await pool.shutdown()
  })

  it('default: the project file is read from cwd and its servers join', async () => {
    const pool = new MCPPool({ cwd: '/p', extraServers: [pluginEntry] })
    await pool.init()
    expect(loadMCPConfig).toHaveBeenCalledWith('/p')
    expect(pool.listServers().map(server => server.name).sort()).toEqual(['from-plugin', 'from-project'])
    expect([...pool.projectServerNames]).toEqual(['from-project'])
    await pool.shutdown()
  })

  it('acquireSessionMCPPool hands the option to the pool it creates', async () => {
    const lease = await acquireSessionMCPPool({ sessionId: 's1', cwd: '/p', extraServers: [pluginEntry], projectServers: false })
    expect(loadMCPConfig).not.toHaveBeenCalled()
    expect(lease.pool.listServers().map(server => server.name)).toEqual(['from-plugin'])
    lease.release()
  })
})
