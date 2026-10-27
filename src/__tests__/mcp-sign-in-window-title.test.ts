import { describe, expect, it } from 'vitest'

import type {
  BrowserBridgeRequest,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'
import { createBridgeMcpOAuthHost, signInWindowTitle } from '../mcp/oauth/bridgeMcpOAuthHost'
import { MCP_OAUTH_REDIRECT_URI } from '../mcp/oauth/McpOAuthService'

/** A transport that answers every request with `{ windowId: 1 }` and records it. */
function recordingTransport() {
  const requests: BrowserBridgeRequest[] = []
  const transport: BrowserBridgeTransport = {
    async request(request) {
      requests.push(request as BrowserBridgeRequest)
      return { id: request.id, route: request.route, ok: true, result: { windowId: 1, ok: true } } as never
    },
    subscribeEvents: () => () => {},
  }
  return { transport, requests }
}

const BASE_PRIMITIVES = ['network.streamOpen', 'network.secretTemplates', 'network.secretFormBody', 'webWindow.captureRedirect']

/** Opens a sign-in window titled `title` and returns the `open` payload the host received. */
async function openPayload(primitives: string[], title?: string): Promise<Record<string, unknown>> {
  const { transport, requests } = recordingTransport()
  let next = 0
  const host = createBridgeMcpOAuthHost(
    { transport, manifest: { capabilities: ['secrets', 'webWindow'], primitives } },
    () => `r${next++}`,
  )
  const controller = new AbortController()
  const done = host
    .openSignInWindow('https://auth.example.test/authorize', MCP_OAUTH_REDIRECT_URI, controller.signal, title)
    .catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort()
  await done
  const open = requests.find(r => r.route.capability === 'webWindow' && r.route.action === 'open')
  return open!.payload as Record<string, unknown>
}

describe('sign-in window title', () => {
  it('collapses whitespace, trims, and drops a blank title', () => {
    expect(signInWindowTitle('  Sign in\n to   notion ')).toBe('Sign in to notion')
    expect(signInWindowTitle(' \t\n ')).toBeNull()
    expect(signInWindowTitle(undefined)).toBeNull()
  })

  it('cuts a long title to the host limit with an ellipsis, never splitting a pair', () => {
    const exact = 'a'.repeat(120)
    expect(signInWindowTitle(exact)).toBe(exact)
    const long = signInWindowTitle('b'.repeat(300))!
    expect(long).toHaveLength(120)
    expect(long.endsWith('…')).toBe(true)
    // A surrogate pair straddling the cut is dropped whole.
    const emoji = signInWindowTitle(`${'c'.repeat(118)}\u{1F600}tail`)!
    expect(emoji).toBe(`${'c'.repeat(118)}…`)
  })

  it('passes the title only to a host that lists webWindow.title', async () => {
    const titled = await openPayload([...BASE_PRIMITIVES, 'webWindow.title'], 'Sign in to notion')
    expect(titled).toMatchObject({ captureRedirect: MCP_OAUTH_REDIRECT_URI, title: 'Sign in to notion' })

    const older = await openPayload(BASE_PRIMITIVES, 'Sign in to notion')
    expect(older).toMatchObject({ captureRedirect: MCP_OAUTH_REDIRECT_URI })
    expect(older).not.toHaveProperty('title')

    const blank = await openPayload([...BASE_PRIMITIVES, 'webWindow.title'], '   ')
    expect(blank).not.toHaveProperty('title')
  })
})
