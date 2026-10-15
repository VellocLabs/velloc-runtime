import { describe, expect, it } from 'vitest'

import {
  pagesNeeded,
  pageRange,
  pageWindow,
} from '../browser/webview/sessionImport/importPaging'

describe('importPaging', () => {
  it('counts pages with a floor of one', () => {
    expect(pagesNeeded(0, 50)).toBe(1)
    expect(pagesNeeded(50, 50)).toBe(1)
    expect(pagesNeeded(51, 50)).toBe(2)
    expect(pagesNeeded(120, 50)).toBe(3)
  })

  it('reports the 1-based row range of a page', () => {
    expect(pageRange(0, 50, 120)).toEqual({ from: 1, to: 50 })
    expect(pageRange(2, 50, 120)).toEqual({ from: 101, to: 120 })
    expect(pageRange(0, 50, 0)).toBeNull()
    expect(pageRange(5, 50, 120)).toBeNull()
  })

  it('lists every page when few, else first/last/neighbours with ellipses', () => {
    expect(pageWindow(0, 4)).toEqual([1, 2, 3, 4])
    expect(pageWindow(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(pageWindow(0, 20)).toEqual([1, 2, 'ellipsis', 20])
    expect(pageWindow(9, 20)).toEqual([1, 'ellipsis', 9, 10, 11, 'ellipsis', 20])
    expect(pageWindow(19, 20)).toEqual([1, 'ellipsis', 19, 20])
    // A single skipped page is shown rather than replaced by an ellipsis.
    expect(pageWindow(3, 20)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 20])
    expect(pageWindow(0, 0)).toEqual([])
  })
})
