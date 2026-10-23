/**
 * `$.mcp.call` / `$.mcp.connect` (F-25): argument checks, server naming (`mcp__` spelling), the result shape,
 * `MCPPool.addServer` (collisions, retry after failure, one connect for concurrent calls), `poolModMcp` over a real
 * pool, including the launch of a stdio server that failed or never started, and both nouns through a real
 * `ModRuntime`, including a guard denying another plugin's call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpBridgeOperations } from '../mcp/nativeBridge'
import type { MCPServerConfig, MCPServerConfigWithName } from '../mcp/types'

const configured: { servers: MCPServerConfigWithName[] } = { servers: [] }
const connects: string[] = []

vi.mock('../mcp/config', () => ({
  loadMCPConfig: async () => configured.servers,
}))
vi.mock('../mcp/client', () => ({
  // A url naming `down` fails to connect, as `connectMCPServer` reports it:
  // a `failed` server, never a rejection.
  connectMCPServer: async ({ name, config }: { name: string; config: MCPServerConfig }) => {
    connects.push(name)
    await Promise.resolve()
    return config.url.includes('down')
      ? { name, config, status: 'failed', tools: [], error: 'ECONNREFUSED' }
      : { name, config, status: 'connected', tools: [{ name: 'echo' }] }
  },
  invokeServerTool: async (server: { name: string }, tool: string, args: Record<string, unknown>) => ({
    content: [{ type: 'text', text: `${server.name}/${tool} ${JSON.stringify(args)}` }],
    isError: tool === 'boom',
    ...(tool === 'structured' ? { structuredContent: { n: 1 } } : {}),
  }),
  disconnectMCPServer: async (server: { status: string }) => {
    server.status = 'closed'
  },
}))

const { MCPPool } = await import('../mcp/pool')
const { ModRuntime } = await import('../mods/ModRuntime')
const { installModWorkerHost } = await import('../mods/ModWorkerHost')
const {
  mcpCallInput,
  mcpConnectInput,
  mcpToolResultOf,
  poolModMcp,
  resolveMcpServerName,
} = await import('../mods/modMcp')
type ModMcpManifestServer = import('../mods/modMcp').ModMcpManifestServer
type ModNounHost = import('../mods/modNouns').ModNounHost
type ModModuleRef = import('../mods/ModRuntime').ModModuleRef
type ModWorkerHandle = import('../mods/ModRuntime').ModWorkerHandle

const open: MessagePort[] = []
const runtimes: Array<InstanceType<typeof ModRuntime>> = []
beforeEach(() => {
  configured.servers = []
  connects.length = 0
})
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

async function pool(servers: MCPServerConfigWithName[] = []) {
  configured.servers = servers
  const built = new MCPPool({ cwd: '/work' })
  await built.init()
  connects.length = 0
  return built
}

describe('the arguments, the name, the result', () => {
  it('call takes (server, tool, args?) and connect (server); anything else is refused by name', () => {
    expect(mcpCallInput(['gh', 'issue', { title: 't' }])).toEqual({ server: 'gh', tool: 'issue', args: { title: 't' } })
    expect(mcpCallInput(['gh', 'issue'])).toEqual({ server: 'gh', tool: 'issue', args: {} })
    expect(() => mcpCallInput(['', 'issue'])).toThrow('$.mcp.call(server, tool, args): server must be a non-empty string')
    expect(() => mcpCallInput(['gh'])).toThrow(/tool must be a non-empty string/)
    expect(() => mcpCallInput(['gh', 'issue', ['x']])).toThrow(/args must be an object/)
    expect(mcpConnectInput(['browser'])).toEqual({ server: 'browser' })
    expect(() => mcpConnectInput([42])).toThrow('$.mcp.connect(server): server must be a non-empty string')
  })

  it('a server is named as listed, or by its mcp__ spelling; none, or a spelling two share, rejects naming what is listed', () => {
    const names = ['claude.ai Gmail', 'gh', 'a b', 'a-b', 'a.b']
    expect(resolveMcpServerName(names, 'gh')).toBe('gh')
    expect(resolveMcpServerName(names, 'claude.ai Gmail')).toBe('claude.ai Gmail')
    expect(resolveMcpServerName(names, 'claude_ai_Gmail')).toBe('claude.ai Gmail')
    // `a-b` is listed as is; `a_b` is the spelling of both `a b` and `a.b`.
    expect(resolveMcpServerName(names, 'a-b')).toBe('a-b')
    expect(() => resolveMcpServerName(names, 'a_b')).toThrow('"a_b" is the spelling of "a b" and "a.b"')
    expect(() => resolveMcpServerName(['gh'], 'jira')).toThrow('$.mcp.call: no MCP server "jira" (listed: "gh")')
    expect(() => resolveMcpServerName([], 'jira')).toThrow('(listed: none)')
  })

  it('the result is the SDK shape, plain data: blocks kept, isError a boolean, structuredContent when present; other forms one text block', () => {
    expect(mcpToolResultOf({ content: [{ type: 'image', data: 'AA', mimeType: 'image/png' }, 'loose'], structuredContent: { a: 1 } })).toEqual({
      content: [{ type: 'image', data: 'AA', mimeType: 'image/png' }, { type: 'text', text: 'loose' }],
      isError: false,
      structuredContent: { a: 1 },
    })
    expect(mcpToolResultOf({ content: [], isError: true })).toEqual({ content: [], isError: true })
    expect(mcpToolResultOf({ toolResult: { ok: 1 } })).toEqual({ content: [{ type: 'text', text: '{"ok":1}' }], isError: false })
    expect(mcpToolResultOf('plain')).toEqual({ content: [{ type: 'text', text: 'plain' }], isError: false })
  })
})

describe('pluginMcpServer', () => {
  it("one plugin's manifest server by its key, substituted as the pool's are; a key it does not list is undefined", async () => {
    const { pluginMcpServer } = await import('../pluginHost')
    const plugin = {
      name: 'docs',
      manifest: { name: 'docs' },
      path: '/plugins/docs',
      mcpServers: { search: { type: 'http' as const, url: '${CLAUDE_PLUGIN_ROOT}/x?k=${TOKEN}' } },
      nativeMcpServers: { shell: { transport: 'stdio' as const, command: '${CLAUDE_PLUGIN_ROOT}/bin/s' } },
    }
    const env = { getEnv: (name: string) => (name === 'TOKEN' ? 't0k' : undefined) }
    expect(pluginMcpServer(plugin, 'search', env)).toEqual({
      kind: 'browser',
      entry: { name: 'search', type: 'http', url: '/plugins/docs/x?k=t0k' },
    })
    expect(pluginMcpServer(plugin, 'shell', env)).toEqual({
      kind: 'native',
      id: 'shell',
      config: { transport: 'stdio', command: '/plugins/docs/bin/s' },
    })
    expect(pluginMcpServer(plugin, 'toString', env)).toBeUndefined()
    const bad = { ...plugin, mcpServers: { search: { type: 'http' as const, url: 'https://h/mcp', headers: { X: 3 as unknown as string } } } }
    expect(pluginMcpServer(bad, 'search', env)).toEqual({ kind: 'refused', reason: 'a header or env value is not text' })
    expect(pluginMcpServer({ name: 'p', manifest: { name: 'p' }, path: '/p' }, 'search', env)).toBeUndefined()
  })
})

describe('MCPPool.addServer', () => {
  it('connects a server the pool does not run; a name already registered wins and is answered as it is', async () => {
    const p = await pool([{ name: 'gh', type: 'http', url: 'https://gh.test/mcp' }])
    const added = await p.addServer({ name: 'docs', type: 'http', url: 'https://docs.test/mcp' })
    expect(added).toMatchObject({ name: 'docs', status: 'connected' })
    expect(p.hasServer('docs')).toBe(true)
    const kept = await p.addServer({ name: 'gh', type: 'http', url: 'https://other.test/mcp' })
    expect(kept.config).toEqual({ type: 'http', url: 'https://gh.test/mcp' })
    expect(connects).toEqual(['docs'])
  })

  it('a failed server with the same config is connected again; concurrent calls share the one connect; a failure never rejects', async () => {
    const p = await pool([{ name: 'flaky', type: 'http', url: 'https://down.test/mcp' }])
    expect(p.getServer('flaky')?.status).toBe('failed')
    const [a, b] = await Promise.all([
      p.addServer({ name: 'flaky', type: 'http', url: 'https://down.test/mcp' }),
      p.addServer({ name: 'flaky', type: 'http', url: 'https://down.test/mcp' }),
    ])
    expect(a).toBe(b)
    expect(a).toMatchObject({ status: 'failed', error: 'ECONNREFUSED' })
    expect(connects).toEqual(['flaky'])
  })
})

describe('poolModMcp', () => {
  const manifests: Record<string, Record<string, ModMcpManifestServer>> = {
    docs: {
      search: { kind: 'browser', entry: { name: 'search', type: 'http', url: 'https://search.test/mcp' } },
      broken: { kind: 'browser', entry: { name: 'broken', type: 'http', url: 'https://down.test/mcp' } },
      gh: { kind: 'browser', entry: { name: 'gh', type: 'http', url: 'https://mine.test/mcp' } },
      shell: { kind: 'native', id: 'shell', config: { transport: 'stdio', command: 'node', args: ['s.js'] } },
      later: { kind: 'native', id: 'later', config: { transport: 'stdio', command: 'node', args: ['l.js'] } },
      locked: { kind: 'refused', reason: 'sensitive option "k" needs an https server URL' },
    },
  }
  const manifestServer = (plugin: string, key: string) => manifests[plugin]?.[key]

  it("connects a manifest server the pool does not run, then answers at once; the same server under another name answers with that name", async () => {
    const p = await pool([{ name: 'shared-search', type: 'http', url: 'https://search.test/mcp' }])
    const mcp = poolModMcp({ pool: () => p, manifestServer })
    expect(await mcp.connect('docs', 'search')).toEqual({ isConnected: true, server: 'shared-search' })
    expect(connects).toEqual([])
    const fresh = await pool()
    const mcp2 = poolModMcp({ pool: () => fresh, manifestServer })
    expect(await mcp2.connect('docs', 'search')).toEqual({ isConnected: true, server: 'search' })
    expect(await mcp2.connect('docs', 'search')).toEqual({ isConnected: true, server: 'search' })
    expect(connects).toEqual(['search'])
    expect(await mcp2.call({ server: 'search', tool: 'echo', args: { q: 1 } }, {})).toEqual({
      content: [{ type: 'text', text: 'search/echo {"q":1}' }],
      isError: false,
    })
  })

  it('refuses without rejecting: another plugin\'s server is unlisted, a name another server holds or a failed connect is failed', async () => {
    const p = await pool([{ name: 'gh', type: 'http', url: 'https://theirs.test/mcp' }])
    const mcp = poolModMcp({ pool: () => p, manifestServer })
    expect(await mcp.connect('other', 'search')).toEqual({
      isConnected: false,
      reason: 'unlisted',
      message: `"search" is not an MCP server in other's manifest`,
    })
    expect(await mcp.connect('docs', 'gh')).toEqual({
      isConnected: false,
      reason: 'failed',
      message: '"gh" is another MCP server\'s name in this session',
    })
    expect(await mcp.connect('docs', 'broken')).toEqual({
      isConnected: false,
      reason: 'failed',
      message: '"broken" did not connect: ECONNREFUSED',
    })
    expect(await poolModMcp({ pool: () => null, manifestServer }).connect('docs', 'search')).toMatchObject({ isConnected: false, reason: 'failed' })
    expect(await mcp.connect('docs', 'locked')).toEqual({
      isConnected: false,
      reason: 'failed',
      message: '"locked" cannot start: sensitive option "k" needs an https server URL',
    })
  })

  it('a connected native manifest server is answered from the pool under its name, with no launch', async () => {
    const fake = {
      listServers: () => [
        { name: 'shell', nativeServerId: 'shell', nativeConfig: { transport: 'stdio', command: 'node', args: ['s.js'] }, status: 'connected', tools: [] },
      ],
      callTool: vi.fn(),
      addServer: vi.fn(),
      launchNativeServer: vi.fn(),
    }
    const mcp = poolModMcp({ pool: () => fake as never, manifestServer })
    expect(await mcp.connect('docs', 'shell')).toEqual({ isConnected: true, server: 'shell' })
    expect(fake.launchNativeServer).not.toHaveBeenCalled()
    expect(fake.addServer).not.toHaveBeenCalled()
  })
})

describe('poolModMcp over native (stdio) servers', () => {
  const shell = { transport: 'stdio' as const, command: 'node', args: ['s.js'] }
  const manifests: Record<string, Record<string, ModMcpManifestServer>> = {
    docs: {
      shell: { kind: 'native', id: 'shell', config: shell },
      later: { kind: 'native', id: 'later', config: { transport: 'stdio', command: 'node', args: ['l.js'] } },
    },
  }
  const manifestServer = (plugin: string, key: string) => manifests[plugin]?.[key]

  /** A pool whose session started `natives`; each bridge connect takes the next outcome (the last repeats). */
  async function nativePool(outcomes: Array<'ok' | 'fail'>, natives: Array<{ id: string; config: typeof shell }>) {
    const launches: string[] = []
    const stops: string[] = []
    let i = 0
    const nativeBridge: McpBridgeOperations = {
      async connect(id) {
        launches.push(id)
        const outcome = outcomes[Math.min(i++, outcomes.length - 1)]
        await Promise.resolve()
        return outcome === 'ok' ? { ok: true, tools: [{ name: 'run' }] } : { ok: false, tools: [], error: `uv not found (${i})` }
      },
      async callTool() {
        return { ok: true, result: {} }
      },
      async disconnect(id) {
        stops.push(id)
      },
    }
    const built = new MCPPool({ cwd: '/work', nativeBridge, loadNativeServers: async () => natives })
    await built.init()
    const offered: string[] = []
    const mcp = poolModMcp({ pool: () => built, manifestServer, onNativeLaunched: name => offered.push(name) })
    return { pool: built, launches, stops, offered, mcp }
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a server that failed at session start is launched again, answers connected, and is offered to the session', async () => {
    const { pool: p, launches, stops, offered, mcp } = await nativePool(['fail', 'ok'], [{ id: 'shell', config: shell }])
    expect(p.getServer('shell')).toMatchObject({ status: 'failed', error: 'uv not found (1)' })
    expect(await mcp.connect('docs', 'shell')).toEqual({ isConnected: true, server: 'shell' })
    expect(launches).toEqual(['shell', 'shell'])
    expect(stops).toEqual(['shell'])
    expect(p.getServer('shell')).toMatchObject({ status: 'connected', nativeConfig: shell, tools: [{ name: 'run' }] })
    expect(offered).toEqual(['shell'])
  })

  it('a launch that fails again answers failed with the new error and offers nothing', async () => {
    const { launches, offered, mcp } = await nativePool(['fail'], [{ id: 'shell', config: shell }])
    expect(await mcp.connect('docs', 'shell')).toEqual({
      isConnected: false,
      reason: 'failed',
      message: '"shell" did not connect: uv not found (2)',
    })
    expect(launches).toEqual(['shell', 'shell'])
    expect(offered).toEqual([])
  })

  it('concurrent connects share one launch and one offer', async () => {
    const { launches, offered, mcp } = await nativePool(['fail', 'ok'], [{ id: 'shell', config: shell }])
    const answers = await Promise.all([mcp.connect('docs', 'shell'), mcp.connect('docs', 'shell'), mcp.connect('docs', 'shell')])
    expect(answers).toEqual(Array(3).fill({ isConnected: true, server: 'shell' }))
    expect(launches).toEqual(['shell', 'shell'])
    expect(offered).toEqual(['shell'])
  })

  it('a connected server is not launched again, nor offered again', async () => {
    const { launches, stops, offered, mcp } = await nativePool(['ok'], [{ id: 'shell', config: shell }])
    expect(await mcp.connect('docs', 'shell')).toEqual({ isConnected: true, server: 'shell' })
    expect(await mcp.connect('docs', 'shell')).toEqual({ isConnected: true, server: 'shell' })
    expect(launches).toEqual(['shell'])
    expect(stops).toEqual([])
    expect(offered).toEqual([])
  })

  it('a server the session never started is launched under its manifest id; a name another config holds is failed', async () => {
    const { pool: p, launches, offered, mcp } = await nativePool(['ok'], [])
    expect(await mcp.connect('docs', 'later')).toEqual({ isConnected: true, server: 'later' })
    expect(launches).toEqual(['later'])
    expect(offered).toEqual(['later'])
    expect(p.getServer('later')).toMatchObject({ status: 'connected', nativeServerId: 'later' })
    const held = await nativePool(['ok'], [{ id: 'later', config: shell }])
    expect(await held.mcp.connect('docs', 'later')).toEqual({
      isConnected: false,
      reason: 'failed',
      message: '"later" is another MCP server\'s name in this session',
    })
    expect(held.launches).toEqual(['later'])
    expect(held.offered).toEqual([])
  })

  it('an offer that throws still answers connected', async () => {
    const { pool: p } = await nativePool(['fail', 'ok'], [{ id: 'shell', config: shell }])
    const mcp = poolModMcp({ pool: () => p, manifestServer, onNativeLaunched: () => { throw new Error('offer broke') } })
    expect(await mcp.connect('docs', 'shell')).toEqual({ isConnected: true, server: 'shell' })
  })

  it('a pool with no native bridge cannot start one and says so', async () => {
    const mcp = poolModMcp({ pool: () => new MCPPool({ cwd: '/work' }), manifestServer })
    expect(await mcp.connect('docs', 'later')).toEqual({
      isConnected: false,
      reason: 'failed',
      message: '"later" was not connected: this session cannot start stdio servers',
    })
  })
})

