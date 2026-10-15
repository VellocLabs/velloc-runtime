/**
 * The window worker host: the lifecycle owner of the kernel's DedicatedWorkers.
 *
 * Driven with a fake control port and fake Workers — node's MessageChannel
 * does not deliver transferred ports on `event.ports`, and the host reads the
 * worker's data port from exactly there, so the events are dispatched by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWindowWorkerHost } from '../browser/workerKernel/WindowWorkerHost'

type Listener = (event: MessageEvent) => void

function makeControlPort() {
  let listener: Listener | null = null
  return {
    posts: [] as Array<Record<string, unknown>>,
    started: false,
    throwOnPost: false,
    addEventListener(_type: string, fn: Listener) {
      listener = fn
    },
    removeEventListener(_type: string, fn: Listener) {
      if (listener === fn) listener = null
    },
    start() {
      this.started = true
    },
    postMessage(message: unknown) {
      if (this.throwOnPost) throw new Error('control port closed')
      this.posts.push(message as Record<string, unknown>)
    },
    /** Deliver a control frame, with `ports` as the transfer list would. */
    deliver(data: unknown, ports: unknown[] = []) {
      listener?.({ data, ports } as unknown as MessageEvent)
    },
    get listening() {
      return listener !== null
    },
  }
}

function makeWorker() {
  return {
    posts: [] as Array<{ message: unknown; transfer: unknown[] }>,
    terminated: 0,
    throwOnPost: false,
    onerror: null as ((e: unknown) => void) | null,
    postMessage(message: unknown, transfer: unknown[] = []) {
      if (this.throwOnPost) throw new Error('DataCloneError')
      this.posts.push({ message, transfer })
    },
    terminate() {
      this.terminated += 1
    },
  }
}

const PEER = { peer: true }

function install(kinds: string[] = ['probe']) {
  const control = makeControlPort()
  const spawned: ReturnType<typeof makeWorker>[] = []
  const spawners: Record<string, () => Worker> = {}
  for (const kind of kinds) {
    spawners[kind] = () => {
      const worker = makeWorker()
      spawned.push(worker)
      return worker as unknown as Worker
    }
  }
  const handle = installWindowWorkerHost(control as unknown as MessagePort, spawners)
  return { control, spawned, handle }
}

afterEach(() => vi.restoreAllMocks())

describe('WindowWorkerHost', () => {
  it('spawns the kind, hands the worker its init and data port, and acks', () => {
    const { control, spawned } = install()
    expect(control.started).toBe(true)
    control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: { n: 1 } }, [PEER])
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.posts).toEqual([
      { message: { type: 'worker.init', init: { n: 1 } }, transfer: [PEER] },
    ])
    expect(control.posts).toEqual([{ type: 'worker.spawned', key: 'probe-1' }])
  })

  it('terminates by key, once — a repeat or an unknown key is a no-op', () => {
    const { control, spawned } = install()
    control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: null }, [PEER])
    control.deliver({ type: 'worker.spawn', key: 'probe-2', kind: 'probe', init: null }, [PEER])
    control.deliver({ type: 'worker.terminate', key: 'probe-1' })
    control.deliver({ type: 'worker.terminate', key: 'probe-1' })
    control.deliver({ type: 'worker.terminate', key: 'nobody' })
    expect(spawned[0]!.terminated).toBe(1)
    expect(spawned[1]!.terminated).toBe(0)
  })

  it('answers worker.error for a kind no spawner serves, spawning nothing', () => {
    const { control, spawned } = install(['probe'])
    control.deliver({ type: 'worker.spawn', key: 'mod-1', kind: 'mod', init: null }, [PEER])
    expect(spawned).toHaveLength(0)
    expect(control.posts).toEqual([
      { type: 'worker.error', key: 'mod-1', message: 'no worker host is installed for kind "mod"' },
    ])
  })

  it('never resolves a kind through the prototype chain', () => {
    const { control, spawned } = install(['probe'])
    for (const kind of ['constructor', 'toString', '__proto__']) {
      control.deliver({ type: 'worker.spawn', key: `k-${kind}`, kind, init: null }, [PEER])
    }
    expect(spawned).toHaveLength(0)
    // Refused as an unknown kind — not "spawned `Object` and it then failed".
    expect(control.posts.map(p => p.message)).toEqual([
      'no worker host is installed for kind "constructor"',
      'no worker host is installed for kind "toString"',
      'no worker host is installed for kind "__proto__"',
    ])
  })

  it('reports a spawner that throws, without acking', () => {
    const control = makeControlPort()
    installWindowWorkerHost(control as unknown as MessagePort, {
      probe: () => {
        throw new Error('nested workers refused')
      },
    })
    control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: null }, [PEER])
    expect(control.posts).toEqual([
      { type: 'worker.error', key: 'probe-1', message: 'nested workers refused' },
    ])
  })

  it('terminates and reports when the init handoff throws, without acking', () => {
    const control = makeControlPort()
    const worker = makeWorker()
    worker.throwOnPost = true
    installWindowWorkerHost(control as unknown as MessagePort, {
      probe: () => worker as unknown as Worker,
    })
    control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: null }, [PEER])
    expect(worker.terminated).toBe(1)
    expect(control.posts).toEqual([
      { type: 'worker.error', key: 'probe-1', message: 'DataCloneError' },
    ])
  })

  it('a worker crash terminates it and reports worker.error under its key', () => {
    const { control, spawned } = install()
    control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: null }, [PEER])
    spawned[0]!.onerror?.({ message: 'Uncaught SyntaxError' })
    expect(spawned[0]!.terminated).toBe(1)
    expect(control.posts.at(-1)).toEqual({
      type: 'worker.error',
      key: 'probe-1',
      message: 'Uncaught SyntaxError',
    })
    // A crash with no message still names the kind.
    control.deliver({ type: 'worker.spawn', key: 'probe-2', kind: 'probe', init: null }, [PEER])
    spawned[1]!.onerror?.({})
    expect(control.posts.at(-1)).toEqual({
      type: 'worker.error',
      key: 'probe-2',
      message: 'probe worker crashed',
    })
  })

  it('ignores a spawn that carries no data port', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { control, spawned } = install()
    control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: null }, [])
    expect(spawned).toHaveLength(0)
    expect(control.posts).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('survives a control port that is gone when it acks', () => {
    const { control, spawned } = install()
    control.throwOnPost = true
    expect(() =>
      control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: null }, [PEER]),
    ).not.toThrow()
    // The worker still exists and is still reclaimable.
    control.deliver({ type: 'worker.terminate', key: 'probe-1' })
    expect(spawned[0]!.terminated).toBe(1)
  })

  it('dispose terminates every live worker and stops listening', () => {
    const { control, spawned, handle } = install()
    control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: null }, [PEER])
    control.deliver({ type: 'worker.spawn', key: 'probe-2', kind: 'probe', init: null }, [PEER])
    handle.dispose()
    expect(spawned.map(w => w.terminated)).toEqual([1, 1])
    expect(control.listening).toBe(false)
    handle.dispose()
    expect(spawned.map(w => w.terminated)).toEqual([1, 1])
  })
})
