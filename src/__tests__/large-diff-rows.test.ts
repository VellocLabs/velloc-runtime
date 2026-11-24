import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StructuredPatchHunk } from 'diff'
import { DiffHunks } from '../components/assistant-ui/edit-tool-diff'
import { boundedHunksBetween, hunksBetween, hunksForCreation } from '../utils/fileChangeHunks'
import {
  diffRowsModel,
  hunkToRows,
  MAX_DIFF_ROWS,
  WORD_DIFF_MAX_LINES,
  WORD_PAIR_MAX_CHARS,
} from '../utils/hunkRows'

// A diff view mounts a bounded number of rows however large the change is (F-9).

function createdFile(lines: number): StructuredPatchHunk[] {
  return hunksForCreation(Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n'))
}

/** `pairs` removed lines each followed by a one-word replacement. */
function replacedBlock(pairs: number): StructuredPatchHunk {
  const removed = Array.from({ length: pairs }, (_, i) => `-const value${i} = oldName`)
  const added = Array.from({ length: pairs }, (_, i) => `+const value${i} = newName`)
  return { oldStart: 1, oldLines: pairs, newStart: 1, newLines: pairs, lines: [...removed, ...added] }
}

const countRows = (html: string) => html.split('aui-edit-diff-gutter').length - 1

describe('rows a diff view builds', () => {
  it('builds at most the row limit and counts the rest', () => {
    const model = diffRowsModel(createdFile(10_000))
    expect(model.shown).toHaveLength(1)
    expect(model.shown[0]!.rows).toHaveLength(MAX_DIFF_ROWS)
    expect(model.hiddenLines).toBe(10_000 - MAX_DIFF_ROWS)
  })

  it('spends the limit across hunks and leaves later hunks unbuilt', () => {
    const hunks = [...createdFile(6), ...createdFile(6), ...createdFile(6)]
    const model = diffRowsModel(hunks, 8)
    expect(model.shown.map(item => item.rows.length)).toEqual([6, 2])
    expect(model.hiddenLines).toBe(10)
  })

  it('keeps every row of a diff under the limit', () => {
    const model = diffRowsModel(createdFile(5))
    expect(model.shown[0]!.rows).toHaveLength(5)
    expect(model.hiddenLines).toBe(0)
  })

  it('numbers a cut hunk as it numbers the whole one', () => {
    const hunk: StructuredPatchHunk = { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' a', '-b', '+c', ' d'] }
    expect(hunkToRows(hunk, { limit: 3 })).toEqual(hunkToRows(hunk).slice(0, 3))
  })

  it('highlights words in a small diff and not in one over the line threshold', () => {
    const small = diffRowsModel([replacedBlock(3)])
    expect(small.shown[0]!.rows.every(row => row.kind === 'word')).toBe(true)

    const big = diffRowsModel([replacedBlock(WORD_DIFF_MAX_LINES / 2 + 1)])
    expect(big.shown[0]!.rows.every(row => row.kind === 'plain')).toBe(true)
  })

  it('leaves a pair plain when its lines are too long to compare by word', () => {
    const long = 'x'.repeat(WORD_PAIR_MAX_CHARS)
    const rows = hunkToRows({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${long}a`, `+${long}b`] })
    expect(rows.map(row => row.kind)).toEqual(['plain', 'plain'])
  })
})

describe('line diff on the UI thread', () => {
  it('matches the full diff when it finishes within the budget', () => {
    expect(boundedHunksBetween('f', 'a\nb\nc\n', 'a\nB\nc\n')).toEqual(hunksBetween('f', 'a\nb\nc\n', 'a\nB\nc\n'))
  })

  it('shows every line removed then added when the budget runs out', () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `a${(i * 7) % 13} ${i}`).join('\n')
    const after = Array.from({ length: 20_000 }, (_, i) => `b${(i * 5) % 11} $${i}\t`).join('\n')
    const hunks = boundedHunksBetween('f', before, after, 1)
    expect(hunks).toHaveLength(1)
    const [hunk] = hunks
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 20_000, newStart: 1, newLines: 20_000 })
    expect(hunk!.lines[0]).toBe('-a0 0')
    expect(hunk!.lines[20_000]).toBe('+b0 $0\t')
  })

  it('reports no hunks for equal texts', () => {
    expect(boundedHunksBetween('f', 'same\n', 'same\n')).toEqual([])
  })
})

describe('DiffHunks (render)', () => {
  it('mounts the row limit for a 10,000-line created file and says how many lines are left out', () => {
    const html = renderToStaticMarkup(
      createElement(DiffHunks, { hunks: createdFile(10_000), onOpenFile: () => {} }),
    )
    expect(countRows(html)).toBe(MAX_DIFF_ROWS)
    expect(html).toContain('data-testid="diff-rows-truncated"')
    expect(html).toContain(`${10_000 - MAX_DIFF_ROWS} more lines not shown.`)
    expect(html).toContain('Open file')
  })

  it('offers no Open file action without a handler', () => {
    const html = renderToStaticMarkup(createElement(DiffHunks, { hunks: createdFile(MAX_DIFF_ROWS + 1) }))
    expect(html).toContain('1 more line not shown.')
    expect(html).not.toContain('data-testid="diff-rows-open-file"')
  })

  it('shows no notice for a diff under the limit', () => {
    const html = renderToStaticMarkup(createElement(DiffHunks, { hunks: createdFile(3) }))
    expect(countRows(html)).toBe(3)
    expect(html).not.toContain('diff-rows-truncated')
  })
})
