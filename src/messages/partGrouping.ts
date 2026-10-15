/**
 * Slice-grouping for message parts, as assistant-ui groups whole messages:
 * consecutive tool-calls fold into one ToolGroup, reasoning into one
 * ReasoningGroup. A tool-call run also absorbs interstitial text/reasoning that
 * leads to the next call, a leading stretch when the run is a card, and
 * trailing reasoning; a trailing text (the reply) is never absorbed.
 */

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
        // Scan the adjacent interstitial stretch of text/reasoning after the
        // last absorbed part. If it leads to an adjacent tool-call, the whole
        // stretch is part of the run (bundled preambles and between-call
        // thinking). Without that lookahead we'd absorb a trailing
        // real-reply paragraph (the stop_reason='end_turn' case) by accident.
        let k = j + 1
        let stretchReasoning = 0
        let leadingReasoningEnd = j
        let sawText = false
        while (
          k < indices.length &&
          indices[k]! === indices[k - 1]! + 1 &&
          isInterstitial(types[indices[k]!])
        ) {
          if (types[indices[k]!] === 'reasoning') {
            stretchReasoning++
            if (!sawText) leadingReasoningEnd = k
          } else {
            sawText = true
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
        // re-laying out when that call lands). Text stops it: that is prose.
        reasoningCount += leadingReasoningEnd - j
        j = leadingReasoningEnd
        break
      }

      let runStart = indices[i]!
      const runEnd = indices[j]!

      // Leading absorption. The parts in front of the first call were
      // already visited and emitted as `single` text / `reasoning-group`
      // ranges; collect the adjacent stretch of them (they are in the slice
      // by construction) and pop it into the run when the run is a card —
      // ≥2 tool-calls, or any reasoning (a single call with no thought keeps
      // its "text + bare tool card" shape).
      let back = ranges.length
      let leadingReasoning = 0
      let expectedEnd = runStart - 1
      while (back > 0) {
        const prior = ranges[back - 1]!
        if (prior.kind === 'single') {
          if (prior.index !== expectedEnd || types[prior.index] !== 'text') break
          expectedEnd = prior.index - 1
        } else if (prior.kind === 'reasoning-group') {
          if (prior.endIndex !== expectedEnd) break
          leadingReasoning += prior.endIndex - prior.startIndex + 1
          expectedEnd = prior.startIndex - 1
        } else {
          break
        }
        back--
      }
      if (
        back < ranges.length &&
        (toolCallCount >= 2 || reasoningCount + leadingReasoning > 0)
      ) {
        runStart = expectedEnd + 1
        reasoningCount += leadingReasoning
        ranges.length = back
      }

      ranges.push({
        kind: 'tool-group',
        startIndex: runStart,
        endIndex: runEnd,
        toolCallCount,
        reasoningCount,
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
  return type === 'text' || type === 'reasoning'
}
