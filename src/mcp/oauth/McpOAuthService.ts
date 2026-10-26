/**
 * Security: sign-in for remote MCP servers (F-10) — authorization code + PKCE
 * with a registered or person-supplied client. The runtime never keeps a
 * token: the token response goes straight into the host secret store (access
 * token bound to the MCP server's origin, refresh token and client secret to
 * the token endpoint's) and later requests carry `{{secret:NAME}}`
 * placeholders the host fills, in headers and in the refresh's form body.
 */
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { BridgeSecretName } from '../../browser/bridge/protocol/secrets'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { McpAuthServerState, McpAuthSignInPayload, McpAuthState } from './mcpAuthProtocol'
import { mcpOAuthKey, mcpOAuthSecretNames, normalizeMcpServerUrl, secretPlaceholder } from './oauthKeys'
import {
  readMcpOAuthRecords,
  writeMcpOAuthRecords,
  type McpOAuthRecord,
  type McpOAuthRecords,
} from './oauthRecords'

/** Where the sign-in window's redirect is captured; nothing listens on it. */
export const MCP_OAUTH_REDIRECT_URI = 'http://127.0.0.1:47643/callback'

/** A token this close to its expiry is refreshed before use. */
const REFRESH_SKEW_MS = 60_000

/** The client name a dynamic registration asks for. */
const CLIENT_NAME = 'Velloc'

export class McpSignInClosedError extends Error {
  constructor() {
    super('The sign-in window was closed before sign-in finished.')
    this.name = 'McpSignInClosedError'
  }
}

/** The host calls a sign-in needs, all made on the runtime's own port. */
export type McpOAuthHost = {
  /** Plain requests for discovery and client registration; no secret rides them. */
  fetch: FetchLike
  /** A POST whose x-www-form-urlencoded body the host builds; values may hold
   *  `{{secret:NAME}}` bound to the URL's origin. */
  postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: string }>
  setSecret(name: BridgeSecretName, value: string, origin: string): Promise<void>
  deleteSecret(name: BridgeSecretName): Promise<void>
  /** Opens `url` in a window and resolves with the URL of the first navigation
   *  to `redirectUri`; rejects `McpSignInClosedError` when the window closes
   *  first. Aborting `signal` closes the window. */
  openSignInWindow(url: string, redirectUri: string, signal: AbortSignal): Promise<string>
  /** The fetch an MCP transport uses when its headers carry placeholders. */
  transportFetch(): FetchLike
}

export type McpOAuthServiceOptions = {
  homeDir: () => string | null
  fs: () => RuntimeFs
  /** The host for the sign-in of `serverUrl` (any server when absent); null
   *  while no host can run a sign-in. */
  host: (serverUrl?: string) => McpOAuthHost | null
  now?: () => number
  /** Default: the SDK's discovery / registration / authorization helpers. */
  oauth?: McpOAuthProtocolHelpers
}

/** The subset of the SDK's client auth helpers the flow uses (a test seam). */
export type McpOAuthProtocolHelpers = {
  discoverOAuthServerInfo: typeof import('@modelcontextprotocol/sdk/client/auth.js').discoverOAuthServerInfo
  discoverOAuthProtectedResourceMetadata: typeof import('@modelcontextprotocol/sdk/client/auth.js').discoverOAuthProtectedResourceMetadata
  registerClient: typeof import('@modelcontextprotocol/sdk/client/auth.js').registerClient
  startAuthorization: typeof import('@modelcontextprotocol/sdk/client/auth.js').startAuthorization
}

/** What a connect sends: auth headers and the fetch that fills them. */
export type McpConnectAuth = { headers: Record<string, string>; fetch: FetchLike }

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

type Flow = { controller: AbortController }

function originOf(url: string): string {
  return new URL(url).origin
}

function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

