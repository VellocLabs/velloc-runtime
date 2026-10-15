import { describe, expect, it } from 'vitest'
import type { StructuredPatchHunk } from 'diff'
import {
  expandIndentTabs,
  hunksBetween,
  hunksForCreation,
  hunksForReplacement,
  summarizeFileChange,
  tallyHunkRows,
} from '../utils/fileChangeHunks'
import { hunkToRows } from '../utils/hunkRows'

// Behaviour pins for the Edit/Write diff helpers: the hunks a change
// produces, the +/- tallies, and the rows the diff view renders from a hunk.

const snippet = (before: string, after: string) => hunksBetween('f.ts', before, after)

const whole = snippet

const applied = (
  original: string,
  find: string,
  replacement: string,
  everywhere: boolean,
) =>
  hunksForReplacement('f.ts', original, { find, put: replacement, everywhere })

const rows = (lines: string[], oldStart = 1) =>
  hunkToRows({ oldStart, oldLines: 0, newStart: oldStart, newLines: 0, lines })

const twentyLines =
  Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n'

describe('hunks between two texts', () => {
  it('emits one hunk with three lines of context around a change', () => {
    expect(snippet('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
    ])
  })

  it('emits nothing when both sides match', () => {
    expect(snippet('same\ncontent\n', 'same\ncontent\n')).toEqual([])
    expect(whole('', '')).toEqual([])
  })

  it('marks a missing final newline on both sides', () => {
    expect(snippet('x', 'y')).toEqual([
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-x', '\\ No newline at end of file', '+y', '\\ No newline at end of file'],
      },
    ])
  })

  it('keeps & and $ intact in the emitted lines', () => {
    const lines = snippet('let x = 1 & 2\n', 'let x = $foo & bar $$ $&\n').flatMap(h => h.lines)
    expect(lines).toEqual(['-let x = 1 & 2', '+let x = $foo & bar $$ $&'])
  })

  it('shows each leading tab as two spaces, leaving inner tabs alone', () => {
    const lines = snippet('\tone\n', '\t\ttwo\tx\n').flatMap(h => h.lines)
    expect(lines).toEqual(['-  one', '+    two\tx'])
    expect(expandIndentTabs('\t\tx\ty\n\tz')).toBe('    x\ty\n  z')
    expect(expandIndentTabs('no tabs')).toBe('no tabs')
  })

  it('treats texts that differ only in leading tabs vs spaces as equal', () => {
    expect(whole('\tx\n', '  x\n')).toEqual([])
  })

  it('splits distant changes into separate hunks with file line numbers', () => {
    const after = twentyLines.replace('line2\n', 'TWO\n').replace('line18\n', 'EIGHTEEN\n')
    const hunks = whole(twentyLines, after)
    expect(hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 5, 1, 5],
      [15, 6, 15, 6],
    ])
  })
})

describe('hunks for an edit applied to the whole file', () => {
  it('numbers a deep change at its position in the file', () => {
    const hunks = applied(twentyLines, 'line10', 'CHANGED', false)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ oldStart: 7, oldLines: 7, newStart: 7, newLines: 7 })
    expect(hunks[0]!.lines).toEqual([
      ' line7', ' line8', ' line9', '-line10', '+CHANGED', ' line11', ' line12', ' line13',
    ])
  })

  it('replaces only the first occurrence unless replace-all is set', () => {
    const once = applied('x\ny\nx\n', 'x', 'z', false).flatMap(h => h.lines)
    expect(once.filter(l => l === '+z')).toHaveLength(1)
    const all = applied('x\ny\nx\n', 'x', 'z', true).flatMap(h => h.lines)
    expect(all.filter(l => l === '+z')).toHaveLength(2)
  })

  it('takes replacement text literally ($ patterns are not expanded)', () => {
    expect(applied('p $ q\np $ q\n', '$', "$&$'", false)).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["+p $&$' q", ' p $ q', '-p $ q'] },
    ])
  })

  it('emits nothing when the search text is absent', () => {
    expect(applied('a\nb\n', 'zzz', 'y', false)).toEqual([])
  })
})

describe('line tallies and new-file hunks', () => {
  it('counts + and - lines across hunks, ignoring context and markers', () => {
    const hunks: StructuredPatchHunk[] = [
      { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [' a', '-b', '+c', '+d'] },
      { oldStart: 9, oldLines: 0, newStart: 9, newLines: 0, lines: ['-e', '\\ No newline at end of file'] },
    ]
    expect(tallyHunkRows(hunks)).toEqual({ added: 2, removed: 2 })
    expect(tallyHunkRows([])).toEqual({ added: 0, removed: 0 })
  })

  it('builds a single all-added hunk for a created file, one row per split line', () => {
    expect(hunksForCreation('one\ntwo\n')).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+one', '+two', '+'] },
    ])
    expect(hunksForCreation('')).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+'] },
    ])
  })
})

