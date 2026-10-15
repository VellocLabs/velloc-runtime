import { describe, expect, it } from 'vitest'
import {
  hardenWorkerRealm,
  RUN_JS_REMOVED_GLOBALS,
  RUN_JS_REMOVED_NAVIGATOR_PROPS,
} from '../browser/runJs/hardenWorkerRealm'

/** A stand-in worker global carrying every capability the hardener must
 *  remove (the real strip runs in the DedicatedWorker entry against `self`,
 *  which unit tests cannot instantiate — same seam as `runJsWorkerCore`'s
 *  `peer`). */
function fakeWorkerGlobal(): Record<string, unknown> & {
  navigator: Record<string, unknown>
  WorkerNavigatorPrototype: Record<string, unknown>
} {
  const g: Record<string, unknown> = {}
  for (const name of RUN_JS_REMOVED_GLOBALS) {
    g[name] = () => name
  }
  // Shaped like the real thing: `WorkerNavigator` is NOT a `[Global]`
  // interface, so `storage` (an accessor) and `sendBeacon` (a method) live on
  // `WorkerNavigator.prototype`, and `navigator` is an instance with only its
  // own data props. Cleaning the instance alone leaves both reachable via
  // the prototype.
  const WorkerNavigatorPrototype: Record<string, unknown> = {
    sendBeacon: () => true,
  }
  Object.defineProperty(WorkerNavigatorPrototype, 'storage', {
    get: () => ({ getDirectory: () => ({}) }),
    configurable: true,
    enumerable: true,
  })
  const navigator = Object.create(WorkerNavigatorPrototype) as Record<string, unknown>
  navigator.hardwareConcurrency = 8
  g.navigator = navigator
  // Things the script legitimately keeps.
  g.setTimeout = setTimeout
  g.console = console
  return Object.assign(g, { navigator, WorkerNavigatorPrototype })
}

describe('hardenWorkerRealm', () => {
  it('removes every listed global and navigator prop, keeps the benign surface', () => {
    const g = fakeWorkerGlobal()
    hardenWorkerRealm(g)
    for (const name of RUN_JS_REMOVED_GLOBALS) {
      expect(g[name], name).toBeUndefined()
    }
    const navigator = g.navigator as Record<string, unknown>
    for (const name of RUN_JS_REMOVED_NAVIGATOR_PROPS) {
      expect(navigator[name], `navigator.${name}`).toBeUndefined()
    }
    // Pinned by name so a future edit cannot quietly drop one: OPFS and the
    // Beacon egress channel are the two that matter; WebSocketStream is the
    // WebSocket spelling that is NOT covered by deleting `WebSocket`.
    expect(RUN_JS_REMOVED_NAVIGATOR_PROPS).toContain('storage')
    expect(RUN_JS_REMOVED_NAVIGATOR_PROPS).toContain('sendBeacon')
    expect(RUN_JS_REMOVED_GLOBALS).toContain('WebSocketStream')
    expect(navigator.hardwareConcurrency).toBe(8)
    expect(g.setTimeout).toBe(setTimeout)
    expect(g.console).toBe(console)
  })

  it('neutralizes navigator props on the PROTOTYPE, not just the instance', () => {
    // Before the fix the instance was shadowed with `undefined` while the
    // prototype kept the real members, so these two spellings still worked:
    //   WorkerNavigator.prototype.sendBeacon.call(navigator, url, body)
    //   Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'storage')
    //     .get.call(navigator)
    const g = fakeWorkerGlobal()
    const proto = g.WorkerNavigatorPrototype
    expect(typeof proto.sendBeacon).toBe('function')
    expect(Object.getOwnPropertyDescriptor(proto, 'storage')?.get).toBeTypeOf('function')

    hardenWorkerRealm(g)

    expect(proto.sendBeacon).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(proto, 'storage')?.get).toBeUndefined()
    expect(Object.getPrototypeOf(g.navigator)).toBe(proto)
    for (const name of RUN_JS_REMOVED_NAVIGATOR_PROPS) {
      expect(g.navigator[name], `navigator.${name}`).toBeUndefined()
      // Nothing left anywhere in the chain that resolves to a live member.
      let obj: object | null = g.navigator
      while (obj) {
        const desc = Object.getOwnPropertyDescriptor(obj, name)
        if (desc) {
          expect(desc.value, `${name} on chain`).toBeUndefined()
          expect(desc.get, `${name} getter on chain`).toBeUndefined()
        }
        obj = Object.getPrototypeOf(obj) as object | null
      }
    }
  })

  it('a non-deletable prototype member is pinned to undefined and stays down', () => {
    const g = fakeWorkerGlobal()
    const proto = g.WorkerNavigatorPrototype
    Object.defineProperty(proto, 'sendBeacon', {
      value: () => true,
      configurable: false,
      writable: true,
    })
    hardenWorkerRealm(g)
    expect(proto.sendBeacon).toBeUndefined()
    expect(g.navigator.sendBeacon).toBeUndefined()
    expect(() => {
      proto.sendBeacon = () => true
    }).toThrow()
  })

  it('neutralizes a non-deletable property via the defineProperty fallback', () => {
    const g = fakeWorkerGlobal()
    Object.defineProperty(g, 'fetch', {
      value: () => 'net',
      configurable: false,
      writable: true,
    })
    hardenWorkerRealm(g)
    expect(g.fetch).toBeUndefined()
    // And it stays down — the script cannot restore it.
    expect(() => {
      ;(g as { fetch?: unknown }).fetch = () => 'net again'
    }).toThrow()
  })

  it('is idempotent', () => {
    const g = fakeWorkerGlobal()
    hardenWorkerRealm(g)
    expect(() => hardenWorkerRealm(g)).not.toThrow()
    expect(g.fetch).toBeUndefined()
  })
})
