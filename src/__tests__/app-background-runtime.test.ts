/**
 * The apps' background modules (F-40): a synced app starts one resident
 * worker, `app.start` is raised with the app, the module's `$.app.state`
 * reaches the state document (the file, the bus, an open session's board as
 * path patches), `$.clock.every` runs, a session noun or event is refused,
 * a crash restarts under the backoff, a sync-out raises `app.stop`.
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

type Worker = ModWorkerHandle & { crash(message?: string): void; id: number }

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
        close: () => settle({ reason: 'closed' }),
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
    expect(status()?.reason).toMatch(/hooks app\.start and app\.stop alone, and it hooks session\.start/)
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
    expect(refuseAppBackgroundRegistrations([{ pattern: 'app.start' }, { pattern: 'app.stop' }] as never)).toBeNull()
    expect(refuseAppBackgroundRegistrations([{ pattern: 'tool.call' }] as never)).toMatch(/hooks tool\.call/)
    expect(refuseAppBackgroundRegistrations([{ pattern: 'app.start', streams: true }] as never)).toMatch(/async generator/)
    expect(refuseAppBackgroundCall('clock', 'every')).toBeNull()
    expect(refuseAppBackgroundCall('app', 'publish')).toBeNull()
    expect(refuseAppBackgroundCall('app', 'delete')).toMatch(/offers state, publish/)
    expect(refuseAppBackgroundCall('http', 'post')).toMatch(/offers fetch/)
    expect(refuseAppBackgroundCall('tool', 'register')).toMatch(/session noun/)
    expect(refuseAppBackgroundUses({ calls: ['app.state', 'prompt.submit'] } as never)).toMatch(/\$\.prompt is a session noun/)
  })
})
