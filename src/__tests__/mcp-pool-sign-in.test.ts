import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCPPool } from '../mcp/pool'
import type { McpBridgeOperations, NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import { setMcpHostProvider } from '../mcp/mcpHost'
import { configureMcpOAuthService, MCP_OAUTH_SERVICE_WAIT_MS } from '../mcp/oauth/mcpOAuthHolder'
import {
  McpOAuthService,
  McpSignInRenewalError,
  type McpConnectAuth,
  type McpOAuthHost,
} from '../mcp/oauth/McpOAuthService'
import { mcpOAuthKey } from '../mcp/oauth/oauthKeys'
import { mcpOAuthRecordsPath } from '../mcp/oauth/oauthRecords'
import type { MCPServerConfig } from '../mcp/types'
import { isMcpUnauthorized, mcpSignInUrl } from '../mcp/unauthorized'
import { pluginServerUrls, startInstallSignIns } from '../mcp/oauth/signInAfterInstall'
import { installDirectoryTarget, type DirectoryOfferDeps } from '../customize/directoryOffer'
import { installProcessFs, resetProcessFs, unconfiguredFs } from '../utils/fs/runtimeFs'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

/** The browser-transport connect, for servers a module adds (`$.mcp.connect`). */
const browser = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../mcp/client', async importOriginal => ({
  ...(await importOriginal<typeof import('../mcp/client')>()),
  connectMCPServer: (options: unknown) => browser.connect(options),
  disconnectMCPServer: async () => {},
}))

const URL_ = 'https://mcp.example.test/mcp'
const HTTP: NexusMcpServerLaunchConfig = { transport: 'http', url: URL_ }
const SIGNED_IN: McpConnectAuth = {
  headers: { Authorization: 'Bearer {{secret:mcp:oauth/k/access}}' },
  fetch: vi.fn() as never,
}

type FakeService = {
  auth: McpConnectAuth | 'required' | null
  refreshWorks: boolean
  connectAuth: ReturnType<typeof vi.fn>
  markRequired: ReturnType<typeof vi.fn>
  handleUnauthorized: ReturnType<typeof vi.fn>
  signInIfRequired: ReturnType<typeof vi.fn>
  clearRequired: ReturnType<typeof vi.fn>
  onAuthChanged: (listener: (url: string, signedIn: boolean) => void) => () => void
  announce: (url: string, signedIn: boolean) => void
}

function fakeService(initial: McpConnectAuth | 'required' | null): FakeService {
  const listeners = new Set<(url: string, signedIn: boolean) => void>()
  const service: FakeService = {
    auth: initial,
    refreshWorks: false,
    connectAuth: vi.fn(async () => service.auth),
    markRequired: vi.fn(async () => {
      if (service.auth === null) service.auth = 'required'
    }),
    handleUnauthorized: vi.fn(async () => {
      if (service.refreshWorks) return true
      service.auth = 'required'
      return false
    }),
    signInIfRequired: vi.fn(async () => {}),
    clearRequired: vi.fn(async () => {
      if (service.auth === 'required') service.auth = null
    }),
    onAuthChanged: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    announce: (url, signedIn) => {
      for (const listener of listeners) listener(url, signedIn)
    },
  }
  configureMcpOAuthService(service as unknown as McpOAuthService)
  return service
}

/** A real service over an in-memory records file holding a sign-in for `URL_`, with a host present. */
function storedSignInService(): McpOAuthService {
  const files = new Map<string, string>([
    [
      mcpOAuthRecordsPath('/home/u'),
      JSON.stringify({
        version: 1,
        servers: {
          [mcpOAuthKey(URL_)!]: {
            url: URL_,
            tokens: {
              tokenEndpoint: 'https://auth.example.test/token',
              accessOrigin: 'https://mcp.example.test',
              hasRefresh: true,
              signedInAt: 1,
            },
          },
        },
      }),
    ],
  ])
  const fs = {
    readFile: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return text
    },
    writeFile: async (path: string, text: string) => {
      files.set(path, text)
    },
    mkdir: async () => {},
  } as unknown as RuntimeFs
  const host = { transportFetch: () => vi.fn() as never } as unknown as McpOAuthHost
  return new McpOAuthService({ homeDir: () => '/home/u', fs: () => fs, host: () => host })
}

function bridge(overrides: Partial<McpBridgeOperations> = {}): McpBridgeOperations {
  return {
    connect: vi.fn(async () => ({ ok: true, tools: [{ name: 'search' }] })),
    callTool: vi.fn(async () => ({ ok: true, result: 'found' })),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  }
}

