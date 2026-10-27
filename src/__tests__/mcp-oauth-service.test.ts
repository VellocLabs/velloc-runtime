import { describe, expect, it, vi } from 'vitest'
import {
  MCP_OAUTH_REDIRECT_URI,
  McpOAuthService,
  McpSignInClosedError,
  type McpOAuthHost,
  type McpOAuthProtocolHelpers,
} from '../mcp/oauth/McpOAuthService'
import { mcpOAuthKey, mcpOAuthSecretNames, normalizeMcpServerUrl } from '../mcp/oauth/oauthKeys'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const SERVER = 'https://MCP.example.test/mcp/'
const SERVER_NORMALIZED = 'https://mcp.example.test/mcp'
const AUTH = 'https://auth.example.test'
const TOKEN_ENDPOINT = `${AUTH}/token`

function memoryFs(files = new Map<string, string>()): RuntimeFs {
  return {
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
}

type Options = {
  registration?: boolean
  issuer?: string
  window?: (url: URL, state: string) => string | Error
  tokenAnswer?: { status: number; body: string }
  /** The answer to the unauthenticated probe; default 401 with no challenge. */
  probe?: { status: number; wwwAuthenticate?: string }
  /** No OAuth metadata anywhere (an API-key server). */
  noMetadata?: boolean
  /** No protected-resource metadata (a legacy server). */
  noResourceMetadata?: boolean
  cimd?: boolean
  resource?: string
}

function rig(options: Options = {}) {
  const files = new Map<string, string>()
  const secrets = new Map<string, { value: string; origin: string }>()
  let now = 1_000_000
  let lastState = ''
  const forms: Array<{ url: string; form: Record<string, string> }> = []
  const opened: string[] = []
  const tokenAnswers: Array<{ status: number; body: string }> = []
  const host: McpOAuthHost = {
    fetch: vi.fn(async () => {
      const probe = options.probe ?? { status: 401 }
      return new Response('{}', {
        status: probe.status,
        headers: probe.wwwAuthenticate ? { 'WWW-Authenticate': probe.wwwAuthenticate } : {},
      })
    }),
    postForm: vi.fn(async (url, form) => {
      forms.push({ url, form })
      return (
        tokenAnswers.shift() ??
        options.tokenAnswer ?? {
          status: 200,
          body: JSON.stringify({ access_token: 'tok-access', refresh_token: 'tok-refresh', expires_in: 3600 }),
        }
      )
    }),
    setSecret: vi.fn(async (name, value, origin) => {
      secrets.set(name, { value, origin })
    }),
    deleteSecret: vi.fn(async name => {
      secrets.delete(name)
    }),
    openSignInWindow: vi.fn(async (url: string, redirectUri: string) => {
      opened.push(url)
      const answer = options.window?.(new URL(url), lastState) ?? `${redirectUri}?code=the-code&state=${lastState}`
      if (answer instanceof Error) throw answer
      return answer
    }),
    transportFetch: () => vi.fn() as never,
  }
  const issuer = options.issuer ?? AUTH
  const oauth: McpOAuthProtocolHelpers = {
    discoverOAuthServerInfo: vi.fn(async () => ({
      authorizationServerUrl: AUTH,
      authorizationServerMetadata: options.noMetadata
        ? undefined
        : {
            issuer,
            authorization_endpoint: `${AUTH}/authorize`,
            token_endpoint: TOKEN_ENDPOINT,
            response_types_supported: ['code'],
            ...(options.registration === false ? {} : { registration_endpoint: `${AUTH}/register` }),
            ...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
          },
      resourceMetadata:
        options.noMetadata || options.noResourceMetadata
          ? undefined
          : { resource: options.resource ?? SERVER_NORMALIZED, scopes_supported: ['read', 'write'] },
    })) as never,
    discoverOAuthProtectedResourceMetadata: vi.fn(async () => ({ resource: SERVER_NORMALIZED })) as never,
    registerClient: vi.fn(async () => ({ client_id: 'dyn-client', redirect_uris: [MCP_OAUTH_REDIRECT_URI] })) as never,
    startAuthorization: vi.fn(async (_server: unknown, args: { state?: string }) => {
      lastState = args.state ?? ''
      return {
        authorizationUrl: new URL(`${AUTH}/authorize?state=${lastState}`),
        codeVerifier: 'the-verifier',
      }
    }) as never,
  }
  let hostPresent = true
  const service = new McpOAuthService({
    homeDir: () => '/home/u',
    fs: () => memoryFs(files),
    host: () => (hostPresent ? host : null),
    now: () => now,
    oauth,
  })
  const authChanges: Array<[string, boolean]> = []
  service.onAuthChanged((url, signedIn) => authChanges.push([url, signedIn]))
  const key = mcpOAuthKey(SERVER)!
  return {
    service,
    host,
    oauth,
    files,
    secrets,
    forms,
    opened,
    tokenAnswers,
    authChanges,
    names: mcpOAuthSecretNames(key),
    advance: (ms: number) => {
      now += ms
    },
    dropHost: () => {
      hostPresent = false
    },
    phase: () => service.getState().servers.find(server => server.url === SERVER_NORMALIZED),
  }
}

async function settled(r: ReturnType<typeof rig>): Promise<void> {
  await vi.waitFor(() => expect(r.phase()?.phase).not.toBe('signing-in'))
}

describe('MCP server URL keys', () => {
  it('normalizes the host case and trailing slash, and refuses non-http URLs', () => {
    expect(normalizeMcpServerUrl(SERVER)).toBe(SERVER_NORMALIZED)
    expect(normalizeMcpServerUrl('https://mcp.example.test/mcp?x=1')).toBe(SERVER_NORMALIZED)
    expect(normalizeMcpServerUrl('file:///etc/passwd')).toBeNull()
    expect(mcpOAuthKey(SERVER)).toBe(mcpOAuthKey(SERVER_NORMALIZED))
    expect(mcpOAuthKey(SERVER)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('McpOAuthService sign-in', () => {
  it('registers a client, captures the code and keeps the tokens only in host secrets', async () => {
    const r = rig()
    await r.service.signIn({ url: SERVER })
    await settled(r)

    expect(r.oauth.registerClient).toHaveBeenCalledWith(
      AUTH,
      expect.objectContaining({
        clientMetadata: expect.objectContaining({
          redirect_uris: [MCP_OAUTH_REDIRECT_URI],
          token_endpoint_auth_method: 'none',
        }),
      }),
    )
    expect(r.oauth.startAuthorization).toHaveBeenCalledWith(
      AUTH,
      expect.objectContaining({ scope: 'read write', redirectUrl: MCP_OAUTH_REDIRECT_URI }),
    )
    expect(r.forms).toEqual([
      {
        url: TOKEN_ENDPOINT,
        form: {
          grant_type: 'authorization_code',
          code: 'the-code',
          redirect_uri: MCP_OAUTH_REDIRECT_URI,
          code_verifier: 'the-verifier',
          client_id: 'dyn-client',
          resource: SERVER_NORMALIZED,
        },
      },
    ])
    expect(r.secrets.get(r.names.access)).toEqual({ value: 'tok-access', origin: 'https://mcp.example.test' })
    expect(r.secrets.get(r.names.refresh)).toEqual({ value: 'tok-refresh', origin: AUTH })
    expect(r.phase()).toEqual({ url: SERVER_NORMALIZED, phase: 'signed-in' })
    expect(r.authChanges).toEqual([[SERVER_NORMALIZED, true]])

    const stored = [...r.files.values()].join('\n')
    expect(stored).toContain('dyn-client')
    expect(stored).not.toContain('tok-access')
    expect(stored).not.toContain('tok-refresh')

    const auth = await r.service.connectAuth(SERVER)
    expect(auth).not.toBe('required')
    expect((auth as { headers: Record<string, string> }).headers).toEqual({
      Authorization: `Bearer {{secret:${r.names.access}}}`,
    })
  })

  it('asks for a client when the authorization server registers none, then uses the one given', async () => {
    const r = rig({ registration: false })
    await r.service.signIn({ url: SERVER })
    await settled(r)
    expect(r.phase()).toEqual({
      url: SERVER_NORMALIZED,
      phase: 'needs-sign-in',
      needsClient: true,
      redirectUri: MCP_OAUTH_REDIRECT_URI,
    })
    expect(r.opened).toEqual([])
    expect(await r.service.connectAuth(SERVER)).toBe('required')

    await r.service.signIn({ url: SERVER, clientId: 'my-client', clientSecret: 'my-secret' })
    await settled(r)
    expect(r.phase()?.phase).toBe('signed-in')
    expect(r.secrets.get(r.names.clientSecret)).toEqual({ value: 'my-secret', origin: AUTH })
    expect(r.forms[0]!.form.client_id).toBe('my-client')
    expect(r.forms[0]!.form.client_secret).toBe(`{{secret:${r.names.clientSecret}}}`)
    expect(JSON.stringify([...r.files.values()])).not.toContain('my-secret')
  })

  it('opens the window with the asking client\'s title, and none without one', async () => {
    const titled = rig()
    await titled.service.signIn({ url: SERVER, windowTitle: 'Sign in to notion' })
    await settled(titled)
    expect(vi.mocked(titled.host.openSignInWindow).mock.calls[0]![3]).toBe('Sign in to notion')

    const plain = rig()
    await plain.service.signIn({ url: SERVER })
    await settled(plain)
    expect(vi.mocked(plain.host.openSignInWindow).mock.calls[0]![3]).toBeUndefined()
  })

  it('asks the Google issuer for an offline grant', async () => {
    const r = rig({ issuer: 'https://accounts.google.com' })
    await r.service.signIn({ url: SERVER })
    await settled(r)
    const opened = new URL(r.opened[0]!)
    expect(opened.searchParams.get('access_type')).toBe('offline')
    expect(opened.searchParams.get('prompt')).toBe('consent')
  })

  it('refuses an answer for another sign-in', async () => {
    const r = rig({ window: () => `${MCP_OAUTH_REDIRECT_URI}?code=x&state=forged` })
    await r.service.signIn({ url: SERVER })
    await settled(r)
    expect(r.phase()?.phase).toBe('needs-sign-in')
    expect(r.phase()?.lastError).toMatch(/did not match/)
    expect(r.forms).toEqual([])
    expect(r.secrets.has(r.names.access)).toBe(false)
  })

  it('reports the provider refusal and treats a closed window as no error', async () => {
    const refused = rig({
      window: (_url, state) => `${MCP_OAUTH_REDIRECT_URI}?error=access_denied&state=${state}`,
    })
    await refused.service.signIn({ url: SERVER })
    await settled(refused)
    expect(refused.phase()?.lastError).toBe('access_denied')

    const closed = rig({ window: () => new McpSignInClosedError() })
    await closed.service.signIn({ url: SERVER })
    await settled(closed)
    expect(closed.phase()).toEqual({ url: SERVER_NORMALIZED, phase: 'needs-sign-in' })
  })

  it('cancel aborts the window and leaves no error', async () => {
    const r = rig()
    let release: (value: string) => void = () => {}
    vi.mocked(r.host.openSignInWindow).mockImplementationOnce(
      (_url, _redirect, signal) =>
        new Promise<string>((resolve, reject) => {
          release = resolve
          signal.addEventListener('abort', () => reject(new McpSignInClosedError()))
        }),
    )
    await r.service.signIn({ url: SERVER })
    await vi.waitFor(() => expect(r.opened.length + vi.mocked(r.host.openSignInWindow).mock.calls.length).toBeGreaterThan(0))
    expect(r.phase()?.phase).toBe('signing-in')
    await r.service.cancel(SERVER)
    await settled(r)
    release('ignored')
    expect(r.phase()).toEqual({ url: SERVER_NORMALIZED, phase: 'needs-sign-in' })
  })

  it('reports itself unavailable without a host', async () => {
    const r = rig()
    r.dropHost()
    expect(r.service.getState().available).toBe(false)
    await expect(r.service.signIn({ url: SERVER })).rejects.toThrow()
  })
})

describe('McpOAuthService tokens', () => {
  async function signedIn(options: Options = {}) {
    const r = rig(options)
    await r.service.signIn({ url: SERVER })
    await settled(r)
    r.forms.length = 0
    return r
  }

  it('refreshes a token near expiry with the refresh token as a placeholder', async () => {
    const r = await signedIn()
    r.tokenAnswers.push({ status: 200, body: JSON.stringify({ access_token: 'tok-access-2', expires_in: 3600 }) })
    r.advance(3600 * 1000 - 30_000)
    const auth = await r.service.connectAuth(SERVER)
    expect(auth).not.toBe('required')
    expect(r.forms).toEqual([
      {
        url: TOKEN_ENDPOINT,
        form: {
          grant_type: 'refresh_token',
          refresh_token: `{{secret:${r.names.refresh}}}`,
          client_id: 'dyn-client',
          resource: SERVER_NORMALIZED,
        },
      },
    ])
    expect(r.secrets.get(r.names.access)?.value).toBe('tok-access-2')
  })

  it('a 401 with a refusing refresh drops the sign-in and announces it', async () => {
    const r = await signedIn()
    r.tokenAnswers.push({ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) })
    expect(await r.service.handleUnauthorized(SERVER)).toBe(false)
    expect(r.secrets.has(r.names.access)).toBe(false)
    expect(r.secrets.has(r.names.refresh)).toBe(false)
    expect(r.authChanges.at(-1)).toEqual([SERVER_NORMALIZED, false])
    expect(r.phase()?.phase).toBe('needs-sign-in')
    expect(r.phase()?.lastError).toMatch(/invalid_grant/)
    expect(await r.service.connectAuth(SERVER)).toBe('required')
  })

  it('a 401 with a working refresh asks for one retry', async () => {
    const r = await signedIn()
    expect(await r.service.handleUnauthorized(SERVER)).toBe(true)
    expect(r.forms[0]!.form.grant_type).toBe('refresh_token')
  })

  it('sign-out deletes the secrets and announces it', async () => {
    const r = await signedIn()
    await r.service.signOut(SERVER)
    expect(r.secrets.size).toBe(0)
    expect(r.authChanges.at(-1)).toEqual([SERVER_NORMALIZED, false])
    expect(r.phase()?.phase).toBe('needs-sign-in')
  })

  it('a reloaded service keeps the sign-in from the records file', async () => {
    const r = await signedIn()
    const reloaded = new McpOAuthService({
      homeDir: () => '/home/u',
      fs: () => memoryFs(r.files),
      host: () => r.host,
      now: () => 1_000_000,
      oauth: r.oauth,
    })
    await reloaded.load()
    expect(reloaded.getState().servers).toEqual([{ url: SERVER_NORMALIZED, phase: 'signed-in' }])
  })
})

describe('McpOAuthService install-time sign-in', () => {
  it('starts a sign-in when the server answers 401 and publishes OAuth metadata', async () => {
    const r = rig()
    await r.service.signInIfRequired(SERVER)
    await settled(r)
    expect(r.opened).toHaveLength(1)
    expect(r.phase()?.phase).toBe('signed-in')
  })

  it('starts a sign-in for an open server that publishes resource metadata', async () => {
    const r = rig({ probe: { status: 200 } })
    await r.service.signInIfRequired(SERVER)
    await settled(r)
    expect(r.opened).toHaveLength(1)
  })

  it('leaves an open server without resource metadata alone', async () => {
    const r = rig({ probe: { status: 200 }, noResourceMetadata: true })
    await r.service.signInIfRequired(SERVER)
    expect(r.opened).toEqual([])
    expect(r.service.getState().servers).toEqual([])
    expect(await r.service.connectAuth(SERVER)).toBeNull()
  })

  it('marks a 401 server with no OAuth metadata as wanting credentials, with no window', async () => {
    const r = rig({ noMetadata: true })
    await r.service.signInIfRequired(SERVER)
    expect(r.opened).toEqual([])
    expect(r.phase()).toEqual({ url: SERVER_NORMALIZED, phase: 'needs-sign-in', needsCredentials: true })
  })
})

describe('McpOAuthService discovery', () => {
  it("follows the 401 challenge's resource_metadata and asks for its scope", async () => {
    const r = rig({
      probe: {
        status: 401,
        wwwAuthenticate: 'Bearer error="invalid_token", resource_metadata="https://meta.example.test/prm", scope="notes:read notes:write"',
      },
    })
    await r.service.signIn({ url: SERVER })
    await settled(r)
    expect(r.oauth.discoverOAuthServerInfo).toHaveBeenCalledWith(
      SERVER_NORMALIZED,
      expect.objectContaining({ resourceMetadataUrl: new URL('https://meta.example.test/prm') }),
    )
    expect(r.oauth.startAuthorization).toHaveBeenCalledWith(
      AUTH,
      expect.objectContaining({ scope: 'notes:read notes:write' }),
    )
    expect(r.phase()?.phase).toBe('signed-in')
  })

  it('refuses resource metadata that names another server', async () => {
    const r = rig({ resource: 'https://elsewhere.example.test/mcp' })
    await r.service.signIn({ url: SERVER })
    await settled(r)
    expect(r.phase()?.lastError).toMatch(/different server/)
    expect(r.opened).toEqual([])
  })

  it('registers a client when the server offers both registration and client metadata documents', async () => {
    const r = rig({ cimd: true })
    await r.service.signIn({ url: SERVER })
    await settled(r)
    expect(r.oauth.registerClient).toHaveBeenCalledTimes(1)
    expect(r.forms[0]!.form.client_id).toBe('dyn-client')
    expect(r.phase()?.phase).toBe('signed-in')
  })

  it('does not reuse a stored client metadata document client once registration is offered', async () => {
    const before = rig({ cimd: true, registration: false })
    await before.service.signIn({ url: SERVER })
    await settled(before)
    const [path, text] = [...before.files.entries()].find(([name]) => name.endsWith('mcp-oauth.json'))!
    const stored = JSON.parse(text) as { servers: Record<string, Record<string, unknown>> }
    for (const server of Object.values(stored.servers)) {
      expect(server.client).toMatchObject({ metadataDocument: true })
      delete server.tokens
    }
    const r = rig({ cimd: true })
    r.files.set(path, JSON.stringify(stored))
    await r.service.signIn({ url: SERVER })
    await settled(r)
    expect(r.oauth.registerClient).toHaveBeenCalledTimes(1)
    expect(r.forms[0]!.form.client_id).toBe('dyn-client')
  })

  it('uses the client ID metadata document where the server accepts one and offers no registration', async () => {
    const { MCP_OAUTH_CLIENT_METADATA_URL } = await import('../mcp/oauth/discovery')
    const r = rig({ cimd: true, registration: false })
    await r.service.signIn({ url: SERVER })
    await settled(r)
    expect(r.oauth.registerClient).not.toHaveBeenCalled()
    expect(r.oauth.startAuthorization).toHaveBeenCalledWith(
      AUTH,
      expect.objectContaining({ clientInformation: { client_id: MCP_OAUTH_CLIENT_METADATA_URL } }),
    )
    expect(r.forms[0]!.form.client_id).toBe(MCP_OAUTH_CLIENT_METADATA_URL)
    expect(r.phase()?.phase).toBe('signed-in')
  })

  it('a sign-in that finds no OAuth metadata reports credentials, not an error', async () => {
    const r = rig({ noMetadata: true })
    await r.service.signIn({ url: SERVER })
    await settled(r)
    expect(r.phase()).toEqual({ url: SERVER_NORMALIZED, phase: 'needs-sign-in', needsCredentials: true })
  })

  it('a server that connects without a sign-in stops waiting for one', async () => {
    const r = rig({ noMetadata: true })
    await r.service.markRequired(SERVER)
    await vi.waitFor(() => expect(r.phase()?.needsCredentials).toBe(true))
    await r.service.clearRequired(SERVER)
    expect(r.service.getState().servers).toEqual([])
    expect(await r.service.connectAuth(SERVER)).toBeNull()
  })

  it('classifies a server once it is first marked required', async () => {
    const r = rig({ noMetadata: true })
    await r.service.markRequired(SERVER)
    await vi.waitFor(() => expect(r.phase()?.needsCredentials).toBe(true))
    await r.service.markRequired(SERVER)
    expect(r.oauth.discoverOAuthServerInfo).toHaveBeenCalledTimes(1)
  })
})

describe('McpOAuthService connector support', () => {
  it('can connect a server with dynamic registration, client metadata documents, an API key, or no sign-in', async () => {
    expect(await rig().service.connectorSupport(SERVER)).toBe('supported')
    expect(await rig({ registration: false, cimd: true }).service.connectorSupport(SERVER)).toBe('supported')
    expect(await rig({ noMetadata: true }).service.connectorSupport(SERVER)).toBe('supported')
    expect(await rig({ probe: { status: 200 }, noResourceMetadata: true }).service.connectorSupport(SERVER)).toBe('supported')
  })

  it('cannot connect one that signs in only with a client registered in advance', async () => {
    expect(await rig({ registration: false }).service.connectorSupport(SERVER)).toBe('needs_registered_client')
  })

  it('reports unknown when the server cannot be asked', async () => {
    const r = rig()
    vi.mocked(r.host.fetch).mockRejectedValueOnce(new Error('offline'))
    expect(await r.service.connectorSupport(SERVER)).toBe('unknown')
    r.dropHost()
    expect(await r.service.connectorSupport(SERVER)).toBe('unknown')
  })
})

describe('WWW-Authenticate parsing', () => {
  it('reads the Bearer parameters and stops at the next scheme', async () => {
    const { parseBearerChallenge } = await import('../mcp/oauth/discovery')
    expect(parseBearerChallenge('Bearer realm="mcp", resource_metadata="https://a.test/x", scope="a b"')).toEqual({
      realm: 'mcp',
      resource_metadata: 'https://a.test/x',
      scope: 'a b',
    })
    expect(parseBearerChallenge('Basic realm="x", Bearer error=invalid_token, DPoP algs="ES256"')).toEqual({
      error: 'invalid_token',
    })
    expect(parseBearerChallenge('Bearer error_description="say \\"hi\\""')).toEqual({ error_description: 'say "hi"' })
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull()
    expect(parseBearerChallenge(null)).toBeNull()
  })

  it('the published client metadata document names itself and the sign-in redirect', async () => {
    const { readFileSync } = await import('node:fs')
    const { MCP_OAUTH_CLIENT_METADATA_URL } = await import('../mcp/oauth/discovery')
    const doc = JSON.parse(readFileSync('public/oauth/client.json', 'utf-8')) as Record<string, unknown>
    expect(doc.client_id).toBe(MCP_OAUTH_CLIENT_METADATA_URL)
    expect(doc.redirect_uris).toEqual([MCP_OAUTH_REDIRECT_URI])
    expect(doc.token_endpoint_auth_method).toBe('none')
  })
})

describe('private-network reach of a sign-in', () => {
  it('is granted only to a server written as a loopback or private literal', async () => {
    const { privateSignInHost } = await import('../mcp/oauth/bridgeMcpOAuthHost')
    expect(privateSignInHost('http://127.0.0.1:8123/mcp')).toBe('127.0.0.1')
    expect(privateSignInHost('http://localhost:3000/mcp')).toBe('localhost')
    expect(privateSignInHost('http://192.168.1.20/mcp')).toBe('192.168.1.20')
    expect(privateSignInHost('http://172.32.0.1/mcp')).toBeNull()
    expect(privateSignInHost('https://mcp.notion.com/mcp')).toBeNull()
    expect(privateSignInHost('https://8.8.8.8/mcp')).toBeNull()
    expect(privateSignInHost(undefined)).toBeNull()
  })
})
