import { afterEach, describe, expect, it, vi } from 'vitest'

import { MODS_APP_DELTA_EVENT, MODS_APP_RESYNC_EVENT, MODS_APP_STATE_EVENT, type AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import { modsAppTopicProvider, registerModsAppTopic } from '../browser/runtimeHub/modsAppTopic'
import { holdAppSurface } from '../browser/webview/apps/appSurfaceView'
import { liveAppState, resetAppStateBusForTests, type AppStateEvent } from '../mods/app/appStateBus'
import { APP_PATCH_BATCH_MAX, appStateText } from '../mods/app/appStateDiff'
import { AppStateRelay } from '../mods/app/appStateRelay'
import { appSurfaceBoard, setAppSurfaceState } from '../mods/app/appSurfaceRegistry'
import { makeWorkerAppState } from '../mods/app/workerAppNoun'

/**
 * An app's script holds its state (F-40): the worker answers reads and
 * applies changes itself, the runtime passes the patches on and keeps no
 * value, and a reader that needs the state whole asks the script for it.
 */

type Noun = {
  state: {
    get(): Promise<Record<string, unknown>>
    update(fn: (draft: Record<string, unknown>) => unknown): Promise<unknown>
    set(value: unknown): Promise<unknown>
  }
  publish(patches: unknown): Promise<{ version: number }>
}

afterEach(() => {
  resetAppStateBusForTests()
  setAppSurfaceState('s1', null)
})

describe('the state in the worker', () => {
  function worker(initial: unknown = { n: 1 }, version = 0) {
    const calls: Array<{ method: string; args: unknown[] }> = []
    let refuse: Error | undefined
    const holder = makeWorkerAppState()
    const call = async (method: string, args: unknown[]): Promise<unknown> => {
      calls.push({ method, args })
      if (method === 'state') return { value: initial, version }
      if (refuse) throw refuse
      return { version: args[1] }
    }
    const sent = () => calls.filter(c => c.method === 'publish').map(c => c.args)
    const asked = () => calls.filter(c => c.method === 'state').length
    return { holder, noun: () => holder.noun(call) as Noun, sent, asked, refuseWith: (error: Error | undefined) => void (refuse = error) }
  }

  it('is read from the runtime once, whichever hook asks, and answered here from then on', async () => {
    const rig = worker()
    expect(await rig.holder.text(), 'nothing was read yet').toEqual({ unloaded: true })
    const first = await rig.noun().state.get()
    first.n = 99
    expect(await rig.noun().state.get(), 'a copy: an edit of one answer never reaches the next').toEqual({ n: 1 })
    await rig.noun().state.update(draft => {
      draft.n = 2
    })
    expect(await rig.noun().state.get(), 'another hook sees the change').toEqual({ n: 2 })
    expect(rig.asked()).toBe(1)
  })

  it('numbers each batch from the version it read, and sends nothing for no change', async () => {
    const rig = worker({ n: 1 }, 4)
    const noun = rig.noun()
    await noun.state.update(draft => {
      draft.n = 2
    })
    await noun.state.set({ n: 2 })
    expect(await noun.publish([{ path: '/list', value: ['a'] }])).toEqual({ version: 6 })
    expect(rig.sent()).toEqual([
      [[{ path: '/n', value: 2 }], 5],
      [[{ path: '/list', value: ['a'] }], 6],
    ])
    expect(await rig.holder.text()).toEqual({ text: appStateText({ n: 2, list: ['a'] }), seq: 6 })
  })

  it('sends a raw batch as the diff, so an append or a removal reaches every reader alike', async () => {
    const rig = worker({ list: ['a'] })
    await rig.noun().publish([{ path: '/list/-', value: 'b' }])
    await rig.noun().publish([{ path: '/list/0' }])
    expect(rig.sent().map(args => args[0])).toEqual([[{ path: '/list', value: ['a', 'b'] }], [{ path: '/list', value: ['b'] }]])
  })

  it('sends a change wider than one batch as the whole state', async () => {
    const rig = worker({})
    const rows = Object.fromEntries(Array.from({ length: APP_PATCH_BATCH_MAX + 1 }, (_, i) => [`r${i}`, i]))
    await rig.noun().state.set(rows)
    expect(rig.sent()).toEqual([[[{ path: '', value: rows }], 1]])
  })

  it('refuses a malformed batch and one past the size cap before anything changes', async () => {
    const rig = worker()
    await expect(rig.noun().publish([{ path: 'n', value: 2 }])).rejects.toThrow(/not a JSON pointer/)
    await expect(rig.noun().state.set({ big: 'x'.repeat(1024 * 1024) })).rejects.toThrow(/at most/)
    expect(rig.sent()).toEqual([])
    expect(await rig.noun().state.get()).toEqual({ n: 1 })
  })

  it('keeps a change the runtime did not take, and numbers the next one after it', async () => {
    const rig = worker()
    rig.refuseWith(new Error('stopped'))
    await expect(
      rig.noun().state.update(draft => {
        draft.n = 2
      }),
    ).rejects.toThrow('stopped')
    rig.refuseWith(undefined)
    await rig.noun().state.update(draft => {
      draft.n = 3
    })
    expect(rig.sent().at(-1)).toEqual([[{ path: '/n', value: 3 }], 2])
    expect(await rig.holder.text()).toEqual({ text: appStateText({ n: 3 }), seq: 2 })
  })

  it('answers with its text while a change waits on the runtime', async () => {
    const holder = makeWorkerAppState()
    let release!: () => void
    const noun = holder.noun(async method => {
      if (method === 'state') return { value: { n: 1 }, version: 0 }
      await new Promise<void>(resolve => (release = resolve))
      return undefined
    }) as Noun
    const change = noun.state.set({ n: 2 })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await holder.text()).toEqual({ text: appStateText({ n: 2 }), seq: 1 })
    release()
    await change
  })
})

