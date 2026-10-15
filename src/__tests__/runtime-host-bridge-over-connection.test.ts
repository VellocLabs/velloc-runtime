/**
 * The page's `BrowserBridgeTransport` over one `RuntimeConnection`: host routes ride `req`/`res` in the legacy
 * envelope, error codes survive, `host_unavailable` retries through the boot window, `fs.*` has no route, a denied
 * route fails with `forbidden_scope`, and host events delegate to the page port.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { BrowserBridgeRequest, BrowserBridgeTransport } from '../browser/bridge/protocol/core'
import { wireError } from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { CapabilityRegistry, ConnectionHub, TopicBroker, type HostBridge, type RuntimeContext } from '../browser/runtimeHub'
import { hostProxySpecs } from '../browser/runtimeHub/hostProxyTable'
import {
  BRIDGE_TRANSPORT_ERROR_CODE,
  connectRuntime,
  createHostBridgeTransportOverConnection,
  wireErrorToLegacy,
  type RuntimeConnection,
} from '../browser/runtimeClient'

type Envelope = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; data?: unknown } }

function makeServer(host: HostBridge | null) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'rc-test',
    bootstrap: () => ({ homeDir: '/h', platform: 'test', pathSep: '/' }),
  })
  for (const spec of hostProxySpecs()) registry.registerHostProxy(spec)
  return { registry, hub, context }
}

function connect(server: ReturnType<typeof makeServer>, scopeCeiling?: 'observe' | 'control' | 'full'): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  server.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'page', kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

function req(capability: string, action: string, payload: unknown = {}): BrowserBridgeRequest {
  return {
    id: `r-${capability}-${action}`,
    route: { namespace: 'nexus', capability, action },
    payload,
  } as unknown as BrowserBridgeRequest
}

/** A fake C++ side: answers by route, records what it saw. */
function fakeHost(answer: (route: string, payload: unknown) => Envelope): HostBridge & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async request(route, payload) {
      const key = `${route.capability}.${route.action}`
      calls.push(key)
      return answer(key, payload) as never
    },
  }
}

