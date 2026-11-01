import { describe, expect, it, vi } from 'vitest'

import {
  chapterEntriesOf,
  chapterTargetFor,
  entryKeyOfRow,
  resolveChapterAnchor,
  type AnchorRow,
} from '../browser/webview/chapterAnchors'
import {
  CHAPTER_MARKS_MAX,
  chapterMarksFromStorage,
  chapterTitle,
  entryText,
  type ChapterMark,
} from '../sessions/chapterMarks'
import { ChapterBook, inConversationOrder, marksWithin } from '../sessions/chapterBook'
import {
  buildForkedTranscriptEntries,
  type BrowserTranscriptEntry,
} from '../sessions/sessionStore'

// Chapter marks (F-37): where a mark lands in the rendered thread, its title, the stored list, the
// runtime's book, and which marks a rewind keeps.

const entry = (uuid: string, transcriptLine: number, text = `text of ${uuid}`) => ({
  uuid,
  transcriptLine,
  message: { content: [{ type: 'text', text }] },
})

const merged = (id: string, lineFrom: number, lineTo: number): AnchorRow => ({
  id,
  metadata: { custom: { lineFrom, lineTo } },
})

describe('resolveChapterAnchor', () => {
  const entries = [entry('u1', 0), entry('a1', 1), entry('a2', 2), entry('a3', 3), entry('u2', 4)]
  const rows: AnchorRow[] = [{ id: 'u1' }, merged('a1', 1, 3), { id: 'u2' }]

  it('a whole message lands on the row of its first entry', () => {
    expect(resolveChapterAnchor(rows, entries, { entryKey: 'a1' })).toEqual({ kind: 'row', index: 1 })
    expect(resolveChapterAnchor(rows, entries, { entryKey: 'u2' })).toEqual({ kind: 'row', index: 2 })
  })

  it('a message folded into a later row lands on the row whose range covers its line', () => {
    const regrouped: AnchorRow[] = [{ id: 'u1' }, merged('a0', 1, 3), { id: 'u2' }]
    expect(resolveChapterAnchor(regrouped, entries, { entryKey: 'a2' })).toEqual({ kind: 'row', index: 1 })
  })

  it('a segment lands inside its row at its own line', () => {
    expect(resolveChapterAnchor(rows, entries, { entryKey: 'a1', segmentKey: 'a3' })).toEqual({
      kind: 'row',
      index: 1,
      ordinal: 3,
    })
  })

  it('is loading while the transcript or the rows are still empty', () => {
    expect(resolveChapterAnchor([], entries, { entryKey: 'u1' })).toEqual({ kind: 'loading' })
    expect(resolveChapterAnchor(rows, [], { entryKey: 'u1' })).toEqual({ kind: 'loading' })
  })

  it('never guesses: an entry that is gone, or has no row, is unavailable', () => {
    expect(resolveChapterAnchor(rows, entries, { entryKey: 'gone' })).toEqual({ kind: 'unavailable' })
    expect(resolveChapterAnchor(rows, entries, { entryKey: 'a1', segmentKey: 'gone' })).toEqual({
      kind: 'unavailable',
    })
    const noRow: AnchorRow[] = [{ id: 'u1' }, { id: 'u2' }]
    expect(resolveChapterAnchor(noRow, entries, { entryKey: 'a2' })).toEqual({ kind: 'unavailable' })
    expect(resolveChapterAnchor(noRow, entries, { entryKey: 'a1', segmentKey: 'a3' })).toEqual({
      kind: 'unavailable',
    })
  })
})

describe('chapterTargetFor', () => {
  const entries = [entry('u1', 0), entry('a1', 1), entry('a2', 2)]

  it('names the row, and the clicked entry when it is a later one in the row', () => {
    const row = merged('a1', 1, 2)
    expect(chapterTargetFor(row, null, entries)).toEqual({ entryKey: 'a1' })
    expect(chapterTargetFor(row, 1, entries)).toEqual({ entryKey: 'a1' })
    expect(chapterTargetFor(row, 2, entries)).toEqual({ entryKey: 'a1', segmentKey: 'a2' })
    expect(chapterTargetFor(row, 99, entries)).toEqual({ entryKey: 'a1' })
  })

  it('names the closing reply, rendered under a turn-derived id, by the entry on its first line', () => {
    const closing = merged('turn:u1:assistant', 1, 2)
    expect(entryKeyOfRow(closing, entries)).toBe('a1')
    expect(chapterTargetFor(closing, 2, entries)).toEqual({ entryKey: 'a1', segmentKey: 'a2' })
    expect(resolveChapterAnchor([{ id: 'u1' }, closing], entries, { entryKey: 'a1' })).toEqual({ kind: 'row', index: 1 })
  })

  it('is null for a row that is not a saved entry yet', () => {
    expect(chapterTargetFor({ id: 'turn:u1:live-stream' }, null, entries)).toBeNull()
    expect(chapterTargetFor(undefined, null, entries)).toBeNull()
  })

  it('a finished reply still rendered from live events can be marked and found', () => {
    const live = [{ uuid: 'a3', message: { content: 'just finished' } }, { type: 'turn_result' }]
    const all = chapterEntriesOf(entries, live)
    expect(chapterTargetFor({ id: 'a3' }, null, all)).toEqual({ entryKey: 'a3' })
    expect(resolveChapterAnchor([{ id: 'u1' }, { id: 'a3' }], all, { entryKey: 'a3' })).toEqual({ kind: 'row', index: 1 })
    expect(chapterEntriesOf(entries, [])).toBe(entries)
  })
})

