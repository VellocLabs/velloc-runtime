/**
 * Pure geometry and segmentation for the message list's virtualization. A row is active (in the window),
 * dormant (mounted, `content-visibility: auto`) or culled (merged into one spacer). Never culled: the
 * last `MESSAGE_TAIL_KEEP` rows (a pending ask registers while mounted) and rows the user interacted with
 * (row-local state would reset).
 */

/** Messages at the end of the transcript that are never culled (rule 1). */
export const MESSAGE_TAIL_KEEP = 12

/** Extra rendered height above and below the viewport, in viewport heights. */
export const MESSAGE_OVERSCAN_VIEWPORTS = 1.5

/** Floor for the overscan band, so a short/unmeasured viewport still buffers. */
export const MIN_MESSAGE_OVERSCAN_PX = 800

/**
 * Height assumed for a row that has never been measured. Only ever affects
 * the scrollbar's length before the user scrolls into that region — the real
 * height replaces it the moment the row mounts, and the component compensates
 * `scrollTop` for the difference so nothing visibly shifts.
 */
export const ESTIMATED_MESSAGE_HEIGHT_PX = 160

/**
 * Rows rendered on the very first commit, before any scroll geometry exists.
 * The thread locks to the bottom on open (see `conversationScrollLock`), so
 * the initial window is the tail.
 */
export const INITIAL_ACTIVE_TAIL = 20

/**
 * Measure-and-re-window passes the list runs synchronously after commits in
 * one task. Each pass that moves state commits again; the cap keeps rows whose
 * height keeps changing from chaining past React's nested-update limit.
 */
export const MAX_SYNC_REWINDOW_PASSES = 8

/** Upper bound on pinned rows, so a long clicking session can't pin the lot. */
export const MAX_PINNED_ROWS = 64

/** A rendered row, or a collapsed run of culled rows. */
export type VirtualSegment =
  | {
      kind: 'spacer'
      /** First culled index in the run. */
      from: number
      /** One past the last culled index in the run. */
      to: number
      /** Sum of the run's last measured heights. */
      height: number
    }
  | {
      kind: 'row'
      index: number
      /**
       * Outside the scroll window — render with `content-visibility: auto`.
       * Only ever set for a row that has been MEASURED: a dormant row is sized
       * by its frozen height, so freezing an estimate would pin a 40px row
       * open at the 160px guess with no way to correct itself.
       */
      dormant: boolean
      /** Last measured height, used as the dormant row's `min-height`. */
      frozenHeight: number
      /**
       * This row has been mounted before — it is being restored, not newly
       * received. Suppresses the message's entry animation so scrolling back
       * through history doesn't replay a fade-in per row.
       */
      restored: boolean
    }

/** Half-open window of message indices rendered without a size override. */
export type MessageRange = { start: number; end: number }

export function rangesEqual(a: MessageRange, b: MessageRange): boolean {
  return a.start === b.start && a.end === b.end
}

/**
 * Prefix sums of `heights`. `offsets[i]` is the top of row `i` and
 * `offsets[count]` is the total content height, so the result is one longer
 * than the input.
 */
export function computeOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1)
  offsets[0] = 0
  let total = 0
  for (let i = 0; i < heights.length; i++) {
    total += heights[i] ?? 0
    offsets[i + 1] = total
  }
  return offsets
}

/** Overscan band for a viewport of `clientHeight` px. */
export function overscanPxForViewport(clientHeight: number): number {
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) {
    return MIN_MESSAGE_OVERSCAN_PX
  }
  return Math.max(
    MIN_MESSAGE_OVERSCAN_PX,
    Math.round(clientHeight * MESSAGE_OVERSCAN_VIEWPORTS),
  )
}

/** Index of the last row whose top is `<= value`, via binary search. */
function lastRowStartingAtOrBefore(
  offsets: readonly number[],
  count: number,
  value: number,
): number {
  let lo = 0
  let hi = count - 1
  let result = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= value) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/**
 * The half-open range of rows that intersect the viewport once padded by
 * `overscanPx` on both sides. Always returns a non-empty range for a
 * non-empty list so there is never a frame with nothing rendered.
 */