function pool(nativeBridge: McpBridgeOperations, config: NexusMcpServerLaunchConfig = HTTP) {
  installProcessFs(unconfiguredFs)
  return new MCPPool({
    cwd: '/w',
    nativeBridge,
    loadNativeServers: vi.fn(async () => [{ id: 'notion', config }]),
  })
}

afterEach(() => {
  configureMcpOAuthService(null)
  resetProcessFs()
})

describe('MCP 401 recognition', () => {
  it('reads both tracks', () => {
    expect(isMcpUnauthorized({ code: 401, message: 'x' })).toBe(true)
    expect(isMcpUnauthorized('HTTP 401: Unauthorized')).toBe(true)
    expect(isMcpUnauthorized(new Error('HTTP 401'))).toBe(true)
    expect(isMcpUnauthorized('HTTP 4010')).toBe(false)
    expect(isMcpUnauthorized({ code: 403 })).toBe(false)
    expect(mcpSignInUrl({ nativeConfig: HTTP })).toBe(URL_)
    expect(mcpSignInUrl({ nativeConfig: { transport: 'stdio', command: 'x' } })).toBeUndefined()
  })
})

describe('MCPPool sign-in', () => {
  it('lists a server answering 401 as needing a sign-in and records it', async () => {
    const service = fakeService(null)
    const b = bridge({ connect: vi.fn(async () => ({ ok: false, tools: [], error: 'HTTP 401: Unauthorized' })) })
    const p = pool(b)
    await p.init()
    expect(p.getServer('notion')?.status).toBe('needs-auth')
    expect(service.markRequired).toHaveBeenCalledWith(URL_)
    await expect(p.callTool('notion', 'search', {})).rejects.toThrow(/needs the person to sign in/)
  })

  it('does not connect a server whose sign-in is missing', async () => {
    fakeService('required')
    const b = bridge()
    const p = pool(b)
    await p.init()
    expect(b.connect).not.toHaveBeenCalled()
    expect(p.getServer('notion')?.status).toBe('needs-auth')
  })

  it('connects with the sign-in header and reconnects once signed in', async () => {
    const service = fakeService('required')
    const b = bridge()
    const p = pool(b)
    const authorized = vi.fn()
    p.onServersAuthorized(authorized)
    await p.init()

    service.auth = SIGNED_IN
    service.announce('https://MCP.example.test/mcp/', true)
    await vi.waitFor(() => expect(p.getServer('notion')?.status).toBe('connected'))
    expect(b.connect).toHaveBeenCalledWith('notion', { ...HTTP, headers: SIGNED_IN.headers })
    expect(authorized).toHaveBeenCalledTimes(1)

    service.auth = 'required'
    service.announce(URL_, false)
    await vi.waitFor(() => expect(p.getServer('notion')?.status).toBe('needs-auth'))
    expect(b.disconnect).toHaveBeenCalled()
  })

  it('a call answering 401 retries once after a renewed sign-in', async () => {
    const service = fakeService(SIGNED_IN)
    service.refreshWorks = true
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 401: token expired' })
      .mockResolvedValue({ ok: true, result: 'found' })
    const p = pool(bridge({ callTool }))
    await p.init()
    await expect(p.callTool('notion', 'search', {})).resolves.toBe('found')
    expect(service.handleUnauthorized).toHaveBeenCalledWith(URL_)
  })

  it('a call answering 401 with no renewal parks the server', async () => {
    fakeService(SIGNED_IN)
    const p = pool(bridge({ callTool: vi.fn(async () => ({ ok: false, error: 'HTTP 401' })) }))
    await p.init()
    await expect(p.callTool('notion', 'search', {})).rejects.toThrow(/needs the person to sign in/)
    expect(p.getServer('notion')?.status).toBe('needs-auth')
  })

  it('a sign-in that cannot be renewed yet leaves the server failed, not waiting for a sign-in', async () => {
    const service = fakeService(SIGNED_IN)
    service.connectAuth.mockRejectedValueOnce(new McpSignInRenewalError('HTTP 503'))
    const b = bridge()
    const p = pool(b)
    await p.init()
    expect(b.connect).not.toHaveBeenCalled()
    expect(p.getServer('notion')?.status).toBe('failed')
    expect(p.getServer('notion')?.error).toMatch(/could not be renewed: HTTP 503/)
    expect(service.markRequired).not.toHaveBeenCalled()

    await p.refresh()
    expect(p.getServer('notion')?.status).toBe('connected')
  })

  it('a call answering 401 whose renewal cannot run yet fails the server and keeps the sign-in', async () => {
    const service = fakeService(SIGNED_IN)
    service.handleUnauthorized.mockRejectedValueOnce(new McpSignInRenewalError('offline'))
    const p = pool(bridge({ callTool: vi.fn(async () => ({ ok: false, error: 'HTTP 401' })) }))
    await p.init()
    await expect(p.callTool('notion', 'search', {})).rejects.toThrow()
    expect(p.getServer('notion')?.status).toBe('failed')
    expect(p.getServer('notion')?.error).toMatch(/could not be renewed: offline/)
    expect(service.markRequired).not.toHaveBeenCalled()
  })
})

