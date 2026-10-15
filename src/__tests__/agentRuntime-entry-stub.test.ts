/**
 * The runtime SharedWorker entry is a STUB: it installs `onconnect`
 * synchronously through a connect gate and `import()`s the runtime body. The
 * split exists for V8 code cache — a worker main script and its static import
 * graph are never cached, dynamically imported chunks are — so these tests
 * guard both the behaviour (no connect is lost while the body loads) and the
 * shape (the entry stays free of static imports).
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_UNAVAILABLE_BYE,
  createConnectGate,
} from '../browser/worker/agentRuntimeConnectGate'
import { RuntimeConnectionClosedError, connectRuntime } from '@/browser/runtimeClient'
import { readFrame, type Frame } from '@/browser/runtimeProtocol'
import { ListenerSet, type FrameTransport } from '@/browser/runtimeTransport'

/**
 * A SharedWorker-side port as the gate sees it: `postMessage` is spied, and a
 * test can deliver a message to whatever listener the gate installed —
 * `attach(wire)` plays the page's `bridge.attachRuntimePort`, which transfers
 * the connection wire the page actually listens on.
 */
type FakePort = MessagePort & {
  postMessage: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  attach(wire: MessagePort): void
  listenerCount(): number
}

function fakePort(label: string): FakePort {
  const listeners: Array<(event: MessageEvent) => void> = []
  return {
    label,
    postMessage: vi.fn(),
    start: vi.fn(),
    addEventListener(_type: string, listener: (event: MessageEvent) => void) {
      listeners.push(listener)
    },
    attach(wire: MessagePort) {
      const event = { data: { type: 'bridge.attachRuntimePort' }, ports: [wire] } as unknown as MessageEvent
      for (const listener of listeners) listener(event)
    },
    listenerCount: () => listeners.length,
  } as unknown as FakePort
}

function connectEvent(port?: MessagePort): MessageEvent {
  return { ports: port ? [port] : [] } as unknown as MessageEvent
}