export function computeVisibleRange(params: {
  offsets: readonly number[]
  count: number
  scrollTop: number
  clientHeight: number
  overscanPx: number
}): MessageRange {
  const { offsets, count, scrollTop, clientHeight, overscanPx } = params
  if (count <= 0) return { start: 0, end: 0 }

  const top = scrollTop - overscanPx
  const bottom = scrollTop + clientHeight + overscanPx

  const start = lastRowStartingAtOrBefore(offsets, count, top)

  // First row that begins at or after the padded bottom edge — everything
  // before it overlaps the band.
  let end = start + 1
  while (end < count && offsets[end] < bottom) end++

  return { start, end: Math.min(count, Math.max(end, start + 1)) }
}

/**
 * Turn the window + keep-rules into the render list: rows for everything that
 * stays mounted, one spacer per contiguous run of culled rows.
 */
export function buildMessageSegments(params: {
  count: number
  range: MessageRange
  heights: readonly number[]
  /** Per-index: has this row ever reported a real height? */
  measured?: readonly boolean[]
  tailKeep?: number
  pinned?: ReadonlySet<number>
  /**
   * Whether row `index` has its content yet (see `historyContentWindow.ts`).
   * A kept row whose content has not arrived renders as part of a spacer for
   * the one commit it takes to arrive, so it is never mounted — or measured —
   * empty. Absent = every row has its content.
   */
  materialized?: (index: number) => boolean
}): VirtualSegment[] {
  const { count, range, heights, measured, materialized } = params
  const tailKeep = params.tailKeep ?? MESSAGE_TAIL_KEEP
  const pinned = params.pinned
  const tailStart = Math.max(0, count - tailKeep)

  const segments: VirtualSegment[] = []
  let spacer: { from: number; to: number; height: number } | null = null

  const flush = (): void => {
    if (!spacer) return
    segments.push({ kind: 'spacer', ...spacer })
    spacer = null
  }

  for (let index = 0; index < count; index++) {
    const inWindow = index >= range.start && index < range.end
    const kept =
      (inWindow || index >= tailStart || pinned?.has(index) === true) &&
      (materialized === undefined || materialized(index))
    if (!kept) {
      const height = heights[index] ?? ESTIMATED_MESSAGE_HEIGHT_PX
      if (spacer && spacer.to === index) {
        spacer.to = index + 1
        spacer.height += height
      } else {
        flush()
        spacer = { from: index, to: index + 1, height }
      }
      continue
    }
    flush()
    const isMeasured = measured?.[index] === true
    segments.push({
      kind: 'row',
      index,
      dormant: !inWindow && isMeasured,
      frozenHeight: heights[index] ?? ESTIMATED_MESSAGE_HEIGHT_PX,
      restored: isMeasured,
    })
  }
  flush()
  return segments
}

/**
 * The rows `buildMessageSegments` keeps mounted (window, tail, pins), in
 * ascending order — before content availability is considered. This is what
 * the virtualizer asks to have materialized; deciding it without looking at
 * what IS materialized is what keeps the request from feeding back on itself.
 */
export function collectKeptRows(params: {
  count: number
  range: MessageRange
  tailKeep?: number
  pinned?: ReadonlySet<number>
}): number[] {
  const { count, range, pinned } = params
  const tailStart = Math.max(0, count - (params.tailKeep ?? MESSAGE_TAIL_KEEP))
  const rows: number[] = []
  for (let index = 0; index < count; index++) {
    if (
      (index >= range.start && index < range.end) ||
      index >= tailStart ||
      pinned?.has(index) === true
    ) {
      rows.push(index)
    }
  }
  return rows
}

/**
 * Add `index` to `pinned`, evicting the oldest entry past `MAX_PINNED_ROWS`.
 * `Set` iterates in insertion order, so the first key is the oldest pin.
 * Returns true when the set changed.
 */
export function pinMessageRow(
  pinned: Set<number>,
  index: number,
  max = MAX_PINNED_ROWS,
): boolean {
  if (pinned.has(index)) return false
  pinned.add(index)
  while (pinned.size > max) {
    const oldest = pinned.values().next()
    if (oldest.done) break
    pinned.delete(oldest.value)
  }
  return true
}
