import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRuntimeHostPage, runRuntimeHostPage } from '../browser/boot/runtimeHostPage'
import {
  RUNTIME_LOSS_MAX_RELOADS,
  RUNTIME_LOSS_WINDOW_MS,
  reloadWhenRuntimeLost,
} from '../browser/boot/runtimeLossReload'
import { BridgeRequestRouter } from '../browser/worker/BridgeRequestRouter'
import { RUNTIME_ALIVE_LOCK, holdRuntimeAliveLock } from '../browser/worker/runtimeAliveLock'
import {
  kernelControlPortsNewestFirst,
  openInstance,
  resetKernelForTests,
  setKernelControlPort,
} from '../browser/workerKernel/IsolatedWorkerKernel'

describe('runtime host page mark', () => {
  it('reads the role from the fragment, with or without the leading #', () => {
    expect(isRuntimeHostPage('#role=runtime-host')).toBe(true)
    expect(isRuntimeHostPage('role=runtime-host')).toBe(true)
    expect(isRuntimeHostPage('#channel=beta&role=runtime-host')).toBe(true)
  })

  it('is false for a window page and for other fragments', () => {
    expect(isRuntimeHostPage('')).toBe(false)
    expect(isRuntimeHostPage(null)).toBe(false)
    expect(isRuntimeHostPage(undefined)).toBe(false)
    expect(isRuntimeHostPage('#role=ui')).toBe(false)
    expect(isRuntimeHostPage('#runtime-host')).toBe(false)
    expect(isRuntimeHostPage('#rt=abc')).toBe(false)
  })

  it('never reads as a remote pairing link', () => {
    // The warm-up script skips the worker when the fragment carries `rt=`.
    expect('#role=runtime-host'.includes('rt=')).toBe(false)
  })
})

type Posted = { message: { type: string; role?: string; owner?: string }; transfer: Transferable[] }

function hostPageHarness() {
  const posted: Posted[] = []
  const listeners = new Set<(event: MessageEvent) => void>()
  const target = {
    addEventListener: (_type: string, listener: unknown) => {
      listeners.add(listener as (event: MessageEvent) => void)
    },
    removeEventListener: (_type: string, listener: unknown) => {
      listeners.delete(listener as (event: MessageEvent) => void)
    },
  } as unknown as Pick<typeof globalThis, 'addEventListener' | 'removeEventListener'>
  const shell = { postMessage: vi.fn() }
  const installKernelHost = vi.fn()
  const holdLock = vi.fn(() => true)
  const done = runRuntimeHostPage({
    workerPort: { postMessage: (message, transfer) => posted.push({ message, transfer }) },
    installKernelHost,
    target,
    holdLock,
    isTrustedOrigin: origin => origin === 'chrome://shell',
  })
  const deliver = (event: Partial<MessageEvent>) => {
    for (const listener of [...listeners]) listener(event as MessageEvent)
  }
  return { posted, shell, installKernelHost, holdLock, done, deliver, listeners }
}

