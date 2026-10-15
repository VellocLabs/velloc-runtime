/**
 * The number of physical lines a transcript load read, carried on the loaded
 * array so the store can number later appends without re-reading. Absent when
 * the load cannot vouch for it (no trailing newline, backend does not count).
 */
const PHYSICAL_LINE_COUNT = Symbol('transcriptPhysicalLineCount')

export function stampTranscriptLineCount(entries: object, count: number): void {
  Object.defineProperty(entries, PHYSICAL_LINE_COUNT, { value: count })
}

export function readTranscriptLineCount(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const count = (payload as { [PHYSICAL_LINE_COUNT]?: unknown })[PHYSICAL_LINE_COUNT]
  return typeof count === 'number' ? count : undefined
}