describe('the relay', () => {
  function relay(options: { file?: string; maxBytes?: number; answer?: () => unknown } = {}) {
    const events: AppStateEvent[] = []
    const written: string[] = []
    const reports: string[] = []
    let answer = options.answer ?? (() => ({ unloaded: true }))
    const made = new AppStateRelay({
      appId: 'pay-board',
      file: 'C:/app/data/state.json',
      fs: {
        readFile: () => (options.file === undefined ? Promise.reject(new Error('none')) : Promise.resolve(options.file)),
        writeFile: async (_path, data) => void written.push(data),
      },
      ensureDir: async () => undefined,
      report: line => void reports.push(line),
      ask: async () => answer(),
      publish: event => events.push(event),
      persistDelayMs: 5,
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    })
    return { relay: made, events, written, reports, answers: (fn: () => unknown) => void (answer = fn) }
  }

  it('gives a starting script the file, and is from then on where the state is read', async () => {
    const rig = relay({ file: '{"n":1}' })
    expect(liveAppState('pay-board')).toBeUndefined()
    expect(await rig.relay.load()).toEqual({ value: { n: 1 }, version: 0 })
    expect(liveAppState('pay-board')).toBe(rig.relay)
    expect(rig.events).toEqual([])
    expect(await relay({ file: 'not json' }).relay.load()).toEqual({ value: {}, version: 0 })
  })

  it('passes a batch on as its patches, with no value', async () => {
    const rig = relay()
    await rig.relay.load()
    const patches = [{ path: '/n', value: 2 }]
    expect(rig.relay.relay(patches, 1)).toEqual({ version: 1 })
    expect(rig.events).toEqual([{ appId: 'pay-board', owner: rig.relay.owner, version: 1, patches }])
    expect(rig.events[0]).not.toHaveProperty('value')
    expect(relay().relay.owner).not.toBe(rig.relay.owner)
  })

  it('passes a batch that skipped one on without patches, and so a script that started again', async () => {
    const rig = relay()
    await rig.relay.load()
    rig.relay.relay([{ path: '/n', value: 2 }], 1)
    rig.relay.relay([{ path: '/n', value: 4 }], 3)
    expect(rig.events.at(-1)).toEqual({ appId: 'pay-board', owner: rig.relay.owner, version: 3 })
    expect(await rig.relay.load(), 'the script started again').toEqual({ value: {}, version: 4 })
    expect(rig.events.at(-1)).toEqual({ appId: 'pay-board', owner: rig.relay.owner, version: 4 })
  })

  it('refuses a malformed batch, one that does not come after the last, and one past the size cap', async () => {
    const rig = relay({ maxBytes: 64 })
    await rig.relay.load()
    rig.relay.relay([{ path: '/n', value: 1 }], 1)
    expect(() => rig.relay.relay([{ path: 'n', value: 1 }], 2)).toThrow(/not a JSON pointer/)
    expect(() => rig.relay.relay([{ path: '/n', value: 1 }], 1)).toThrow(/does not come after batch 1/)
    expect(() => rig.relay.relay([{ path: '/n', value: 1 }], '2')).toThrow(/does not come after/)
    expect(() => rig.relay.relay([{ path: '/n', value: 'x'.repeat(64) }], 2)).toThrow(/at most 64/)
    expect(rig.events).toHaveLength(1)
    expect(rig.relay.version()).toBe(1)
  })

  it('writes the text the script answers with a short while after a batch, once for several', async () => {
    const rig = relay({ answer: () => ({ text: '{"n":3}', seq: 2 }) })
    await rig.relay.load()
    rig.relay.relay([{ path: '/n', value: 2 }], 1)
    rig.relay.relay([{ path: '/n', value: 3 }], 2)
    expect(rig.written).toEqual([])
    await vi.waitFor(() => expect(rig.written).toEqual(['{"n":3}']))
    rig.relay.relay([{ path: '/n', value: 4 }], 3)
    rig.answers(() => ({ text: '{"n":4}', seq: 3 }))
    await rig.relay.flush()
    expect(rig.written).toEqual(['{"n":3}', '{"n":4}'])
  })

  it('neither writes nor gives out a text past the size cap, and reports a write that failed', async () => {
    const rig = relay({ maxBytes: 26, answer: () => ({ text: '{"long":"0123456789abcdef0123"}', seq: 1 }) })
    await rig.relay.load()
    rig.relay.relay([{ path: '/n', value: 1 }], 1)
    await rig.relay.flush()
    expect(rig.written).toEqual([])
    expect(rig.reports).toEqual([expect.stringMatching(/could not be written.*at most 26/)])
    await expect(rig.relay.read()).rejects.toThrow(/at most 26/)
  })

  it('reads the state whole from the script, and from the file when no script answers', async () => {
    const rig = relay({ file: '{"n":1}', answer: () => ({ text: '{"n":7}', seq: 3 }) })
    await rig.relay.load()
    expect(await rig.relay.read()).toEqual({ version: 3, value: { n: 7 } })
    rig.answers(() => ({ unloaded: true }))
    expect(await rig.relay.read()).toEqual({ version: 0, value: { n: 1 } })
    rig.answers(() => {
      throw new Error('no script is running')
    })
    expect(await rig.relay.read()).toEqual({ version: 0, value: { n: 1 } })
  })

  it('writes what is pending when it is disposed, then tells its readers the script is gone', async () => {
    const rig = relay({ answer: () => ({ text: '{"n":2}', seq: 1 }) })
    const heard: AppStateEvent[] = []
    await rig.relay.load()
    rig.relay.relay([{ path: '/n', value: 2 }], 1)
    const { onAppState } = await import('../mods/app/appStateBus')
    onAppState('pay-board', event => heard.push(event))
    await rig.relay.dispose()
    expect(rig.written).toEqual(['{"n":2}'])
    expect(liveAppState('pay-board')).toBeUndefined()
    expect(heard).toEqual([{ appId: 'pay-board', owner: rig.relay.owner, version: 1, gone: true }])
    expect(() => rig.relay.relay([{ path: '/n', value: 3 }], 2)).toThrow(/stopped/)
  })
})