describe('MCPPool before the sign-in service exists', () => {
  afterEach(() => {
    setMcpHostProvider(null)
    browser.connect.mockReset()
    vi.useRealTimers()
  })

  const carriesBearer = (headers?: Record<string, string>) => /^Bearer /.test(headers?.Authorization ?? '')
  /** A bridge whose server admits only a request carrying a sign-in. */
  function guardedBridge(): McpBridgeOperations {
    return bridge({
      connect: vi.fn(async (_name: string, config: NexusMcpServerLaunchConfig) =>
        carriesBearer(config.headers)
          ? { ok: true, tools: [{ name: 'search' }] }
          : { ok: false, tools: [], error: 'HTTP 401: invalid_token' },
      ),
    })
  }
  const SIGNED_IN_HEADERS = { Authorization: expect.stringMatching(/^Bearer \{\{secret:/) }

  it('a server parked by a 401 at boot reconnects, signed in, once the service has loaded its records', async () => {
    const b = guardedBridge()
    const p = pool(b)
    await p.init()
    expect(p.getServer('notion')?.status).toBe('needs-auth')
    expect(b.connect).toHaveBeenCalledTimes(1)

    const service = storedSignInService()
    configureMcpOAuthService(service)
    await service.load()
    await vi.waitFor(() => expect(p.getServer('notion')?.status).toBe('connected'))
    expect(b.connect).toHaveBeenCalledTimes(2)
    expect(b.connect).toHaveBeenLastCalledWith('notion', { ...HTTP, headers: SIGNED_IN_HEADERS })
  })

  it('a server a module added while the service was missing reconnects the same way', async () => {
    browser.connect.mockImplementation(
      async ({ name, config, auth }: { name: string; config: MCPServerConfig; auth?: McpConnectAuth }) =>
        auth
          ? { name, config, status: 'connected', tools: [{ name: 'search' }] }
          : { name, config, status: 'needs-auth', tools: [], error: 'HTTP 401: invalid_token' },
    )
    installProcessFs(unconfiguredFs)
    const p = new MCPPool({ cwd: '/w', projectServers: false })
    await p.init()
    const parked = await p.addServer({ name: 'notes', type: 'http', url: URL_ })
    expect(parked.status).toBe('needs-auth')
    expect(browser.connect).toHaveBeenCalledTimes(1)

    const service = storedSignInService()
    configureMcpOAuthService(service)
    await service.load()
    await vi.waitFor(() => expect(p.getServer('notes')?.status).toBe('connected'))
    expect(browser.connect).toHaveBeenCalledTimes(2)
    expect(browser.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ headers: SIGNED_IN_HEADERS }) }),
    )
  })

  it('a connect that starts with a host port but no service yet waits for the service', async () => {
    vi.useFakeTimers()
    setMcpHostProvider(() => ({ transport: {} as never }))
    const b = guardedBridge()
    const p = pool(b)
    const booting = p.init()
    await vi.advanceTimersByTimeAsync(50)
    expect(b.connect).not.toHaveBeenCalled()

    fakeService(SIGNED_IN)
    await booting
    expect(b.connect).toHaveBeenCalledTimes(1)
    expect(b.connect).toHaveBeenCalledWith('notion', { ...HTTP, headers: SIGNED_IN.headers })
    expect(p.getServer('notion')?.status).toBe('connected')
  })

  it('a host realm that never installs a service connects as before once the wait ends', async () => {
    vi.useFakeTimers()
    setMcpHostProvider(() => ({ transport: {} as never }))
    const b = bridge()
    const p = pool(b)
    const booting = p.init()
    await vi.advanceTimersByTimeAsync(MCP_OAUTH_SERVICE_WAIT_MS - 1)
    expect(b.connect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await booting
    expect(b.connect).toHaveBeenCalledWith('notion', HTTP)
    expect(p.getServer('notion')?.status).toBe('connected')
  })

  it("a server with the person's own credential does not wait", async () => {
    vi.useFakeTimers()
    setMcpHostProvider(() => ({ transport: {} as never }))
    const keyed: NexusMcpServerLaunchConfig = { ...HTTP, headers: { Authorization: 'token' } }
    const b = bridge()
    const p = pool(b, keyed)
    const booting = p.init()
    await vi.advanceTimersByTimeAsync(0)
    expect(b.connect).toHaveBeenCalledWith('notion', keyed)
    await booting
    expect(p.getServer('notion')?.status).toBe('connected')
  })
})

