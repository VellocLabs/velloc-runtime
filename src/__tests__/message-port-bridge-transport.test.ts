import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserBridgeRequest,
  BrowserBridgeRoute,
} from '../browser/bridge/protocol/core'
import { MessagePortBridgeTransport } from '../browser/bridge/transport/messagePortBridgeTransport'

function makeRoute(capability: string, action: string): BrowserBridgeRoute {
  return { namespace: 'nexus', capability, action } as BrowserBridgeRoute
}

/**
 * Poll until `predicate` holds. MessageChannel delivery is an event-loop
 * macrotask; a single `setTimeout(0)` can miss it under suite-wide event-loop
 * contention (a leaked timer or a slow async op elsewhere), making a positive
 * delivery assertion flaky. Polling waits up to `timeoutMs` instead.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  if (!predicate()) {
    throw new Error('waitFor: condition not met within ' + timeoutMs + 'ms')
  }
}

function makeRequest(
  capability: string,
  action: string,
  payload: Record<string, unknown> = {},
  id = 'req-1',
): BrowserBridgeRequest {
  return { id, route: makeRoute(capability, action), payload: payload as never }
}

describe('MessagePortBridgeTransport', () => {
  it('round-trips a request → response over a MessageChannel', async () => {
    const channel = new MessageChannel()
    const client = new MessagePortBridgeTransport({ port: channel.port1 })

    // Stand-in for the worker side: echo any request as a success
    // response using the same wire shape.
    channel.port2.addEventListener('message', (event: MessageEvent) => {
      const data = event.data
      if (data?.direction !== 'request') return
      channel.port2.postMessage({
        hostBridge: true,
        direction: 'response',
        id: data.id,
        route: data.route,
        ok: true,
        result: { echoed: data.payload },
      })
    })
    channel.port2.start()

    const response = await client.request(makeRequest('cap', 'act', { v: 1 }))
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.result).toEqual({ echoed: { v: 1 } })
    }

    client.dispose()
    channel.port2.close()
  })

  it('delivers a server-pushed event to subscribers', async () => {
    const channel = new MessageChannel()
    const client = new MessagePortBridgeTransport({ port: channel.port1 })
    const seen: Array<{ route: BrowserBridgeRoute; payload: unknown }> = []
    const unsub = client.subscribeEvents(envelope => {
      seen.push({ route: envelope.route, payload: envelope.payload })
    })

    channel.port2.postMessage({
      hostBridge: true,
      direction: 'event',
      route: makeRoute('features', 'changed'),
      payload: { enabled: { 'foo.bar': true } },
    })
    channel.port2.start()

    await waitFor(() => seen.length === 1)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.route.capability).toBe('features')
    expect(seen[0]!.route.action).toBe('changed')
    expect(seen[0]!.payload).toEqual({ enabled: { 'foo.bar': true } })

    unsub()
    client.dispose()
    channel.port2.close()
  })

  it('rejects pending requests when disposed', async () => {
    const channel = new MessageChannel()
    const client = new MessagePortBridgeTransport({ port: channel.port1 })
    const pendingPromise = client.request(makeRequest('slow', 'noResponse'))
    // No response will ever arrive from port2.
    client.dispose()
    await expect(pendingPromise).rejects.toThrow(/disposed/)
    channel.port2.close()
  })

  it('times out a request that gets no response', async () => {
    const channel = new MessageChannel()
    const client = new MessagePortBridgeTransport({
      port: channel.port1,
      requestTimeoutMs: 50,
    })
    await expect(
      client.request(makeRequest('cap', 'act')),
    ).rejects.toThrow(/timed out/)
    client.dispose()
    channel.port2.close()
  })

  it('ignores non-bridge messages (no bridge tag)', async () => {
    const channel = new MessageChannel()
    const client = new MessagePortBridgeTransport({ port: channel.port1 })
    const onEvent = vi.fn()
    client.subscribeEvents(onEvent)

    channel.port2.postMessage({ random: 'noise' })
    channel.port2.postMessage(null)
    channel.port2.postMessage(42)
    channel.port2.start()

    await new Promise(r => setTimeout(r, 0))
    expect(onEvent).not.toHaveBeenCalled()

    client.dispose()
    channel.port2.close()
  })

  it('ignores response envelopes for unknown request ids (late or duplicate)', async () => {
    const channel = new MessageChannel()
    const client = new MessagePortBridgeTransport({ port: channel.port1 })

    // No pending request — a stray response shouldn't blow up.
    channel.port2.postMessage({
      hostBridge: true,
      direction: 'response',
      id: 'never-sent',
      route: makeRoute('cap', 'act'),
      ok: true,
      result: {},
    })
    channel.port2.start()

    await new Promise(r => setTimeout(r, 0))
    // Nothing to assert directly — the test passes if no error is thrown.
    expect(true).toBe(true)

    client.dispose()
    channel.port2.close()
  })

  it('forwards request rejections when post-fail occurs', async () => {
    // Construct a port stub whose `postMessage` throws.
    const port: MessagePort = {
      postMessage: vi.fn(() => {
        throw new Error('port closed')
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      // The transport never inspects these.
      onmessage: null,
      onmessageerror: null,
      dispatchEvent: vi.fn(() => true),
    } as unknown as MessagePort
    const client = new MessagePortBridgeTransport({ port })

    await expect(client.request(makeRequest('cap', 'act'))).rejects.toThrow(/port closed/)
    client.dispose()
  })
  it('ignores a frame that carries some other tag instead of hostBridge', async () => {
    const channel = new MessageChannel()
    const client = new MessagePortBridgeTransport({ port: channel.port1, requestTimeoutMs: 50 })
    channel.port2.addEventListener('message', (event: MessageEvent) => {
      const data = event.data
      if (data?.direction !== 'request') return
      channel.port2.postMessage({
        someOtherBridge: true,
        direction: 'response',
        id: data.id,
        route: data.route,
        ok: true,
        result: 'legacy-tagged',
      })
    })
    channel.port2.start()

    await expect(client.request(makeRequest('cap', 'act'))).rejects.toThrow(/timed out/)

    client.dispose()
    channel.port2.close()
  })

  it('tags outgoing frames hostBridge and carries the call context next to the payload', async () => {
    const channel = new MessageChannel()
    const client = new MessagePortBridgeTransport({ port: channel.port1 })
    const seen: Record<string, unknown>[] = []
    channel.port2.addEventListener('message', (event: MessageEvent) => {
      const data = event.data
      if (data?.direction !== 'request') return
      seen.push(data)
      channel.port2.postMessage({
        hostBridge: true,
        direction: 'response',
        id: data.id,
        route: data.route,
        ok: true,
        result: null,
      })
    })
    channel.port2.start()

    await client.request({ ...makeRequest('cap', 'act', { v: 1 }), context: { sessionId: 's1' } })
    await client.request(makeRequest('cap', 'act', { v: 2 }, 'req-2'))

    expect(seen[0]).toMatchObject({ hostBridge: true, payload: { v: 1 }, context: { sessionId: 's1' } })
    expect(Object.keys(seen[0]!).filter(k => k.endsWith('Bridge'))).toEqual(['hostBridge'])
    expect(seen[1]).not.toHaveProperty('context')

    client.dispose()
    channel.port2.close()
  })
})
