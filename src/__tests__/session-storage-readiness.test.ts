/**
 * SessionStorageCoordinator readiness: a boot timeout with no transport commits a sticky flat fallback; a late
 * healthy attach rebuilds flat storage and fires onStorageReady; a stale generation cannot settle a successor's
 * waiters; a replacement keeps the mode, and its timeout rejects waiters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionStorageCoordinator } from '../browser/worker/SessionStorageCoordinator'

const READY_TIMEOUT_MS = 6_500 // > STORAGE_READY_TIMEOUT_MS (6s)

type CoordinatorInternals = {
  establishedStorageMode: 'grouped' | 'flat' | null
  storageFallbackCommitted: boolean
  storage: unknown
  initStorage: (path: string, generation: number) => Promise<void>
}

function makeCoordinator(options: {
  getTransport: () => unknown
  onStorageReady?: () => void
}): { coordinator: SessionStorageCoordinator; internals: CoordinatorInternals } {
  const coordinator = new SessionStorageCoordinator({
    getDirectBridgeTransport: options.getTransport as never,
    onStorageReady: options.onStorageReady ?? (() => {}),
  })
  return {
    coordinator,
    internals: coordinator as unknown as CoordinatorInternals,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('SessionStorageCoordinator — readiness fallback (transport-less boot)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('initial timeout with no transport commits a FLAT fallback and later calls short-circuit', async () => {
    const { coordinator, internals } = makeCoordinator({
      getTransport: () => null,
    })
    let settled = false
    const first = coordinator.ensureStorage('/base').then(() => {
      settled = true
    })
    await flushMicrotasks()
    // No transport → the waiter parks until the bounded timeout.
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS)
    await first
    expect(settled).toBe(true)
    expect(internals.establishedStorageMode).toBe('flat')
    expect(internals.storageFallbackCommitted).toBe(true)
    expect(coordinator.getStorage()).toBeNull()

    // Later inits are instant — no waiter, no timer.
    let secondSettled = false
    void coordinator.ensureStorage('/base').then(() => {
      secondSettled = true
    })
    await flushMicrotasks()
    expect(secondSettled).toBe(true)
  })

  it('a late healthy attach after the fallback rebuilds FLAT storage and fires onStorageReady', async () => {
    let transport: unknown = null
    const onStorageReady = vi.fn()
    const { coordinator, internals } = makeCoordinator({
      getTransport: () => transport,
      onStorageReady,
    })
    const first = coordinator.ensureStorage('/base')
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS)
    await first
    expect(internals.storageFallbackCommitted).toBe(true)
    expect(onStorageReady).not.toHaveBeenCalled()

    // The direct port arrives late but healthy. Established-flat rebuilds
    // skip the home-dir probe, so no bridge round-trip is needed.
    transport = {}
    await coordinator.handleDirectTransportAttached()

    expect(coordinator.getStorage()).not.toBeNull()
    expect(coordinator.getGroupedStorage()).toBeNull()
    expect(internals.establishedStorageMode).toBe('flat')
    expect(internals.storageFallbackCommitted).toBe(false)
    expect(coordinator.storageRoot()).toBe('/base')
    expect(onStorageReady).toHaveBeenCalledTimes(1)
  })

  it("a stale attempt's completion cannot resolve or reject the successor generation's waiters", async () => {
    const transport = {}
    const { coordinator, internals } = makeCoordinator({
      getTransport: () => transport,
    })
    const attempts: Array<{
      generation: number
      resolve: () => void
      reject: (error: unknown) => void
    }> = []
    internals.initStorage = (_path, generation) =>
      new Promise<void>((resolve, reject) => {
        attempts.push({ generation, resolve, reject })
      })

    let firstSettled: 'pending' | 'resolved' | 'rejected' = 'pending'
    const first = coordinator.ensureStorage('/base').then(
      () => {
        firstSettled = 'resolved'
      },
      () => {
        firstSettled = 'rejected'
      },
    )
    await flushMicrotasks()
    expect(attempts).toHaveLength(1)

    // The transport is replaced while attempt A is in flight.
    coordinator.handleDirectTransportDetached()
    // Attempt A dies with the old transport — its rejection must NOT
    // reach the surviving waiter (generation mismatch).
    attempts[0].reject(new Error('stale transport died'))
    await flushMicrotasks()
    expect(firstSettled).toBe('pending')

    // The replacement attach starts attempt B on a newer generation; its
    // success installs storage and resolves EVERY parked waiter.
    const attach = coordinator.handleDirectTransportAttached()
    await flushMicrotasks()
    expect(attempts).toHaveLength(2)
    expect(attempts[1].generation).toBeGreaterThan(attempts[0].generation)
    internals.storage = {}
    attempts[1].resolve()
    await attach
    await first
    expect(firstSettled).toBe('resolved')
  })

  it('established-mode detach → attach rebuilds in the SAME mode with the retained path', async () => {
    const transport = {}
    const { coordinator, internals } = makeCoordinator({
      getTransport: () => transport,
    })
    const calls: Array<{ path: string; generation: number }> = []
    internals.initStorage = (path, generation) => {
      calls.push({ path, generation })
      internals.storage = {}
      return Promise.resolve()
    }
    await coordinator.ensureStorage('/base')
    internals.establishedStorageMode = 'grouped'
    expect(calls).toHaveLength(1)

    coordinator.handleDirectTransportDetached()
    expect(coordinator.getStorage()).toBeNull()

    await coordinator.handleDirectTransportAttached()
    expect(calls).toHaveLength(2)
    expect(calls[1].path).toBe('/base')
    expect(internals.establishedStorageMode).toBe('grouped')
    expect(coordinator.getStorage()).not.toBeNull()
  })

  it('an established-mode replacement timeout REJECTS waiters so callers can retry after a later attach', async () => {
    const { coordinator, internals } = makeCoordinator({
      getTransport: () => null,
    })
    internals.establishedStorageMode = 'grouped'

    const parked = coordinator.ensureStorage('/base')
    // Attach the rejection handler BEFORE the timer fires — the reject
    // happens inside the advance, and a handler-less rejection is
    // reported as an unhandled error even if asserted later.
    const expectation = expect(parked).rejects.toThrow(
      /Timed out rebuilding established session storage/,
    )
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS)
    await expectation
    // The established layout is never abandoned for a different one.
    expect(internals.establishedStorageMode).toBe('grouped')
    expect(internals.storageFallbackCommitted).toBe(false)
  })
})
