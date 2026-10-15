/**
 * The kernel's LONG-LIVED worker (`openInstance`) — the counterpart of
 * `runOnce` for a profile whose worker stays (a mod). The kernel only brokers
 * the spawn and reports the worker's end; what runs on the port is the
 * profile's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KERNEL_SPAWN_ACK_TIMEOUT_MS,
  isKernelAvailable,
  kernelControlPortCount,
  openInstance,
  resetKernelForTests,
  setKernelControlPort,
  whenKernelControlPortAttached,
} from '../browser/workerKernel/IsolatedWorkerKernel'

type Post = { message: { type: string; key?: string; kind?: string; init?: unknown }; transfer: unknown[] }

function makeControl() {
  return {
    onmessage: null as ((e: MessageEvent) => void) | null,
    posts: [] as Post[],
    throwOnSpawn: false,
    start() {},
    postMessage(message: unknown, transfer: unknown[] = []) {
      const typed = message as Post['message']
      if (this.throwOnSpawn && typed.type === 'worker.spawn') throw new Error('DataCloneError')
      this.posts.push({ message: typed, transfer })
    },
    say(data: unknown) {
      this.onmessage?.({ data } as MessageEvent)
    },
    spawn(): Post {
      return this.posts.find(p => p.message.type === 'worker.spawn')!
    },
    terminates(): string[] {
      return this.posts.filter(p => p.message.type === 'worker.terminate').map(p => p.message.key!)
    },
  }
}

const ports: MessagePort[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  resetKernelForTests()
  for (const port of ports.splice(0)) port.close()
})

function attach() {
  const control = makeControl()
  setKernelControlPort(control as unknown as MessagePort)
  return control
}

describe('openInstance', () => {
  it('is unavailable until a control port is attached', async () => {
    await expect(openInstance({ kind: 'mod', init: null, label: 'mod acme' })).rejects.toThrow(
      /^mod acme is unavailable/,
    )
  })

  it('spawns the kind with its init and resolves on the ack, with the data port', async () => {
    const control = attach()
    const opening = openInstance({ kind: 'mod', init: { plugin: 'acme' }, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    const spawn = control.spawn()
    expect(spawn.message).toMatchObject({ kind: 'mod', init: { plugin: 'acme' } })
    expect(spawn.message.key).toMatch(/^mod-\d+-\d+$/)
    // No name given: the spawn carries none.
    expect('name' in spawn.message).toBe(false)
    control.say({ type: 'worker.spawned', key: spawn.message.key })
    const instance = await opening
    ports.push(instance.port)
    expect(instance.key).toBe(spawn.message.key)
    // The far end of the channel went to the window; this one is the runtime's.
    expect(spawn.transfer).toHaveLength(1)
    expect(instance.port).not.toBe(spawn.transfer[0])
    expect(control.terminates()).toEqual([])
  })

  it('carries the name DevTools lists the worker by', async () => {
    const control = attach()
    const opening = openInstance({ kind: 'mod', init: { plugin: 'acme' }, label: 'mod acme', name: 'acme' })
    await vi.advanceTimersByTimeAsync(0)
    const spawn = control.spawn()
    expect(spawn.message).toMatchObject({ kind: 'mod', name: 'acme' })
    control.say({ type: 'worker.spawned', key: spawn.message.key })
    ports.push((await opening).port)
  })

  it('stays open: no clock runs on it after the ack', async () => {
    const control = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    control.say({ type: 'worker.spawned', key: control.spawn().message.key })
    const instance = await opening
    ports.push(instance.port)
    let closed = false
    void instance.closed.then(() => (closed = true))
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)
    expect(closed).toBe(false)
    expect(control.terminates()).toEqual([])
  })

  it('fails fast when the spawn is never acknowledged, and reclaims the worker', async () => {
    const control = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    opening.catch(() => {})
    await vi.advanceTimersByTimeAsync(KERNEL_SPAWN_ACK_TIMEOUT_MS)
    await expect(opening).rejects.toThrow(
      `mod acme could not start: the execution window did not respond within ${KERNEL_SPAWN_ACK_TIMEOUT_MS}ms`,
    )
    expect(control.terminates()).toEqual([control.spawn().message.key])
  })

  it('a profile that spawns at boot may allow longer for the acknowledgement', async () => {
    const control = attach()
    const opening = openInstance({
      kind: 'mod',
      init: null,
      label: 'mod acme',
      spawnAckTimeoutMs: 20_000,
    })
    let settled = false
    opening.then(
      () => (settled = true),
      () => (settled = true),
    )
    // Past the default deadline: still waiting, nothing reclaimed.
    await vi.advanceTimersByTimeAsync(KERNEL_SPAWN_ACK_TIMEOUT_MS + 1_000)
    expect(settled).toBe(false)
    expect(control.terminates()).toEqual([])
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(opening).rejects.toThrow(
      'mod acme could not start: the execution window did not respond within 20000ms',
    )
  })

  it('rejects when the window reports the worker could not be created', async () => {
    const control = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    opening.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    control.say({ type: 'worker.error', key: control.spawn().message.key, message: 'no worker host is installed for kind "mod"' })
    await expect(opening).rejects.toThrow('mod acme worker error: no worker host is installed for kind "mod"')
  })

  it('rejects when the spawn cannot be sent', async () => {
    const control = attach()
    control.throwOnSpawn = true
    await expect(openInstance({ kind: 'mod', init: null, label: 'mod acme' })).rejects.toThrow(
      'mod acme failed to reach its execution worker: DataCloneError',
    )
  })

  it('a crash after the ack settles `closed` as crashed, once', async () => {
    const control = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    const key = control.spawn().message.key
    control.say({ type: 'worker.spawned', key })
    const instance = await opening
    control.say({ type: 'worker.error', key, message: 'Uncaught RangeError' })
    await expect(instance.closed).resolves.toEqual({ reason: 'crashed', message: 'Uncaught RangeError' })
    // The window is told to reclaim it; a later close() is a no-op.
    expect(control.terminates()).toEqual([key])
    instance.close()
    control.say({ type: 'worker.error', key, message: 'again' })
    expect(control.terminates()).toEqual([key])
  })

  it('close() terminates the worker, settles `closed`, and is idempotent', async () => {
    const control = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    const key = control.spawn().message.key
    control.say({ type: 'worker.spawned', key })
    const instance = await opening
    instance.close()
    instance.close()
    await expect(instance.closed).resolves.toEqual({ reason: 'closed' })
    expect(control.terminates()).toEqual([key])
  })

  it("a worker.error for another key does not touch this instance", async () => {
    const control = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    const key = control.spawn().message.key
    control.say({ type: 'worker.error', key: 'mod-999-0', message: 'someone else' })
    control.say({ type: 'worker.spawned', key })
    const instance = await opening
    ports.push(instance.port)
    expect(control.terminates()).toEqual([])
  })

  it('a window that leaves settles its instances `crashed`; spawns fall back to the window attached before it', async () => {
    const older = attach()
    const newer = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    // Spawned through the newest window.
    expect(older.posts).toEqual([])
    const key = newer.spawn().message.key
    newer.say({ type: 'worker.spawned', key })
    const instance = await opening
    ports.push(instance.port)
    newer.say({ type: 'window.leaving' })
    await expect(instance.closed).resolves.toEqual({
      reason: 'crashed',
      message: 'the window that hosted it went away',
    })
    // The next one goes through the window that is still there.
    const next = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    const nextKey = older.spawn().message.key
    older.say({ type: 'worker.spawned', key: nextKey })
    ports.push((await next).port)
    // The last window gone: nothing to spawn through.
    older.say({ type: 'window.leaving' })
    await expect(openInstance({ kind: 'mod', init: null, label: 'mod acme' })).rejects.toThrow(
      /^mod acme is unavailable/,
    )
  })

  it("a window that leaves does not touch the instances another window spawned", async () => {
    const older = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    const key = older.spawn().message.key
    older.say({ type: 'worker.spawned', key })
    const instance = await opening
    ports.push(instance.port)
    const newer = attach()
    newer.say({ type: 'window.leaving' })
    const settled = await Promise.race([instance.closed, Promise.resolve('open')])
    expect(settled).toBe('open')
    expect(older.terminates()).toEqual([])
  })
})

describe('the control-port pool', () => {
  it('every window is pooled; a spawn the newest does not acknowledge is tried through another, and the slow one goes to the back', async () => {
    const older = attach()
    const newer = attach()
    expect(kernelControlPortCount()).toBe(2)
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    const lostKey = newer.spawn().message.key
    await vi.advanceTimersByTimeAsync(KERNEL_SPAWN_ACK_TIMEOUT_MS)
    // The unanswered spawn is reclaimed, and the older window is asked.
    expect(newer.terminates()).toEqual([lostKey])
    const key = older.spawn().message.key
    older.say({ type: 'worker.spawned', key })
    ports.push((await opening).port)
    // Still pooled (it may only be slow), but no longer first.
    expect(kernelControlPortCount()).toBe(2)
    const next = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    await vi.advanceTimersByTimeAsync(0)
    expect(older.posts.filter(p => p.message.type === 'worker.spawn')).toHaveLength(2)
    const nextKey = older.posts.filter(p => p.message.type === 'worker.spawn')[1]!.message.key!
    older.say({ type: 'worker.spawned', key: nextKey })
    ports.push((await next).port)
  })

  it('a worker error the window reports is the answer: no other window is tried', async () => {
    const older = attach()
    const newer = attach()
    const opening = openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    opening.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    newer.say({ type: 'worker.error', key: newer.spawn().message.key, message: 'no worker host' })
    await expect(opening).rejects.toThrow('mod acme worker error: no worker host')
    expect(older.posts).toEqual([])
  })

  it("a port whose far end closes leaves the pool and fails what it spawned", async () => {
    const channel = new MessageChannel()
    ports.push(channel.port1, channel.port2)
    const spawns: string[] = []
    channel.port2.onmessage = event => {
      const message = event.data as { type: string; key: string }
      if (message.type !== 'worker.spawn') return
      spawns.push(message.key)
      channel.port2.postMessage({ type: 'worker.spawned', key: message.key })
    }
    setKernelControlPort(channel.port1)
    vi.useRealTimers()
    const instance = await openInstance({ kind: 'mod', init: null, label: 'mod acme' })
    ports.push(instance.port)
    expect(spawns).toHaveLength(1)
    // The window's realm went away without a pagehide.
    channel.port2.close()
    await expect(instance.closed).resolves.toEqual({
      reason: 'crashed',
      message: 'the window that hosted it went away',
    })
    expect(kernelControlPortCount()).toBe(0)
    expect(isKernelAvailable()).toBe(false)
  })

  it('whenKernelControlPortAttached waits for a window, and stops waiting on abort', async () => {
    const controller = new AbortController()
    const abandoned = whenKernelControlPortAttached(controller.signal)
    controller.abort()
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    let attached = false
    const waiting = whenKernelControlPortAttached().then(() => {
      attached = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(attached).toBe(false)
    attach()
    await waiting
    expect(attached).toBe(true)
    // With one attached it resolves at once.
    await expect(whenKernelControlPortAttached()).resolves.toBeUndefined()
  })
})