describe('chapterTitle', () => {
  it('takes the first non-blank line, whitespace folded', () => {
    expect(chapterTitle('\n\n   Fix   the\tparser  \nsecond line')).toBe('Fix the parser')
  })

  it('cuts at 40 graphemes with an ellipsis', () => {
    const forty = 'a'.repeat(40)
    expect(chapterTitle(forty)).toBe(forty)
    expect(chapterTitle(forty + 'b')).toBe(forty + '…')
  })

  it('counts a CJK character or a joined emoji as one', () => {
    const han = '章'.repeat(41)
    expect(chapterTitle(han)).toBe('章'.repeat(40) + '…')
    const family = '👨‍👩‍👧'
    const title = chapterTitle(family.repeat(41))!
    expect(title).toBe(family.repeat(40) + '…')
  })

  it('titles a quoted-context prompt by the person’s own words', () => {
    const prompt = '[Quoted context 1]\n> some quoted reply\n[User message]\nWhy does this fail?'
    expect(chapterTitle(prompt)).toBe('Why does this fail?')
  })

  it('is null when there is no text', () => {
    expect(chapterTitle('')).toBeNull()
    expect(chapterTitle('  \n\t\n')).toBeNull()
  })

  it('reads an entry’s text blocks, joined', () => {
    expect(entryText({ message: { content: 'plain' } })).toBe('plain')
    expect(
      entryText({ message: { content: [{ type: 'tool_use' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }),
    ).toBe('a\nb')
    expect(entryText({ message: { content: [{ type: 'tool_use' }] } })).toBe('')
    expect(entryText(null)).toBe('')
  })
})

describe('chapterMarksFromStorage', () => {
  it('keeps valid marks in order and drops malformed rows', () => {
    const good: ChapterMark = { id: 'c1', entryKey: 'u1', title: 'T', createdAt: 1 }
    const segment: ChapterMark = { id: 'c2', entryKey: 'a1', segmentKey: 'a2', title: null, createdAt: 2 }
    expect(
      chapterMarksFromStorage([
        good,
        { id: 'c3', entryKey: '', title: 'x', createdAt: 3 },
        { id: 'c4', entryKey: 'u1', title: 5, createdAt: 3 },
        { id: 'c5', entryKey: 'u1', title: 'x', createdAt: Number.NaN },
        { id: 'c6', entryKey: 'u1', segmentKey: 'x'.repeat(201), title: 'x', createdAt: 1 },
        'junk',
        null,
        segment,
      ]),
    ).toEqual([good, segment])
    expect(chapterMarksFromStorage(undefined)).toEqual([])
    expect(chapterMarksFromStorage({ marks: [] })).toEqual([])
  })
})

function makeBook(entries: unknown[]) {
  let stored: unknown
  const writes: ChapterMark[][] = []
  const onChange = vi.fn()
  let n = 0
  const book = new ChapterBook({
    storage: {
      read: async () => stored,
      write: async (_sessionId, marks) => {
        writes.push(marks)
        stored = JSON.parse(JSON.stringify(marks))
      },
      entries: async () => entries,
    },
    onChange,
    now: () => 1000,
    newId: () => `c${++n}`,
  })
  return { book, writes, onChange, setStored: (value: unknown) => (stored = value) }
}

describe('ChapterBook', () => {
  const entries = [
    entry('u1', 0, 'First question\nmore'),
    entry('a1', 1, 'The reply'),
    entry('a2', 2, 'A later part'),
    { uuid: 't1', transcriptLine: 3, message: { content: [{ type: 'tool_use' }] } },
    entry('u2', 4, 'Second question'),
  ]

  it('marks a place with a title from its own text and tells the topic', async () => {
    const { book, onChange } = makeBook(entries)
    expect(await book.mark('s1', 'u1')).toEqual({
      ok: true,
      created: true,
      mark: { id: 'c1', entryKey: 'u1', title: 'First question', createdAt: 1000 },
    })
    const segment = await book.mark('s1', 'a1', 'a2')
    expect(segment).toMatchObject({ ok: true, mark: { entryKey: 'a1', segmentKey: 'a2', title: 'A later part' } })
    expect(await book.mark('s1', 't1')).toMatchObject({ ok: true, mark: { title: null } })
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onChange).toHaveBeenCalledWith('s1')
  })

  it('refuses a place the transcript does not have', async () => {
    const { book, writes } = makeBook(entries)
    expect(await book.mark('s1', 'gone')).toEqual({ ok: false, reason: 'unknown-entry' })
    expect(await book.mark('s1', 'a1', 'gone')).toEqual({ ok: false, reason: 'unknown-entry' })
    expect(writes).toHaveLength(0)
  })

  it('marking the same place twice returns the existing mark', async () => {
    const { book, writes } = makeBook(entries)
    const first = await book.mark('s1', 'u2')
    const again = await book.mark('s1', 'u2')
    expect(again).toEqual({ ok: true, created: false, mark: first.ok && first.mark })
    expect(writes).toHaveLength(1)
  })

  it('keeps the list in conversation order, not the order marks were made', async () => {
    const { book } = makeBook(entries)
    await book.mark('s1', 'u2')
    await book.mark('s1', 'a1', 'a2')
    await book.mark('s1', 'u1')
    expect((await book.marks('s1')).map(m => m.segmentKey ?? m.entryKey)).toEqual(['u1', 'a2', 'u2'])
  })

  it('stops at the limit', async () => {
    const many = Array.from({ length: CHAPTER_MARKS_MAX + 1 }, (_, i) => entry(`e${i}`, i))
    const { book } = makeBook(many)
    for (let i = 0; i < CHAPTER_MARKS_MAX; i++) expect((await book.mark('s1', `e${i}`)).ok).toBe(true)
    expect(await book.mark('s1', `e${CHAPTER_MARKS_MAX}`)).toEqual({ ok: false, reason: 'limit' })
  })

  it('runs one session’s operations one at a time, so concurrent marks all land', async () => {
    const { book } = makeBook(entries)
    await Promise.all([book.mark('s1', 'u1'), book.mark('s1', 'a1'), book.mark('s1', 'u2')])
    expect((await book.marks('s1')).map(m => m.entryKey)).toEqual(['u1', 'a1', 'u2'])
  })

  it('unmarks by id; an unknown id changes nothing', async () => {
    const { book, onChange } = makeBook(entries)
    const made = await book.mark('s1', 'u1')
    onChange.mockClear()
    expect(await book.unmark('s1', 'nope')).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(await book.unmark('s1', made.ok ? made.mark.id : '')).toBe(true)
    expect(await book.marks('s1')).toEqual([])
    expect(onChange).toHaveBeenCalledWith('s1')
  })

  it('reads the stored list afresh, dropping malformed rows', async () => {
    const { book, setStored } = makeBook(entries)
    setStored([{ id: 'x', entryKey: 'u1', title: 'kept', createdAt: 1 }, { bad: true }])
    expect(await book.marks('s1')).toEqual([{ id: 'x', entryKey: 'u1', title: 'kept', createdAt: 1 }])
  })
})

describe('order and rewind helpers', () => {
  const mark = (id: string, entryKey: string, segmentKey?: string): ChapterMark => ({
    id,
    entryKey,
    ...(segmentKey ? { segmentKey } : {}),
    title: id,
    createdAt: 0,
  })

  it('a mark whose entry is gone keeps its place after the others', () => {
    const position = new Map([['u1', 0], ['u2', 4]])
    const sorted = inConversationOrder([mark('gone', 'x'), mark('b', 'u2'), mark('a', 'u1')], position)
    expect(sorted.map(m => m.id)).toEqual(['a', 'b', 'gone'])
  })

  it('a copy keeps the marks whose entry and segment it copied', () => {
    const kept = marksWithin(
      [mark('a', 'u1'), mark('b', 'a1', 'a2'), mark('c', 'a1', 'a3'), mark('d', 'u2')],
      [{ uuid: 'u1' }, { uuid: 'a1' }, { uuid: 'a2' }],
    )
    expect(kept.map(m => m.id)).toEqual(['a', 'b'])
  })
})

describe('marks across a fork', () => {
  const text = (uuid: string, parentUuid: string | null, type: 'user' | 'assistant') =>
    ({
      type,
      uuid,
      parentUuid,
      sessionId: 'old',
      timestamp: '2026-10-01T00:00:00.000Z',
      message: { role: type, content: [{ type: 'text', text: uuid }] },
    }) as unknown as BrowserTranscriptEntry
  const source = [text('u1', null, 'user'), text('a1', 'u1', 'assistant'), text('u2', 'a1', 'user'), text('a2', 'u2', 'assistant')]
  const chapterMarks: ChapterMark[] = [
    { id: 'c1', entryKey: 'u1', title: 'u1', createdAt: 0 },
    { id: 'c2', entryKey: 'u2', title: 'u2', createdAt: 0 },
  ]

  it('a rewind keeps the marks in the part it keeps', () => {
    const built = buildForkedTranscriptEntries(source, 'a1', 'new', 1, { chapterMarks }, undefined, { as: 'rewind' })
    expect(built?.meta.metadata.chapterMarks).toEqual([chapterMarks[0]])
  })

  it('a plain fork starts with none', () => {
    const built = buildForkedTranscriptEntries(source, 'a2', 'new', 1, { chapterMarks })
    expect(built?.meta.metadata.chapterMarks).toBeUndefined()
  })
})
