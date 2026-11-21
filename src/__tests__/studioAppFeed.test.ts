// A studio app surface's operation list (F-1): a later board extends it with
// data patches by path, or the data whole, so the engine applies only what is
// new; a new build or an overlong list starts it fresh.
import { describe, expect, it } from 'vitest'
import { GenerativeUISurfaceManager } from '@copilotkit/core/generative-ui'
import { studioUI } from '../browser/webview/a2ui/studio/studioCatalog'
import { nextStudioFeed, STUDIO_FEED_LIMIT, type StudioFeed } from '../browser/webview/a2ui/studio/StudioAppSurface'
import type { AppSurfaceState } from '../browser/runtimeProtocol/modApps'

const BODY = 'surface("s")\nroot = Text($/data/title)'
const rows = Array.from({ length: 300 }, (_, i) => ({ key: `m${i}`, mark: '' }))

const board = (extra: Partial<AppSurfaceState> = {}): AppSurfaceState => ({
  appId: 'a',
  catalog: 'studio',
  surface: { body: BODY, hash: 'h1', surfaceIds: ['s'] },
  data: { title: 'T', rows },
  dataSeq: 1,
  text: { hello: 'Hello' },
  refreshing: false,
  ...extra,
})

type Op = { updateDataModel?: { path: string; value?: unknown } }
const tail = (feed: StudioFeed | null, n: number) => (feed!.operations.slice(-n) as Op[]).map(op => op.updateDataModel)

describe('the studio app feed', () => {
  it('starts whole: the build, the text, the data', () => {
    const feed = nextStudioFeed(null, board(), 's')!
    expect(tail(feed, 2).map(u => u?.path)).toEqual(['/text', '/data'])
    expect(feed.dataSeq).toBe(1)
  })

  it('a patched board appends only the patched paths, the earlier list kept as its prefix', () => {
    const first = nextStudioFeed(null, board(), 's')!
    const next = nextStudioFeed(first, board({ dataSeq: 2, dataPatches: { from: 1, patches: [{ path: '/rows/37/mark', value: '✓' }] } }), 's')!
    expect(next.operations.slice(0, first.operations.length)).toEqual(first.operations)
    expect(next.operations.length).toBe(first.operations.length + 1)
    expect(tail(next, 1)).toEqual([{ surfaceId: 's', path: '/data/rows/37/mark', value: '✓' }])
    const removed = nextStudioFeed(next, board({ dataSeq: 3, dataPatches: { from: 2, patches: [{ path: '/rows/37/mark' }] } }), 's')!
    expect(tail(removed, 1)).toEqual([{ surfaceId: 's', path: '/data/rows/37/mark' }])
  })

  it('patches from another value, or none, append the data whole; an unchanged board keeps the same feed', () => {
    const first = nextStudioFeed(null, board(), 's')!
    const skipped = nextStudioFeed(first, board({ dataSeq: 3, dataPatches: { from: 2, patches: [{ path: '/title', value: 'U' }] } }), 's')!
    expect(tail(skipped, 1)[0]?.path).toBe('/data')
    expect(skipped.operations.length).toBe(first.operations.length + 1)
    expect(nextStudioFeed(skipped, board({ dataSeq: 3 }), 's')).toBe(skipped)
  })

  it('changed text appends /text; a new build or a list past the limit starts fresh', () => {
    const first = nextStudioFeed(null, board(), 's')!
    const texted = nextStudioFeed(first, board({ text: { hello: 'Hi' } }), 's')!
    expect(tail(texted, 1)[0]).toEqual({ surfaceId: 's', path: '/text', value: { hello: 'Hi' } })
    const rebuilt = nextStudioFeed(texted, board({ surface: { body: BODY, hash: 'h2', surfaceIds: ['s'] } }), 's')!
    expect(rebuilt.operations.length).toBe(first.operations.length)
    let feed = first
    for (let seq = 2; feed.operations.length >= first.operations.length && seq < STUDIO_FEED_LIMIT + 10; seq++) {
      const next = nextStudioFeed(feed, board({ dataSeq: seq, dataPatches: { from: seq - 1, patches: [{ path: '/title', value: String(seq) }] } }), 's')!
      if (next.operations.length < feed.operations.length) { feed = next; break }
      feed = next
    }
    expect(feed.operations.length).toBe(first.operations.length)
  })

  it('the engine keeps the surface it drew when the list grows, and rebuilds it on a fresh list', () => {
    const manager = new GenerativeUISurfaceManager(studioUI as never)
    manager.setActiveThread('t')
    const ingest = (feed: StudioFeed) =>
      manager.ingest('t', undefined, { surfaceId: 's', target: 'studio:s', catalogId: studioUI.id, operations: feed.operations, status: 'ready', rejected: [] } as never)
    const first = nextStudioFeed(null, board(), 's')!
    ingest(first)
    const drawn = manager.getSurface('t', 's')
    expect(drawn).toBeDefined()
    ingest(nextStudioFeed(first, board({ dataSeq: 2, dataPatches: { from: 1, patches: [{ path: '/title', value: 'U' }] } }), 's')!)
    expect(manager.getSurface('t', 's')).toBe(drawn)
    ingest(nextStudioFeed(first, board({ surface: { body: BODY, hash: 'h2', surfaceIds: ['s'] } }), 's')!)
    expect(manager.getSurface('t', 's')).not.toBe(drawn)
  })

  it('no build draws nothing', () => {
    expect(nextStudioFeed(null, board({ surface: null }), 's')).toBeNull()
  })
})
