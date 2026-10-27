/**
 * `McpOAuthHost` over the runtime's own host port (F-10): the sign-in window
 * is a single-web window whose redirect the host captures, the token requests
 * are host-built form posts, and the tokens go straight into the secret store.
 */
import { createNativePrimitives } from '../../browser/bridge/nativePrimitives'
import type { McpHostAccess } from '../mcpHost'
import { createPrimitiveFetch } from '../primitiveTransports'
import { McpSignInClosedError, type McpOAuthHost, type McpSignInCapture } from './McpOAuthService'

/** Everything a sign-in needs from the host, by manifest entry. */
export const MCP_OAUTH_PRIMITIVES = [
  'network.streamOpen',
  'network.secretTemplates',
  'network.secretFormBody',
  'webWindow.captureRedirect',
] as const
export const MCP_OAUTH_CAPABILITIES = ['secrets', 'webWindow'] as const

const SIGN_IN_WINDOW = { width: 520, height: 720 }
/** The longest window title the host accepts, in UTF-16 units. */
const MAX_WINDOW_TITLE = 120

/**
 * `title` as the host takes it: whitespace runs collapsed, ends trimmed, cut
 * to the host's limit with an ellipsis. Null when nothing is left, so a blank
 * title never fails the sign-in.
 */
export function signInWindowTitle(title: string | undefined): string | null {
  const collapsed = title?.replace(/\s+/g, ' ').trim() ?? ''
  if (!collapsed) return null
  if (collapsed.length <= MAX_WINDOW_TITLE) return collapsed
  let cut = collapsed.slice(0, MAX_WINDOW_TITLE - 1)
  // Never leave half a surrogate pair before the ellipsis.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}\u2026`
}

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
    openSignInWindow(url, redirectUri, signal, title) {
      const listed = (name: string): boolean => host.manifest?.primitives?.includes(name) === true
      // An older host has no fixed titles; it shows the page's own.
      const fixedTitle = listed('webWindow.title') ? signInWindowTitle(title) : null
      // An older host closes the window on the capture; it has no result pages.
      const awaitResult = listed('webWindow.signInResult')
      const captured = (windowId: number, capturedUrl: string): McpSignInCapture => {
        let done = false
        const once = (run: () => Promise<void>): void => {
          if (done || !awaitResult) return
          done = true
          void run().catch(() => {})
        }
        return {
          url: capturedUrl,
          finish: outcome =>
            once(() =>
              primitives.webWindow.showSignInResult(
                windowId,
                outcome.ok,
                !outcome.ok && outcome.reason ? outcome.reason : undefined,
              ),
            ),
          close: () => once(() => primitives.webWindow.close(windowId)),
        }
      }
      return new Promise<McpSignInCapture>((resolve, reject) => {
        let windowId: number | null = null
        let settled = false
        const offs: Array<() => void> = []
        const finish = (outcome: () => void): void => {
          if (settled) return
          settled = true
          for (const off of offs) off()
          signal.removeEventListener('abort', onAbort)
          outcome()
        }
        const onAbort = (): void => {
          if (windowId !== null) void primitives.webWindow.close(windowId).catch(() => {})
          finish(() => reject(signal.reason ?? new McpSignInClosedError()))
        }
        // Listeners first: a redirect can be captured before `open` answers.
        const early: Array<{ windowId: number; url?: string }> = []
        offs.push(
          primitives.webWindow.onRedirectCaptured(event => {
            if (windowId === null) early.push({ windowId: event.windowId, url: event.url })
            else if (event.windowId === windowId) finish(() => resolve(captured(event.windowId, event.url)))
          }),
          primitives.webWindow.onClosed(event => {
            if (windowId === null) early.push({ windowId: event.windowId })
            else if (event.windowId === windowId) finish(() => reject(new McpSignInClosedError()))
          }),
        )
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort)
        primitives.webWindow
          .open(url, {
            captureRedirect: redirectUri,
            ...SIGN_IN_WINDOW,
            ...(fixedTitle !== null ? { title: fixedTitle } : {}),
            ...(awaitResult ? { awaitSignInResult: true } : {}),
          })
          .then(id => {
            windowId = id
            if (settled) {
              void primitives.webWindow.close(id).catch(() => {})
              return
            }
            for (const event of early) {
              if (event.windowId !== id) continue
              if (event.url !== undefined) finish(() => resolve(captured(id, event.url!)))
              else finish(() => reject(new McpSignInClosedError()))
            }
          })
          .catch(error => finish(() => reject(error)))
      })
    },
  }
}
