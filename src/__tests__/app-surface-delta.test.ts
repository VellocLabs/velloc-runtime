import { describe, expect, it, vi } from 'vitest'

import { isAppSurfaceDelta, MODS_APP_DELTA_EVENT, MODS_APP_STATE_EVENT, type AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import { modsAppTopicProvider, registerModsAppTopic } from '../browser/runtimeHub/modsAppTopic'
import { holdAppSurface } from '../browser/webview/apps/appSurfaceView'
import { appSurfaceDelta, applyAppSurfaceDelta } from '../mods/app/appSurfaceDelta'

/**
 * A page that holds an app's board is sent what changed (F-40): the data as
 * patches, any other field whole, and the board itself only when a change
 * cannot be applied to the board held.
 */

const board = (extra: Partial<AppSurfaceState> = {}): AppSurfaceState => ({
  appId: 'pay-board',
  surface: { body: 'surface("a")', hash: 'h1', surfaceIds: ['a'] },
  data: { count: 1, rows: [{ id: 1 }, { id: 2 }] },
  dataAt: 10,
  dataSeq: 1,
  refreshing: false,
  ...extra,
})

describe('appSurfaceDelta', () => {
  it('is null for the same board, whatever patches led to it', () => {
    expect(appSurfaceDelta(board(), board({ dataPatches: { from: 0, patches: [] } }))).toBeNull()
  })

  it('carries a changed field whole and names a removed one', () => {
    const delta = appSurfaceDelta(board({ errors: [{ kind: 'data', message: 'x' }] }), board({ refreshing: true }))
    expect(delta).toEqual({ set: { refreshing: true }, unset: ['errors'] })
    expect(isAppSurfaceDelta(delta)).toBe(true)
  })

  it('carries a data batch as its patches, never the value', () => {
    const patches = [{ path: '/count', value: 2 }]
    const after = board({ data: { count: 2, rows: [{ id: 1 }, { id: 2 }] }, dataSeq: 2, dataAt: 20, dataPatches: { from: 1, patches } })
    expect(appSurfaceDelta(board(), after)).toEqual({ data: { from: 1, dataSeq: 2, dataAt: 20, patches } })
  })

  it('gives no delta when the data was read whole, went away, or the app changed', () => {
    expect(appSurfaceDelta(board(), board({ data: { count: 9 }, dataSeq: 2 }))).toBeUndefined()
    expect(appSurfaceDelta(board(), board({ dataSeq: 3, dataPatches: { from: 2, patches: [] } }))).toBeUndefined()
    const { dataAt: _at, ...noAt } = board({ dataSeq: 2, dataPatches: { from: 1, patches: [] } })
    expect(appSurfaceDelta(board(), noAt), 'a data change with no time').toBeUndefined()
    const { data: _d, dataSeq: _s, dataAt: _a, ...bare } = board()
    expect(appSurfaceDelta(board(), bare)).toBeUndefined()
    expect(appSurfaceDelta(board(), board({ appId: 'other' }))).toBeUndefined()
  })
})

describe('applyAppSurfaceDelta', () => {
  it('gives the board after, and leaves the board before as it was', () => {
    const before = board({ dataPatches: { from: 0, patches: [] } })
    const patches = [{ path: '/rows/1/id', value: 7 }]
    const next = applyAppSurfaceDelta(before, { set: { refreshing: true }, data: { from: 1, dataSeq: 2, dataAt: 20, patches } })!
    expect(next).toMatchObject({ refreshing: true, dataSeq: 2, dataAt: 20, data: { count: 1, rows: [{ id: 1 }, { id: 7 }] }, dataPatches: { from: 1, patches } })
    expect(before.data).toEqual({ count: 1, rows: [{ id: 1 }, { id: 2 }] })
    // Rows the patch did not reach are the same objects, so a page compares them by identity.
    expect((next.data as { rows: unknown[] }).rows[0]).toBe((before.data as { rows: unknown[] }).rows[0])
  })

  it('a change with no data keeps the data and drops the patches of the board before', () => {
    const before = board({ dataPatches: { from: 0, patches: [{ path: '/count', value: 1 }] } })
    const next = applyAppSurfaceDelta(before, { set: { refreshing: true } })!
    expect(next.data).toBe(before.data)
    expect(next.dataPatches).toBeUndefined()
  })

  it('refuses data that does not follow the board held, and a patch that cannot be applied', () => {
    expect(applyAppSurfaceDelta(board(), { data: { from: 4, dataSeq: 5, dataAt: 1, patches: [] } })).toBeUndefined()
    expect(applyAppSurfaceDelta(board(), { data: { from: 1, dataSeq: 2, dataAt: 1, patches: [{ path: '/__proto__/x', value: 1 }] } })).toBeUndefined()
  })
})

describe('isAppSurfaceDelta', () => {
  it('refuses a field that is not a plain field of the board, and malformed data', () => {
    expect(isAppSurfaceDelta({ set: { appId: 'x' } })).toBe(false)
    expect(isAppSurfaceDelta({ unset: ['data'] })).toBe(false)
    expect(isAppSurfaceDelta({ data: { from: 1, dataSeq: 2, dataAt: 1, patches: [{ value: 1 }] } })).toBe(false)
    expect(isAppSurfaceDelta({})).toBe(true)
  })
})

describe('the mods/app topic', () => {
  it('publishes a delta when one is given, the board otherwise; the snapshot is the board', async () => {
    const sent: Array<{ topic: string; payload: unknown; type: string }> = []
    let listener: ((sessionId: string, state: AppSurfaceState | null, delta?: unknown) => void) | undefined
    registerModsAppTopic(
      {
        registerProvider: () => () => undefined,
        publish: (topic: string, payload: unknown, options: { type: string }) => void sent.push({ topic, payload, type: options.type }),
      } as never,
      ((fn: unknown) => {
        listener = fn as typeof listener
        return () => undefined
      }) as never,
    )
    listener!('s1', board())
    listener!('s1', board({ refreshing: true }), { set: { refreshing: true } })
    expect(sent).toEqual([
      { topic: 'mods/app/s1', payload: board(), type: MODS_APP_STATE_EVENT },
      { topic: 'mods/app/s1', payload: { set: { refreshing: true } }, type: MODS_APP_DELTA_EVENT },
    ])
    const pages: unknown[] = []
    for await (const page of modsAppTopicProvider(() => board()).snapshot('mods/app/s1' as never, {} as never)) pages.push(page)
    expect(pages).toEqual([{ type: MODS_APP_STATE_EVENT, payload: board() }])
  })
})

describe('the board store of a page', () => {
  function connection() {
    let listener: ((event: { type: string; payload: unknown }) => void) | undefined
    const log: string[] = []
    const subscribe = vi.fn((_topic: string, fn: typeof listener) => {
      listener = fn
      log.push('subscribe')
      return () => void log.push('unsubscribe')
    })
    return { connection: { subscribe } as never, log, deliver: (type: string, payload: unknown) => listener?.({ type, payload }) }
  }

  it('applies a delta to the board it holds', () => {
    const rig = connection()
    const seen: Array<AppSurfaceState | null> = []
    holdAppSurface(rig.connection, 's1', state => seen.push(state))
    rig.deliver(MODS_APP_STATE_EVENT, board())
    rig.deliver(MODS_APP_DELTA_EVENT, { data: { from: 1, dataSeq: 2, dataAt: 20, patches: [{ path: '/count', value: 2 }] } })
    expect(seen.at(-1)).toMatchObject({ dataSeq: 2, data: { count: 2 }, dataPatches: { from: 1 } })
    expect(rig.log).toEqual(['subscribe'])
  })

  it('subscribes again for the board when a delta does not follow it, and tells no listener of the gap', () => {
    const rig = connection()
    const seen: Array<AppSurfaceState | null> = []
    holdAppSurface(rig.connection, 's1', state => seen.push(state))
    rig.deliver(MODS_APP_STATE_EVENT, board())
    rig.deliver(MODS_APP_DELTA_EVENT, { data: { from: 5, dataSeq: 6, dataAt: 20, patches: [] } })
    expect(rig.log).toEqual(['subscribe', 'unsubscribe', 'subscribe'])
    expect(seen).toHaveLength(1)
    rig.deliver(MODS_APP_STATE_EVENT, board({ dataSeq: 6, data: { count: 6 } }))
    expect(seen.at(-1)).toMatchObject({ dataSeq: 6, data: { count: 6 } })
  })

  it('a delta before any board is one the snapshot holds: it is dropped, with no new subscription', () => {
    const rig = connection()
    const seen: Array<AppSurfaceState | null> = []
    holdAppSurface(rig.connection, 's1', state => seen.push(state))
    rig.deliver(MODS_APP_DELTA_EVENT, { set: { refreshing: true } })
    expect(rig.log).toEqual(['subscribe'])
    expect(seen).toHaveLength(0)
  })

  it('subscribes again once for a gap: deltas still on their way before the new board are dropped', () => {
    const rig = connection()
    const seen: Array<AppSurfaceState | null> = []
    holdAppSurface(rig.connection, 's1', state => seen.push(state))
    rig.deliver(MODS_APP_STATE_EVENT, board())
    rig.deliver(MODS_APP_DELTA_EVENT, { data: { from: 5, dataSeq: 6, dataAt: 20, patches: [] } })
    rig.deliver(MODS_APP_DELTA_EVENT, { data: { from: 6, dataSeq: 7, dataAt: 30, patches: [] } })
    expect(rig.log).toEqual(['subscribe', 'unsubscribe', 'subscribe'])
    rig.deliver(MODS_APP_STATE_EVENT, board({ dataSeq: 7, data: { count: 7 } }))
    rig.deliver(MODS_APP_DELTA_EVENT, { data: { from: 7, dataSeq: 8, dataAt: 40, patches: [{ path: '/count', value: 8 }] } })
    expect(seen.at(-1)).toMatchObject({ dataSeq: 8, data: { count: 8 } })
    expect(rig.log).toHaveLength(3)
  })

  it('a delta that would leave a malformed board is a gap', () => {
    const rig = connection()
    const seen: Array<AppSurfaceState | null> = []
    holdAppSurface(rig.connection, 's1', state => seen.push(state))
    rig.deliver(MODS_APP_STATE_EVENT, board())
    rig.deliver(MODS_APP_DELTA_EVENT, { set: { errors: 'not a list' } })
    expect(rig.log).toEqual(['subscribe', 'unsubscribe', 'subscribe'])
    expect(seen).toHaveLength(1)
  })
})
