import { describe, expect, it, vi } from 'vitest'
import { DirectPortBridgeTransport } from '../browser/bridge/DirectPortBridgeTransport'
import type {
  BrowserBridgeRequest,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'
import {
  resolveHomeDirViaBridge,
  resolveHomeDirViaBridgeBounded,
} from '../utils/resolveHomeDirViaBridge'

// A transport whose `fs.userHome` answers immediately with `home`.
function fastTransport(home: string) {
  return {
    request: async () => ({ ok: true as const, result: home }),
  } as unknown as Parameters<typeof resolveHomeDirViaBridgeBounded>[0]
}

// A transport that receives the request but NEVER answers (the web-deployment /
// un-rebuilt-host case the timeout exists for).
function hangingTransport() {
  return {
    request: () => new Promise(() => {}),
  } as unknown as Parameters<typeof resolveHomeDirViaBridgeBounded>[0]
}

describe('resolveHomeDirViaBridgeBounded', () => {
  it('resolves the host home dir and reports no timeout', async () => {
    const result = await resolveHomeDirViaBridgeBounded(
      fastTransport('/home/user'),
      5_000,
    )
    expect(result).toEqual({ home: '/home/user', timedOut: false })
  })

  it('reports timedOut when the host never answers', async () => {
    vi.useFakeTimers()
    try {
      const pending = resolveHomeDirViaBridgeBounded(hangingTransport(), 5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(pending).resolves.toEqual({ home: null, timedOut: true })
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: the previous inline `Promise.race([probe, setTimeout(...)])` left
  // the timeout's `setTimeout` scheduled even after a fast host won the race, so
  // its callback fired ~8s after a SUCCESSFUL resolve and logged a spurious
  // "timed out … falling back" warning on every boot. The timer must be cleared.
  it('leaves no pending timer after a fast resolve (no spurious late timeout)', async () => {
    vi.useFakeTimers()
    try {
      const result = await resolveHomeDirViaBridgeBounded(
        fastTransport('/home/user'),
        5_000,
      )
      expect(result.timedOut).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('null transport → no home, not a timeout', async () => {
    const result = await resolveHomeDirViaBridgeBounded(undefined, 5_000)
    expect(result).toEqual({ home: null, timedOut: false })
  })
})

// A transport answering each request from `answer`, recording what was asked.
function scriptedTransport(
  answer: (request: BrowserBridgeRequest) => { ok: boolean; result?: unknown },
) {
  const requests: BrowserBridgeRequest[] = []
  const transport = {
    request: async (request: BrowserBridgeRequest) => {
      requests.push(request)
      const { ok, result } = answer(request)
      return ok
        ? { id: request.id, route: request.route, ok: true, result }
        : {
          id: request.id,
          route: request.route,
          ok: false,
          error: { code: 'bridge_timeout', message: 'timed out' },
        }
    },
  } as unknown as BrowserBridgeTransport
  return { transport, requests }
}

describe('resolveHomeDirViaBridge', () => {
  it('never answers the host working directory as the home', async () => {
    const { transport, requests } = scriptedTransport(request =>
      request.route.action === 'cwd'
        ? { ok: true, result: '/browser/cwd' }
        : { ok: false },
    )
    await expect(resolveHomeDirViaBridge(transport)).resolves.toBeNull()
    expect(requests.map(r => r.route.action)).not.toContain('cwd')
  })

  it('asks fs.userHome once more after a failed answer', async () => {
    let calls = 0
    const { transport, requests } = scriptedTransport(request => {
      if (request.route.action !== 'userHome') return { ok: true, result: '/cwd' }
      calls += 1
      return calls === 1 ? { ok: false } : { ok: true, result: '/home/user' }
    })
    await expect(resolveHomeDirViaBridge(transport)).resolves.toBe('/home/user')
    expect(requests.map(r => r.route.action)).toEqual(['userHome', 'userHome'])
  })

  it('gives calls in the same millisecond distinct request ids', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_791_827_617_257)
    try {
      const { transport, requests } = scriptedTransport(() => ({
        ok: true,
        result: '/home/user',
      }))
      await Promise.all([
        resolveHomeDirViaBridge(transport),
        resolveHomeDirViaBridge(transport),
      ])
      expect(new Set(requests.map(r => r.id)).size).toBe(2)
    } finally {
      now.mockRestore()
    }
  })

  // Two sessions booting together share the manager's one host port, whose
  // pending replies are keyed by request id.
  it('two sessions resolving at the same millisecond over one host port both get the home', async () => {
    const channel = new MessageChannel()
    const client = new DirectPortBridgeTransport({
      port: channel.port1,
      requestTimeoutMs: 200,
    })
    channel.port2.addEventListener('message', (event: MessageEvent) => {
      let data = event.data
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch { return }
      }
      if (data?.direction !== 'request') return
      channel.port2.postMessage({
        hostBridge: true,
        direction: 'response',
        id: data.id,
        route: data.route,
        ok: true,
        result: data.route.action === 'userHome' ? '/home/user' : '/browser/cwd',
      })
    })
    channel.port2.start()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_791_827_617_257)
    try {
      const homes = await Promise.all([
        resolveHomeDirViaBridge(client),
        resolveHomeDirViaBridge(client),
      ])
      expect(homes).toEqual(['/home/user', '/home/user'])
    } finally {
      now.mockRestore()
      client.dispose()
      channel.port2.close()
    }
  })
})
