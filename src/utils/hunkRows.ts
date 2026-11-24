import { diffWordsWithSpace, type StructuredPatchHunk } from 'diff'

/**
 * Contract: one hunk into inline-diff rows. The first character picks the side
 * (`+` / `-` / unchanged). Numbering starts at `oldStart`; removed rows do not
 * advance it, so a replaced block shares numbers with its replacement. Adjacent
 * removed/added blocks pair in order; a pair with at most 40% changed characters
 * becomes `word` rows with highlighted spans, otherwise both stay plain.
 * Word spans are skipped for a pair over WORD_PAIR_MAX_CHARS and for a whole
 * diff over WORD_DIFF_MAX_LINES; `diffRowsModel` shows at most MAX_DIFF_ROWS.
 */

export type RowSide = 'add' | 'remove' | 'nochange'

export type RowSpan = { text: string; highlight: boolean }

export type HunkRow =
  | { kind: 'plain'; type: RowSide; lineNum: number; code: string }
  | { kind: 'word'; type: 'add' | 'remove'; lineNum: number; parts: RowSpan[] }

/** Largest changed share (2/5) of a pair that still gets word highlighting. */
const MAX_CHANGED_NUM = 2
const MAX_CHANGED_DEN = 5

/** Rows a diff view mounts; the rest is counted, not built. */
export const MAX_DIFF_ROWS = 2_000
/** Diff size (hunk lines) above which no pair gets word spans. */
export const WORD_DIFF_MAX_LINES = 1_000
/** Combined length of a pair above which it stays plain. */
export const WORD_PAIR_MAX_CHARS = 2_000

export type HunkRowOptions = {
  /** Compute word spans for removed/added pairs (default true). */
  words?: boolean
  /** Build rows for at most this many leading lines of the hunk. */
  limit?: number
}

function sideOf(line: string): RowSide {
  const sign = line.charAt(0)
  return sign === '+' ? 'add' : sign === '-' ? 'remove' : 'nochange'
}

/** Highlighted spans for both lines of a pair, or null to keep them plain. */
function pairSpans(
  removedText: string,
  addedText: string,
): { removed: RowSpan[]; added: RowSpan[] } | null {
  const total = removedText.length + addedText.length
  if (total === 0 || total > WORD_PAIR_MAX_CHARS) return null
  const pieces = diffWordsWithSpace(removedText, addedText, { ignoreCase: false })
  let changed = 0
  for (const piece of pieces) {
    if (piece.added || piece.removed) changed += piece.value.length
  }
  if (changed * MAX_CHANGED_DEN > total * MAX_CHANGED_NUM) return null

  const removed: RowSpan[] = []
  const added: RowSpan[] = []
  for (const piece of pieces) {
    if (piece.added) {
      added.push({ text: piece.value, highlight: true })
    } else if (piece.removed) {
      removed.push({ text: piece.value, highlight: true })
    } else {
      removed.push({ text: piece.value, highlight: false })
      added.push({ text: piece.value, highlight: false })
    }
  }
  return { removed, added }
}

export function hunkToRows(hunk: StructuredPatchHunk, options: HunkRowOptions = {}): HunkRow[] {
  const { words = true, limit } = options
  const lines = limit !== undefined && limit < hunk.lines.length ? hunk.lines.slice(0, Math.max(0, limit)) : hunk.lines
  const sides = lines.map(sideOf)
  const texts = lines.map(line => line.slice(1))
  const count = sides.length

  // spansAt[i] is set for both members of a pair that qualifies for word rows.
  const spansAt: Array<RowSpan[] | undefined> = new Array(count)
  let at = words ? 0 : count
  while (at < count) {
    if (sides[at] !== 'remove') {
      at += 1
      continue
    }
    let addsFrom = at
    while (addsFrom < count && sides[addsFrom] === 'remove') addsFrom += 1
    let addsTo = addsFrom
    while (addsTo < count && sides[addsTo] === 'add') addsTo += 1
    const pairs = Math.min(addsFrom - at, addsTo - addsFrom)
    for (let k = 0; k < pairs; k += 1) {
      const spans = pairSpans(texts[at + k]!, texts[addsFrom + k]!)
      if (spans) {
        spansAt[at + k] = spans.removed
        spansAt[addsFrom + k] = spans.added
      }
    }
    at = addsTo
  }

  const rows: HunkRow[] = []
  let lineNum = hunk.oldStart
  let removedStreak = 0
  for (let i = 0; i < count; i += 1) {
    const type = sides[i]!
    let num: number
    if (type === 'remove') {
      num = lineNum + removedStreak
      removedStreak += 1
    } else {
      removedStreak = 0
      num = lineNum
      lineNum += 1
    }
    const parts = spansAt[i]
    if (parts && type !== 'nochange') {
      rows.push({ kind: 'word', type, lineNum: num, parts })
    } else {
      rows.push({ kind: 'plain', type, lineNum: num, code: texts[i]! })
    }
  }
  return rows
}

/** One hunk's rows as a diff view shows them. */
export type ShownHunk = { hunk: StructuredPatchHunk; rows: HunkRow[] }

/** Rows to mount for a diff, and how many hunk lines (markers excluded) were left out. */
export type DiffRowsModel = { shown: ShownHunk[]; hiddenLines: number }

/**
 * Contract: rows for `hunks` up to `maxRows` in order; later lines and hunks
 * are counted in `hiddenLines`, never converted. Pure; cost is bounded by
 * `maxRows`, not by the diff's size.
 */
export function diffRowsModel(
  hunks: readonly StructuredPatchHunk[],
  maxRows: number = MAX_DIFF_ROWS,
): DiffRowsModel {
  let total = 0
  for (const hunk of hunks) total += countContentLines(hunk.lines, 0)
  const words = total <= WORD_DIFF_MAX_LINES
  const shown: ShownHunk[] = []
  let budget = Math.max(0, maxRows)
  let hiddenLines = 0
  for (const hunk of hunks) {
    if (budget === 0) {
      hiddenLines += countContentLines(hunk.lines, 0)
      continue
    }
    const rows = hunkToRows(hunk, { words, limit: budget })
    shown.push({ hunk, rows })
    budget -= rows.length
    hiddenLines += countContentLines(hunk.lines, rows.length)
  }
  return { shown, hiddenLines }
}

/** Lines of `lines` from `from` on, `\ No newline at end of file` markers skipped. */
function countContentLines(lines: readonly string[], from: number): number {
  let n = 0
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i]!.charAt(0) !== '\\') n += 1
  }
  return n
}