describe("MCPPool with the person's own credential", () => {
  const KEYED: NexusMcpServerLaunchConfig = { ...HTTP, headers: { Authorization: '{{secret:mcp:notion/header/authorization}}' } }

  it('connects a server waiting for a sign-in once it carries an Authorization header, and clears the wait', async () => {
    const service = fakeService('required')
    const b = bridge()
    const p = pool(b, KEYED)
    await p.init()
    expect(b.connect).toHaveBeenCalledWith('notion', KEYED)
    expect(p.getServer('notion')?.status).toBe('connected')
    expect(service.clearRequired).toHaveBeenCalledWith(URL_)
  })

  it('a 401 for its own credential still reads as needing one', async () => {
    const service = fakeService(null)
    const p = pool(bridge({ connect: vi.fn(async () => ({ ok: false, tools: [], error: 'HTTP 401' })) }), KEYED)
    await p.init()
    expect(p.getServer('notion')?.status).toBe('needs-auth')
    expect(service.markRequired).toHaveBeenCalledWith(URL_)
    expect(service.clearRequired).not.toHaveBeenCalled()
  })
})

describe('install-time sign-in', () => {
  it('starts the sign-in of each installed http server once', () => {
    const service = fakeService(null)
    startInstallSignIns([URL_, undefined, URL_])
    expect(service.signInIfRequired).toHaveBeenCalledTimes(1)
    expect(
      pluginServerUrls(
        [
          { name: 'a', plugin: 'notion', transport: 'http', url: URL_ },
          { name: 'b', plugin: 'notion', transport: 'stdio' },
          { name: 'c', plugin: 'other', transport: 'http', url: 'https://other.test' },
        ],
        'notion',
      ),
    ).toEqual([URL_])
  })

  it('a directory connector install starts its sign-in', async () => {
    const startSignIn = vi.fn()
    const deps = { upsertMcpServer: vi.fn(async () => {}), startSignIn } as unknown as DirectoryOfferDeps
    await installDirectoryTarget({ kind: 'connector', id: 'gmail', config: { transport: 'http', url: URL_ } }, deps)
    expect(startSignIn).toHaveBeenCalledWith(URL_)
    await installDirectoryTarget({ kind: 'connector', id: 'local', config: { transport: 'stdio', command: 'x' } }, deps)
    expect(startSignIn).toHaveBeenCalledTimes(1)
  })
})

describe('settings probe with a held sign-in', () => {
  it('sends the sign-in header and, on 401, renews it and probes once more', async () => {
    const { probeWithHeldSignIn } = await import('../mcp/oauth/mcpOAuthHolder')
    const service = fakeService(SIGNED_IN)
    service.refreshWorks = true
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'HTTP 401: invalid_token' })
      .mockResolvedValueOnce({ ok: true })
    await expect(probeWithHeldSignIn(HTTP, probe)).resolves.toEqual({ ok: true })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe.mock.calls[0]![0]).toEqual({ ...HTTP, headers: SIGNED_IN.headers })
    expect(service.handleUnauthorized).toHaveBeenCalledWith(URL_)
  })

  it('leaves a 401 for a server with no held sign-in alone', async () => {
    const { probeWithHeldSignIn } = await import('../mcp/oauth/mcpOAuthHolder')
    const service = fakeService(null)
    const probe = vi.fn(async () => ({ ok: false, error: 'HTTP 401' }))
    await expect(probeWithHeldSignIn(HTTP, probe)).resolves.toEqual({ ok: false, error: 'HTTP 401' })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(service.handleUnauthorized).not.toHaveBeenCalled()
  })
})
