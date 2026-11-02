import { describe, expect, it } from 'vitest'

import {
  CHAPTER_READ_LINE_PX,
  SESSION_START_ID,
  activeChapterId,
  type RailPlace,
  type ViewportGeometry,
} from '../browser/webview/chapterRail'

/** Which chapter the rail marks as being read (F-37). */

const start: RailPlace = { id: SESSION_START_ID, index: -1, top: null }
const view = (over: Partial<ViewportGeometry> = {}): ViewportGeometry => ({
  scrollTop: 500,
  scrollHeight: 5000,
  clientHeight: 800,
  firstRowAtReadLine: 10,
  ...over,
})

describe('activeChapterId', () => {
  it('is the session start until a mark reaches the read line', () => {
    const places = [start, { id: 'a', index: 12, top: CHAPTER_READ_LINE_PX + 1 }]
    expect(activeChapterId(places, view())).toBe(SESSION_START_ID)
  })

  it('is the last mark whose row has reached the read line', () => {
    const places = [
      start,
      { id: 'a', index: 3, top: -400 },
      { id: 'b', index: 7, top: CHAPTER_READ_LINE_PX },
      { id: 'c', index: 9, top: 300 },
    ]
    expect(activeChapterId(places, view())).toBe('b')
  })

  it('a culled row above the mounted rows counts as read; one below does not', () => {
    const places = [start, { id: 'above', index: 2, top: null }, { id: 'below', index: 40, top: null }]
    expect(activeChapterId(places, view({ firstRowAtReadLine: 10 }))).toBe('above')
  })

  it('reads the last entry at the bottom, even a short last chapter that never reaches the line', () => {
    const places = [start, { id: 'a', index: 3, top: -200 }, { id: 'last', index: 30, top: 600 }]
    expect(activeChapterId(places, view({ scrollTop: 4195 }))).toBe('last')
    expect(activeChapterId(places, view({ scrollTop: 4100 }))).toBe('a')
  })

  it('a viewport that does not scroll reads by the line, not by the bottom rule', () => {
    const places = [start, { id: 'a', index: 3, top: 300 }]
    expect(activeChapterId(places, view({ scrollTop: 0, scrollHeight: 600, clientHeight: 800 }))).toBe(
      SESSION_START_ID,
    )
  })

  it('no entries, no chapter', () => {
    expect(activeChapterId([], view())).toBeNull()
  })
})