describe('agentRuntimeConnectGate', () => {
  it('queues ports that arrive before open() and delivers them in order', () => {
    const gate = createConnectGate()
    const a = fakePort('a')
    const b = fakePort('b')
    gate.onconnect(connectEvent(a))
    gate.onconnect(connectEvent(b))
    expect(gate.waitingCount).toBe(2)

    const accept = vi.fn()
    gate.open(accept)

    expect(accept.mock.calls.map(([p]) => p)).toEqual([a, b])
    expect(gate.waitingCount).toBe(0)
  })

  it('hands later connects straight through once open', () => {
    const gate = createConnectGate()
    const accept = vi.fn()
    gate.open(accept)

    const c = fakePort('c')
    gate.onconnect(connectEvent(c))

    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith(c)
    expect(gate.waitingCount).toBe(0)
  })

  it('ignores a connect event that carries no port', () => {
    const gate = createConnectGate()
    gate.onconnect(connectEvent())
    const accept = vi.fn()
    gate.open(accept)
    expect(accept).not.toHaveBeenCalled()
  })

  it('keeps arrival order for a port that connects re-entrantly during the drain', () => {
    const gate = createConnectGate()
    const a = fakePort('a')
    const b = fakePort('b')
    const late = fakePort('late')
    gate.onconnect(connectEvent(a))
    gate.onconnect(connectEvent(b))

    const seen: MessagePort[] = []
    gate.open((port) => {
      seen.push(port)
      if (port === a) {
        // An acceptor side effect re-enters the gate while it is draining:
        // the newcomer must queue BEHIND `b`, not jump ahead of it.
        gate.onconnect(connectEvent(late))
      }
    })

    expect(seen).toEqual([a, b, late])
    expect(gate.waitingCount).toBe(0)
  })

  it('refuses to open twice', () => {
    const gate = createConnectGate()
    gate.open(() => {})
    expect(() => gate.open(() => {})).toThrow(/open\(\) called twice/)
  })

  it('fail() answers every wire a queued or later port transfers in with the bye frame', () => {
    const gate = createConnectGate()
    const a = fakePort('a')
    const b = fakePort('b')
    gate.onconnect(connectEvent(a))
    gate.onconnect(connectEvent(b))
    // Until the gate gives up, it must not read the ports: the runtime's
    // manager is the one that attaches and starts them.
    expect(a.listenerCount()).toBe(0)

    gate.fail()

    // The page talks on the wire it transfers, not on the SharedWorker port.
    expect(a.postMessage).not.toHaveBeenCalled()
    expect(a.start).toHaveBeenCalledTimes(1)
    const wireA = fakePort('wire-a')
    const wireB = fakePort('wire-b')
    a.attach(wireA)
    b.attach(wireB)
    expect(wireA.postMessage).toHaveBeenCalledWith(RUNTIME_UNAVAILABLE_BYE)
    expect(wireB.postMessage).toHaveBeenCalledWith(RUNTIME_UNAVAILABLE_BYE)
    expect(gate.waitingCount).toBe(0)

    const later = fakePort('later')
    gate.onconnect(connectEvent(later))
    const wireLater = fakePort('wire-later')
    later.attach(wireLater)
    expect(wireLater.postMessage).toHaveBeenCalledWith(RUNTIME_UNAVAILABLE_BYE)

    gate.fail() // idempotent: no second listener, no second start
    expect(a.listenerCount()).toBe(1)
    expect(a.start).toHaveBeenCalledTimes(1)
    expect(() => gate.open(() => {})).toThrow(/open\(\) after fail\(\)/)
  })

  it('the bye frame is a wire-valid final close the page connection acts on', async () => {
    // The gate carries the frame as a literal (a type-only import keeps the
    // protocol module out of the worker entry's runtime graph). Guard the
    // literal against the real codec and the real RuntimeConnection: the
    // codec must accept it as-is (an unknown bye code would be tolerated as
    // `shutting_down`, which a reconnectable peer would treat as a restart),
    // and a connection still in its handshake must reject with that code.
    const decoded = readFrame(JSON.parse(JSON.stringify(RUNTIME_UNAVAILABLE_BYE)))
    expect(decoded).toEqual({ kind: 'bye', code: 'runtime_unavailable' })

    const transport = scriptedTransport()
    const promise = connectRuntime({
      transport,
      client: { clientId: 'c1', kind: 'desktop-shell' },
      handshakeTimeoutMs: 0,
    })
    transport.deliver(decoded!)
    const error = await promise.then(
      () => {
        throw new Error('expected the handshake to reject')
      },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(RuntimeConnectionClosedError)
    expect((error as RuntimeConnectionClosedError).code).toBe('runtime_unavailable')
  })

  it('fail() after open() is refused', () => {
    const gate = createConnectGate()
    gate.open(() => {})
    expect(() => gate.fail()).toThrow(/fail\(\) after open\(\)/)
  })
})

describe('agentRuntime.sharedworker entry stub', () => {
  const entryUrl = new URL(
    '../browser/worker/agentRuntime.sharedworker.ts',
    import.meta.url,
  )
  const entrySource = readFileSync(fileURLToPath(entryUrl), 'utf8')

  it('statically imports nothing but the connect gate', () => {
    // Every static import here lands in the worker main-script graph, which
    // Chromium never serves from V8 code cache. The body must stay behind
    // `import()`.
    const staticImports = [...entrySource.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1])
    expect(staticImports).toEqual(['./agentRuntimeConnectGate'])
    expect(entrySource).not.toMatch(/^import\s+['"]/m) // no bare side-effect imports
  })

  it('loads the runtime body through a dynamic import that exists on disk', () => {
    const dynamic = entrySource.match(/import\(\s*['"]([^'"]+)['"]\s*\)/g) ?? []
    expect(dynamic).toEqual(["import('./agentRuntimeBody')"])
    expect(
      existsSync(fileURLToPath(new URL('../browser/worker/agentRuntimeBody.ts', import.meta.url))),
    ).toBe(true)
  })
})

describe('agentRuntime.sharedworker entry wiring', () => {
  const scope = globalThis as typeof globalThis & {
    onconnect?: ((event: MessageEvent) => void) | null
  }
  const originalOnconnect = scope.onconnect

  afterEach(() => {
    scope.onconnect = originalOnconnect
    vi.resetModules()
    vi.doUnmock('../browser/worker/agentRuntimeBody')
  })

  it('installs onconnect synchronously and delivers early ports once the body loads', async () => {
    const accept = vi.fn()
    const startAgentRuntime = vi.fn(() => accept)
    vi.doMock('../browser/worker/agentRuntimeBody', () => ({ startAgentRuntime }))

    scope.onconnect = null
    const entryEvaluated = import('../browser/worker/agentRuntime.sharedworker')
    await entryEvaluated

    // The handler is in place as soon as the entry has evaluated — before the
    // body import has had a chance to settle in a real browser.
    expect(typeof scope.onconnect).toBe('function')
    const early = fakePort('early')
    scope.onconnect!(connectEvent(early))

    await vi.waitFor(() => expect(startAgentRuntime).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(early))

    const late = fakePort('late')
    scope.onconnect!(connectEvent(late))
    expect(accept).toHaveBeenLastCalledWith(late)
    expect(accept).toHaveBeenCalledTimes(2)
  })

  it('refuses queued and later ports with the bye frame when the body import rejects', async () => {
    // A failed body import cannot be reported to the pages as a worker error
    // (the worker's evaluation phase is over) and the MessagePort `close`
    // event is behind a test-only runtime flag, so the stub must POST on each
    // port — the bye frame the page connection turns into a final close. Left
    // queued, every page would wait on `worker.init` forever.
    vi.doMock('../browser/worker/agentRuntimeBody', () => {
      throw new Error('chunk 404')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    scope.onconnect = null
    await import('../browser/worker/agentRuntime.sharedworker')
    const early = fakePort('early')
    scope.onconnect!(connectEvent(early))

    await vi.waitFor(() => expect(early.start).toHaveBeenCalledTimes(1))
    const earlyWire = fakePort('early-wire')
    early.attach(earlyWire)
    expect(earlyWire.postMessage).toHaveBeenCalledWith(RUNTIME_UNAVAILABLE_BYE)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('runtime body failed to load'),
      expect.any(Error),
    )

    const later = fakePort('later')
    scope.onconnect!(connectEvent(later))
    const laterWire = fakePort('later-wire')
    later.attach(laterWire)
    expect(laterWire.postMessage).toHaveBeenCalledWith(RUNTIME_UNAVAILABLE_BYE)
    consoleError.mockRestore()
  })
})

/** A FrameTransport the test feeds frames into; `send` is swallowed. */
function scriptedTransport(): FrameTransport & { deliver(frame: Frame): void } {
  const frames = new ListenerSet<[Frame]>()
  const closed = new ListenerSet<[string, boolean]>()
  const transport: FrameTransport & { deliver(frame: Frame): void } = {
    kind: 'message-port',
    limits: { chunkBytes: 1024, windowChunks: 8 },
    bufferedBytes: () => 0,
    send() {},
    sendBlobChunk() {},
    onFrame: l => frames.add(l),
    onBlobChunk: () => () => {},
    onClosed: l => closed.add(l),
    deliver(frame) {
      frames.emit(frame)
    },
    close() {
      closed.emit('closed', false)
    },
  }
  return transport
}