describe('createHostBridgeTransportOverConnection', () => {
  it('a host route rides the protocol and comes back in the legacy envelope, id and route echoed', async () => {
    const host = fakeHost((key, payload) => ({ ok: true, result: { key, payload } }))
    const server = makeServer(host)
    const transport = createHostBridgeTransportOverConnection({ connection: () => connect(server) })
    const res = await transport.request(req('appInfo', 'getVersionInfo', { q: 1 }))
    expect(res).toEqual({
      id: 'r-appInfo-getVersionInfo',
      route: { namespace: 'nexus', capability: 'appInfo', action: 'getVersionInfo' },
      ok: true,
      result: { key: 'appInfo.getVersionInfo', payload: { q: 1 } },
    })
    expect(host.calls).toEqual(['appInfo.getVersionInfo'])
  })

  it("a C++ error code the hub folded into `internal` is unfolded; a protocol code passes through", async () => {
    const host = fakeHost(key =>
      key === 'search.queryTranscripts'
        ? { ok: false, error: { code: 'SEARCH_BAD_PATTERN', message: 'bad regex', data: { at: 3 } } }
        : { ok: false, error: { code: 'not_found', message: 'no such tab' } },
    )
    const server = makeServer(host)
    const transport = createHostBridgeTransportOverConnection({ connection: () => connect(server) })
    const search = (await transport.request(req('search', 'queryTranscripts'))) as Envelope
    expect(search).toMatchObject({ ok: false, error: { code: 'SEARCH_BAD_PATTERN', message: 'bad regex', data: { at: 3 } } })
    const tab = (await transport.request(req('session', 'setActiveSession'))) as Envelope
    expect(tab).toMatchObject({ ok: false, error: { code: 'not_found', message: 'no such tab' } })
  })

  it('wireErrorToLegacy is the inverse of the hub mapping for both shapes', () => {
    expect(wireErrorToLegacy(wireError('internal', 'm', { code: 'X_CODE', data: { k: 1 } }))).toEqual({
      code: 'X_CODE',
      message: 'm',
      data: { k: 1 },
    })
    expect(wireErrorToLegacy(wireError('internal', 'm', { code: 'X_CODE' }))).toEqual({ code: 'X_CODE', message: 'm' })
    expect(wireErrorToLegacy(wireError('forbidden_scope', 'no'))).toEqual({ code: 'forbidden_scope', message: 'no' })
    expect(wireErrorToLegacy(wireError('internal', 'plain'))).toEqual({ code: 'internal', message: 'plain' })
  })

  it('host_unavailable is retried across the boot-order window, then surfaces as itself', async () => {
    const host = fakeHost(() => ({ ok: true, result: 'later' }))
    const server = makeServer(null)
    const transport = createHostBridgeTransportOverConnection({
      connection: () => connect(server),
      retry: { attempts: 4, delayMs: 5 },
    })
    // The C++ port arrives while the first attempts are failing.
    setTimeout(() => {
      server.context.host = host
    }, 12)
    const res = (await transport.request(req('ui', 'getBootTimings'))) as Envelope
    expect(res).toMatchObject({ ok: true, result: 'later' })

    const never = makeServer(null)
    const stuck = createHostBridgeTransportOverConnection({
      connection: () => connect(never),
      retry: { attempts: 2, delayMs: 1 },
    })
    const failed = (await stuck.request(req('ui', 'getBootTimings'))) as Envelope
    expect(failed).toMatchObject({ ok: false, error: { code: 'host_unavailable' } })
  })

  it('there is no direct seam: `fs.*` rides the connection, has no route, and never reaches the page port or the host', async () => {
    const host = fakeHost(() => ({ ok: true, result: 'must not reach the host' }))
    const server = makeServer(host)
    const pagePort: BrowserBridgeTransport = {
      request: vi.fn(async () => {
        throw new Error('the page port must never be requested')
      }) as never,
    }
    const transport = createHostBridgeTransportOverConnection({
      connection: () => connect(server),
      events: pagePort,
    })
    const res = (await transport.request(req('fs', 'readFile', { path: 'a' }))) as Envelope
    expect(res).toMatchObject({ ok: false, error: { code: 'unknown_route' } })
    expect(host.calls).toEqual([])
    expect(pagePort.request).not.toHaveBeenCalled()
  })

  it('a route the hub denies fails with forbidden_scope — it is NOT retried on the direct port', async () => {
    const host = fakeHost(() => ({ ok: true, result: 'must not reach the host' }))
    const server = makeServer(host)
    const pagePort: BrowserBridgeTransport = {
      request: vi.fn(async () => {
        throw new Error('the page port must not be used for a denied route')
      }) as never,
    }
    const transport = createHostBridgeTransportOverConnection({
      connection: () => connect(server, 'control'),
      events: pagePort,
    })
    const denied = (await transport.request(req('ui', 'openUrl', { url: 'https://x' }))) as Envelope
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden_scope' } })
    expect(host.calls).toEqual([])
    expect(pagePort.request).not.toHaveBeenCalled()
    // The one observe-scoped read still works under the ceiling.
    const version = (await transport.request(req('appInfo', 'getVersionInfo'))) as Envelope
    expect(version).toMatchObject({ ok: true })
  })

  it('a connection that never comes up answers bridge_transport_error instead of throwing', async () => {
    const transport = createHostBridgeTransportOverConnection({
      connection: () => Promise.reject(new Error('runtime connection closed (transport)')),
    })
    const res = (await transport.request(req('ui', 'openUrl'))) as Envelope
    expect(res).toMatchObject({
      ok: false,
      error: { code: BRIDGE_TRANSPORT_ERROR_CODE, message: 'runtime connection closed (transport)' },
    })
  })

  it('host-pushed events delegate to the page port while it exists, and are absent without it', () => {
    const unsubscribe = vi.fn()
    const subscribeEvents = vi.fn(() => unsubscribe)
    const withEvents = createHostBridgeTransportOverConnection({
      connection: () => Promise.reject(new Error('unused')),
      events: { request: vi.fn() as never, subscribeEvents },
    })
    const handler = vi.fn()
    expect(withEvents.subscribeEvents?.(handler)).toBe(unsubscribe)
    expect(subscribeEvents).toHaveBeenCalledWith(handler)

    const withoutEvents = createHostBridgeTransportOverConnection({
      connection: () => Promise.reject(new Error('unused')),
    })
    expect(withoutEvents.subscribeEvents).toBeUndefined()
  })
})
