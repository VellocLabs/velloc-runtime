/**
 * `McpOAuthHost` over the runtime's own host port (F-10): the sign-in window
 * is a single-web window whose redirect the host captures, the token requests
 * are host-built form posts, and the tokens go straight into the secret store.
 */
import { createNativePrimitives } from '../../browser/bridge/nativePrimitives'
import { openSignInWindow } from '../../browser/bridge/signInWindow'
import type { McpHostAccess } from '../mcpHost'
import { createPrimitiveFetch } from '../primitiveTransports'
import { McpSignInClosedError, type McpOAuthHost } from './McpOAuthService'

/** Everything a sign-in needs from the host, by manifest entry. */
export const MCP_OAUTH_PRIMITIVES = [
  'network.streamOpen',
  'network.secretTemplates',
  'network.secretFormBody',
  'webWindow.captureRedirect',
] as const
export const MCP_OAUTH_CAPABILITIES = ['secrets', 'webWindow'] as const

/** Whether `host` can run a sign-in. */
export function hostServesMcpOAuth(host: McpHostAccess | null): boolean {
  const manifest = host?.manifest
  if (!manifest) return false
  const primitives = manifest.primitives ?? []
  const capabilities = manifest.capabilities ?? []
  return (
    MCP_OAUTH_PRIMITIVES.every(name => primitives.includes(name))
    && MCP_OAUTH_CAPABILITIES.every(name => capabilities.includes(name))
  )
}

/**
 * Security: the host name a sign-in may reach on the private network — the
 * server's own, and only when it is written as a loopback or private literal
 * (a server the person runs locally). A public server's metadata can never
 * steer a sign-in request into the private network.
 */
export function privateSignInHost(serverUrl: string | undefined): string | null {
  if (!serverUrl) return null
  let hostname: string
  try {
    hostname = new URL(serverUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  if (hostname === 'localhost' || hostname === '[::1]') return hostname
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
  const [a, b] = octets as [number, number, number, number]
  const isPrivate = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  return isPrivate ? hostname : null
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function createBridgeMcpOAuthHost(
  host: McpHostAccess,
  createRequestId: () => string,
  serverUrl?: string,
): McpOAuthHost {
  const primitives = createNativePrimitives({
    transport: host.transport,
    createRequestId,
    manifest: host.manifest,
  })
  const decoder = new TextDecoder()
  const privateHost = privateSignInHost(serverUrl)
  const reachesPrivate = (url: string): boolean => privateHost !== null && hostnameOf(url) === privateHost
  const publicFetch = createPrimitiveFetch(primitives.network)
  const localFetch = privateHost ? createPrimitiveFetch(primitives.network, { allowPrivateNetwork: true }) : publicFetch
  const fetch: McpOAuthHost['fetch'] = (input, init) =>
    (reachesPrivate(typeof input === 'string' ? input : input.toString()) ? localFetch : publicFetch)(input, init)
  return {
    fetch,
    transportFetch: () => fetch,
    async postForm(url, form) {
      const result = await primitives.network.postForm({
        url,
        formParams: form,
        headers: { Accept: 'application/json' },
        ...(reachesPrivate(url) ? { allowPrivateNetwork: true } : {}),
      })
      return { status: result.status, body: decoder.decode(result.body) }
    },
    setSecret: (name, value, origin) => primitives.secrets.set(name, value, origin),
    async deleteSecret(name) {
      await primitives.secrets.delete(name)
    },
    openSignInWindow: (url, redirectUri, signal, title) =>
      openSignInWindow(primitives.webWindow, host.manifest, {
        url,
        redirectUri,
        signal,
        ...(title !== undefined ? { title } : {}),
        closed: () => new McpSignInClosedError(),
      }),
  }
}
