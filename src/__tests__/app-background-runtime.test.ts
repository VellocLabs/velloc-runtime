/**
 * The apps' background modules (F-40): a synced app starts one resident
 * worker, `app.start` is raised with the app, the module's `$.app.state`
 * reaches the state document (the file, the bus, an open session's board as
 * path patches), `$.clock.every` runs, a session noun or event is refused,
 * a crash restarts under the backoff, a sync-out raises `app.stop`; an
 * `app.action` is handled or falls through, within its budget; `$.app.badge`
 * reaches the icon and clears at the stop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import {
  AppBackgroundRuntime,
  type AppBackgroundRef,
  type AppBackgroundRuntimeOptions,
} from '../mods/app/AppBackgroundRuntime'
import { refuseAppBackgroundCall, refuseAppBackgroundRegistrations, refuseAppBackgroundUses } from '../mods/app/appBackgroundEvents'
import type { AppBackgroundMcpOwner } from '../mods/app/appBackgroundMcp'
import { liveAppState, resetAppStateBusForTests } from '../mods/app/appStateBus'
import { createAppSurfaceHost } from '../mods/app/appSurfaceHost'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const openPorts: MessagePort[] = []
const runtimes: AppBackgroundRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
  resetAppStateBusForTests()
})

type Worker = ModWorkerHandle & { crash(message?: string): void; id: number; failClose?: boolean }

const FOLDER = 'C:/home/.velloc/shared-workspace/app-pay-board'

function world(
  modules: Record<string, string>,
  options: Partial<AppBackgroundRuntimeOptions> & { files?: Record<string, string> } = {},
) {
  const reports: string[] = []
  const workers: Worker[] = []
  const files = new Map(Object.entries(options.files ?? {}))
  const writes: string[] = []
  let opened = 0
  const fs = {
    readFile: async (path: string) => {
      const text = files.get(path.split('\\').join('/'))
      if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
      return text
    },
    writeFile: async (path: string, data: string) => {
      files.set(path.split('\\').join('/'), data)
      writes.push(path.split('\\').join('/'))
    },
    mkdir: async () => undefined,
    stat: async (path: string) => {
      const key = path.split('\\').join('/').replace(/\/+$/, '')
      const text = files.get(key)
      if (text !== undefined) return { isFile: () => true, isDirectory: () => false, size: text.length, mtimeMs: 1 }
      if ([...files.keys()].some(file => file.startsWith(`${key}/`)) || FOLDER.startsWith(key)) {
        return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 1 }
      }
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
    },
  }
  const runtime = new AppBackgroundRuntime({
    readModule: async path => {
      const source = modules[path]
      if (source === undefined) throw new Error(`ENOENT ${path}`)
      return source
    },
    openWorker: async () => {
      const id = ++opened
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed'; message?: string }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed'; message?: string }>(resolve => {
        settle = resolve
      })
      const worker: Worker = {
        id,
        port: channel.port1,
        closed,
        close: () => {
          if (worker.failClose) throw new Error('close failed')
          settle({ reason: 'closed' })
        },
        crash: message => settle({ reason: 'crashed', ...(message ? { message } : {}) }),
      }
      workers.push(worker)
      return worker
    },
    window: { available: () => true, attached: async () => {} },
    fs: fs as never,
    report: line => reports.push(line),
    respawnBackoffMs: [10],
    persistDelayMs: 5,
    ...options,
  })
  runtimes.push(runtime)
  const ref = (path: string, appId = 'pay-board'): AppBackgroundRef => ({
    plugin: 'pay',
    path,
    root: '/plugins/pay',
    appId,
    folder: FOLDER,
    stateFile: `${FOLDER}/data/latest.json`,
  })
  const status = (appId = 'pay-board') => runtime.status().find(s => s.appId === appId)
  return { runtime, reports, workers, files, writes, ref, status, opened: () => opened }
}

/** Reads its state at start, counts ticks on a timer, logs its stop. */
const COUNTER = `
  export function register(on) {
    on('app.start', async ($, e) => {
      await $.app.state.update(s => { s.started = e.appId; s.folder = e.folder; s.ticks = 0 })
      $.clock.every(5, () => $.app.state.update(s => { s.ticks += 1 }))
    })
    on('app.stop', ($, e) => $.log.info('stop ' + e.reason))
  }
`

