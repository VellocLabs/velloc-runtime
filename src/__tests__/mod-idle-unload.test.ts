/**
 * The idle unload (F-25, mods/modIdleUnload.ts): a session whose roster has been empty for the delay and that never
 * ran in this process gives its mods back; an attach or a submitted message loads them again; a mod mid-call
 * (`ModRuntime.isBusy`) holds the unload off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModIdleUnload, MOD_IDLE_UNLOAD_DELAY_MS } from '../mods/modIdleUnload'
import { ModRuntime, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  modRosterAttach,
  modRosterDetach,
  resetModSlotRegistryForTests,
  watchModRoster,
} from '../mods/modSlotRegistry'

function world(options: { roster?: number; busy?: boolean } = {}) {
  let size = options.roster ?? 0
  let busy = options.busy ?? false
  const watchers = new Set<(size: number) => void>()
  const log: string[] = []
  const idle = createModIdleUnload({
    rosterSize: () => size,
    watchRoster: watcher => {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },
    isBusy: () => busy,
    unload: async () => {
      log.push('unload')
    },
    load: async () => {
      log.push('load')
    },
  })
  const setRoster = (next: number) => {
    size = next
    for (const watcher of [...watchers]) watcher(size)
  }
  return {
    idle,
    log,
    watchers,
    setRoster,
    setBusy: (next: boolean) => {
      busy = next
    },
  }
}

describe('createModIdleUnload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('unloads a session nobody attached to once the delay passed — not before', () => {
    const { idle, log } = world()
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS - 1)
    expect(log).toEqual([])
    vi.advanceTimersByTime(1)
    expect(log).toEqual(['unload'])
    expect(idle.isUnloaded()).toBe(true)
  })

  it('keeps the mods while a client is attached, and counts the delay from its detach', () => {
    const { log, setRoster } = world({ roster: 1 })
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS * 3)
    expect(log).toEqual([])
    setRoster(0)
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS - 1)
    expect(log).toEqual([])
    vi.advanceTimersByTime(1)
    expect(log).toEqual(['unload'])
  })

  it('a client back within the delay cancels the unload', () => {
    const { log, setRoster } = world()
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS - 1)
    setRoster(1)
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS * 2)
    expect(log).toEqual([])
  })

  it('a client attaching after the unload loads the mods again; leaving again unloads them again', () => {
    const { idle, log, setRoster } = world()
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS)
    setRoster(1)
    expect(log).toEqual(['unload', 'load'])
    expect(idle.isUnloaded()).toBe(false)
    setRoster(0)
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS)
    expect(log).toEqual(['unload', 'load', 'unload'])
  })

  it('a session that ran keeps its mods for good', () => {
    const { idle, log, setRoster } = world({ roster: 1 })
    expect(idle.noteRan()).toBeUndefined()
    setRoster(0)
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS * 5)
    expect(log).toEqual([])
  })

  it('a message for an unloaded session loads the mods and hands the turn the reload', async () => {
    const { idle, log } = world()
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS)
    const arriving = idle.noteRan()
    expect(arriving).toBeInstanceOf(Promise)
    await arriving
    expect(log).toEqual(['unload', 'load'])
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS * 5)
    expect(log).toEqual(['unload', 'load'])
  })

  it('a mod in the middle of something is not cut off: asked again a delay later', () => {
    const { log, setBusy } = world({ busy: true })
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS * 2)
    expect(log).toEqual([])
    setBusy(false)
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS)
    expect(log).toEqual(['unload'])
  })

  it('dispose stops the timer and the watch', () => {
    const { idle, log, watchers } = world()
    idle.dispose()
    vi.advanceTimersByTime(MOD_IDLE_UNLOAD_DELAY_MS * 2)
    expect(log).toEqual([])
    expect(watchers.size).toBe(0)
  })
})

describe('watchModRoster', () => {
  afterEach(() => resetModSlotRegistryForTests())

  it('hears the size of a session’s roster on every attach and detach, slot or not', () => {
    const sizes: number[] = []
    const undo = watchModRoster('sess-w', size => sizes.push(size))
    modRosterAttach('sess-w', { clientId: 'a', surface: 'desktop' })
    modRosterAttach('sess-w', { clientId: 'a', surface: 'desktop' }) // already there: no change
    modRosterAttach('sess-w', { clientId: 'b', surface: 'desktop' })
    modRosterAttach('other', { clientId: 'c', surface: 'desktop' })
    modRosterDetach('sess-w', 'a')
    modRosterDetach('sess-w', 'b')
    expect(sizes).toEqual([1, 2, 1, 0])
    undo()
    modRosterAttach('sess-w', { clientId: 'd', surface: 'desktop' })
    expect(sizes).toEqual([1, 2, 1, 0])
  })
})

describe('ModRuntime.isBusy', () => {
  const open: MessagePort[] = []
  afterEach(() => {
    for (const port of open.splice(0)) port.close()
  })

  it('is false once the calls of session.start settled, true while the person is asked', async () => {
    const runtime = new ModRuntime({
      modules: [{ plugin: 'busy', path: '/plugins/busy/hooks/register.js' }],
      readModule: async () =>
        `export function register(on) {\non('session.start', async ($, e, next) => { await $.ui.log('hi'); return next(e) })\n}\n`,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      session: { id: () => 'sess-busy', cwd: () => '/work' },
      report: () => {},
    })
    try {
      await runtime.ready
      expect(runtime.isBusy()).toBe(false)
      const done = runtime.waitOnPerson()
      expect(runtime.isBusy()).toBe(true)
      done()
      expect(runtime.isBusy()).toBe(false)
    } finally {
      runtime.dispose()
    }
    expect(runtime.isBusy()).toBe(false)
  })
})