describe('runRuntimeHostPage', () => {
  const opened: MessageChannel[] = []
  afterEach(() => {
    for (const channel of opened.splice(0)) {
      channel.port1.close()
      channel.port2.close()
    }
  })
  const channel = () => {
    const made = new MessageChannel()
    opened.push(made)
    return made
  }

  it('holds the keep-alive lock and attaches the worker spawner as the runtime host', () => {
    const h = hostPageHarness()
    expect(h.holdLock).toHaveBeenCalledTimes(1)
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].message).toEqual({ type: 'workerHost.attachControlPort', role: 'runtime-host' })
    expect(h.posted[0].transfer).toHaveLength(1)
    // The spawner listens on the other end of the channel the worker was sent.
    expect(h.installKernelHost).toHaveBeenCalledTimes(1)
    expect(h.installKernelHost.mock.calls[0][0]).toBeInstanceOf(MessagePort)
    expect(h.installKernelHost.mock.calls[0][0]).not.toBe(h.posted[0].transfer[0])
  })

  it('answers the shell and hands the worker its bridge port, marked as the runtime host', async () => {
    const h = hostPageHarness()
    h.deliver({ data: { type: 'nexus-init', nexus: true }, source: h.shell as never, origin: 'chrome://shell' })
    expect(h.shell.postMessage).toHaveBeenCalledWith({ type: 'nexus-init-ack' }, 'chrome://shell')
    const page = channel()
    const worker = channel()
    const pageClose = vi.spyOn(page.port1, 'close')
    h.deliver({
      data: { type: 'nexus-bridge-bootstrap', nexus: true },
      source: h.shell as never,
      origin: 'chrome://shell',
      ports: [page.port1, worker.port1],
    })
    await h.done
    expect(h.posted[1].message).toEqual({ type: 'bridge.setPort', owner: 'runtime-host' })
    expect(h.posted[1].transfer).toEqual([worker.port1])
    expect(pageClose).toHaveBeenCalledTimes(1)
    expect(h.listeners.size).toBe(0)
  })

  it('ignores an untrusted origin, and bridge ports from anyone but the shell it answered', () => {
    const h = hostPageHarness()
    const stranger = { postMessage: vi.fn() }
    h.deliver({ data: { type: 'nexus-init', nexus: true }, source: stranger as never, origin: 'https://evil.example' })
    expect(stranger.postMessage).not.toHaveBeenCalled()
    h.deliver({ data: { type: 'nexus-init', nexus: true }, source: h.shell as never, origin: 'chrome://shell' })
    const page = channel()
    const worker = channel()
    h.deliver({
      data: { type: 'nexus-bridge-bootstrap', nexus: true },
      source: stranger as never,
      origin: 'chrome://shell',
      ports: [page.port1, worker.port1],
    })
    h.deliver({
      data: { type: 'nexus-bridge-bootstrap', nexus: true },
      source: h.shell as never,
      origin: 'chrome://shell',
      ports: [page.port1],
    })
    expect(h.posted).toHaveLength(1)
  })
})