describe('a board whose data the script holds', () => {
  const board = (extra: Partial<AppSurfaceState> = {}): AppSurfaceState => ({
    appId: 'pay-board',
    surface: { body: 'surface("a")', hash: 'h1', surfaceIds: ['a'] },
    dataAt: 10,
    dataSeq: 1,
    refreshing: false,
    ...extra,
  })

  it('is served whole with the data read in, and with a data error when the read fails', async () => {
    setAppSurfaceState('s1', board(), undefined, async () => ({ data: { count: 9 }, dataSeq: 2, dataAt: 20 }))
    expect(await appSurfaceBoard('s1')).toEqual(board({ data: { count: 9 }, dataSeq: 2, dataAt: 20 }))
    const pages: unknown[] = []
    for await (const page of modsAppTopicProvider().snapshot('mods/app/s1' as never, {} as never)) pages.push(page)
    expect(pages).toEqual([{ type: MODS_APP_STATE_EVENT, payload: board({ data: { count: 9 }, dataSeq: 2, dataAt: 20 }) }])
    setAppSurfaceState('s1', board(), undefined, async () => {
      throw new Error('its script stopped')
    })
    expect((await appSurfaceBoard('s1'))?.errors).toEqual([{ kind: 'data', message: expect.stringContaining('its script stopped') }])
    // A board that carries its own data is served as it is.
    setAppSurfaceState('s1', board({ data: { count: 3 } }))
    expect(await appSurfaceBoard('s1')).toEqual(board({ data: { count: 3 } }))
    expect(await appSurfaceBoard('nobody')).toBeNull()
  })

  it('is never published whole: a change that is no delta tells the pages to ask again', () => {
    const sent: Array<{ payload: unknown; type: string }> = []
    const stop = registerModsAppTopic({
      registerProvider: () => () => undefined,
      publish: (_topic: string, payload: unknown, options: { type: string }) => void sent.push({ payload, type: options.type }),
    } as never)
    const load = async () => ({ data: {}, dataSeq: 1, dataAt: 10 })
    setAppSurfaceState('s1', board(), undefined, load)
    const delta = { data: { from: 1, dataSeq: 2, dataAt: 20, patches: [{ path: '/count', value: 2 }] } }
    setAppSurfaceState('s1', board({ dataSeq: 2, dataAt: 20 }), delta, load)
    setAppSurfaceState('s1', board({ dataSeq: 3, dataAt: 30 }), undefined, load)
    setAppSurfaceState('s1', board({ dataSeq: 4, data: { count: 3 } }))
    stop()
    expect(sent).toEqual([
      { payload: null, type: MODS_APP_RESYNC_EVENT },
      { payload: delta, type: MODS_APP_DELTA_EVENT },
      { payload: null, type: MODS_APP_RESYNC_EVENT },
      { payload: board({ dataSeq: 4, data: { count: 3 } }), type: MODS_APP_STATE_EVENT },
    ])
  })

  it('a page told to ask again subscribes again and keeps the board it shows until the new one comes', () => {
    let listener: ((event: { type: string; payload: unknown }) => void) | undefined
    const log: string[] = []
    const connection = {
      subscribe: (_topic: string, fn: typeof listener) => {
        listener = fn
        log.push('subscribe')
        return () => void log.push('unsubscribe')
      },
    } as never
    const seen: Array<AppSurfaceState | null> = []
    const release = holdAppSurface(connection, 's1', state => seen.push(state))
    listener!({ type: MODS_APP_STATE_EVENT, payload: board({ data: { count: 1 } }) })
    listener!({ type: MODS_APP_RESYNC_EVENT, payload: null })
    expect(log).toEqual(['subscribe', 'unsubscribe', 'subscribe'])
    expect(seen).toHaveLength(1)
    listener!({ type: MODS_APP_STATE_EVENT, payload: board({ data: { count: 2 }, dataSeq: 2 }) })
    expect(seen.at(-1)).toMatchObject({ data: { count: 2 }, dataSeq: 2 })
    release()
  })
})
