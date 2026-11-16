// @vitest-environment happy-dom
/**
 * The page's half of `$.ui.place` (F-25): each row stands after the message that was
 * last when the page first saw it, in placing order; a row seen before any message
 * stands before the first; anchors live per session across remounts.
 */
import { describe, expect, it } from 'vitest'
import { ModPlacedAnchors, placedAnchorsFor } from '../components/assistant-ui/mod-placed'

const row = (id: string) => ({ plugin: 'p', id, requestId: `placed:p:${id}` })

describe('placed row anchors', () => {
  it('pins a new row after the last message once, and keeps it there as the transcript grows', () => {
    const anchors = new ModPlacedAnchors()
    let heard = 0
    anchors.subscribe(() => void (heard += 1))
    expect(anchors.bind([row('a')], 'm1')).toBe(true)
    expect(anchors.bind([row('a'), row('b')], 'm2')).toBe(true)
    expect(anchors.bind([row('a'), row('b')], 'm3')).toBe(false)
    expect(heard).toBe(2)
    const rows = [row('a'), row('b')]
    expect(anchors.after(rows, 'm1')).toEqual([row('a')])
    expect(anchors.after(rows, 'm2')).toEqual([row('b')])
    expect(anchors.after(rows, 'm3')).toEqual([])
  })

  it('a row seen before any message stands before the first; rows keep placing order', () => {
    const anchors = new ModPlacedAnchors()
    anchors.bind([row('x'), row('y')], null)
    expect(anchors.after([row('y'), row('x')], null).map(r => r.id)).toEqual(['y', 'x'])
  })

  it('a row whose message left the thread moves after the last; a row gone and placed again goes at the end', () => {
    const anchors = new ModPlacedAnchors()
    anchors.bind([row('a')], 'm1', new Set(['m1']))
    anchors.bind([row('a')], 'm3', new Set(['m1', 'm2', 'm3']))
    expect(anchors.after([row('a')], 'm1')).toEqual([row('a')])
    expect(anchors.bind([row('a')], 'm3', new Set())).toBe(false)
    expect(anchors.bind([row('a')], 'm3', new Set(['m2', 'm3']))).toBe(true)
    expect(anchors.after([row('a')], 'm3')).toEqual([row('a')])
    expect(anchors.bind([], 'm4', new Set(['m2', 'm3', 'm4']))).toBe(true)
    anchors.bind([row('a')], 'm9', new Set(['m9']))
    expect(anchors.after([row('a')], 'm9')).toEqual([row('a')])
  })

  it("a session's anchors are the same object across the thread's remounts", () => {
    expect(placedAnchorsFor('s1')).toBe(placedAnchorsFor('s1'))
    expect(placedAnchorsFor('s1')).not.toBe(placedAnchorsFor('s2'))
  })
})