describe('AppBackgroundRuntime — a synced app', () => {
  it('starts one worker, raises app.start with the app, reads the state file, and publishes its changes as patches', async () => {
    const { runtime, ref, status, opened, files, writes } = world(
      { '/plugins/pay/bg.js': COUNTER },
      { files: { [`${FOLDER}/data/latest.json`]: '{"count":3}' } },
    )
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    expect(opened()).toBe(1)
    const document = runtime.document('pay-board')!
    await vi.waitFor(() => expect((document.value as { ticks: number }).ticks).toBeGreaterThanOrEqual(2))
    expect(document.value).toMatchObject({ count: 3, started: 'pay-board', folder: FOLDER })
    expect(liveAppState('pay-board')?.value).toBe(document.value)
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0))
    await document.flush()
    expect(JSON.parse(files.get(`${FOLDER}/data/latest.json`)!)).toMatchObject({ count: 3, started: 'pay-board' })
  })

  it("an open session's board follows the live state: whole at first, then the patches, with the sequence they apply to", async () => {
    const { runtime, ref, status } = world({ '/plugins/pay/bg.js': COUNTER })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    const published: AppSurfaceState[] = []
    const disk = { stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 1, mtimeMs: 1 }) as never, readFileBytes: async () => new TextEncoder().encode('surface("app")\nroot = Text($/data/ticks)') }
    const host = createAppSurfaceHost({
      fs: disk,
      app: { appId: 'pay-board', plugin: 'pay', folder: FOLDER, decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui', data: 'data/latest.json' }, seed: { version: 1, written: [], conflicts: [] } },
      sessionId: 's1',
      compile: async () => ({ ok: true, surfaceIds: ['app'] }),
      publish: (_id, state) => {
        if (state) published.push(state)
      },
      registerBuild: () => () => true,
    })
    const first = await host.start()
    expect(first.data).toMatchObject({ started: 'pay-board' })
    expect(first.surface?.surfaceIds).toEqual(['app'])
    const built = published.indexOf(first)
    await vi.waitFor(() => expect(published.length).toBeGreaterThanOrEqual(built + 3))
    const second = published[built + 1]!
    const third = published[built + 2]!
    expect(second.dataSeq).toBe(first.dataSeq! + 1)
    expect(second.dataPatches).toEqual({ from: first.dataSeq, patches: [{ path: '/ticks', value: (second.data as { ticks: number }).ticks }] })
    expect(third.dataPatches?.from).toBe(second.dataSeq)
    expect(third.dataSeq).toBe(second.dataSeq! + 1)
    host.dispose()
  })

  it('a sync-out raises app.stop and closes the worker; the live state is gone', async () => {
    const { runtime, ref, status, workers, reports } = world({ '/plugins/pay/bg.js': COUNTER })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    runtime.sync([])
    await vi.waitFor(() => expect(reports).toContain('pay [info]: stop the app is gone'))
    await expect(workers[0]!.closed).resolves.toEqual({ reason: 'closed' })
    expect(status()).toBeUndefined()
    expect(liveAppState('pay-board')).toBeUndefined()
  })

  it('a crashed worker starts again after the backoff and app.start runs again; an unchanged ref is left alone', async () => {
    const { runtime, ref, status, workers, opened, reports } = world({ '/plugins/pay/bg.js': COUNTER })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    runtime.sync([ref('/plugins/pay/bg.js')])
    expect(opened()).toBe(1)
    workers[0]!.crash('boom')
    await vi.waitFor(() => expect(opened()).toBe(2))
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    expect(reports).toContainEqual(expect.stringMatching(/stopped — its worker is gone \(boom\); it starts again after 10ms/))
    const document = runtime.document('pay-board')!
    expect(document.value).toMatchObject({ started: 'pay-board' })
  })

  it('a changed module starts after the old one stopped: it reads what the old one wrote, and keeps the live state', async () => {
    const SAVER = `
      export function register(on) {
        on('app.start', async ($) => { await $.app.state.update(s => { s.ticks = (s.ticks ?? 0) + 1 }) })
        on('app.stop', async ($) => {
          await $.clock.sleep(30)
          await $.app.state.update(s => { s.saved = 'on stop' })
        })
      }
    `
    const { runtime, ref, status, files } = world(
      { '/plugins/pay/bg.js': SAVER, '/plugins/pay/bg2.js': SAVER },
      { persistDelayMs: 1000 },
    )
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(runtime.document('pay-board')?.value).toMatchObject({ ticks: 1 }))
    runtime.sync([ref('/plugins/pay/bg2.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    const document = runtime.document('pay-board')!
    await vi.waitFor(() => expect(document.value).toMatchObject({ ticks: 2, saved: 'on stop' }))
    expect(liveAppState('pay-board')?.value, 'the old module going leaves the new one\'s live state').toBe(document.value)
    await document.flush()
    expect(JSON.parse(files.get(`${FOLDER}/data/latest.json`)!)).toMatchObject({ ticks: 2, saved: 'on stop' })
  })

  it('a stop that throws is reported and does not hold back the next module of the app', async () => {
    const { runtime, ref, status, workers, reports } = world({ '/plugins/pay/bg.js': COUNTER, '/plugins/pay/bg2.js': COUNTER, '/plugins/pay/bg3.js': COUNTER })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    workers[0]!.failClose = true
    runtime.sync([ref('/plugins/pay/bg2.js')])
    runtime.sync([ref('/plugins/pay/bg3.js')])
    await vi.waitFor(() => expect(reports).toContainEqual(expect.stringMatching(/did not stop cleanly \(close failed\)/)))
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    expect(runtime.document('pay-board')!.value).toMatchObject({ started: 'pay-board' })
  })

  it('waits for a window instead of failing', async () => {
    let attached!: () => void
    const { runtime, ref, status, opened } = world(
      { '/plugins/pay/bg.js': COUNTER },
      { window: { available: () => false, attached: () => new Promise<void>(resolve => (attached = resolve)) } },
    )
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('waiting'))
    await sleep(20)
    expect(opened()).toBe(0)
    attached()
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
  })
})

