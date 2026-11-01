/**
 * Where a chapter mark lands in the rendered thread (F-37). A mark names transcript entries by uuid,
 * never by line: lines are renumbered by a fork or rewind, uuids are not. Resolution is strict — the
 * uuid's entry must be loaded and must map to a rendered row, or the mark is unavailable; nothing is
 * guessed from a neighbouring line or a proportional position.
 */

/** The part of a rendered row the resolver reads. */
export type AnchorRow = {
  id?: unknown
  metadata?: unknown
}

/** The part of a transcript entry the resolver reads. */
export type AnchorEntry = {
  uuid?: unknown
  transcriptLine?: unknown
}

/** A chapter's target: the row's first entry, and optionally a later entry folded into that row. */
export type ChapterTarget = {
  entryKey: string
  segmentKey?: string
}

export type ChapterAnchor =
  | { kind: 'row'; index: number; ordinal?: number }
  | { kind: 'loading' }
  | { kind: 'unavailable' }

function lineRangeOf(row: AnchorRow): { from: number; to: number } | null {
  const custom = (row.metadata as { custom?: Record<string, unknown> } | undefined)?.custom
  const from = custom?.lineFrom
  const to = custom?.lineTo
  return typeof from === 'number' && typeof to === 'number' ? { from, to } : null
}

function rowCoveringLine(rows: readonly AnchorRow[], line: number): number {
  return rows.findIndex(row => {
    const range = lineRangeOf(row)
    return range !== null && line >= range.from && line <= range.to
  })
}

/**
 * Resolves `target` against the loaded transcript `entries` and the rendered `rows`. `loading` while
 * either is still empty; `unavailable` once loaded and the entry or its row cannot be found exactly.
 */
export function resolveChapterAnchor(
  rows: readonly AnchorRow[],
  entries: readonly AnchorEntry[],
  target: ChapterTarget,
): ChapterAnchor {
  if (entries.length === 0 || rows.length === 0) return { kind: 'loading' }
  const key = target.segmentKey ?? target.entryKey
  const entry = entries.find(candidate => candidate.uuid === key)
  if (!entry) return { kind: 'unavailable' }
  const line = typeof entry.transcriptLine === 'number' ? entry.transcriptLine : undefined

  if (target.segmentKey === undefined) {
    const direct = rows.findIndex(row => row.id === target.entryKey)
    if (direct >= 0) return { kind: 'row', index: direct }
    const covering = line === undefined ? -1 : rowCoveringLine(rows, line)
    return covering >= 0 ? { kind: 'row', index: covering } : { kind: 'unavailable' }
  }

  if (line === undefined) return { kind: 'unavailable' }
  const owner = rows.findIndex(row => row.id === target.entryKey)
  const index = owner >= 0 && covers(rows[owner]!, line) ? owner : rowCoveringLine(rows, line)
  return index >= 0 ? { kind: 'row', index, ordinal: line } : { kind: 'unavailable' }
}

function covers(row: AnchorRow, line: number): boolean {
  const range = lineRangeOf(row)
  return range === null || (line >= range.from && line <= range.to)
}

/**
 * The entries a mark is checked against on the page: the loaded transcript, then the live events. A
 * finished turn keeps rendering from its live events until the transcript is fetched again, and those
 * are already saved, under the uuids their rows carry; a running turn's rows use derived ids that match
 * none of them.
 */
export function chapterEntriesOf(
  transcript: readonly AnchorEntry[],
  live: readonly unknown[],
): readonly AnchorEntry[] {
  return live.length === 0 ? transcript : [...transcript, ...(live as readonly AnchorEntry[])]
}

/** The entry a row id names: its uuid, or the pending-bubble id a landed mid-turn prompt carries. */
function entryNamedBy(rowId: string, entries: readonly AnchorEntry[]): AnchorEntry | undefined {
  const id = rowId.replace(/:duplicate-\d+$/, '')
  return entries.find(
    entry =>
      entry.uuid === id ||
      (entry as { attachment?: { source_uuid?: unknown } }).attachment?.source_uuid === id,
  )
}

/**
 * The uuid of the first transcript entry behind `row`: the entry its id names (a repeated row's
 * `:duplicate-N` suffix dropped; a landed mid-turn prompt by the id it was sent under), else the entry on
 * the first line of its range (the conversation's closing reply renders under a turn-derived id). Null for
 * a row with neither — a live turn that is not written yet.
 */
export function entryKeyOfRow(row: AnchorRow | undefined, entries: readonly AnchorEntry[]): string | null {
  if (!row) return null
  const named = typeof row.id === 'string' ? entryNamedBy(row.id, entries) : undefined
  if (typeof named?.uuid === 'string') return named.uuid
  const from = lineRangeOf(row)?.from
  if (from === undefined) return null
  const uuid = entries.find(entry => entry.transcriptLine === from)?.uuid
  return typeof uuid === 'string' ? uuid : null
}

/**
 * The chapter target for a right-click on `row` at transcript line `clickedLine` (the nearest
 * `data-line-ordinal`, when there is one). Null for a row that is not a persisted entry yet.
 */
export function chapterTargetFor(
  row: AnchorRow | undefined,
  clickedLine: number | null,
  entries: readonly AnchorEntry[],
): ChapterTarget | null {
  const entryKey = entryKeyOfRow(row, entries)
  if (entryKey === null) return null
  if (clickedLine === null) return { entryKey }
  const entry = entries.find(candidate => candidate.transcriptLine === clickedLine)
  const uuid = typeof entry?.uuid === 'string' ? entry.uuid : null
  return uuid && uuid !== entryKey ? { entryKey, segmentKey: uuid } : { entryKey }
}
