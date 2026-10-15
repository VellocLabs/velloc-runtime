// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { SearchQuery, search, setSearchQuery } from '@codemirror/search'

import {
  SEARCH_COUNT_MAX_DOC_LENGTH,
  SEARCH_MATCH_SCAN_CAP,
  countSearchMatches,
  formatSearchMatchCount,
} from '../components/assistant-ui/codemirror-search-count'

/**
 * The `3/17` readout in the Files view's find panel. CodeMirror ships no match
 * counter, so both halves of it are ours: the scan (bounded, so a one-letter
 * query in a huge file can't walk the document on every keystroke) and the
 * "which one am I on" index, which is derived from the SELECTION because that
 * is how CodeMirror represents the current match.
 */

function stateWith(doc: string, query?: SearchQuery): EditorState {
  const state = EditorState.create({ doc, extensions: [search()] })
  if (!query) return state
  return state.update({ effects: setSearchQuery.of(query) }).state
}

/** Move the selection onto `[from, to)` — what `findNext` does to mark a match. */
function select(state: EditorState, from: number, to: number): EditorState {
  return state.update({ selection: { anchor: from, head: to } }).state
}

describe('countSearchMatches', () => {
  it('is empty with no query at all', () => {
    const count = countSearchMatches(stateWith('alpha beta alpha'))
    expect(count).toEqual({ total: 0, current: 0, capped: false })
  })

  it('is empty for an empty query', () => {
    const count = countSearchMatches(
      stateWith('alpha beta alpha', new SearchQuery({ search: '' })),
    )
    expect(count!.total).toBe(0)
  })

  it('is empty for an invalid regular expression', () => {
    const count = countSearchMatches(
      stateWith('alpha', new SearchQuery({ search: '([', regexp: true })),
    )
    expect(count!.total).toBe(0)
  })

  it('counts every match, reporting 0 when none is selected', () => {
    const count = countSearchMatches(
      stateWith('alpha beta alpha gamma alpha', new SearchQuery({ search: 'alpha' })),
    )
    expect(count).toEqual({ total: 3, current: 0, capped: false })
  })

  it('reports the 1-based index of the selected match', () => {
    const doc = 'alpha beta alpha gamma alpha'
    const base = stateWith(doc, new SearchQuery({ search: 'alpha' }))
    // Second occurrence starts at 11.
    expect(countSearchMatches(select(base, 11, 16))).toMatchObject({
      total: 3,
      current: 2,
    })
    expect(countSearchMatches(select(base, 23, 28))).toMatchObject({
      total: 3,
      current: 3,
    })
  })

  it('does not count a selection that merely overlaps a match', () => {
    const base = stateWith('alpha beta', new SearchQuery({ search: 'alpha' }))
    expect(countSearchMatches(select(base, 1, 4))!.current).toBe(0)
  })

  it('honours case sensitivity', () => {
    const doc = 'Alpha alpha ALPHA'
    expect(
      countSearchMatches(stateWith(doc, new SearchQuery({ search: 'alpha' })))!.total,
    ).toBe(3)
    expect(
      countSearchMatches(
        stateWith(doc, new SearchQuery({ search: 'alpha', caseSensitive: true })),
      )!.total,
    ).toBe(1)
  })

  it('honours regexp queries', () => {
    const count = countSearchMatches(
      stateWith('a1 b2 c3', new SearchQuery({ search: '[a-z]\\d', regexp: true })),
    )
    expect(count!.total).toBe(3)
  })

  it('stops at the scan cap and flags the total as a lower bound', () => {
    // A pathological query: one letter repeated far past the cap.
    const doc = 'x'.repeat(SEARCH_MATCH_SCAN_CAP + 500)
    const count = countSearchMatches(
      stateWith(doc, new SearchQuery({ search: 'x' })),
      50,
    )
    expect(count).toMatchObject({ total: 50, capped: true })
  })

  it('refuses to count a document too large to scan per keystroke', () => {
    // The match cap bounds match-HEAVY scans; a query with few hits in a huge
    // file still walks the whole doc, per keystroke. Past the doc-size gate
    // the counter returns null and renders nothing at all.
    const doc = 'y '.repeat(600) // 1200 chars, few matches
    const state = stateWith(doc, new SearchQuery({ search: 'zzz' }))
    expect(countSearchMatches(state, SEARCH_MATCH_SCAN_CAP, 1000)).toBeNull()
    // At or under the gate it counts normally.
    expect(
      countSearchMatches(state, SEARCH_MATCH_SCAN_CAP, doc.length),
    ).toEqual({ total: 0, current: 0, capped: false })
    expect(SEARCH_COUNT_MAX_DOC_LENGTH).toBeGreaterThan(100_000)
    // …and null formats as the empty string (the counter just doesn't render).
    expect(formatSearchMatchCount(null)).toBe('')
  })
})

describe('formatSearchMatchCount', () => {
  it('renders current/total', () => {
    expect(formatSearchMatchCount({ total: 17, current: 3, capped: false })).toBe(
      '3/17',
    )
  })

  it('renders 0/N before a match is selected, and 0/0 for no results', () => {
    expect(formatSearchMatchCount({ total: 17, current: 0, capped: false })).toBe(
      '0/17',
    )
    expect(formatSearchMatchCount({ total: 0, current: 0, capped: false })).toBe(
      '0/0',
    )
  })

  it('marks a capped total as a lower bound', () => {
    expect(formatSearchMatchCount({ total: 10000, current: 4, capped: true })).toBe(
      '4/10000+',
    )
  })

  it('renders nothing when there is no count', () => {
    expect(formatSearchMatchCount(null)).toBe('')
  })
})
