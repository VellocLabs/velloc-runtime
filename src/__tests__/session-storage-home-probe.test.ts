/**
 * SessionStorageCoordinator.resolveHomeDir: the runtime hub's home source.
 * The probe is bound to the transport that asked, a no-answer is asked again,
 * and the home is known in either storage layout (F-17, P-3).
 */
import { describe, it, expect } from 'vitest'
import { SessionStorageCoordinator } from '../browser/worker/SessionStorageCoordinator'

type Req = { id: string; route: { capability: string; action: string }; payload: unknown }

/** A host port that never answers until disposed; then every request is transport_disposed. */
function silentTransport() {
  const pending = new Map<string, (r: unknown) => void>()
  let disposed = false
  const requests: string[] = []
  return {
    requests,
    request(req: Req): Promise<unknown> {
      requests.push(`${req.route.capability}.${req.route.action}`)
      if (disposed) {
        return Promise.resolve({
          id: req.id,
          route: req.route,
          ok: false,
          error: { code: 'transport_disposed', message: 'disposed' },
        })
      }
      return new Promise(resolve => pending.set(req.id, resolve))
    },
    subscribeEvents() {
      return () => {}
    },
    dispose() {
      disposed = true
      for (const [id, resolve] of pending) {
        resolve({ id, ok: false, error: { code: 'transport_disposed', message: 'disposed' } })
      }
      pending.clear()
    },
  }
}

/** A host port whose `fs.userHome` answers `home` (or fails while `home` is null). */
function answeringTransport(initial: string | null) {
  const requests: string[] = []
  const state = { home: initial }
  return {
    requests,
    state,
    async request(req: Req): Promise<unknown> {
      requests.push(`${req.route.capability}.${req.route.action}`)
      if (req.route.action === 'userHome' && state.home) {
        return { id: req.id, route: req.route, ok: true, result: state.home }
      }
      return { id: req.id, route: req.route, ok: false, error: { code: 'not_found', message: 'nope' } }
    },
    subscribeEvents() {
      return () => {}
    },
    dispose() {},
  }
}

function coordinatorOver(current: () => unknown) {
  const coordinator = new SessionStorageCoordinator({
    getDirectBridgeTransport: () => current() as never,
    onStorageReady: () => {},
  })
  const mode = () =>
    (coordinator as unknown as { establishedStorageMode: string | null }).establishedStorageMode
  return { coordinator, mode }
}

describe('SessionStorageCoordinator.resolveHomeDir', () => {
  it('a port replaced while the hub probe is pending does not latch the flat layout', async () => {
    const t1 = silentTransport()
    const t2 = answeringTransport('/home/me')
    let current: unknown = t1
    const { coordinator, mode } = coordinatorOver(() => current)

    const hubProbe = coordinator.resolveHomeDir()
    current = t2
    t1.dispose()
    await coordinator.handleDirectTransportAttached()
    expect(await hubProbe).toBeNull()

    await coordinator.ensureStorage('/profile/.nexus')
    expect(t2.requests).toContain('fs.userHome')
    expect(mode()).toBe('grouped')
    expect(coordinator.getHomeDir()).toBe('/home/me')
  })

  it('a no-answer is asked again on the next call', async () => {
    const t = answeringTransport(null)
    const { coordinator } = coordinatorOver(() => t)

    expect(await coordinator.resolveHomeDir()).toBeNull()
    const asked = t.requests.length
    t.state.home = '/home/me'
    expect(await coordinator.resolveHomeDir()).toBe('/home/me')
    const answered = t.requests.length
    expect(answered).toBeGreaterThan(asked)
    expect(await coordinator.resolveHomeDir()).toBe('/home/me')
    expect(t.requests.length).toBe(answered)
  })

  it('names the home once the flat layout is established', async () => {
    const t = answeringTransport(null)
    const { coordinator, mode } = coordinatorOver(() => t)

    await coordinator.ensureStorage('/profile/.nexus')
    expect(mode()).toBe('flat')
    t.state.home = '/home/me'
    expect(await coordinator.resolveHomeDir()).toBe('/home/me')
    expect(coordinator.getHomeDir()).toBeNull()
    expect(mode()).toBe('flat')
  })
})