describe('AppBackgroundRuntime — admission', () => {
  it('a module hooking a session event is refused and its worker closed', async () => {
    const { runtime, ref, status, workers } = world({
      '/plugins/pay/bg.js': `export function register(on) { on('app.start', () => {}); on('session.start', () => {}) }`,
    })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('refused'))
    expect(status()?.reason).toMatch(/hooks app\.start, app\.stop and app\.action alone, and it hooks session\.start/)
    await expect(workers[0]!.closed).resolves.toEqual({ reason: 'closed' })
  })

  it('a session noun is refused at the call; an unreadable module is failed until it can be read', async () => {
    const { runtime, ref, status } = world({
      '/plugins/pay/bg.js': `
        export function register(on) {
          on('app.start', async ($) => {
            let message = 'none'
            try { await $.ui.toast('hi') } catch (error) { message = error.name + ': ' + error.message }
            await $.app.state.set({ message })
          })
        }`,
    })
    runtime.sync([ref('/plugins/pay/bg.js'), ref('/plugins/pay/missing.js', 'pay-other')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    await vi.waitFor(() => expect((runtime.document('pay-board')!.value as { message: string }).message).toMatch(/^NotAllowedError: \$\.ui is a session noun/))
    expect(status('pay-other')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/could not be read/) })
  })

  it('an unreadable module is read again on the next sync; a refused one is left off', async () => {
    const modules: Record<string, string> = { '/plugins/pay/refused.js': `export function register(on) { on('session.start', () => {}) }` }
    const { runtime, ref, status, opened } = world(modules)
    const refs = [ref('/plugins/pay/bg.js'), ref('/plugins/pay/refused.js', 'pay-other')]
    runtime.sync(refs)
    await vi.waitFor(() => expect(status()?.state).toBe('failed'))
    await vi.waitFor(() => expect(status('pay-other')?.state).toBe('refused'))
    const spawned = opened()
    modules['/plugins/pay/bg.js'] = COUNTER
    runtime.sync(refs)
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    expect(opened(), 'one new worker, for the module now read').toBe(spawned + 1)
    expect(status('pay-other')?.state).toBe('refused')
  })

  it('a batch the document refuses rejects the call and leaves the state as it was', async () => {
    const { runtime, ref, status } = world({
      '/plugins/pay/bg.js': `
        export function register(on) {
          on('app.start', async ($) => {
            await $.app.state.set({ ok: 1 })
            let refused = 'none'
            try { await $.app.publish([{ path: 'bad' }]) } catch (error) { refused = error.message }
            await $.app.state.update(s => { s.refused = refused })
          })
        }`,
    })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    await vi.waitFor(() => expect(runtime.document('pay-board')!.value).toMatchObject({ ok: 1, refused: expect.stringMatching(/not a JSON pointer/) }))
    expect(runtime.document('pay-board')!.version).toBe(2)
  })

  it('an object the module got and edited in place is still published when set', async () => {
    const { runtime, ref, status } = world({
      '/plugins/pay/bg.js': `
        export function register(on) {
          on('app.start', async ($) => {
            await $.app.state.set({ count: 1, list: [] })
            const s = await $.app.state.get()
            s.count += 1
            await $.app.state.set(s)
            s.count += 1
            await $.app.state.update(d => { d.note = 'after' })
            const u = await $.app.state.update(d => { d.list.push('a') })
            u.list.push('b')
            await $.app.state.set(u)
          })
        }`,
    })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    await vi.waitFor(() => expect(runtime.document('pay-board')!.value).toEqual({ count: 2, note: 'after', list: ['a', 'b'] }))
  })

  it('the static checks name the session events, the session nouns and the forbidden methods', () => {
    expect(refuseAppBackgroundRegistrations([{ pattern: 'app.start' }, { pattern: 'app.stop' }, { pattern: 'app.action' }] as never)).toBeNull()
    expect(refuseAppBackgroundRegistrations([{ pattern: 'tool.call' }] as never)).toMatch(/hooks tool\.call/)
    expect(refuseAppBackgroundRegistrations([{ pattern: 'app.start', streams: true }] as never)).toMatch(/async generator/)
    expect(refuseAppBackgroundCall('clock', 'every')).toBeNull()
    expect(refuseAppBackgroundCall('app', 'publish')).toBeNull()
    expect(refuseAppBackgroundCall('app', 'badge')).toBeNull()
    expect(refuseAppBackgroundCall('app', 'delete')).toMatch(/offers state, publish, badge/)
    expect(refuseAppBackgroundCall('http', 'post')).toMatch(/offers fetch/)
    expect(refuseAppBackgroundCall('mcp', 'call')).toBeNull()
    expect(refuseAppBackgroundCall('mcp', 'connect')).toBeNull()
    expect(refuseAppBackgroundCall('mcp', 'listTools')).toMatch(/offers call, connect/)
    expect(refuseAppBackgroundCall('tool', 'register')).toMatch(/session noun/)
    expect(refuseAppBackgroundUses({ calls: ['app.state', 'prompt.submit'] } as never)).toMatch(/\$\.prompt is a session noun/)
  })
})

