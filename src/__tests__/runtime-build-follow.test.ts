/**
 * A window's page runs the build of the runtime that is alive (P-2): the alive lock is named per
 * build, a page of another build moves to the live runtime's entry, and a runtime retires before a
 * staged build is applied.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BUILD_FOLLOWED_KEY,
  followLiveRuntimeBuild,
  parseRuntimePath,
} from '../browser/boot/runtimeBuildFollow'
import { createRuntimeRetire, installUpdateRestartGate } from '../browser/boot/updateRestartGate'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { PortMessageRouter } from '../browser/worker/PortMessageRouter'
import {
  RUNTIME_RETIRE_DELAY_MS,
  createRuntimeAliveLock,
  isRuntimeBuildKey,
  liveRuntimeBuildKeys,
  retireRuntimeRealm,
  runtimeAliveLock,
  runtimeAliveLockName,
  runtimeBuildKey,
} from '../browser/worker/runtimeAliveLock'

const OLD_ISO = '2026-09-17T10:30:00.000Z'
const OLD_KEY = '20260917T103000000Z'
const NEW_ISO = '2026-10-02T08:00:00.000Z'
const NEW_KEY = '20261002T080000000Z'
const ORIGIN = 'https://app.example'

describe('the alive lock name', () => {
  it('carries the build key, and the dev key for a build without a stamp', () => {
    expect(runtimeBuildKey(OLD_ISO)).toBe(OLD_KEY)
    expect(runtimeAliveLockName(runtimeBuildKey(OLD_ISO))).toBe(`velloc-runtime-alive:${OLD_KEY}`)
    for (const none of ['', null, undefined, 'not a stamp']) expect(runtimeBuildKey(none)).toBe('dev')
  })

  it('lists the live builds from held lock names, each once', () => {
    expect(
      liveRuntimeBuildKeys([
        { name: 'other' },
        { name: `velloc-runtime-alive:${OLD_KEY}` },
        { name: 'velloc-runtime-alive:' },
        { name: 'velloc-runtime-alive:../../evil' },
        { name: 'velloc-runtime-alive://evil.example/x' },
        { name: 'velloc-runtime-alive:dev' },
        { name: `velloc-runtime-alive:${NEW_KEY}` },
        { name: `velloc-runtime-alive:${OLD_KEY}` },
        {},
      ]),
    ).toEqual([OLD_KEY, 'dev', NEW_KEY])
    expect(liveRuntimeBuildKeys(undefined)).toEqual([])
  })
})

describe('createRuntimeAliveLock', () => {
  function fakeLocks() {
    const holds: Array<Promise<unknown> | undefined> = []
    const request = vi.fn(async (_name: string, callback: () => Promise<unknown> | undefined) => {
      const held = callback()
      holds.push(held)
      await held
    })
    return { request, holds, locks: { request } as unknown as LockManager }
  }

  it('requests the build lock once and holds it', async () => {
    const { request, holds, locks } = fakeLocks()
    const lock = createRuntimeAliveLock(locks)
    expect(lock.hold(OLD_ISO)).toBe(true)
    expect(lock.hold(NEW_ISO)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe(`velloc-runtime-alive:${OLD_KEY}`)
    const settled = vi.fn()
    void holds[0]?.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
  })

  it('lets the lock go on release, and never takes it afterwards', async () => {
    const { request, holds, locks } = fakeLocks()
    const lock = createRuntimeAliveLock(locks)
    lock.hold(OLD_ISO)
    const settled = vi.fn()
    void holds[0]?.then(settled)
    lock.release()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledTimes(1)
    expect(lock.hold(NEW_ISO)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('a release before the grant gives the lock straight back', () => {
    let granted: (() => Promise<unknown> | undefined) | undefined
    const request = vi.fn(async (_name: string, callback: () => Promise<unknown> | undefined) => {
      granted = callback
    })
    const lock = createRuntimeAliveLock({ request } as unknown as LockManager)
    lock.hold(OLD_ISO)
    lock.release()
    expect(granted?.()).toBeUndefined()
  })

  it('is a no-op where Web Locks does not exist', () => {
    expect(createRuntimeAliveLock(null).hold(OLD_ISO)).toBe(false)
  })

  it('reports the lock it holds, then retiring once released', () => {
    const { locks } = fakeLocks()
    const lock = createRuntimeAliveLock(locks)
    expect(lock.state()).toBeNull()
    lock.hold(OLD_ISO)
    lock.hold(NEW_ISO)
    expect(lock.state()).toEqual({ lock: `velloc-runtime-alive:${OLD_KEY}` })
    lock.release()
    expect(lock.state()).toEqual({ retiring: true })
  })
})

describe('isRuntimeBuildKey', () => {
  it('accepts a build key and the dev key only', () => {
    expect(isRuntimeBuildKey(OLD_KEY)).toBe(true)
    expect(isRuntimeBuildKey('dev')).toBe(true)
    for (const bad of ['', '..', 'a/b', `${OLD_KEY}/`, `${OLD_KEY}?x`, '20260917T103000Z', 'https://x']) {
      expect(isRuntimeBuildKey(bad)).toBe(false)
    }
  })
})

describe('runtime.build on the worker port', () => {
  it('takes the lock for the first build and tells every page which lock it holds', () => {
    const router = new PortMessageRouter({} as never)
    const first = { postMessage: vi.fn() } as unknown as MessagePort
    const second = { postMessage: vi.fn() } as unknown as MessagePort
    const state = vi.spyOn(runtimeAliveLock, 'state').mockReturnValue({ lock: `velloc-runtime-alive:${OLD_KEY}` })
    const hold = vi.spyOn(runtimeAliveLock, 'hold').mockReturnValue(true)
    router.handle(first, { data: { type: 'runtime.build', build: OLD_ISO } } as MessageEvent)
    router.handle(second, { data: { type: 'runtime.build', build: 42 } } as MessageEvent)
    expect(hold.mock.calls).toEqual([[OLD_ISO], [null]])
    for (const port of [first, second]) {
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'runtime.alive', lock: `velloc-runtime-alive:${OLD_KEY}` })
    }
    state.mockReturnValue({ retiring: true })
    router.handle(second, { data: { type: 'runtime.build', build: NEW_ISO } } as MessageEvent)
    expect(second.postMessage).toHaveBeenLastCalledWith({ type: 'runtime.alive', retiring: true })
    state.mockRestore()
    hold.mockRestore()
  })
})

describe('retireRuntimeRealm', () => {
  it('lets the lock go at once, then says goodbye and closes the realm after the answer delay', () => {
    const release = vi.fn()
    const close = vi.fn()
    const order: string[] = []
    const beforeClose = vi.fn(() => { order.push('bye') })
    close.mockImplementation(() => { order.push('close') })
    const timers: Array<{ fn: () => void; ms: number }> = []
    retireRuntimeRealm(beforeClose, { release }, { close }, (fn, ms) => timers.push({ fn, ms }))
    expect(release).toHaveBeenCalledTimes(1)
    expect(beforeClose).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(timers.map(t => t.ms)).toEqual([RUNTIME_RETIRE_DELAY_MS])
    timers[0].fn()
    expect(order).toEqual(['bye', 'close'])
  })

  it('closes the realm even when the goodbye throws', () => {
    const close = vi.fn()
    const timers: Array<() => void> = []
    retireRuntimeRealm(() => { throw new Error('x') }, { release: vi.fn() }, { close }, fn => timers.push(fn))
    expect(() => timers[0]()).toThrow('x')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('parseRuntimePath', () => {
  it('reads the version root and an entry key', () => {
    expect(parseRuntimePath('/runtime/v12/')).toEqual({ root: '/runtime/v12/', entryKey: null })
    expect(parseRuntimePath(`/runtime/v12/b/${OLD_KEY}/`)).toEqual({ root: '/runtime/v12/', entryKey: OLD_KEY })
    expect(parseRuntimePath('/')).toBeNull()
  })
})

describe('followLiveRuntimeBuild', () => {
  function page(options: {
    live?: string[]
    pathname?: string
    ownBuildIso?: string
    followed?: string | null
    entryOk?: boolean
  }) {
    const store = new Map<string, string>()
    if (options.followed) store.set(BUILD_FOLLOWED_KEY, options.followed)
    const replace = vi.fn()
    const fetch = vi.fn(async (_url: string) => ({ ok: options.entryOk ?? true }))
    const run = () =>
      followLiveRuntimeBuild({
        locks: {
          query: async () => ({ held: (options.live ?? []).map(key => ({ name: `velloc-runtime-alive:${key}` })) }),
        } as unknown as Pick<LockManager, 'query'>,
        location: {
          origin: ORIGIN,
          pathname: options.pathname ?? '/runtime/v12/',
          search: '?product=Velloc',
          hash: '#x=1',
          replace,
        },
        fetch,
        storage: {
          getItem: key => store.get(key) ?? null,
          setItem: (key, value) => void store.set(key, value),
          removeItem: key => void store.delete(key),
        },
        ownBuildIso: options.ownBuildIso ?? NEW_ISO,
      })
    return { run, replace, fetch, followed: () => store.get(BUILD_FOLLOWED_KEY) ?? null }
  }

  it('boots as it is when no runtime is alive', async () => {
    const p = page({})
    expect(await p.run()).toBe(false)
    expect(p.replace).not.toHaveBeenCalled()
    expect(p.fetch).not.toHaveBeenCalled()
  })

  it('boots as it is when a runtime of its own build is alive, even beside another', async () => {
    const p = page({ live: [OLD_KEY, NEW_KEY] })
    expect(await p.run()).toBe(false)
    expect(p.replace).not.toHaveBeenCalled()
  })

  it('moves to the entry of the live runtime of another build, keeping query and fragment', async () => {
    const p = page({ live: [OLD_KEY] })
    expect(await p.run()).toBe(true)
    expect(p.fetch).toHaveBeenCalledWith(`${ORIGIN}/runtime/v12/b/${OLD_KEY}/`)
    expect(p.replace).toHaveBeenCalledWith(`${ORIGIN}/runtime/v12/b/${OLD_KEY}/?product=Velloc#x=1`)
    expect(p.followed()).toBe(OLD_KEY)
  })

  it('moves from one entry to another when the live runtime changed build', async () => {
    const p = page({ live: [NEW_KEY], pathname: `/runtime/v12/b/${OLD_KEY}/`, ownBuildIso: OLD_ISO, followed: OLD_KEY })
    expect(await p.run()).toBe(true)
    expect(p.replace).toHaveBeenCalledWith(`${ORIGIN}/runtime/v12/b/${NEW_KEY}/?product=Velloc#x=1`)
    expect(p.followed()).toBe(NEW_KEY)
  })

  it('stays when the entry is not served', async () => {
    const p = page({ live: [OLD_KEY], entryOk: false })
    expect(await p.run()).toBe(false)
    expect(p.replace).not.toHaveBeenCalled()
    expect(p.followed()).toBeNull()
  })

  it('tries one target once: an entry that did not give that build is not loaded again', async () => {
    const p = page({ live: [OLD_KEY], pathname: `/runtime/v12/b/${OLD_KEY}/`, followed: OLD_KEY })
    expect(await p.run()).toBe(false)
    expect(p.fetch).not.toHaveBeenCalled()
  })

  it('follows again from the version root even when that target was followed before', async () => {
    const p = page({ live: [OLD_KEY], followed: OLD_KEY })
    expect(await p.run()).toBe(true)
    expect(p.replace).toHaveBeenCalledWith(`${ORIGIN}/runtime/v12/b/${OLD_KEY}/?product=Velloc#x=1`)
  })

  it('never navigates for a malformed key in a lock name', async () => {
    for (const bad of ['..', 'x/../../evil', '%2e%2e']) {
      const p = page({ live: [bad] })
      expect(await p.run()).toBe(false)
      expect(p.fetch).not.toHaveBeenCalled()
      expect(p.replace).not.toHaveBeenCalled()
    }
  })

  it('stays when the entry probe fails on the network', async () => {
    const p = page({ live: [OLD_KEY] })
    p.fetch.mockRejectedValueOnce(new TypeError('network'))
    expect(await p.run()).toBe(false)
    expect(p.replace).not.toHaveBeenCalled()
  })

  it('goes back to the version root once no runtime is alive, only from the entry it moved to', async () => {
    const moved = page({ pathname: `/runtime/v12/b/${OLD_KEY}/`, ownBuildIso: OLD_ISO, followed: OLD_KEY })
    expect(await moved.run()).toBe(true)
    expect(moved.replace).toHaveBeenCalledWith(`${ORIGIN}/runtime/v12/?product=Velloc#x=1`)
    expect(moved.followed()).toBeNull()

    const opened = page({ pathname: `/runtime/v12/b/${OLD_KEY}/`, ownBuildIso: OLD_ISO })
    expect(await opened.run()).toBe(false)
    expect(opened.replace).not.toHaveBeenCalled()
  })

  it('never moves on a dev server, off a versioned path, or towards a dev runtime', async () => {
    expect(await page({ live: [OLD_KEY], ownBuildIso: '' }).run()).toBe(false)
    expect(await page({ live: [OLD_KEY], pathname: '/' }).run()).toBe(false)
    expect(await page({ live: ['dev'] }).run()).toBe(false)
  })

  it('answers false when the locks cannot be read', async () => {
    expect(
      await followLiveRuntimeBuild({
        locks: { query: async () => { throw new Error('denied') } } as unknown as Pick<LockManager, 'query'>,
        location: { origin: ORIGIN, pathname: '/runtime/v12/', search: '', hash: '', replace: vi.fn() },
        storage: null,
        ownBuildIso: NEW_ISO,
      }),
    ).toBe(false)
    expect(await followLiveRuntimeBuild({ locks: null })).toBe(false)
  })
})

describe('the page-side retire call', () => {
  const connectionAnswering = (answer: () => Promise<unknown>) => {
    const request = vi.fn(async (_route: string) => answer())
    return { request, connection: async () => ({ request }) as unknown as Pick<RuntimeConnection, 'request'> }
  }

  it('asks runtime.retireForUpdate and is true only for a runtime that agreed', async () => {
    const { request, connection } = connectionAnswering(async () => ({ retired: true, reasons: [] }))
    expect(await createRuntimeRetire(connection)()).toBe(true)
    expect(request).toHaveBeenCalledWith('runtime.retireForUpdate')
    for (const answer of [null, {}, { retired: 'yes' }, { retired: false, reasons: ['turn_running'] }]) {
      expect(await createRuntimeRetire(connectionAnswering(async () => answer).connection)()).toBe(false)
    }
    const failing = connectionAnswering(async () => { throw new Error('gone') })
    expect(await createRuntimeRetire(failing.connection)()).toBe(false)
  })

  it('is installed beside the restart gate', () => {
    const target: NonNullable<Parameters<typeof installUpdateRestartGate>[1]> = {}
    installUpdateRestartGate(connectionAnswering(async () => null).connection, target)
    expect(typeof target.__nexusRestartGate).toBe('function')
    expect(typeof target.__nexusRuntimeRetire).toBe('function')
  })
})
