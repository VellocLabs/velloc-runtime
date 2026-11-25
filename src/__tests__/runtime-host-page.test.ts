import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRuntimeHostPage, runRuntimeHostPage } from '../browser/boot/runtimeHostPage'
import {
  RUNTIME_LOSS_MAX_RELOADS,
  RUNTIME_LOSS_WINDOW_MS,
  RUNTIME_ALIVE_ANSWER_MS,
  reloadWhenRuntimeLost,
  watchRuntimeAlive,
} from '../browser/boot/runtimeLossReload'
import { BridgeRequestRouter } from '../browser/worker/BridgeRequestRouter'
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
    expect(lateClose).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it("a window's port held on standby takes over when the runtime host page's port closes", async () => {
    const { router, changed, port } = setup()
    const hostChannel = new MessageChannel()
    opened.push(hostChannel)
    router.setHostPort(hostChannel.port1, { fromRuntimeHost: true })
    const owned = router.getDirectTransport()
    const first = port()
    const firstClose = vi.spyOn(first, 'close')
    router.setHostPort(first)
    router.setHostPort(port())
    expect(firstClose).toHaveBeenCalledTimes(1)
    hostChannel.port1.dispatchEvent(new Event('close'))
    const next = router.getDirectTransport()
    expect(next).not.toBeNull()
    expect(next).not.toBe(owned)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[1][0]).toBe(next)
  })

  it("with no window port on standby, the runtime host page's port closing detaches the transport", () => {
    const { router, changed } = setup()
    const hostChannel = new MessageChannel()
    opened.push(hostChannel)
    router.setHostPort(hostChannel.port1, { fromRuntimeHost: true })
    hostChannel.port1.dispatchEvent(new Event('close'))
    expect(router.getDirectTransport()).toBeNull()
    expect(changed).toHaveBeenLastCalledWith(null)
  })

  it('a standby window port that closes is not taken over', () => {
    const { router, changed } = setup()
    const hostChannel = new MessageChannel()
    const windowChannel = new MessageChannel()
    opened.push(hostChannel, windowChannel)
    router.setHostPort(hostChannel.port1, { fromRuntimeHost: true })
    router.setHostPort(windowChannel.port1)
    windowChannel.port1.dispatchEvent(new Event('close'))
    hostChannel.port1.dispatchEvent(new Event('close'))
    expect(router.getDirectTransport()).toBeNull()
    expect(changed).toHaveBeenLastCalledWith(null)
  })

  it("the runtime host page's port drops a window port held on standby", () => {
    const { router, port } = setup()
    router.setHostPort(port(), { fromRuntimeHost: true })
    const standby = port()
    const standbyClose = vi.spyOn(standby, 'close')
    router.setHostPort(standby)
    router.setHostPort(port(), { fromRuntimeHost: true })
    expect(standbyClose).toHaveBeenCalledTimes(1)
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

const RUNTIME_ALIVE_LOCK = 'velloc-runtime-alive:20260917T103000000Z'

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
    const watch = () => reloadWhenRuntimeLost({ locks, reload, storage, sleep, now: () => clock, lockName: RUNTIME_ALIVE_LOCK })
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

  it('past the cap inside one window, waits for the window to pass and then reloads', async () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loseOnce = async () => {
      const watching = h.watch()
      await h.settle()
      h.lose()
      await watching
    }
    for (let i = 0; i < RUNTIME_LOSS_MAX_RELOADS; i++) await loseOnce()
    expect(h.reload).toHaveBeenCalledTimes(RUNTIME_LOSS_MAX_RELOADS)
    expect(h.sleep).not.toHaveBeenCalledWith(expect.any(Number))
    h.advance(10_000)
    await loseOnce()
    expect(h.sleep).toHaveBeenLastCalledWith(RUNTIME_LOSS_WINDOW_MS - 10_000)
    expect(h.reload).toHaveBeenCalledTimes(RUNTIME_LOSS_MAX_RELOADS + 1)
    warn.mockRestore()
  })

  it('does nothing where Web Locks does not exist', async () => {
    const reload = vi.fn()
    await reloadWhenRuntimeLost({ locks: null, reload })
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('watchRuntimeAlive', () => {
  const OTHER_LOCK = 'velloc-runtime-alive:20261002T080000000Z'

  function rig() {
    let onMessage: ((event: MessageEvent) => void) | undefined
    const port = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((_type: string, fn: unknown) => { onMessage = fn as (event: MessageEvent) => void }),
      removeEventListener: vi.fn(),
    } as unknown as Pick<MessagePort, 'postMessage' | 'addEventListener' | 'removeEventListener'> & {
      postMessage: ReturnType<typeof vi.fn>
      removeEventListener: ReturnType<typeof vi.fn>
    }
    const watched: string[] = []
    const locks = {
      query: async () => ({ held: [{ name: OTHER_LOCK }, { name: RUNTIME_ALIVE_LOCK }] }),
      request: vi.fn(async (name: string) => { watched.push(name) }),
    } as unknown as Pick<LockManager, 'request' | 'query'>
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const reload = vi.fn()
    let timer: (() => void) | undefined
    const setTimer = vi.fn((fn: () => void) => { timer = fn })
    const deps = { locks, reload, storage, sleep: async () => {}, now: () => 1_000_000, setTimer, lockName: RUNTIME_ALIVE_LOCK }
    return {
      port, watched, reload, setTimer, deps, store,
      answer: (data: unknown) => onMessage?.({ data } as MessageEvent),
      timeout: () => timer?.(),
    }
  }

  it('says the build and watches the lock the runtime names, even another build\'s', async () => {
    const r = rig()
    const watching = watchRuntimeAlive(r.port, '2026-09-17T10:30:00.000Z', r.deps)
    expect(r.port.postMessage).toHaveBeenCalledWith({ type: 'runtime.build', build: '2026-09-17T10:30:00.000Z' })
    expect(r.setTimer).toHaveBeenCalledWith(expect.any(Function), RUNTIME_ALIVE_ANSWER_MS)
    r.answer({ type: 'other' })
    r.answer({ type: 'runtime.alive', lock: OTHER_LOCK })
    await watching
    expect(r.watched).toEqual([OTHER_LOCK])
    expect(r.reload).toHaveBeenCalledTimes(1)
    expect(r.port.removeEventListener).toHaveBeenCalled()
  })

  it('reloads at once, counted against the cap, when the runtime is retiring', async () => {
    const r = rig()
    const watching = watchRuntimeAlive(r.port, '', r.deps)
    r.answer({ type: 'runtime.alive', retiring: true })
    await watching
    expect(r.watched).toEqual([])
    expect(r.reload).toHaveBeenCalledTimes(1)
    expect(JSON.parse(r.store.get('nexus.runtimeLossReloads') ?? '[]')).toHaveLength(1)
  })

  it('watches the page\'s own lock when no answer comes in time', async () => {
    const r = rig()
    const watching = watchRuntimeAlive(r.port, '', r.deps)
    r.timeout()
    await watching
    expect(r.watched).toEqual([RUNTIME_ALIVE_LOCK])
    expect(r.reload).toHaveBeenCalledTimes(1)
  })

  it('switches to the lock of an answer that came after the wait, while that lock is not yet held', async () => {
    const r = rig()
    let held: string[] = ['other']
    const sleeps: Array<() => void> = []
    r.deps.locks = {
      query: async () => ({ held: held.map(name => ({ name })) }),
      request: vi.fn(async (name: string) => { r.watched.push(name) }),
    } as unknown as Pick<LockManager, 'request' | 'query'>
    r.deps.sleep = () => new Promise<void>(resolve => sleeps.push(resolve))
    const watching = watchRuntimeAlive(r.port, '', r.deps)
    r.timeout()
    await vi.waitFor(() => expect(sleeps).toHaveLength(1))
    r.answer({ type: 'runtime.alive', lock: OTHER_LOCK })
    held = [OTHER_LOCK]
    sleeps[0]()
    await watching
    expect(r.watched).toEqual([OTHER_LOCK])
    expect(r.reload).toHaveBeenCalledTimes(1)
  })

  it('reloads when a late answer says the runtime is retiring', async () => {
    const r = rig()
    const sleeps: Array<() => void> = []
    r.deps.locks = {
      query: async () => ({ held: [] }),
      request: vi.fn(),
    } as unknown as Pick<LockManager, 'request' | 'query'>
    r.deps.sleep = () => new Promise<void>(resolve => sleeps.push(resolve))
    const watching = watchRuntimeAlive(r.port, '', r.deps)
    r.timeout()
    await vi.waitFor(() => expect(sleeps).toHaveLength(1))
    r.answer({ type: 'runtime.alive', retiring: true })
    sleeps[0]()
    await watching
    expect(r.reload).toHaveBeenCalledTimes(1)
  })
})