function parseTokenResponse(status: number, body: string): TokenResponse {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    // reported below
  }
  if (status < 200 || status >= 300 || typeof parsed.access_token !== 'string' || !parsed.access_token) {
    const reason =
      typeof parsed.error_description === 'string'
        ? parsed.error_description
        : typeof parsed.error === 'string'
          ? parsed.error
          : `HTTP ${status}`
    throw new Error(`The token endpoint refused the request: ${reason}`)
  }
  const token: TokenResponse = { access_token: parsed.access_token }
  if (typeof parsed.refresh_token === 'string' && parsed.refresh_token) token.refresh_token = parsed.refresh_token
  if (typeof parsed.expires_in === 'number' && parsed.expires_in > 0) token.expires_in = parsed.expires_in
  if (typeof parsed.scope === 'string') token.scope = parsed.scope
  return token
}

async function defaultHelpers(): Promise<McpOAuthProtocolHelpers> {
  const sdk = await import('@modelcontextprotocol/sdk/client/auth.js')
  return {
    discoverOAuthServerInfo: sdk.discoverOAuthServerInfo,
    discoverOAuthProtectedResourceMetadata: sdk.discoverOAuthProtectedResourceMetadata,
    registerClient: sdk.registerClient,
    startAuthorization: sdk.startAuthorization,
  }
}

export class McpOAuthService {
  private readonly options: McpOAuthServiceOptions
  private readonly now: () => number
  private records: McpOAuthRecords | null = null
  private loading: Promise<McpOAuthRecords> | null = null
  private writeTail: Promise<void> = Promise.resolve()
  private readonly flows = new Map<string, Flow>()
  private readonly refreshing = new Map<string, Promise<boolean>>()
  private readonly needsClient = new Set<string>()
  private readonly lastErrors = new Map<string, string>()
  private readonly stateListeners = new Set<(state: McpAuthState) => void>()
  private readonly authListeners = new Set<(url: string, signedIn: boolean) => void>()

