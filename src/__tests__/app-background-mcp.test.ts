/**
 * `$.mcp` of an app's background module (F-40): a pool of the module's own,
 * built at the first call and shut at the close; its plugin's manifest
 * servers connect, substituted with the settings read at the connect; any
 * other server is unlisted, and a call names the module's servers alone.
 */
import { describe, expect, it, vi } from 'vitest'

import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { LiveServerLink, MCPServerConfigWithName } from '../mcp/types'
import {
  createAppBackgroundMcp,
  sameMcpOwner,
  type AppBackgroundMcpOptions,
  type AppBackgroundMcpOwner,
  type AppBackgroundMcpPool,
} from '../mods/app/appBackgroundMcp'

const FOLDER = 'C:/home/.velloc/shared-workspace/app-pay-board'

const OWNER: AppBackgroundMcpOwner = {
  name: 'pay',
  path: '/plugins/pay',
  manifest: { name: 'pay' } as never,
  mcpServers: { docs: { type: 'http', url: 'https://docs.test/x?k=${TOKEN}' } },
  nativeMcpServers: { shell: { transport: 'stdio', command: '${BIN}/s' } },
}

function fakePool() {
  const servers: LiveServerLink[] = []
  const pool = {
    inits: 0,
    shutdowns: 0,
    async init() {
      pool.inits += 1
    },
    async shutdown() {
      pool.shutdowns += 1
    },
    listServers: () => servers,
    addServer: vi.fn(async (entry: MCPServerConfigWithName) => {
      const { name, ...config } = entry
      const link = { name, config, status: 'connected', tools: [] } as unknown as LiveServerLink
      servers.push(link)
      return link
    }),
    launchNativeServer: vi.fn(async (name: string, config: NexusMcpServerLaunchConfig) => {
      const link = { name, nativeServerId: name, nativeConfig: config, status: 'connected', tools: [] } as unknown as LiveServerLink
      servers.push(link)
      return link
    }),
    callTool: vi.fn(async (server: string, tool: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: `${server}/${tool} ${JSON.stringify(args)}` }],
    })),
  }
  return pool
}

function rig(options: Partial<AppBackgroundMcpOptions> = {}) {
  const pools: ReturnType<typeof fakePool>[] = []
  const reports: string[] = []
  const createPool = vi.fn((_: { cwd: string }) => {
    const pool = fakePool()
    pools.push(pool)
    return pool as unknown as AppBackgroundMcpPool
  })
  const scope = vi.fn(async () => ({}))
  const mcp = createAppBackgroundMcp({
    owner: OWNER,
    folder: FOLDER,
    scope,
    getEnv: name => (name === 'TOKEN' ? 't0k' : name === 'BIN' ? '/plugins/pay/bin' : undefined),
    createPool,
    report: line => reports.push(line),
    ...options,
  })
  return { mcp, pools, reports, createPool, scope }
}

