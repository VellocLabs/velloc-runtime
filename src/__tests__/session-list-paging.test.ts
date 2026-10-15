import { describe, expect, it } from 'vitest'
import {
  SESSION_PAGE_SIZE,
  countIncluding,
  nextPageCount,
  revealNextPage,
} from '../browser/webview/sessionListPaging'

describe('sessionListPaging', () => {
  it('starts at one page of 20', () => {
    expect(SESSION_PAGE_SIZE).toBe(20)
  })

  describe('nextPageCount', () => {
    it('offers a full page while more than a page remains', () => {
      expect(nextPageCount(200, 20)).toBe(20)
      expect(nextPageCount(41, 20)).toBe(20)
    })

    it('clamps the label to what is actually left', () => {
      // The last click on a 27-row list reads "Show 7 more", not "Show 20 more".
      expect(nextPageCount(27, 20)).toBe(7)
      expect(nextPageCount(21, 20)).toBe(1)
    })

    it('offers nothing once everything is visible', () => {
      expect(nextPageCount(20, 20)).toBe(0)
      expect(nextPageCount(5, 20)).toBe(0)
      // A shrinking list (sessions deleted) must not render a button either.
      expect(nextPageCount(3, 40)).toBe(0)
    })
  })

  describe('revealNextPage', () => {
    it('grows by a page each click, unbounded', () => {
      expect(revealNextPage(200, 20)).toBe(40)
      expect(revealNextPage(200, 40)).toBe(60)
      expect(revealNextPage(200, 180)).toBe(200)
    })

    it('never runs past the end of the list', () => {
      expect(revealNextPage(27, 20)).toBe(27)
      expect(revealNextPage(5, 20)).toBe(5)
    })
  })

  describe('countIncluding', () => {
    it('leaves the window alone when the row is already visible', () => {
      expect(countIncluding(20, 0)).toBe(20)
      expect(countIncluding(20, 19)).toBe(20)
    })

    it('grows to a whole page that includes the row', () => {
      expect(countIncluding(20, 20)).toBe(40)
      expect(countIncluding(20, 56)).toBe(60)
    })

    it('never shrinks an already-expanded window', () => {
      expect(countIncluding(100, 3)).toBe(100)
    })

    it('is a no-op when the row is not in this list', () => {
      // A project node that does not own the active session passes -1.
      expect(countIncluding(20, -1)).toBe(20)
    })
  })
})