describe('AppBackgroundRuntime — app.action', () => {
  /** Handles `refresh` by counting it into the state; says no to `other`; throws on `boom`; sleeps on `slow`. */
  const ACTOR = `
    export function register(on) {
      on('app.start', async ($) => { await $.app.state.set({ seen: [] }) })
      on('app.action', async ($, e) => {
        await $.app.state.update(s => { s.seen.push([e.appId, e.action, e.context, e.sessionId]) })
        if (e.action === 'boom') throw new Error('no such case')
        if (e.action === 'slow') await new Promise(resolve => setTimeout(resolve, 200))
        if (e.action === 'plain') return 1
        return { handled: e.action === 'refresh' }
      })
    }`

  async function ready(source = ACTOR, options: Partial<AppBackgroundRuntimeOptions> = {}) {
    const w = world({ '/plugins/pay/bg.js': source }, options)
    w.runtime.sync([w.ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(w.status()?.state).toBe('ready'))
    return w
  }

  it('a handled action is true and the module saw the event; a refused one, a failing one and an unknown app are false', async () => {
    const { runtime, reports } = await ready()
    expect(await runtime.action('pay-board', 'refresh', { id: 7 }, 's1')).toBe(true)
    expect(await runtime.action('pay-board', 'other', undefined, 's1')).toBe(false)
    expect(await runtime.action('pay-board', 'plain', null, 's2')).toBe(true)
    expect(await runtime.action('pay-board', 'boom', null, 's1')).toBe(false)
    expect(await runtime.action('pay-other', 'refresh', null, 's1')).toBe(false)
    expect((runtime.document('pay-board')!.value as { seen: unknown[] }).seen).toEqual([
      ['pay-board', 'refresh', { id: 7 }, 's1'],
      ['pay-board', 'other', null, 's1'],
      ['pay-board', 'plain', null, 's2'],
      ['pay-board', 'boom', null, 's1'],
    ])
    expect(reports).toContainEqual(expect.stringMatching(/pay: the background module's app\.action hook failed \(throw\)/))
  })

  it('a handler past its budget is false and reported; a module without the hook is false without a dispatch', async () => {
    const { runtime, reports } = await ready(ACTOR, { actionTimeoutMs: 40 })
    expect(await runtime.action('pay-board', 'slow', null, 's1')).toBe(false)
    expect(reports).toContainEqual(expect.stringMatching(/pay: (the background module's app\.action hook failed \(|app\.action "slow" of pay-board did not finish within 40ms)/))
    const quiet = await ready(COUNTER)
    expect(await quiet.runtime.action('pay-board', 'refresh', null, 's1')).toBe(false)
  })

  it("a session's board is refreshing while the module has the action, and not after; an action the manifest does not name is not offered", async () => {
    const { runtime } = await ready()
    const published: AppSurfaceState[] = []
    const disk = { stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 1, mtimeMs: 1 }) as never, readFileBytes: async () => new TextEncoder().encode('surface("app")\nroot = Text("x")') }
    const host = createAppSurfaceHost({
      fs: disk,
      app: { appId: 'pay-board', plugin: 'pay', folder: FOLDER, decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui', localActions: ['refresh', 'slow'] }, seed: { version: 1, written: [], conflicts: [] } },
      sessionId: 's1',
      compile: async () => ({ ok: true, surfaceIds: ['app'] }),
      publish: (_id, state) => {
        if (state) published.push(state)
      },
      registerBuild: () => () => true,
      registerActor: () => () => true,
      dispatchAction: (appId, action, context, sessionId) => runtime.action(appId, action, context, sessionId),
    })
    const first = await host.start()
    expect(first.localActions).toEqual(['refresh', 'slow'])
    expect(first.refreshing).toBe(false)
    const flags = () => published.map(state => state.refreshing)
    await expect(host.action('refresh', { id: 1 })).resolves.toEqual({ handled: true })
    expect(flags().slice(-2)).toEqual([true, false])
    const before = published.length
    await expect(host.action('open_case', { id: 1 })).resolves.toEqual({ handled: false })
    expect(published.length).toBe(before)
    expect((runtime.document('pay-board')!.value as { seen: unknown[][] }).seen.map(row => row[1])).toEqual(['refresh'])
    host.dispose()
  })
})

describe('AppBackgroundRuntime — $.app.badge', () => {
  /** Sets a badge at start; a `badge` action sets what it is told and keeps a refusal in the state. */
  const BADGER = `
    export function register(on) {
      on('app.start', async ($) => { await $.app.badge(3) })
      on('app.action', async ($, e) => {
        try { await $.app.badge(e.context) } catch (error) { await $.app.state.update(s => { s.refused = error.name + ': ' + error.message }) }
        return true
      })
    }`

  it('reaches the icon as set, once per change, refuses what is not a count, and clears at the stop', async () => {
    const badges: Array<[string, number | null]> = []
    const { runtime, ref, status } = world({ '/plugins/pay/bg.js': BADGER }, { onBadge: (appId, count) => badges.push([appId, count]) })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    await vi.waitFor(() => expect(badges).toEqual([['pay-board', 3]]))
    await runtime.action('pay-board', 'badge', 3, 's1')
    await runtime.action('pay-board', 'badge', 12, 's1')
    expect(badges).toEqual([['pay-board', 3], ['pay-board', 12]])
    for (const bad of [-1, 1.5, 'x']) {
      await runtime.action('pay-board', 'badge', bad, 's1')
      expect((runtime.document('pay-board')!.value as { refused: string }).refused).toMatch(/^TypeError: \$\.app\.badge\(count\): count is a whole number from 0, or null/)
    }
    await runtime.action('pay-board', 'badge', 0, 's1')
    expect(badges.at(-1)).toEqual(['pay-board', 0])
    runtime.sync([])
    await vi.waitFor(() => expect(status()).toBeUndefined())
    expect(badges.at(-1)).toEqual(['pay-board', null])
    expect(badges).toHaveLength(4)
  })

  it('a module that set no badge clears nothing at its stop; null clears before the stop', async () => {
    const badges: Array<[string, number | null]> = []
    const { runtime, ref, status } = world({ '/plugins/pay/bg.js': COUNTER }, { onBadge: (appId, count) => badges.push([appId, count]) })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    runtime.sync([])
    await vi.waitFor(() => expect(status()).toBeUndefined())
    expect(badges).toEqual([])
    const second = world({ '/plugins/pay/bg.js': BADGER }, { onBadge: (appId, count) => badges.push([appId, count]) })
    second.runtime.sync([second.ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(badges).toEqual([['pay-board', 3]]))
    await second.runtime.action('pay-board', 'badge', null, 's1')
    expect(badges).toEqual([['pay-board', 3], ['pay-board', null]])
    second.runtime.sync([])
    await vi.waitFor(() => expect(second.status()).toBeUndefined())
    expect(badges).toHaveLength(2)
  })

  it('a crash restart keeps the badge; a module that stays off after its crashes clears it', async () => {
    const badges: Array<[string, number | null]> = []
    const { runtime, ref, status, workers, opened } = world({ '/plugins/pay/bg.js': BADGER }, { onBadge: (appId, count) => badges.push([appId, count]) })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(badges).toEqual([['pay-board', 3]]))
    for (let crash = 1; crash <= 3; crash++) {
      workers[crash - 1]!.crash('boom')
      await vi.waitFor(() => expect(opened()).toBe(crash + 1))
      await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    }
    expect(badges).toEqual([['pay-board', 3]])
    workers[3]!.crash('boom')
    await vi.waitFor(() => expect(status()?.state).toBe('dead'))
    expect(badges).toEqual([['pay-board', 3], ['pay-board', null]])
  })
})

describe('AppBackgroundRuntime — $.mcp', () => {
  const OWNER: AppBackgroundMcpOwner = {
    name: 'pay',
    path: '/plugins/pay',
    manifest: { name: 'pay' } as never,
    mcpServers: { docs: { type: 'http', url: 'https://docs.test/mcp' } },
  }
  /** Connects its own server at start, calls it, and keeps both answers in the state. */
  const MCP_USER = `
    export function register(on) {
      on('app.start', async ($) => {
        let connect, result
        try { connect = await $.mcp.connect('docs') } catch (error) { connect = { error: error.name } }
        try { result = await $.mcp.call('docs', 'search', { q: 1 }) } catch (error) { result = { error: error.name } }
        await $.app.state.update(s => { s.connect = connect; s.result = result })
      })
    }
  `

  it('a module connects its own manifest server and calls it through a pool of its own, built at the first call and closed at the stop', async () => {
    const built: string[] = []
    const connects: string[] = []
    let closed = 0
    const { runtime, ref, status, reports } = world(
      { '/plugins/pay/bg.js': MCP_USER },
      {
        mcp: moduleRef => {
          built.push(`${moduleRef.appId}:${moduleRef.folder}:${moduleRef.mcpOwner.name}`)
          return {
            host: {
              connect: async (plugin, key) => {
                connects.push(`${plugin}/${key}`)
                return { isConnected: true, server: key }
              },
              call: async input => ({ content: [{ type: 'text', text: `${input.server}/${input.tool} ${JSON.stringify(input.args)}` }], isError: false }),
            },
            close: async () => {
              closed += 1
            },
          }
        },
      },
    )
    runtime.sync([{ ...ref('/plugins/pay/bg.js'), mcpOwner: OWNER }])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    const document = runtime.document('pay-board')!
    await vi.waitFor(() => expect(document.value).toHaveProperty('result'))
    expect(document.value).toEqual({
      connect: { isConnected: true, server: 'docs' },
      result: { content: [{ type: 'text', text: 'docs/search {"q":1}' }], isError: false },
    })
    expect(built).toEqual([`pay-board:${FOLDER}:pay`])
    expect(connects).toEqual(['pay/docs'])
    expect(closed).toBe(0)
    runtime.sync([])
    await vi.waitFor(() => expect(status()).toBeUndefined())
    await vi.waitFor(() => expect(closed).toBe(1))
    expect(reports.filter(line => /failed/.test(line))).toEqual([])
  })

  it('a worker that closes without crashing closes the pool with it', async () => {
    let closed = 0
    const { runtime, ref, status, workers } = world(
      { '/plugins/pay/bg.js': MCP_USER },
      {
        mcp: () => ({
          host: {
            connect: async (_plugin, key) => ({ isConnected: true, server: key }),
            call: async () => ({ content: [], isError: false }),
          },
          close: async () => {
            closed += 1
          },
        }),
      },
    )
    runtime.sync([{ ...ref('/plugins/pay/bg.js'), mcpOwner: OWNER }])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    await vi.waitFor(() => expect(runtime.document('pay-board')!.value).toHaveProperty('result'))
    expect(closed).toBe(0)
    workers[0]!.close()
    await vi.waitFor(() => expect(closed).toBe(1))
  })

  it('without an MCP host, or a plugin manifest, $.mcp is refused at the call as not supported', async () => {
    const { runtime, ref, status } = world({ '/plugins/pay/bg.js': MCP_USER })
    runtime.sync([{ ...ref('/plugins/pay/bg.js'), mcpOwner: OWNER }])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    const document = runtime.document('pay-board')!
    await vi.waitFor(() => expect(document.value).toHaveProperty('result'))
    expect(document.value).toEqual({ connect: { error: 'NotSupportedError' }, result: { error: 'NotSupportedError' } })
  })
})

describe('AppBackgroundRuntime — declared folders', () => {
  /** Reads a file of a declared folder, writes into the writable one, tries the read-only one and an outside path. */
  const FOLDER_USER = `
    export function register(on) {
      on('app.start', async ($, e) => {
        const out = { folders: e.folders }
        out.read = await $.fs.read('C:/home/Downloads/in.csv', 'text')
        await $.fs.write('C:/home/Documents/invoices/2026/new.txt', 'n')
        try { await $.fs.write('C:/home/Downloads/out.txt', 'x') } catch (error) { out.readOnly = error.name }
        try { await $.fs.read('C:/home/secret.txt', 'text') } catch (error) { out.outside = error.name }
        await $.app.state.set(out)
      })
    }
  `
  const FOLDERS = { read: ['C:/home/Downloads'], write: ['C:/home/Documents/invoices'] }

  it("reaches its approved folders beside the app's own, writes only where declared, and app.start names them", async () => {
    const { runtime, ref, status, files } = world(
      { '/plugins/pay/bg.js': FOLDER_USER },
      { files: { 'C:/home/Downloads/in.csv': 'csv', 'C:/home/secret.txt': 's' } },
    )
    runtime.sync([{ ...ref('/plugins/pay/bg.js'), folders: FOLDERS }])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    const document = runtime.document('pay-board')!
    await vi.waitFor(() => expect(document.value).toHaveProperty('outside'))
    expect(document.value).toEqual({ folders: FOLDERS, read: 'csv', readOnly: 'NotAllowedError', outside: 'NotAllowedError' })
    expect(files.get('C:/home/Documents/invoices/2026/new.txt')).toBe('n')
    expect(files.has('C:/home/Downloads/out.txt')).toBe(false)
  })

  it('without approved folders the module stays in the app folder and app.start names none', async () => {
    const { runtime, ref, status } = world({ '/plugins/pay/bg.js': FOLDER_USER }, { files: { 'C:/home/Downloads/in.csv': 'csv' } })
    runtime.sync([ref('/plugins/pay/bg.js')])
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    await vi.waitFor(() => expect(status()?.state).toBe('ready'))
    const document = runtime.document('pay-board')!
    await sleep(50)
    expect(document.value).toEqual({})
  })
})