describe('the runtime host page owns the host bridge port', () => {
  const opened: MessageChannel[] = []
  afterEach(() => {
    for (const channel of opened.splice(0)) {
      channel.port1.close()
      channel.port2.close()
    }
  })
  function setup() {
    const changed = vi.fn()
    const router = new BridgeRequestRouter({
      getSessionWorker: () => undefined,
      listSessionIds: () => [].values(),
      onDirectTransportChanged: changed,
    })
    const port = () => {
      const made = new MessageChannel()
      opened.push(made)
      return made.port1
    }
    return { router, changed, port }
  }

  it("a window's port never replaces the runtime host page's", () => {
    const { router, changed, port } = setup()
    router.setHostPort(port(), { fromRuntimeHost: true })
    const owned = router.getDirectTransport()
    const late = port()
    const lateClose = vi.spyOn(late, 'close')
    router.setHostPort(late)
    expect(router.getDirectTransport()).toBe(owned)
    expect(lateClose).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it("the runtime host page's port replaces a window's, whichever came first", () => {
    const { router, changed, port } = setup()
    router.setHostPort(port())
    const first = router.getDirectTransport()
    router.setHostPort(port(), { fromRuntimeHost: true })
    expect(router.getDirectTransport()).not.toBe(first)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('windows replace one another when no runtime host page is there', () => {
    const { router, changed, port } = setup()
    router.setHostPort(port())
    router.setHostPort(port())
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('worker spawns prefer the runtime host page', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetKernelForTests()
  })
  function control() {
    return {
      onmessage: null as ((event: MessageEvent) => void) | null,
      spawns: 0,
      start() {},
      postMessage(message: { type: string; key?: string }) {
        if (message.type !== 'worker.spawn') return
        this.spawns++
        queueMicrotask(() => this.onmessage?.({ data: { type: 'worker.spawned', key: message.key } } as MessageEvent))
      },
    }
  }
  const asPort = (fake: ReturnType<typeof control>) => fake as unknown as MessagePort

  it('spawns through the runtime host page whichever attached first, and plays audio in windows only', async () => {
    for (const hostFirst of [true, false]) {
      resetKernelForTests()
      const host = control()
      const windowA = control()
      const windowB = control()
      if (hostFirst) setKernelControlPort(asPort(host), 'runtime-host')
      setKernelControlPort(asPort(windowA))
      if (!hostFirst) setKernelControlPort(asPort(host), 'runtime-host')
      setKernelControlPort(asPort(windowB), 'window')
      const instance = await openInstance({ kind: 'mod', init: null, label: 'mod acme' })
      instance.port.close()
      expect([host.spawns, windowA.spawns, windowB.spawns]).toEqual([1, 0, 0])
      expect(kernelControlPortsNewestFirst()).toEqual([asPort(windowB), asPort(windowA)])
    }
  })

  it('falls back to the newest window when the runtime host page leaves', async () => {
    const host = control()
    const windowA = control()
    setKernelControlPort(asPort(windowA))
    setKernelControlPort(asPort(host), 'runtime-host')
    host.onmessage?.({ data: { type: 'window.leaving' } } as MessageEvent)
    const instance = await openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    instance.port.close()
    expect([host.spawns, windowA.spawns]).toEqual([0, 1])
  })
})

describe('holdRuntimeAliveLock', () => {
  it('requests the exclusive alive lock and never lets go', async () => {
    const request = vi.fn((_name: string, _hold: () => Promise<never>) => new Promise<never>(() => {}))
    expect(holdRuntimeAliveLock({ request } as unknown as LockManager)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe(RUNTIME_ALIVE_LOCK)
    const held = request.mock.calls[0][1]()
    const settled = vi.fn()
    held.then(settled, settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
  })

  it('is a no-op where Web Locks does not exist', () => {
    expect(holdRuntimeAliveLock(null)).toBe(false)
  })
})

describe('reloadWhenRuntimeLost', () => {
  function harness(heldAfterPolls = 0) {
    let polls = 0
    let grant: (() => void) | undefined
    const request = vi.fn(
      (_name: string, _options: LockOptions, callback: () => unknown) =>
        new Promise<void>(resolve => {
          grant = () => {
            callback()
            resolve()
          }
        }),
    )
    const locks = {
      query: async () => ({
        held: polls++ >= heldAfterPolls ? [{ name: RUNTIME_ALIVE_LOCK }] : [{ name: 'other' }],
      }),
      request,
    } as unknown as Pick<LockManager, 'request' | 'query'>
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const reload = vi.fn()
    const sleep = vi.fn(async () => {})
    let clock = 1_000_000
    const watch = () => reloadWhenRuntimeLost({ locks, reload, storage, sleep, now: () => clock })
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
    return { watch, request, reload, sleep, settle, lose: () => grant?.(), advance: (ms: number) => (clock += ms) }
  }

  it('queues behind the alive lock only once it is seen held', async () => {
    const h = harness(2)
    void h.watch()
    await h.settle()
    expect(h.sleep).toHaveBeenCalledTimes(2)
    expect(h.request).toHaveBeenCalledTimes(1)
    expect(h.request.mock.calls[0][0]).toBe(RUNTIME_ALIVE_LOCK)
    expect(h.request.mock.calls[0][1]).toEqual({ mode: 'shared' })
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('reloads once the lock is granted, which means the runtime is gone', async () => {
    const h = harness()
    const watching = h.watch()
    await h.settle()
    h.lose()
    await watching
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('stops after the cap inside one window, and starts again once the window has passed', async () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loseOnce = async () => {
      const watching = h.watch()
      await h.settle()
      h.lose()
      await watching
    }
    for (let i = 0; i < RUNTIME_LOSS_MAX_RELOADS + 2; i++) await loseOnce()
    expect(h.reload).toHaveBeenCalledTimes(RUNTIME_LOSS_MAX_RELOADS)
    h.advance(RUNTIME_LOSS_WINDOW_MS + 1)
    await loseOnce()
    expect(h.reload).toHaveBeenCalledTimes(RUNTIME_LOSS_MAX_RELOADS + 1)
    warn.mockRestore()
  })

  it('does nothing where Web Locks does not exist', async () => {
    const reload = vi.fn()
    await reloadWhenRuntimeLost({ locks: null, reload })
    expect(reload).not.toHaveBeenCalled()
  })
})
