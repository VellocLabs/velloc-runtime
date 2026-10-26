import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCPPool } from '../mcp/pool'
import type { McpBridgeOperations, NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import { configureMcpOAuthService } from '../mcp/oauth/mcpOAuthHolder'
import type { McpConnectAuth, McpOAuthService } from '../mcp/oauth/McpOAuthService'
import { isMcpUnauthorized, mcpSignInUrl } from '../mcp/unauthorized'
import { pluginServerUrls, startInstallSignIns } from '../mcp/oauth/signInAfterInstall'
import { installDirectoryTarget, type DirectoryOfferDeps } from '../customize/directoryOffer'
import { installProcessFs, resetProcessFs, unconfiguredFs } from '../utils/fs/runtimeFs'

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

function bridge(overrides: Partial<McpBridgeOperations> = {}): McpBridgeOperations {
  return {
    connect: vi.fn(async () => ({ ok: true, tools: [{ name: 'search' }] })),
    callTool: vi.fn(async () => ({ ok: true, result: 'found' })),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  }
}

function pool(nativeBridge: McpBridgeOperations) {
  installProcessFs(unconfiguredFs)
  return new MCPPool({
    cwd: '/w',
    nativeBridge,
    loadNativeServers: vi.fn(async () => [{ id: 'notion', config: HTTP }]),
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