describe('$.mcp through the runtime', () => {
  let uniq = 0
  function world(modules: Record<string, string>, host: Partial<ModNounHost> = {}) {
    const reports: string[] = []
    const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    const runtime = new ModRuntime({
      modules: refs,
      readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      session: { id: () => 's', cwd: () => '/work/project', ...host },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, reports }
  }

  function line(reports: string[], plugin: string): unknown {
    const found = reports.find(r => r.startsWith(`${plugin}: {`))
    if (!found) throw new Error(`no report from ${plugin}: ${JSON.stringify(reports)}`)
    return JSON.parse(found.slice(plugin.length + 2))
  }

  it("a mod connects its own server at session.start and calls tools by either spelling; an error result is isError; a guard denies another plugin's call; bad arguments are refused by name", async () => {
    const p = await pool([{ name: 'claude.ai Gmail', type: 'http', url: 'https://gmail.test/mcp' }])
    const manifest: Record<string, ModMcpManifestServer> = {
      search: { kind: 'browser', entry: { name: 'search', type: 'http', url: 'https://search.test/mcp' } },
    }
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('mcp.call', ($, e, next) => e.tool === 'send' ? { deny: 'GUARD: no send on ' + e.server } : next(e));
          }
        `,
        caller: `
          let connected;
          export function register(on) {
            on('session.start', async ($, e, next) => {
              connected = await $.mcp.connect('search');
              return next(e);
            });
            on('prompt.submit', async ($, e, next) => {
              const listed = await $.mcp.call('claude.ai Gmail', 'echo', { to: 'a' });
              const spelled = await $.mcp.call('claude_ai_Gmail', 'boom');
              const own = await $.mcp.call(connected.server, 'structured');
              const denied = await $.mcp.call('claude.ai Gmail', 'send').catch(err => err.name + ': ' + err.message);
              const missing = await $.mcp.call('jira', 'echo').catch(err => err.name);
              const bad = await $.mcp.call('gh').catch(err => err.name + ': ' + err.message);
              const unlisted = await $.mcp.connect('gmail');
              await $.ui.log(JSON.stringify({ connected, listed, spelled, own, denied, missing, bad, unlisted }));
              return next(e);
            });
          }
        `,
      },
      { mcp: poolModMcp({ pool: () => p, manifestServer: (plugin, key) => (plugin === 'caller' ? manifest[key] : undefined) }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(line(reports, 'caller')).toEqual({
      connected: { isConnected: true, server: 'search' },
      listed: { content: [{ type: 'text', text: 'claude.ai Gmail/echo {"to":"a"}' }], isError: false },
      spelled: { content: [{ type: 'text', text: 'claude.ai Gmail/boom {}' }], isError: true },
      own: { content: [{ type: 'text', text: 'search/structured {}' }], isError: false, structuredContent: { n: 1 } },
      denied: 'DeniedError: GUARD: no send on claude.ai Gmail',
      missing: 'NotFoundError',
      bad: 'TypeError: $.mcp.call(server, tool, args): tool must be a non-empty string',
      unlisted: { isConnected: false, reason: 'unlisted', message: `"gmail" is not an MCP server in caller's manifest` },
    })
  })

  it('a session that takes no MCP refuses the noun by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.mcp.call('gh', 'echo').catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['probe: NotSupportedError: $.mcp is not available: this session takes no MCP servers'])
  })
})
