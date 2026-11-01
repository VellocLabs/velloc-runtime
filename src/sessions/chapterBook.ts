/**
 * Contract: ChapterBook — the runtime's record of every session's chapter marks (F-37). It owns the
 * state; the page reads it published and changes it through protocol actions.
 * - one list per session, kept in the session's metadata and read afresh for every operation, so a list
 *   rewritten elsewhere (a rewind's copy) is never shadowed by a cache
 * - operations on one session run one at a time: a mark or unmark reads, changes and writes the list
 *   across awaits, and a second one waits for the first
 * - a mark is checked against the session's transcript: its entry (and segment) must exist; the title is
 *   derived here from that entry's text (for a whole message whose first step has none, the reply's next
 *   text), never taken from a client
 * - the list is kept in conversation order; marking the same place twice returns the existing mark
 * Runs in the SharedWorker; the clock and ids are injected for tests.
 */

import { randomUuid } from '../utils/randomUuid'
import {
  CHAPTER_MARKS_MAX,
  chapterMarksFromStorage,
  entryTitle,
  isPromptEntry,
  type ChapterMark,
} from './chapterMarks'

/** Where a session's marks and its transcript are read, and the marks written. */
export type ChapterStorage = {
  /** The stored list (anything; malformed rows are dropped), or undefined. */
  read(sessionId: string): Promise<unknown>
  write(sessionId: string, marks: ChapterMark[]): Promise<void>
  /** The session's transcript entries, in order. */
  entries(sessionId: string): Promise<readonly unknown[]>
}

export type ChapterBookOptions = {
  storage: ChapterStorage
  onChange?: (sessionId: string) => void
  now?: () => number
  newId?: () => string
}

export type MarkResult =
  | { ok: true; mark: ChapterMark; created: boolean }
  | { ok: false; reason: 'unknown-entry' | 'limit' }

const uuidOf = (entry: unknown): string | undefined => {
  const uuid = (entry as { uuid?: unknown } | null)?.uuid
  return typeof uuid === 'string' ? uuid : undefined
}

export class ChapterBook {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly options: ChapterBookOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => `chapter-${randomUuid()}`)
  }

  /** The session's marks, in conversation order. */
  marks(sessionId: string): Promise<ChapterMark[]> {
    return this.serial(sessionId, () => this.load(sessionId))
  }

  /** Marks a message, or one entry folded into it; a segment naming the message's own entry is the message. */
  mark(sessionId: string, entryKey: string, segment?: string): Promise<MarkResult> {
    const segmentKey = segment === entryKey ? undefined : segment
    return this.serial(sessionId, async () => {
      const marks = await this.load(sessionId)
      const same = marks.find(m => m.entryKey === entryKey && m.segmentKey === segmentKey)
      if (same) return { ok: true, mark: same, created: false }
      if (marks.length >= CHAPTER_MARKS_MAX) return { ok: false, reason: 'limit' }
      const entries = await this.options.storage.entries(sessionId)
      const position = positions(entries)
      const titledAt = position.get(segmentKey ?? entryKey)
      if (!position.has(entryKey) || titledAt === undefined) return { ok: false, reason: 'unknown-entry' }
      const mark: ChapterMark = {
        id: this.newId(),
        entryKey,
        ...(segmentKey !== undefined ? { segmentKey } : {}),
        title: segmentKey === undefined ? messageTitle(entries, titledAt) : entryTitle(entries[titledAt]),
        createdAt: this.now(),
      }
      const next = inConversationOrder([...marks, mark], position)
      await this.options.storage.write(sessionId, next)
      this.options.onChange?.(sessionId)
      return { ok: true, mark, created: true }
    })
  }

  /** Removes one mark; false when the session has no mark with that id. */
  unmark(sessionId: string, markId: string): Promise<boolean> {
    return this.serial(sessionId, async () => {
      const marks = await this.load(sessionId)
      const next = marks.filter(m => m.id !== markId)
      if (next.length === marks.length) return false
      await this.options.storage.write(sessionId, next)
      this.options.onChange?.(sessionId)
      return true
    })
  }

  private async load(sessionId: string): Promise<ChapterMark[]> {
    return chapterMarksFromStorage(await this.options.storage.read(sessionId))
  }

  private serial<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    const settled = next.catch(() => undefined)
    this.chains.set(sessionId, settled)
    void settled.then(() => {
      if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId)
    })
    return next
  }
}

/**
 * The title of a mark on the message starting at `entries[at]`: that entry's, or for a reply step with no
 * text (a tool call), the first entry with text later in the same reply, stopping at the next prompt.
 */
function messageTitle(entries: readonly unknown[], at: number): string | null {
  const own = entryTitle(entries[at])
  if (own !== null || isPromptEntry(entries[at])) return own
  for (let index = at + 1; index < entries.length; index++) {
    if (isPromptEntry(entries[index])) return null
    const title = entryTitle(entries[index])
    if (title !== null) return title
  }
  return null
}

function positions(entries: readonly unknown[]): Map<string, number> {
  const at = new Map<string, number>()
  entries.forEach((entry, index) => {
    const uuid = uuidOf(entry)
    if (uuid !== undefined && !at.has(uuid)) at.set(uuid, index)
  })
  return at
}

/** Marks sorted by where they sit in the conversation; marks whose entry is gone keep their place last. */
export function inConversationOrder(marks: readonly ChapterMark[], position: ReadonlyMap<string, number>): ChapterMark[] {
  const key = (mark: ChapterMark) => position.get(mark.segmentKey ?? mark.entryKey) ?? Number.POSITIVE_INFINITY
  return marks
    .map((mark, index) => ({ mark, index }))
    .sort((a, b) => key(a.mark) - key(b.mark) || a.index - b.index)
    .map(each => each.mark)
}

/**
 * The marks a copy of a session keeps when it holds only `keptEntries` (a rewind): those whose entry and
 * segment were copied.
 */
export function marksWithin(marks: readonly ChapterMark[], keptEntries: readonly unknown[]): ChapterMark[] {
  const kept = new Set(keptEntries.map(uuidOf).filter((uuid): uuid is string => uuid !== undefined))
  return marks.filter(m => kept.has(m.entryKey) && (m.segmentKey === undefined || kept.has(m.segmentKey)))
}

let book: ChapterBook | null = null
const changeListeners = new Set<(sessionId: string) => void>()

/** The manager registers the realm's book at boot; the protocol capability reads it. Null before then. */
export function setChapterBook(next: ChapterBook | null): void {
  book = next
}

export function getChapterBook(): ChapterBook | null {
  return book
}

/** The book's change feed, for the protocol topic. */
export function onChaptersChanged(listener: (sessionId: string) => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function notifyChaptersChanged(sessionId: string): void {
  for (const listener of Array.from(changeListeners)) listener(sessionId)
}
