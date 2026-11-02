/**
 * The chapter rail's reading of the thread viewport (F-37): which chapter the reader is in, given where
 * each chapter's row sits. Pure, so it is testable without layout; the rail measures and calls it.
 */

/** How far below the viewport's top a chapter's row must have reached to be the one being read. */
export const CHAPTER_READ_LINE_PX = 64
/** Within this distance of the bottom, the last chapter is the one being read. */
export const CHAPTER_BOTTOM_SLACK_PX = 8

/** The rail's own entry for the conversation's beginning, before any mark. */
export const SESSION_START_ID = 'session-start'

/** One rail entry's place: its row index, and its row's top relative to the viewport top when mounted. */
export type RailPlace = {
  id: string
  /** Row index in the thread; -1 for the session start (before every row). */
  index: number
  /** Pixels from the viewport's top to the row's top; null when the row is not mounted. */
  top: number | null
}

export type ViewportGeometry = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** Index of the first row whose box reaches the read line; null when no row is mounted. */
  firstRowAtReadLine: number | null
}

/**
 * The id of the chapter being read: the last entry whose row has reached the read line. A row that is
 * not mounted counts as above the line when its index precedes the first mounted row at the line, and
 * below it otherwise. A viewport scrolled to its end reads the last entry. `places` must be in
 * conversation order and start with the session start.
 */
export function activeChapterId(places: readonly RailPlace[], view: ViewportGeometry): string | null {
  if (places.length === 0) return null
  const scrollable = view.scrollHeight > view.clientHeight + 1
  if (scrollable && view.scrollHeight - view.scrollTop - view.clientHeight <= CHAPTER_BOTTOM_SLACK_PX) {
    return places[places.length - 1]!.id
  }
  let active = places[0]!.id
  for (const place of places) {
    if (place.index < 0) continue
    const reached =
      place.top !== null
        ? place.top <= CHAPTER_READ_LINE_PX
        : view.firstRowAtReadLine !== null && place.index < view.firstRowAtReadLine
    if (reached) active = place.id
  }
  return active
}
