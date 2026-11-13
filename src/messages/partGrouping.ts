/**
 * Slice-grouping for message parts: consecutive tool-calls fold into one
 * tool group, reasoning into one ReasoningGroup. Text ends a tool group: a
 * run absorbs only the reasoning (and blank text) between its calls, the
 * reasoning in front of its first call, and trailing reasoning. The text
 * directly in front of a run is that run's narration: it is not part of the
 * run's range, and is named by `narrationIndex` instead of standing alone.
 */

/**
 * Type label for a text part with nothing to show. It neither ends a run nor
 * narrates one. The caller assigns it; a part's own type is still `text`.
 */
export const BLANK_TEXT_PART = 'text-blank'

export type SliceRange =
  | {
      kind: 'tool-group'
      startIndex: number
      endIndex: number
      /** Count of `tool-call` parts inside [startIndex..endIndex]; excludes
       *  absorbed text parts. Consumers use this for the wrap decision
       *  (collapsible only when ≥2 actual tool calls) and for the "Used N
       *  tools" label. */
      toolCallCount: number
      /** Count of absorbed `reasoning` parts. Any reasoning makes the run a
       *  card even with one tool-call: the thought is a row of its own. */
      reasoningCount: number
      /** The text part that introduces this run, when one sits directly in
       *  front of it. Outside [startIndex..endIndex]; rendered with the run. */
      narrationIndex?: number
    }
  | { kind: 'reasoning-group'; startIndex: number; endIndex: number }
  | { kind: 'single'; index: number }

/**
 * Group adjacent `tool-call` / `reasoning` parts of a slice into ranges; other
 * types are `single`; a gap in `indices` breaks the run. Length-1 runs are
 * still groups (callers decide whether to wrap them).
 *
 * @param types  full message-part type array, indexed by underlying part position
 * @param indices subset of indices to group (must be sorted, may have gaps)
 */
export function groupSliceByPartType(
  types: readonly string[],
  indices: readonly number[],
): SliceRange[] {
  if (indices.length === 0) return []

  // Build a reverse map from underlying index → position in `indices` so we
  // can answer "is index X in this slice?" cheaply during the leading-text
  // look-behind pass. The slice may have gaps, so we can't just compare to
  // `indices[i-1]`.
  const sliceContains = new Set<number>(indices)

  const ranges: SliceRange[] = []
  let i = 0
  while (i < indices.length) {
    const start = indices[i]!
    const type = types[start]

    if (type === 'tool-call') {
      let j = i
      let toolCallCount = 1
      let reasoningCount = 0
      while (j + 1 < indices.length) {
        // Scan the adjacent stretch of reasoning / blank text after the last
        // absorbed part. If it leads to an adjacent tool-call, the stretch is
        // part of the run (between-call thinking). Text is not interstitial:
        // it ends the run, and narrates the next one if a call follows it.
        let k = j + 1
        let stretchReasoning = 0
        let trailingReasoningEnd = j
        let sawBlank = false
        while (
          k < indices.length &&
          indices[k]! === indices[k - 1]! + 1 &&
          isInterstitial(types[indices[k]!])
        ) {
          if (types[indices[k]!] === 'reasoning') {
            stretchReasoning++
            if (!sawBlank) trailingReasoningEnd = k
          } else {
            sawBlank = true
          }
          k++
        }
        if (
          k < indices.length &&
          indices[k]! === indices[k - 1]! + 1 &&
          types[indices[k]!] === 'tool-call'
        ) {
          j = k
          toolCallCount++
          reasoningCount += stretchReasoning
          continue
        }
        // No tool-call follows: keep only the reasoning that directly trails
        // the run (the model thinking about its next step — it streams before
        // the next call exists, so absorbing it now keeps the card from
        // re-laying out when that call lands).
        reasoningCount += trailingReasoningEnd - j
        j = trailingReasoningEnd
        break
      }

      let runStart = indices[i]!
      const runEnd = indices[j]!

      // Leading absorption. The parts in front of the first call were
      // already visited and emitted as `single` / `reasoning-group` ranges
      // (they are in the slice by construction). Reasoning and blank text
      // adjacent to the run join it; the first real text met going backwards
      // becomes the run's narration and the walk stops there.
      let back = ranges.length
      let leadingReasoning = 0
      let expectedEnd = runStart - 1
      let narrationIndex: number | undefined
      while (back > 0) {
        const prior = ranges[back - 1]!
        if (prior.kind === 'reasoning-group') {
          if (prior.endIndex !== expectedEnd) break
          leadingReasoning += prior.endIndex - prior.startIndex + 1
          expectedEnd = prior.startIndex - 1
          back--
          continue
        }
        if (prior.kind !== 'single' || prior.index !== expectedEnd) break
        if (types[prior.index] === BLANK_TEXT_PART) {
          expectedEnd = prior.index - 1
          back--
          continue
        }
        if (types[prior.index] === 'text') {
          narrationIndex = prior.index
          back--
        }
        break
      }
      if (back < ranges.length) {
        runStart =
          narrationIndex === undefined ? expectedEnd + 1 : narrationIndex + 1
        reasoningCount += leadingReasoning
        ranges.length = back
      }

      ranges.push({
        kind: 'tool-group',
        startIndex: runStart,
        endIndex: runEnd,
        toolCallCount,
        reasoningCount,
        ...(narrationIndex === undefined ? {} : { narrationIndex }),
      })
      i = j + 1
      continue
    }

    if (type === 'reasoning') {
      let j = i
      while (
        j + 1 < indices.length &&
        types[indices[j + 1]!] === 'reasoning' &&
        indices[j + 1]! === indices[j]! + 1
      ) {
        j++
      }
      ranges.push({
        kind: 'reasoning-group',
        startIndex: indices[i]!,
        endIndex: indices[j]!,
      })
      i = j + 1
      continue
    }

    ranges.push({ kind: 'single', index: start })
    i++
  }
  return ranges
}

/** A part that may sit between two tool-calls of one run. */
function isInterstitial(type: string | undefined): boolean {
  return type === 'reasoning' || type === BLANK_TEXT_PART
}