describe('createAppBackgroundMcp', () => {
  it("builds the pool once, at the first call, with the app's folder; a manifest server connects substituted, and the call reaches it", async () => {
    const { mcp, pools, createPool, scope } = rig()
    expect(createPool).not.toHaveBeenCalled()
    await expect(mcp.host.call({ server: 'docs', tool: 'search', args: {} }, {})).rejects.toMatchObject({
      name: 'NotFoundError',
      message: '$.mcp.call: no MCP server "docs" (listed: none)',
    })
    expect(createPool).toHaveBeenCalledWith({ cwd: FOLDER })
    expect(pools[0]!.inits).toBe(1)
    expect(await mcp.host.connect('pay', 'docs')).toEqual({ isConnected: true, server: 'docs' })
    expect(pools[0]!.addServer).toHaveBeenCalledWith({ name: 'docs', type: 'http', url: 'https://docs.test/x?k=t0k' })
    expect(await mcp.host.call({ server: 'docs', tool: 'search', args: { q: 1 } }, {})).toEqual({
      content: [{ type: 'text', text: 'docs/search {"q":1}' }],
      isError: false,
    })
    expect(await mcp.host.connect('pay', 'docs')).toEqual({ isConnected: true, server: 'docs' })
    expect(pools[0]!.addServer).toHaveBeenCalledTimes(1)
    expect(scope).toHaveBeenCalledTimes(2)
    expect(createPool).toHaveBeenCalledTimes(1)
  })

  it("another plugin's key and a key the manifest does not list are unlisted; a stdio server is launched under its own id with the manifest's config", async () => {
    const { mcp, pools } = rig()
    expect(await mcp.host.connect('other', 'docs')).toEqual({
      isConnected: false,
      reason: 'unlisted',
      message: '"docs" is not an MCP server in other\'s manifest',
    })
    expect(await mcp.host.connect('pay', 'nope')).toEqual({
      isConnected: false,
      reason: 'unlisted',
      message: '"nope" is not an MCP server in pay\'s manifest',
    })
    expect(await mcp.host.connect('pay', 'shell')).toEqual({ isConnected: true, server: 'shell' })
    expect(pools[0]!.launchNativeServer).toHaveBeenCalledWith(
      'shell',
      { transport: 'stdio', command: '/plugins/pay/bin/s' },
      { replaceConfig: true },
    )
    expect(pools[0]!.addServer).not.toHaveBeenCalled()
  })

  it('close shuts the pool down and ends $.mcp; a settings read that fails is reported and the connect goes on without it', async () => {
    const { mcp, pools } = rig()
    await mcp.host.connect('pay', 'docs')
    await mcp.close()
    await mcp.close()
    expect(pools[0]!.shutdowns).toBe(1)
    await expect(mcp.host.connect('pay', 'docs')).rejects.toMatchObject({
      name: 'NotSupportedError',
      message: '$.mcp is not available: the background module is stopped',
    })
    const unread = rig({ scope: async () => Promise.reject(new Error('EACCES')) })
    expect(await unread.mcp.host.connect('pay', 'docs')).toEqual({ isConnected: true, server: 'docs' })
    expect(unread.reports).toEqual([
      "pay: the plugin's settings could not be read for $.mcp.connect; options and keys unresolved (EACCES)",
    ])
    const idle = rig()
    await idle.mcp.close()
    expect(idle.createPool).not.toHaveBeenCalled()
  })

  it('a pool whose init fails is shut and not kept: the next call builds again', async () => {
    let failures = 1
    const { mcp, pools, createPool } = rig({
      createPool: () => {
        const pool = fakePool()
        if (failures-- > 0) pool.init = async () => Promise.reject(new Error('no host'))
        pools.push(pool)
        return pool as unknown as AppBackgroundMcpPool
      },
    })
    void createPool
    await expect(mcp.host.connect('pay', 'docs')).rejects.toThrow('no host')
    expect(pools[0]!.shutdowns).toBe(1)
    expect(await mcp.host.connect('pay', 'docs')).toEqual({ isConnected: true, server: 'docs' })
    expect(pools).toHaveLength(2)
    expect(pools[1]!.inits).toBe(1)
  })

  it('sameMcpOwner: the same plugin with the same servers; a changed server list is another', () => {
    expect(sameMcpOwner(OWNER, { ...OWNER })).toBe(true)
    expect(sameMcpOwner(undefined, undefined)).toBe(true)
    expect(sameMcpOwner(OWNER, undefined)).toBe(false)
    expect(sameMcpOwner(OWNER, { ...OWNER, nativeMcpServers: {} })).toBe(false)
    expect(sameMcpOwner(OWNER, { ...OWNER, mcpServers: { docs: { type: 'http', url: 'https://else.test/mcp' } } })).toBe(false)
    expect(sameMcpOwner(OWNER, { ...OWNER, path: '/elsewhere/pay' })).toBe(false)
  })
})