  constructor(options: McpOAuthServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  // ---- state ---------------------------------------------------------------

  getState(): McpAuthState {
    const servers: McpAuthServerState[] = []
    for (const [key, record] of Object.entries(this.records ?? {})) {
      const signingIn = this.flows.has(key)
      if (!signingIn && !record.tokens && !record.required) continue
      const server: McpAuthServerState = {
        url: record.url,
        phase: signingIn ? 'signing-in' : record.tokens ? 'signed-in' : 'needs-sign-in',
      }
      if (!signingIn && !record.tokens && this.needsClient.has(key)) {
        server.needsClient = true
        server.redirectUri = MCP_OAUTH_REDIRECT_URI
      }
      const lastError = this.lastErrors.get(key)
      if (lastError && !signingIn) server.lastError = lastError
      servers.push(server)
    }
    servers.sort((a, b) => a.url.localeCompare(b.url))
    return { available: this.options.host() !== null, servers }
  }

  onStateChange(listener: (state: McpAuthState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** A server gained (`true`) or lost (`false`) its sign-in. */
  onAuthChanged(listener: (url: string, signedIn: boolean) => void): () => void {
    this.authListeners.add(listener)
    return () => this.authListeners.delete(listener)
  }

  /** Loads the records once, so the first published state is complete. */
  async load(): Promise<void> {
    await this.loadRecords()
    this.publish()
  }

  private publish(): void {
    const state = this.getState()
    for (const listener of Array.from(this.stateListeners)) listener(state)
  }

  private announce(url: string, signedIn: boolean): void {
    for (const listener of Array.from(this.authListeners)) listener(url, signedIn)
  }

  // ---- records -------------------------------------------------------------

  private loadRecords(): Promise<McpOAuthRecords> {
    if (this.records) return Promise.resolve(this.records)
    if (!this.loading) {
      const homeDir = this.options.homeDir()
      const read = homeDir ? readMcpOAuthRecords(homeDir, this.options.fs()) : Promise.resolve({})
      this.loading = read.then(records => {
        this.records ??= records
        return this.records
      })
    }
    return this.loading
  }

  private save(): Promise<void> {
    const homeDir = this.options.homeDir()
    if (!homeDir || !this.records) return Promise.resolve()
    const snapshot = structuredClone(this.records)
    const run = this.writeTail.then(() => writeMcpOAuthRecords(homeDir, this.options.fs(), snapshot))
    this.writeTail = run.catch(err => {
      console.warn('[mcp] saving sign-in records failed:', err instanceof Error ? err.message : err)
    })
    return this.writeTail
  }

  private async recordFor(rawUrl: string): Promise<{ key: string; url: string; record: McpOAuthRecord } | null> {
    const key = mcpOAuthKey(rawUrl)
    const url = normalizeMcpServerUrl(rawUrl)
    if (!key || !url) return null
    const records = await this.loadRecords()
    const record = records[key] ?? { url }
    return { key, url, record }
  }

  private put(key: string, record: McpOAuthRecord): void {
    if (!this.records) this.records = {}
    this.records[key] = record
  }

  // ---- connect-time --------------------------------------------------------

  /**
   * What a connect to `rawUrl` sends: auth headers once signed in (refreshed
   * first when near expiry), `'required'` when the server wants a sign-in
   * that is missing, null when nothing is known about it.
   */
  async connectAuth(rawUrl: string): Promise<McpConnectAuth | 'required' | null> {
    const found = await this.recordFor(rawUrl)
    if (!found) return null
    const { key, record } = found
    if (!record.tokens) return record.required ? 'required' : null
    const host = this.options.host(rawUrl)
    if (!host) return null
    const expiresAt = record.tokens.expiresAt
    if (expiresAt !== undefined && this.now() >= expiresAt - REFRESH_SKEW_MS) {
      if (!(await this.refresh(key))) return 'required'
    }
    const names = mcpOAuthSecretNames(key)
    return {
      headers: { Authorization: `Bearer ${secretPlaceholder(names.access)}` },
      fetch: host.transportFetch(),
    }
  }

  /** Records that `rawUrl` asks for a sign-in (it answered 401). */
  async markRequired(rawUrl: string): Promise<void> {
    const found = await this.recordFor(rawUrl)
    if (!found || found.record.required) return
    this.put(found.key, { ...found.record, required: true })
    await this.save()
    this.publish()
  }

  /**
   * `rawUrl` answered 401 to a request that carried its sign-in. True when a
   * refresh renewed the token (worth one retry); otherwise the sign-in is
   * dropped and the server needs a new one.
   */
  async handleUnauthorized(rawUrl: string): Promise<boolean> {
    const found = await this.recordFor(rawUrl)
    if (!found) return false
    if (found.record.tokens?.hasRefresh && (await this.refresh(found.key))) return true
    if (found.record.tokens || !found.record.required) {
      await this.dropTokens(found.key, true)
      this.announce(found.url, false)
    }
    return false
  }

  // ---- sign-in -------------------------------------------------------------

  /**
   * Starts a sign-in for `payload.url` and resolves once it has started; the
   * outcome is published. A sign-in already running for the server is
   * replaced.
   */
  async signIn(payload: McpAuthSignInPayload): Promise<void> {
    const found = await this.recordFor(payload.url)
    if (!found) throw new Error('Only http(s) MCP servers can be signed in to.')
    const host = this.options.host(found.url)
    if (!host) throw new Error('No host is available to run an MCP sign-in.')
    this.flows.get(found.key)?.controller.abort()
    const flow: Flow = { controller: new AbortController() }
    this.flows.set(found.key, flow)
    this.lastErrors.delete(found.key)
    this.put(found.key, { ...found.record, required: true })
    this.publish()
    void this.runSignIn(found.key, found.url, payload, host, flow)
      .catch(error => {
        if (this.flows.get(found.key) !== flow) return
        if (!(error instanceof McpSignInClosedError) && !flow.controller.signal.aborted) {
          this.lastErrors.set(found.key, oneLine(error))
        }
      })
      .finally(() => {
        if (this.flows.get(found.key) === flow) this.flows.delete(found.key)
        this.publish()
      })
  }

  async cancel(rawUrl: string): Promise<void> {
    const key = mcpOAuthKey(rawUrl)
    if (key) this.flows.get(key)?.controller.abort()
  }

  async signOut(rawUrl: string): Promise<void> {
    const found = await this.recordFor(rawUrl)
    if (!found) return
    this.flows.get(found.key)?.controller.abort()
    if (!found.record.tokens) return
    await this.dropTokens(found.key, true)
    this.announce(found.url, false)
    this.publish()
  }

  /**
   * After a connector or plugin install: when `rawUrl` publishes OAuth
   * resource metadata and holds no sign-in, record it as required and start a
   * sign-in (or, with no way to get a client, publish that one is needed).
   */
  async signInIfRequired(rawUrl: string): Promise<void> {
    const found = await this.recordFor(rawUrl)
    const host = this.options.host(found?.url)
    if (!found || !host || found.record.tokens || this.flows.has(found.key)) return
    const helpers = this.options.oauth ?? (await defaultHelpers())
    try {
      await helpers.discoverOAuthProtectedResourceMetadata(found.url, {}, host.fetch)
    } catch {
      return
    }
    await this.markRequired(found.url)
    await this.signIn({ url: found.url })
  }

  private async runSignIn(
    key: string,
    url: string,
    payload: McpAuthSignInPayload,
    host: McpOAuthHost,
    flow: Flow,
  ): Promise<void> {
    const signal = flow.controller.signal
    const helpers = this.options.oauth ?? (await defaultHelpers())
    const info = await helpers.discoverOAuthServerInfo(url, { fetchFn: host.fetch })
    const metadata = info.authorizationServerMetadata
    if (!metadata) throw new Error('The server does not publish where to sign in.')
    signal.throwIfAborted()
    const names = mcpOAuthSecretNames(key)
    const tokenOrigin = originOf(metadata.token_endpoint)

    let record = (await this.recordFor(url))!.record
    let client = record.client?.authServer === info.authorizationServerUrl ? record.client : undefined
    if (payload.clientId) {
      if (payload.clientSecret) await host.setSecret(names.clientSecret, payload.clientSecret, tokenOrigin)
      client = {
        authServer: info.authorizationServerUrl,
        clientId: payload.clientId,
        ...(payload.clientSecret ? { hasSecret: true } : {}),
      }
    } else if (!client) {
      if (!metadata.registration_endpoint) {
        this.needsClient.add(key)
        this.put(key, { ...record, required: true })
        await this.save()
        return
      }
      const registered = await helpers.registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: CLIENT_NAME,
          redirect_uris: [MCP_OAUTH_REDIRECT_URI],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        fetchFn: host.fetch,
      })
      if (registered.client_secret) await host.setSecret(names.clientSecret, registered.client_secret, tokenOrigin)
      client = {
        authServer: info.authorizationServerUrl,
        clientId: registered.client_id,
        registered: true,
        ...(registered.client_secret ? { hasSecret: true } : {}),
      }
    }
    this.needsClient.delete(key)
    record = { ...record, required: true, client }
    this.put(key, record)
    await this.save()
    signal.throwIfAborted()

    const scopes = info.resourceMetadata?.scopes_supported
    const resource = new URL(info.resourceMetadata?.resource ?? url)
    const state = crypto.randomUUID()
    const { authorizationUrl, codeVerifier } = await helpers.startAuthorization(info.authorizationServerUrl, {
      metadata,
      clientInformation: { client_id: client.clientId },
      redirectUrl: MCP_OAUTH_REDIRECT_URI,
      ...(scopes && scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
      state,
      resource,
    })
    // A refresh token from this issuer only comes with an offline grant.
    if (new URL(metadata.issuer).hostname === 'accounts.google.com') {
      authorizationUrl.searchParams.set('access_type', 'offline')
      authorizationUrl.searchParams.set('prompt', 'consent')
    }

    const captured = new URL(await host.openSignInWindow(authorizationUrl.href, MCP_OAUTH_REDIRECT_URI, signal))
    signal.throwIfAborted()
    if (captured.searchParams.get('state') !== state) throw new Error('The sign-in answer did not match this sign-in.')
    const refused = captured.searchParams.get('error')
    if (refused) throw new Error(captured.searchParams.get('error_description') ?? refused)
    const code = captured.searchParams.get('code')
    if (!code) throw new Error('The sign-in answer carried no authorization code.')

    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: MCP_OAUTH_REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: client.clientId,
      resource: resource.href,
    }
    if (client.hasSecret) form.client_secret = secretPlaceholder(names.clientSecret)
    const answer = await host.postForm(metadata.token_endpoint, form)
    const token = parseTokenResponse(answer.status, answer.body)
    signal.throwIfAborted()

    const accessOrigin = originOf(url)
    await host.setSecret(names.access, token.access_token, accessOrigin)
    if (token.refresh_token) await host.setSecret(names.refresh, token.refresh_token, tokenOrigin)
    this.put(key, {
      ...record,
      tokens: {
        tokenEndpoint: metadata.token_endpoint,
        accessOrigin,
        resource: resource.href,
        ...(token.scope ? { scope: token.scope } : {}),
        ...(token.expires_in ? { expiresAt: this.now() + token.expires_in * 1000 } : {}),
        hasRefresh: token.refresh_token !== undefined,
        signedInAt: this.now(),
      },
    })
    this.lastErrors.delete(key)
    await this.save()
    if (this.flows.get(key) === flow) this.flows.delete(key)
    this.publish()
    this.announce(url, true)
  }

  // ---- refresh -------------------------------------------------------------

  /** Renews the access token; false (and the sign-in dropped) when it cannot. */
  private refresh(key: string): Promise<boolean> {
    const running = this.refreshing.get(key)
    if (running) return running
    const run = this.runRefresh(key).finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, run)
    return run
  }

