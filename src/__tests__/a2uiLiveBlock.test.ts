import { describe, expect, it } from 'vitest'
import { Catalog } from '@a2ui/web_core/catalog'
import { a2uiBlockKey } from '../toolkit/builtin/a2ui/express/a2uiBlocks'
import { createA2uiExpressCompiler, type A2uiBlockStream } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import catalogDocument from '../toolkit/builtin/a2ui/express/velloc-catalog.json'
import { createA2uiLiveBlocks, liveMentionKey, withLiveMention } from '../browser/webview/a2ui/a2uiLiveBlock'

const BODY = 'surface("form")\nroot = Card(col)\ncol = Column([hi])\nhi = Text("hello")\n'

function compiler() {
  const catalog = (Catalog as unknown as { fromJson(json: unknown): never }).fromJson(catalogDocument)
  return createA2uiExpressCompiler(catalog)
}

describe('Express block stream', () => {
  it('yields each statement as it is read', () => {
    const c = compiler()
    const stream = c.stream(c.createState())
    const first = stream.feed('surface("form")\nroot = Card(col)\n')
    expect(first.ok && first.messages[0]).toMatchObject({ createSurface: { surfaceId: 'form' } })
    const rest = stream.feed('col = Column([hi])\nhi = Text("hello")\n')
    expect(rest.ok && rest.messages.length).toBeGreaterThan(0)
  })

  it('stops after a statement that cannot be read', () => {
    const c = compiler()
    const stream = c.stream(c.createState())
    stream.feed('surface("form")\nroot = Card(col)\n')
    const bad = stream.feed('col = Nope(1)\n')
    expect(bad.ok).toBe(false)
    expect(stream.feed('x = Text("a")\n')).toMatchObject({ ok: false, messages: [] })
  })
})

describe('live block reader', () => {
  function recorder() {
    const chunks: string[] = []
    let opened = 0
    const live = createA2uiLiveBlocks((): A2uiBlockStream => {
      opened += 1
      return {
        feed: chunk => {
          chunks.push(chunk)
          return { ok: true, messages: chunk.includes('surface(') ? [{ createSurface: { surfaceId: 'form' } } as never] : [] }
        },
        close: () => ({ ok: true, messages: [] }),
      }
    })
    return { live, chunks, opened: () => opened }
  }

  it('feeds only what was added and names the surface', () => {
    const { live, chunks } = recorder()
    live.feed('m:0:1', 'surface("form")\nroot', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)', false)
    expect(chunks).toEqual(['surface("form")\nroot', ' = Card(col)'])
    expect(live.snapshot()).toEqual({ segmentKey: 'm:0:1', surfaceId: 'form', mentionKey: liveMentionKey('m:0:1') })
  })

  it('starts over when the text is not a continuation', () => {
    const { live, opened } = recorder()
    live.feed('m:0:1', 'surface("form")\nroot', false)
    live.feed('m:0:1', 'surface("other")', false)
    live.feed('m:0:2', 'surface("form")', false)
    expect(opened()).toBe(3)
  })

  it('takes the finished block key when its own block closes', () => {
    const { live } = recorder()
    live.feed('m:0:1', BODY.slice(0, 20), false)
    live.feed('m:0:9', BODY, true)
    expect(live.snapshot()?.mentionKey).toBe(liveMentionKey('m:0:1'))
    live.feed('m:0:1', BODY, true)
    expect(live.snapshot()?.mentionKey).toBe(a2uiBlockKey('form', BODY))
  })

  it('ignores a block that was finished when first drawn', () => {
    const { live, opened } = recorder()
    live.feed('m:0:1', BODY, true)
    expect(live.snapshot()).toBeNull()
    expect(opened()).toBe(0)
  })

  it('tells listeners when the surface or key changes, not on every chunk', () => {
    const { live } = recorder()
    let calls = 0
    live.subscribe(() => { calls += 1 })
    live.feed('m:0:1', 'surface("form")\n', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n', false)
    expect(calls).toBe(1)
  })
})

describe('withLiveMention', () => {
  const derived = (entries: [string, string][]) => ({
    latestMentionBySurface: new Map(entries),
    deletedSurfaceIds: new Set<string>(['form']),
  })
  const live = { segmentKey: 'm:0:1', surfaceId: 'form', mentionKey: 'live:m:0:1' }

  it('puts the streaming surface on top while the transcript has not caught up', () => {
    const merged = withLiveMention(derived([['a', 'k1']]), live, undefined)
    expect([...merged.latestMentionBySurface]).toEqual([['a', 'k1'], ['form', 'live:m:0:1']])
    expect(merged.deletedSurfaceIds.has('form')).toBe(false)
  })

  it('updates an existing surface in place', () => {
    const merged = withLiveMention(derived([['form', 'k0'], ['b', 'k2']]), live, 'k0')
    expect([...merged.latestMentionBySurface.keys()]).toEqual(['form', 'b'])
    expect(merged.latestMentionBySurface.get('form')).toBe('live:m:0:1')
  })

  it('steps aside once the transcript holds a newer mention', () => {
    const input = derived([['form', 'k9']])
    expect(withLiveMention(input, live, 'k0')).toBe(input)
  })

  it('does nothing without a known surface', () => {
    const input = derived([])
    expect(withLiveMention(input, { ...live, surfaceId: null }, undefined)).toBe(input)
    expect(withLiveMention(input, null, undefined)).toBe(input)
  })
})

describe('live block finish', () => {
  function realLive() {
    const c = compiler()
    const state = c.createState()
    return { c, state, live: createA2uiLiveBlocks(() => c.stream(state)) }
  }

  it('completes a streamed block from its stored copy, so it is not compiled twice', () => {
    const { c, state, live } = realLive()
    live.feed('m:0:1', BODY.slice(0, 40), false)
    expect(live.finish('form', BODY)).toEqual({ kind: 'drawn' })
    expect(live.finish('form', BODY)).toEqual({ kind: 'not-streamed' })
    // Compiling the same create block again is what the finish spares.
    expect(c.compile(BODY, state)).toMatchObject({ ok: false })
  })

  it('reports a streamed block that fails, and whether it made the surface', () => {
    const { live } = realLive()
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n', false)
    expect(live.finish('form', 'surface("form")\nroot = Card(col)\ncol = Nope(1)\n')).toEqual({ kind: 'failed', created: true })
  })

  it('leaves a block it did not stream to the feeder', () => {
    const { live } = realLive()
    expect(live.finish('form', BODY)).toEqual({ kind: 'not-streamed' })
    live.feed('m:0:1', 'surface("form")\n', false)
    expect(live.finish('other', 'surface("other")\n')).toEqual({ kind: 'not-streamed' })
    expect(live.finish('form', 'surface("form")\nx = Text("changed")\n'.replace('surface("form")\n', 'surface("form") \n'))).toEqual({ kind: 'not-streamed' })
  })
})
