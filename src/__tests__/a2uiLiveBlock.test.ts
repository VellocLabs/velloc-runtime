import { describe, expect, it } from 'vitest'
import { Catalog } from '@a2ui/web_core/catalog'
import { createA2uiExpressCompiler, type A2uiBlockStream } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import catalogDocument from '../toolkit/builtin/a2ui/express/velloc-catalog.json'
import { createA2uiLiveBlocks, liveMentionKey, withLiveMention } from '../browser/webview/a2ui/a2uiLiveBlock'
import { splitA2uiText } from '../toolkit/builtin/a2ui/express/a2uiBlocks'

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

  it('feeds what was added, to the end of the line being written, and names the surface', () => {
    const { live, chunks } = recorder()
    live.feed('m:0:1', 'surface("form")\nroot', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n', false)
    expect(chunks).toEqual(['surface("form")\nroot', ' = Card(col)', '\n'])
    expect(live.snapshot()).toEqual({ blockKey: 'm:0:1', surfaceId: 'form', mentionKey: liveMentionKey('m:0:1') })
  })

  it('holds back only a fragment that could become the closing tag or a fence', () => {
    const { live, chunks } = recorder()
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n<', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n</a2', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n  ``', false)
    expect(chunks).toEqual(['surface("form")\nroot = Card(col)\n'])
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n<b', false)
    expect(chunks.at(-1)).toBe('<b')
  })

  it('holds back a closing tag begun at the end of a statement line', () => {
    const { live, chunks } = recorder()
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col) <', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col) </a2', false)
    expect(chunks.join('')).toBe('surface("form")\nroot = Card(col)')
  })

  it('finishes a block whose closing tag ends its last statement line', () => {
    const catalog = (Catalog as unknown as { fromJson(json: unknown): never }).fromJson(catalogDocument)
    const c = createA2uiExpressCompiler(catalog)
    const state = c.createState()
    const live = createA2uiLiveBlocks(() => c.stream(state))
    const reply = 'Here:\n<a2ui>\nsurface("form")\nroot = Text("x")</a2ui>\nDone.'
    for (let end = 1; end <= reply.length; end++) {
      for (const segment of splitA2uiText(reply.slice(0, end))) {
        if (segment.kind === 'block') live.feed('k:0', segment.body, segment.closed)
      }
    }
    const block = splitA2uiText(reply).find(segment => segment.kind === 'block') as { body: string }
    expect(live.finish('u:0', 'form', block.body)).toEqual({ kind: 'drawn' })
  })

  it('starts over when the text is rewritten, not when it shrinks', () => {
    const { live, opened } = recorder()
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n``', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n```\n', false)
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n', false)
    expect(opened()).toBe(1)
    live.feed('m:0:1', 'surface("other")\n', false)
    live.feed('m:0:2', 'surface("form")\n', false)
    expect(opened()).toBe(3)
  })

  it('takes its block key as the mention when its own block closes', () => {
    const { live } = recorder()
    live.feed('m:0:1', BODY.slice(0, 20), false)
    live.feed('m:0:9', BODY, true)
    expect(live.snapshot()?.mentionKey).toBe(liveMentionKey('m:0:1'))
    live.feed('m:0:1', BODY, true)
    expect(live.snapshot()?.mentionKey).toBe('m:0:1')
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
  const live = { blockKey: 'm:0:1', surfaceId: 'form', mentionKey: 'live:m:0:1' }

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

  it('completes every block of a reply, not only the last one to stream', () => {
    const { live } = realLive()
    const other = BODY.replace('surface("form")', 'surface("other")')
    live.feed('m:0:0', BODY, false)
    live.feed('m:0:0', BODY, true)
    live.feed('m:0:1', other, false)
    live.feed('m:0:1', other, true)
    expect(live.finish('stored:0', 'form', BODY)).toEqual({ kind: 'drawn' })
    expect(live.finish('stored:1', 'other', other)).toEqual({ kind: 'drawn' })
  })

  it('does not replay a block whose closing tag arrives split across chunks', () => {
    const { live } = realLive()
    live.feed('m:0:0', BODY, false)
    live.feed('m:0:0', `${BODY}</`, false)
    live.feed('m:0:0', BODY, true)
    expect(live.finish('stored:0', 'form', BODY.trimEnd())).toEqual({ kind: 'drawn' })
  })

  it('does not replay a block whose closing fence arrives split across chunks', () => {
    const { live } = realLive()
    live.feed('m:0:0', `${BODY}\`\``, false)
    live.feed('m:0:0', BODY, false)
    expect(live.finish('stored:0', 'form', BODY)).toEqual({ kind: 'drawn' })
  })

  it('completes a streamed block from its stored copy, so it is not compiled twice', () => {
    const { c, state, live } = realLive()
    live.feed('m:0:1', BODY.slice(0, 40), false)
    expect(live.finish('stored:0', 'form', BODY)).toEqual({ kind: 'drawn' })
    expect(live.finish('stored:0', 'form', BODY)).toEqual({ kind: 'not-streamed' })
    // The surface is complete: the same block again only updates it.
    expect(c.compile(BODY, state)).toMatchObject({ ok: true, messages: [{ updateComponents: { surfaceId: 'form' } }] })
  })

  it('reports a streamed block that fails, and whether it made the surface', () => {
    const { live } = realLive()
    live.feed('m:0:1', 'surface("form")\nroot = Card(col)\n', false)
    expect(live.finish('stored:0', 'form', 'surface("form")\nroot = Card(col)\ncol = Nope(1)\n')).toEqual({ kind: 'failed', created: true })
  })

  it('finds a block by its key when two blocks draw one surface alike', () => {
    const { live } = realLive()
    const reset = 'surface("form")\n$/count = 0\n'
    live.feed('m:0', BODY, false)
    live.feed('m:0', BODY, true)
    expect(live.finish('m:0', 'form', BODY)).toEqual({ kind: 'drawn' })
    live.feed('m2:0', reset, false)
    live.feed('m2:0', reset, true)
    live.feed('m3:0', reset, false)
    live.feed('m3:0', reset, true)
    expect(live.finish('m3:0', 'form', reset)).toEqual({ kind: 'drawn' })
    expect(live.finish('m2:0', 'form', reset)).toEqual({ kind: 'drawn' })
    expect(live.finish('m2:0', 'form', reset)).toEqual({ kind: 'not-streamed' })
  })

  it('leaves a block it did not stream to the feeder', () => {
    const { live } = realLive()
    expect(live.finish('stored:0', 'form', BODY)).toEqual({ kind: 'not-streamed' })
    live.feed('m:0:1', 'surface("form")\n', false)
    expect(live.finish('stored:1', 'other', 'surface("other")\n')).toEqual({ kind: 'not-streamed' })
    expect(live.finish('stored:0', 'form', 'surface("form")\nx = Text("changed")\n'.replace('surface("form")\n', 'surface("form") \n'))).toEqual({ kind: 'not-streamed' })
  })
})