  private async runRefresh(key: string): Promise<boolean> {
    const record = this.records?.[key]
    const tokens = record?.tokens
    const host = this.options.host(record?.url)
    if (!record || !tokens || !host) return false
    if (!tokens.hasRefresh || !record.client) {
      await this.dropTokens(key, true)
      this.announce(record.url, false)
      return false
    }
    const names = mcpOAuthSecretNames(key)
    const form: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: secretPlaceholder(names.refresh),
      client_id: record.client.clientId,
    }
    if (tokens.resource) form.resource = tokens.resource
    if (record.client.hasSecret) form.client_secret = secretPlaceholder(names.clientSecret)
    try {
      const answer = await host.postForm(tokens.tokenEndpoint, form)
      const token = parseTokenResponse(answer.status, answer.body)
      await host.setSecret(names.access, token.access_token, tokens.accessOrigin)
      if (token.refresh_token) {
        await host.setSecret(names.refresh, token.refresh_token, originOf(tokens.tokenEndpoint))
      }
      const next = { ...tokens }
      if (token.expires_in) next.expiresAt = this.now() + token.expires_in * 1000
      else delete next.expiresAt
      if (token.scope) next.scope = token.scope
      this.put(key, { ...record, tokens: next })
      await this.save()
      return true
    } catch (error) {
      this.lastErrors.set(key, oneLine(error))
      await this.dropTokens(key, true)
      this.announce(record.url, false)
      return false
    }
  }

  private async dropTokens(key: string, publish: boolean): Promise<void> {
    const record = this.records?.[key]
    if (!record) return
    const names = mcpOAuthSecretNames(key)
    const host = this.options.host(record.url)
    if (host && record.tokens) {
      await host.deleteSecret(names.access).catch(() => {})
      if (record.tokens.hasRefresh) await host.deleteSecret(names.refresh).catch(() => {})
    }
    const { tokens: _dropped, ...rest } = record
    this.put(key, { ...rest, required: true })
    await this.save()
    if (publish) this.publish()
  }
}
