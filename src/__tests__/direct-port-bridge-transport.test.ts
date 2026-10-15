// DirectPortBridgeTransport timeouts and orphans: the `model` capability's timeout (100s) sits above the host's
// 90s idle deadline so the native timeout wins; a response with no pending entry is traced via traceLine and
// dropped, never routed into a flow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DirectPortBridgeTransport,
  __test_only_getRouteTimeoutMs,
} from '../browser/bridge/DirectPortBridgeTransport'
import type { BrowserBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import { startTraceCapture } from '../utils/debugLog'
import {
  getWorkerLogBuffer,
  setWorkerLogCaptureSource,
} from '../utils/workerLogBuffer'

function makeRoute(capability: string, action: string): BrowserBridgeRoute {
  return { namespace: 'nexus', capability, action } as BrowserBridgeRoute
}

/**
 * Poll until `predicate` holds. MessageChannel delivery is an event-loop
 * macrotask; a single `setTimeout(0)` can miss it under suite-wide event-loop
 * contention, making a positive delivery assertion flaky. Polling waits up to
 * `timeoutMs` instead.
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

describe('DirectPortBridgeTransport — model timeout override + orphan logging', () => {
  beforeEach(() => {
    startTraceCapture()
    getWorkerLogBuffer().clear()
  })
  afterEach(() => {
    setWorkerLogCaptureSource('debug', false)
    getWorkerLogBuffer().clear()
  })

  function orphanLogs(): string[] {
    return getWorkerLogBuffer()
      .drain()
      .map(e => e.text)
      .filter(m => m.includes('[bridge] orphan response'))
  }

  it('resolves model routes to a 100s timeout, above the native 90s deadline', () => {
    // Assert the override value directly (no real 100s wait). The contract:
    // model's timeout must sit ABOVE the native stream-idle deadline (default
    // 90s) so the native timeout — which cancels upstream and returns a typed
    // {status:'timeout'} — always wins the race; the JS transport is only the
    // fallback for a response that never arrives at all.
    expect(__test_only_getRouteTimeoutMs(makeRoute('model', 'rawStreamRead'), 30_000)).toBe(100_000)
    expect(__test_only_getRouteTimeoutMs(makeRoute('model', 'rawStreamOpen'), 30_000)).toBe(100_000)
  })

  it('gives network.streamOpen its own 610s timeout, above the 600s MCP idle deadline', () => {
    expect(__test_only_getRouteTimeoutMs(makeRoute('network', 'streamOpen'), 30_000)).toBe(610_000)
  })

  it('leaves non-model routes on the default timeout', () => {
    expect(__test_only_getRouteTimeoutMs(makeRoute('fs', 'cwd'), 30_000)).toBe(30_000)
    // browser keeps its own 185s override.
    expect(__test_only_getRouteTimeoutMs(makeRoute('browser', 'click'), 30_000)).toBe(185_000)
  })

  it('logs + drops an orphan response (no pending entry) instead of resolving', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({ port: channel.port1 })
    channel.port2.start()

    // Push a response for an id that was never requested (orphan).
    channel.port2.postMessage({
      hostBridge: true,
      direction: 'response',
      id: 'never-requested',
      route: makeRoute('model', 'rawStreamRead'),
      ok: true,
      result: { chunks: [], done: false, status: 'ok' },
    })

    await waitFor(() => orphanLogs().length === 1)
    const log = orphanLogs()[0]!
    expect(log).toContain('id=never-requested')
    expect(log).toContain('model/rawStreamRead')

    client.dispose()
    channel.port2.close()
  })

  it('treats a late response (arriving after its timeout) as an orphan', async () => {
    const channel = new MessageChannel()
    // A tiny base timeout so the request times out fast; use an fs route so no
    // capability override lifts it back up.
    const client = new DirectPortBridgeTransport({
      port: channel.port1,
      requestTimeoutMs: 50,
    })

    // Hold port2 silent until after the timeout, then send a LATE response.
    // NOTE: the DirectPort control envelope is posted as a JSON STRING, so
    // port2 must JSON.parse before inspecting `direction`.
    let resolveLate: (() => void) | null = null
    channel.port2.addEventListener('message', (event: MessageEvent) => {
      let data = event.data
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch { return }
      }
      if (data?.direction !== 'request') return
      const reqId = data.id
      const reqRoute = data.route
      resolveLate = () => {
        channel.port2.postMessage({
          hostBridge: true,
          direction: 'response',
          id: reqId,
          route: reqRoute,
          ok: true,
          result: {},
        })
      }
    })
    channel.port2.start()

    // Start the request WITHOUT awaiting: we must let port2's message event
    // fire (arming resolveLate) before the 50ms timeout resolves the promise.
    // Awaiting here would race — under event-loop contention port2's delivery
    // can land after the timeout callback, leaving resolveLate unarmed.
    const responsePromise = client.request({
      id: 'late-1',
      route: makeRoute('fs', 'cwd'),
      payload: {} as never,
    })

    // Wait until port2 has actually received the request (resolveLate armed),
    // THEN let the 50ms timeout elapse so the pending entry is deleted.
    await waitFor(() => resolveLate !== null)

    const response = await responsePromise
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('bridge_timeout')
    }

    // The pending entry is gone (deleted on timeout). Fire the late response —
    // it must be logged as an orphan, not resolved anywhere.
    resolveLate!()
    await waitFor(() => orphanLogs().length === 1)
    expect(orphanLogs()[0]).toContain('id=late-1')

    client.dispose()
    channel.port2.close()
  })
})

describe('DirectPortBridgeTransport — request rollback when serialize/post throws', () => {
  it('rejects, clears the timer and drops the pending entry so dispose() has nothing to resolve', async () => {
    vi.useFakeTimers()
    try {
      const channel = new MessageChannel()
      const client = new DirectPortBridgeTransport({ port: channel.port1 })
      expect(vi.getTimerCount()).toBe(0)

      // A BigInt payload makes JSON.stringify throw AFTER the pending entry
      // and its timer were registered.
      await expect(
        client.request({
          id: 'boom-1',
          route: makeRoute('fs', 'cwd'),
          payload: { n: BigInt(1) } as never,
        }),
      ).rejects.toBeInstanceOf(TypeError)

      // No leaked timeout (pre-fix: a 30s timer stayed armed) …
      expect(vi.getTimerCount()).toBe(0)
      // … and no leaked pending entry: dispose() must not try to resolve the
      // already-rejected request. (Private map, inspected on purpose — the leak
      // has no other observable from the public surface.)
      expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
      client.dispose()
      channel.port2.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DirectPortBridgeTransport — unconsumed transferred ports are closed', () => {
  /** Resolves when `port`'s counterpart is closed (Node emits 'close' on
   *  either end once the channel is disconnected). */
  function closedSignal(port: MessagePort): { closed: () => boolean } {
    let closed = false
    port.addEventListener('close', () => {
      closed = true
    })
    port.start()
    return { closed: () => closed }
  }

  /** Host side: answer every request via `reply(request) → [message, ports]`. */
  function host(
    port2: MessagePort,
    reply: (req: { id: string; route: BrowserBridgeRoute }) => [unknown, MessagePort[]] | null,
  ): void {
    port2.addEventListener('message', (event: MessageEvent) => {
      let data = event.data
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch { return }
      }
      if (data?.direction !== 'request') return
      const answer = reply({ id: data.id, route: data.route })
      if (!answer) return
      port2.postMessage(answer[0], answer[1])
    })
    port2.start()
  }

  it('closes the port(s) riding on an orphan response', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({ port: channel.port1 })
    const stray = new MessageChannel()
    const sig = closedSignal(stray.port2)
    channel.port2.start()
    channel.port2.postMessage(
      {
        hostBridge: true,
        direction: 'response',
        id: 'never-requested',
        route: makeRoute('fs', 'readFile'),
        ok: true,
        result: null,
      },
      [stray.port1],
    )
    await waitFor(sig.closed)
    client.dispose()
    channel.port2.close()
  })

  it('closes a port sent on a json route', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({ port: channel.port1 })
    const stray = new MessageChannel()
    const sig = closedSignal(stray.port2)
    host(channel.port2, ({ id, route }) => [
      { hostBridge: true, direction: 'response', id, route, ok: true, result: '/cwd' },
      [stray.port1],
    ])
    const response = await client.request({
      id: 'json-1',
      route: makeRoute('fs', 'cwd'),
      payload: {} as never,
    })
    expect(response.ok).toBe(true)
    await waitFor(sig.closed)
    client.dispose()
    channel.port2.close()
  })

  it('closes the port on an ok:false envelope for a response_port route', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({ port: channel.port1 })
    const stray = new MessageChannel()
    const sig = closedSignal(stray.port2)
    host(channel.port2, ({ id, route }) => [
      {
        hostBridge: true,
        direction: 'response',
        id,
        route,
        ok: false,
        error: { code: 'FS_ERROR', message: 'EACCES: permission denied' },
      },
      [stray.port1],
    ])
    const response = await client.request({
      id: 'err-1',
      route: makeRoute('fs', 'readFile'),
      payload: { path: '/x' } as never,
    })
    expect(response.ok).toBe(false)
    await waitFor(sig.closed)
    client.dispose()
    channel.port2.close()
  })

  it('reads the declared port and closes a surplus one on a response_port route', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({ port: channel.port1 })
    const bytesChannel = new MessageChannel()
    const surplus = new MessageChannel()
    const sig = closedSignal(surplus.port2)
    host(channel.port2, ({ id, route }) => {
      const payload = new Uint8Array([1, 2, 3])
      bytesChannel.port2.postMessage(payload.buffer, [payload.buffer])
      return [
        { hostBridge: true, direction: 'response', id, route, ok: true, result: null },
        [bytesChannel.port1, surplus.port1],
      ]
    })
    const response = await client.request({
      id: 'bin-1',
      route: makeRoute('fs', 'readFile'),
      payload: { path: '/x' } as never,
    })
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(Array.from(response.result as Uint8Array)).toEqual([1, 2, 3])
    }
    await waitFor(sig.closed)
    client.dispose()
    channel.port2.close()
  })

  it('network.httpRequest sends the body on a port — an empty one without a body — and stitches the response body back', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({ port: channel.port1 })
    const received: Array<{ payload: Record<string, unknown>; body: number[] }> = []
    channel.port2.addEventListener('message', (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      if (data?.direction !== 'request') return
      const [bodyPort] = event.ports
      bodyPort!.addEventListener('message', (bytes: MessageEvent) => {
        bodyPort!.close()
        received.push({ payload: data.payload, body: Array.from(new Uint8Array(bytes.data as ArrayBuffer)) })
        const answer = new Uint8Array([9, 8, 7])
        const back = new MessageChannel()
        back.port2.postMessage(answer.buffer, [answer.buffer])
        channel.port2.postMessage(
          { hostBridge: true, direction: 'response', id: data.id, route: data.route, ok: true, result: { status: 200, headers: {} } },
          [back.port1],
        )
      })
      bodyPort!.start()
    })
    channel.port2.start()

    const posted = await client.request({
      id: 'http-1',
      route: makeRoute('network', 'httpRequest'),
      payload: { url: 'https://a.example/', method: 'POST', body: new Uint8Array([1, 2]) } as never,
    })
    const got = await client.request({
      id: 'http-2',
      route: makeRoute('network', 'httpRequest'),
      payload: { url: 'https://a.example/' } as never,
    })
    expect(received).toEqual([
      { payload: { url: 'https://a.example/', method: 'POST' }, body: [1, 2] },
      { payload: { url: 'https://a.example/' }, body: [] },
    ])
    for (const response of [posted, got]) {
      expect(response.ok).toBe(true)
      if (response.ok) {
        const result = response.result as { status: number; body: Uint8Array }
        expect(result.status).toBe(200)
        expect(Array.from(result.body)).toEqual([9, 8, 7])
      }
    }
    client.dispose()
    channel.port2.close()
  })

  it('closes ports on an event whose route declares no binary fields', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({ port: channel.port1 })
    const stray = new MessageChannel()
    const sig = closedSignal(stray.port2)
    const seen: unknown[] = []
    client.subscribeEvents(e => { seen.push(e) })
    channel.port2.start()
    channel.port2.postMessage(
      {
        hostBridge: true,
        direction: 'event',
        route: makeRoute('fs', 'cwd'),
        payload: { kind: 'noop' },
      },
      [stray.port1],
    )
    await waitFor(() => seen.length === 1)
    await waitFor(sig.closed)
    client.dispose()
    channel.port2.close()
  })
  it('puts the call context on the control envelope next to the payload', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({ port: channel.port1 })
    const seen: Record<string, unknown>[] = []
    channel.port2.addEventListener('message', (event: MessageEvent) => {
      let data = event.data
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch { return }
      }
      if (data?.direction !== 'request') return
      seen.push(data)
      channel.port2.postMessage(
        JSON.stringify({ hostBridge: true, direction: 'response', id: data.id, route: data.route, ok: true, result: null }),
      )
    })
    channel.port2.start()

    await client.request({
      id: 'ctx-1',
      route: makeRoute('files', 'read'),
      payload: { file_path: '/x' } as never,
      context: { sessionId: 's1' },
    })

    expect(seen[0]).toMatchObject({
      hostBridge: true,
      direction: 'request',
      id: 'ctx-1',
      payload: { file_path: '/x' },
      context: { sessionId: 's1' },
    })
    expect(Object.keys(seen[0]!).filter(k => k.endsWith('Bridge'))).toEqual(['hostBridge'])

    client.dispose()
    channel.port2.close()
  })
})
