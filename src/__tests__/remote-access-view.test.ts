import { describe, expect, it, vi } from 'vitest'

import { holdRemoteAccessView } from '../browser/webview/remote/remoteAccessView'
import { isSettingsSectionVisible } from '../browser/webview/settings/settingsNav'
import type { CapabilityQuery } from '../browser/webview/useCan'

/**
 * The page's shared `remote/state` store (F-24): a topic's snapshot reaches only the first subscriber, so later
 * components read the store rather than subscribing on their own.
 */

type Event = { payload: unknown }

function makeConnection() {
  const listeners = new Set<(event: Event) => void>()
  const wire = { subscribes: 0, unsubscribes: 0 }
  let snapshot: unknown = null
  const connection = {
    subscribe: vi.fn((topic: string, listener: (event: Event) => void) => {
      expect(topic).toBe('remote/state')
      const first = listeners.size === 0
      listeners.add(listener)
      if (first) {
        wire.subscribes += 1
        // The runtime answers the wire subscribe with a snapshot — to the
        // listeners present now, i.e. this first one.
        if (snapshot !== null) queueMicrotask(() => listener({ payload: snapshot }))
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) wire.unsubscribes += 1
      }
    }),
  }
  return {
    connection,
    wire,
    setSnapshot(payload: unknown) {
      snapshot = payload
    },
    publish(payload: unknown) {
      snapshot = payload
      for (const listener of Array.from(listeners)) listener({ payload })
    },
  }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function state(clients: number) {
  return {
    relay: 'online',
    pairings: [],
    access: {
      supported: true,
      enabled: true,
      bindAddress: '0.0.0.0',
      port: 47615,
      state: 'listening',
      addresses: [],
      clients,
    },
  }
}

describe('holdRemoteAccessView', () => {
  it('gives a late holder the current state at once, with one wire subscription', async () => {
    const fake = makeConnection()
    fake.setSnapshot(state(2))
    const topbar = vi.fn()
    holdRemoteAccessView(fake.connection, topbar)
    await flush()
    expect(topbar).toHaveBeenLastCalledWith(
      expect.objectContaining({ access: expect.objectContaining({ clients: 2 }) }),
    )

    // The settings page opens later. Subscribing on its own would have
    // missed the snapshot; holding the store hands it over immediately.
    const page = vi.fn()
    holdRemoteAccessView(fake.connection, page)
    expect(page).toHaveBeenCalledTimes(1)
    expect(page.mock.calls[0]![0].access.clients).toBe(2)
    expect(fake.wire.subscribes).toBe(1)
  })

  it('tells every holder about each publish', async () => {
    const fake = makeConnection()
    const a = vi.fn()
    const b = vi.fn()
    holdRemoteAccessView(fake.connection, a)
    holdRemoteAccessView(fake.connection, b)
    fake.publish(state(1))
    expect(a.mock.calls.at(-1)![0].access.clients).toBe(1)
    expect(b.mock.calls.at(-1)![0].access.clients).toBe(1)
  })

  it('drops the wire subscription with the last holder, and re-subscribes for the next', async () => {
    const fake = makeConnection()
    const releaseA = holdRemoteAccessView(fake.connection, vi.fn())
    const releaseB = holdRemoteAccessView(fake.connection, vi.fn())
    releaseA()
    expect(fake.wire.unsubscribes).toBe(0)
    releaseB()
    expect(fake.wire.unsubscribes).toBe(1)

    fake.setSnapshot(state(4))
    const again = vi.fn()
    holdRemoteAccessView(fake.connection, again)
    await flush()
    expect(fake.wire.subscribes).toBe(2)
    expect(again.mock.calls.at(-1)![0].access.clients).toBe(4)
  })

  it('ignores a payload that carries no access object', () => {
    const fake = makeConnection()
    const holder = vi.fn()
    holdRemoteAccessView(fake.connection, holder)
    fake.publish({ relay: 'off' })
    fake.publish(null)
    expect(holder).not.toHaveBeenCalled()
  })

  it('a release is idempotent', () => {
    const fake = makeConnection()
    const release = holdRemoteAccessView(fake.connection, vi.fn())
    const other = holdRemoteAccessView(fake.connection, vi.fn())
    release()
    release()
    expect(fake.wire.unsubscribes).toBe(0)
    other()
    expect(fake.wire.unsubscribes).toBe(1)
  })
})

describe('isSettingsSectionVisible (the topbar button\'s destination gate)', () => {
  const all: CapabilityQuery = { can: () => true }
  const none: CapabilityQuery = { can: () => false }

  it('is true for Remote access only with the grant, host support and the beta channel', () => {
    expect(isSettingsSectionVisible('remoteAccess', all, true, 'beta')).toBe(true)
    expect(isSettingsSectionVisible('remoteAccess', all, false, 'beta')).toBe(false)
    expect(isSettingsSectionVisible('remoteAccess', none, true, 'beta')).toBe(false)
    expect(isSettingsSectionVisible('remoteAccess', all, true, 'stable')).toBe(false)
  })
})