describe('diff summary for one Edit/Write call', () => {
  it('edit with the pre-edit file: file-relative hunks and tallies', () => {
    expect(
      summarizeFileChange({
        op: 'replace',
        path: 'f.ts',
        find: 'c',
        put: 'C',
        everywhere: false,
        before: 'a\nb\nc\nd\ne\n',
      }),
    ).toEqual({
      filePath: 'f.ts',
      patchHunks: [
        { oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' a', ' b', '-c', '+C', ' d', ' e'] },
      ],
      fileWasCreated: false,
      plusLines: 1,
      minusLines: 1,
    })
  })

  it('edit without the pre-edit file: diffs the two snippets', () => {
    expect(
      summarizeFileChange({
        op: 'replace',
        path: 'f.ts',
        find: 'x\n',
        put: 'y\nz\n',
        everywhere: true,
      }),
    ).toEqual({
      filePath: 'f.ts',
      patchHunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-x', '+y', '+z'] },
      ],
      fileWasCreated: false,
      plusLines: 2,
      minusLines: 1,
    })
  })

  it('write without a prior file: a created file', () => {
    expect(summarizeFileChange({ op: 'overwrite', path: 'n.ts', text: 'one\ntwo\n' })).toEqual({
      filePath: 'n.ts',
      patchHunks: [
        { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+one', '+two', '+'] },
      ],
      fileWasCreated: true,
      plusLines: 3,
      minusLines: 0,
    })
  })

  it('write over an existing file: diffs old content against new', () => {
    expect(
      summarizeFileChange({
        op: 'overwrite',
        path: 'n.ts',
        text: 'a\nB\nc\n',
        before: 'a\nb\nc\n',
      }),
    ).toEqual({
      filePath: 'n.ts',
      patchHunks: [
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] },
      ],
      fileWasCreated: false,
      plusLines: 1,
      minusLines: 1,
    })
  })

  it('write with identical content: no hunks, not a new file', () => {
    expect(
      summarizeFileChange({ op: 'overwrite', path: 'n.ts', text: 'a\n', before: 'a\n' }),
    ).toEqual({ filePath: 'n.ts', patchHunks: [], fileWasCreated: false, plusLines: 0, minusLines: 0 })
  })
})

describe('rendered rows for a hunk', () => {
  it('numbers rows from the hunk start; removed runs do not advance the counter', () => {
    expect(
      rows(
        [' ctx', '-r1', '-r2', '-r3', '+a1', ' mid', '-gone', ' end', '\\ No newline at end of file', '-', '+'],
        4,
      ),
    ).toEqual([
      { kind: 'plain', type: 'nochange', lineNum: 4, code: 'ctx' },
      { kind: 'plain', type: 'remove', lineNum: 5, code: 'r1' },
      { kind: 'plain', type: 'remove', lineNum: 6, code: 'r2' },
      { kind: 'plain', type: 'remove', lineNum: 7, code: 'r3' },
      { kind: 'plain', type: 'add', lineNum: 5, code: 'a1' },
      { kind: 'plain', type: 'nochange', lineNum: 6, code: 'mid' },
      { kind: 'plain', type: 'remove', lineNum: 7, code: 'gone' },
      { kind: 'plain', type: 'nochange', lineNum: 7, code: 'end' },
      { kind: 'plain', type: 'nochange', lineNum: 8, code: ' No newline at end of file' },
      { kind: 'plain', type: 'remove', lineNum: 9, code: '' },
      { kind: 'plain', type: 'add', lineNum: 9, code: '' },
    ])
  })

  it('a replaced block shares line numbers between its removed and added rows', () => {
    const numbered = rows([' ctx', '-old1', '-old2', '+new1', '+new2', ' ctx2'], 5)
    expect(numbered.map(r => [r.type, r.lineNum])).toEqual([
      ['nochange', 5],
      ['remove', 6],
      ['remove', 7],
      ['add', 6],
      ['add', 7],
      ['nochange', 8],
    ])
  })

  it('highlights only the changed words of a lightly edited line pair', () => {
    expect(rows(['-hello world foo bar', '+hello world FOO bar'])).toEqual([
      {
        kind: 'word',
        type: 'remove',
        lineNum: 1,
        parts: [
          { text: 'hello world ', highlight: false },
          { text: 'foo', highlight: true },
          { text: ' bar', highlight: false },
        ],
      },
      {
        kind: 'word',
        type: 'add',
        lineNum: 1,
        parts: [
          { text: 'hello world ', highlight: false },
          { text: 'FOO', highlight: true },
          { text: ' bar', highlight: false },
        ],
      },
    ])
  })

  it('pairs removed and added rows in order; extra rows stay plain', () => {
    const out = rows([
      '-alpha beta gamma delta',
      '-second line stays the same mostly',
      '+alpha beta GAMMA delta',
    ])
    expect(out.map(r => [r.kind, r.type])).toEqual([
      ['word', 'remove'],
      ['plain', 'remove'],
      ['word', 'add'],
    ])
  })

  it('does not pair across a context row', () => {
    const out = rows(['-alpha beta gamma delta', ' ctx', '+alpha beta GAMMA delta'])
    expect(out.map(r => r.kind)).toEqual(['plain', 'plain', 'plain'])
  })

  it('falls back to plain rows when a pair changed by more than 40%', () => {
    const out = rows(['-a', '+completely different long line here'])
    expect(out).toEqual([
      { kind: 'plain', type: 'remove', lineNum: 1, code: 'a' },
      { kind: 'plain', type: 'add', lineNum: 1, code: 'completely different long line here' },
    ])
  })

  it('applies the 40% cut-off inclusively', () => {
    // 'ab cd' -> 'ab ce': changed 'cd' + 'ce' = 4 of 10 characters = exactly 0.4.
    expect(rows(['-ab cd', '+ab ce']).map(r => r.kind)).toEqual(['word', 'word'])
    // 'ab cd' -> 'ab cde': 'cd' + 'cde' = 5 of 11 > 0.4.
    expect(rows(['-ab cd', '+ab cde']).map(r => r.kind)).toEqual(['plain', 'plain'])
  })
})
