import { describe, expect, it } from 'vitest'

import type {
  BridgeEventEnvelope,
  BrowserBridgeRequest,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'
import { createBridgeMcpOAuthHost } from '../mcp/oauth/bridgeMcpOAuthHost'
import { MCP_OAUTH_REDIRECT_URI, type McpSignInCapture } from '../mcp/oauth/McpOAuthService'

const BASE_PRIMITIVES = ['network.streamOpen', 'network.secretTemplates', 'network.secretFormBody', 'webWindow.captureRedirect']
const CAPTURED = `${MCP_OAUTH_REDIRECT_URI}?code=c&state=s`

/** A host whose window 7 captures CAPTURED as soon as it opens. */
function capturingHost(primitives: string[]) {
  const requests: BrowserBridgeRequest[] = []
  const listeners = new Set<(event: BridgeEventEnvelope) => void>()
  const transport: BrowserBridgeTransport = {
    async request(request) {
      requests.push(request as BrowserBridgeRequest)
      if (request.route.action === 'open') {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              route: { namespace: 'nexus', capability: 'webWindow', action: 'onRedirectCaptured' },
              payload: { windowId: 7, url: CAPTURED },
            } as BridgeEventEnvelope)
          }
        })
      }
      return { id: request.id, route: request.route, ok: true, result: { windowId: 7, ok: true } } as never
    },
    subscribeEvents: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  let next = 0
  const host = createBridgeMcpOAuthHost(
    { transport, manifest: { capabilities: ['secrets', 'webWindow'], primitives } },
    () => `r${next++}`,
  )
  const sent = (action: string) =>
    requests.filter(r => r.route.capability === 'webWindow' && r.route.action === action).map(r => r.payload)
  return { host, sent }
}

async function capture(primitives: string[]): Promise<{ captured: McpSignInCapture; sent: (action: string) => unknown[] }> {
  const { host, sent } = capturingHost(primitives)
  const captured = await host.openSignInWindow(
    'https://auth.example.test/authorize',
    MCP_OAUTH_REDIRECT_URI,
    new AbortController().signal,
  )
  return { captured, sent }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('sign-in window result', () => {
  it('keeps the window for the result and reports it once on a host that lists webWindow.signInResult', async () => {
    const { captured, sent } = await capture([...BASE_PRIMITIVES, 'webWindow.signInResult'])
    expect(captured.url).toBe(CAPTURED)
    expect(sent('open')[0]).toMatchObject({ captureRedirect: MCP_OAUTH_REDIRECT_URI, awaitSignInResult: true })

    captured.finish({ ok: false, reason: 'The user said no' })
    captured.finish({ ok: true })
    captured.close()
    await flush()
    expect(sent('showSignInResult')).toEqual([{ windowId: 7, ok: false, message: 'The user said no' }])
    expect(sent('close')).toEqual([])
  })

  it('sends no message with a success, or with a failure that has no reason', async () => {
    const ok = await capture([...BASE_PRIMITIVES, 'webWindow.signInResult'])
    ok.captured.finish({ ok: true })
    const bare = await capture([...BASE_PRIMITIVES, 'webWindow.signInResult'])
    bare.captured.finish({ ok: false })
    await flush()
    expect(ok.sent('showSignInResult')).toEqual([{ windowId: 7, ok: true }])
    expect(bare.sent('showSignInResult')).toEqual([{ windowId: 7, ok: false }])
  })

  it('closes the waiting window when the sign-in is cancelled', async () => {
    const { captured, sent } = await capture([...BASE_PRIMITIVES, 'webWindow.signInResult'])
    captured.close()
    await flush()
    expect(sent('close')).toEqual([{ windowId: 7 }])
    expect(sent('showSignInResult')).toEqual([])
  })

  it('asks an older host for nothing: it closed the window on the capture', async () => {
    const { captured, sent } = await capture(BASE_PRIMITIVES)
    expect(sent('open')[0]).not.toHaveProperty('awaitSignInResult')
    captured.finish({ ok: true })
    captured.close()
    await flush()
    expect(sent('showSignInResult')).toEqual([])
    expect(sent('close')).toEqual([])
  })
})
