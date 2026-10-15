import { describe, expect, it } from 'vitest'
import { isValidElement } from 'react'
import { groupSliceByPartType } from '../messages/partGrouping'
import { renderSliceWithGrouping } from '../components/assistant-ui/assistant-message-body'

describe('groupSliceByPartType', () => {
  it('returns an empty array for an empty slice', () => {
    expect(groupSliceByPartType([], [])).toEqual([])
  })

  it('emits a single-element tool-group for one tool-call', () => {
    const types = ['tool-call']
    expect(groupSliceByPartType(types, [0])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 0, toolCallCount: 1, reasoningCount: 0 },
    ])
  })

  it('emits a single-element reasoning-group for one reasoning part', () => {
    const types = ['reasoning']
    expect(groupSliceByPartType(types, [0])).toEqual([
      { kind: 'reasoning-group', startIndex: 0, endIndex: 0 },
    ])
  })

  it('groups a run of consecutive adjacent tool-calls', () => {
    const types = ['tool-call', 'tool-call', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 2, toolCallCount: 3, reasoningCount: 0 },
    ])
  })

  it('groups a run of consecutive adjacent reasoning parts', () => {
    const types = ['reasoning', 'reasoning']
    expect(groupSliceByPartType(types, [0, 1])).toEqual([
      { kind: 'reasoning-group', startIndex: 0, endIndex: 1 },
    ])
  })

  it('emits a single range for non-grouping types like text', () => {
    const types = ['text']
    expect(groupSliceByPartType(types, [0])).toEqual([
      { kind: 'single', index: 0 },
    ])
  })

  it('breaks runs across mixed types', () => {
    // The tool-call run absorbs the immediately-preceding text since the run
    // has 2 tool-calls; the reply text after it stays separate, and so does
    // the reasoning after the reply (no tool-call beside it).
    const types = ['text', 'tool-call', 'tool-call', 'text', 'reasoning']
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 2, toolCallCount: 2, reasoningCount: 0 },
      { kind: 'single', index: 3 },
      { kind: 'reasoning-group', startIndex: 4, endIndex: 4 },
    ])
  })

  it('breaks a tool-call run when the slice indices are not adjacent', () => {
    // Underlying message has a non-tool part at index 2; the slice skips it.
    // Even though the slice's own positions are consecutive (0, 1, 2 of the
    // slice array), the *underlying* indices [0, 1, 3] have a gap and the run
    // must break at the gap.
    const types = ['tool-call', 'tool-call', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 3])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 1, toolCallCount: 2, reasoningCount: 0 },
      { kind: 'tool-group', startIndex: 3, endIndex: 3, toolCallCount: 1, reasoningCount: 0 },
    ])
  })

  it('breaks a reasoning run when the slice indices are not adjacent', () => {
    const types = ['reasoning', 'text', 'reasoning']
    expect(groupSliceByPartType(types, [0, 2])).toEqual([
      { kind: 'reasoning-group', startIndex: 0, endIndex: 0 },
      { kind: 'reasoning-group', startIndex: 2, endIndex: 2 },
    ])
  })

  it('handles a slice that starts in the middle of the message', () => {
    const types = ['text', 'text', 'tool-call', 'tool-call', 'text']
    expect(groupSliceByPartType(types, [2, 3, 4])).toEqual([
      { kind: 'tool-group', startIndex: 2, endIndex: 3, toolCallCount: 2, reasoningCount: 0 },
      { kind: 'single', index: 4 },
    ])
  })

  // --- Reasoning is a row of the tool run, not a break in it ---

  it('folds reasoning interleaved with tools into ONE run (the reported shape)', () => {
    // reasoning1 tool2 tool3 reasoning4 tool5 tool6 used to render as four
    // surfaces (reasoning, card, reasoning, card). It is one card, six rows.
    const types = [
      'reasoning', 'tool-call', 'tool-call',
      'reasoning', 'tool-call', 'tool-call',
    ]
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4, 5])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 5, toolCallCount: 4, reasoningCount: 2 },
    ])
  })

  it('absorbs a mixed text/reasoning stretch between two calls', () => {
    // Interleaved thinking: [thinking, text, tool_use] per step, flattened.
    const types = ['tool-call', 'reasoning', 'text', 'reasoning', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 4, toolCallCount: 2, reasoningCount: 2 },
    ])
  })

  it('absorbs trailing reasoning after the last call, but not the reply after it', () => {
    // Mid-stream the thought arrives before the next call exists; absorbing it
    // now means the card does not re-lay out when that call lands. A text
    // after it is the reply and stays outside.
    const types = ['tool-call', 'reasoning', 'reasoning', 'text']
    expect(groupSliceByPartType(types, [0, 1, 2, 3])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 2, toolCallCount: 1, reasoningCount: 2 },
      { kind: 'single', index: 3 },
    ])
  })

  it('does not absorb reasoning that sits after a trailing text', () => {
    const types = ['tool-call', 'text', 'reasoning']
    expect(groupSliceByPartType(types, [0, 1, 2])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 0, toolCallCount: 1, reasoningCount: 0 },
      { kind: 'single', index: 1 },
      { kind: 'reasoning-group', startIndex: 2, endIndex: 2 },
    ])
  })

  it('absorbs leading reasoning (and the text after it) even for a single call', () => {
    // Any reasoning makes the run a card, so the leading stretch joins it.
    const types = ['reasoning', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 2, toolCallCount: 1, reasoningCount: 1 },
    ])
  })

  it('leaves reasoning with no tool-call beside it as a reasoning-group', () => {
    const types = ['reasoning', 'text']
    expect(groupSliceByPartType(types, [0, 1])).toEqual([
      { kind: 'reasoning-group', startIndex: 0, endIndex: 0 },
      { kind: 'single', index: 1 },
    ])
  })

  it('does not reach across a slice gap or an isolated tool for reasoning', () => {
    // Index 2 is outside the slice; index 4 is an isolated (standalone) tool.
    const types = ['tool-call', 'reasoning', 'tool-call', 'reasoning', 'tool-call-isolated', 'reasoning', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 3, 4, 5, 6])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 1, toolCallCount: 1, reasoningCount: 1 },
      { kind: 'reasoning-group', startIndex: 3, endIndex: 3 },
      { kind: 'single', index: 4 },
      { kind: 'tool-group', startIndex: 5, endIndex: 6, toolCallCount: 1, reasoningCount: 1 },
    ])
  })

  // --- Anthropic bundled-preamble absorption ---

  it('absorbs interstitial text between adjacent tool-calls', () => {
    // The shape Anthropic emits after `mergeConsecutiveAssistantMessages`
    // flattens multiple [text, tool-call] turns: text breaks the run by
    // type, but the next-after-text is itself an adjacent tool-call so it
    // should be absorbed.
    const types = ['tool-call', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 2, toolCallCount: 2, reasoningCount: 0 },
    ])
  })

  it('absorbs leading text in front of a multi-tool run', () => {
    // [text, tool-call, text, tool-call] is the canonical merged-Anthropic
    // shape. The leading text is absorbed because the run has ≥2 tool-calls.
    const types = ['text', 'tool-call', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2, 3])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 3, toolCallCount: 2, reasoningCount: 0 },
    ])
  })

  it('does NOT absorb leading text for a single-tool run', () => {
    // A single tool call (the bundle from one Anthropic turn) keeps the
    // text as a separate `single` so the existing "text + bare tool card"
    // visual stays intact. ToolGroupImpl unwraps the size-1 group.
    const types = ['text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1])).toEqual([
      { kind: 'single', index: 0 },
      { kind: 'tool-group', startIndex: 1, endIndex: 1, toolCallCount: 1, reasoningCount: 0 },
    ])
  })

  it('does NOT absorb trailing real-prose text (stop_reason: end_turn)', () => {
    // The sample-log shape: a multi-turn tool run followed by a final
    // assistant message with prose only. The trailing text has no
    // following tool-call so the algorithm must leave it as a `single`.
    const types = ['text', 'tool-call', 'text', 'tool-call', 'text']
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 3, toolCallCount: 2, reasoningCount: 0 },
      { kind: 'single', index: 4 },
    ])
  })

  it('absorbs multiple interstitial texts across a long run', () => {
    // Continuous N-turn agent run, fully bundled.
    const types = [
      'text', 'tool-call',
      'text', 'tool-call',
      'text', 'tool-call',
      'text', 'tool-call',
    ]
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4, 5, 6, 7])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 7, toolCallCount: 4, reasoningCount: 0 },
    ])
  })

  it('does not absorb a non-adjacent leading text outside the slice', () => {
    // Underlying parts: [text (0), other (1), tool-call (2), text (3), tool-call (4)]
    // Slice excludes index 1; even though candidate=1 is text-adjacent to
    // the run, sliceContains[1] is false. With leading-absorb skipped, the
    // text at index 0 is also non-adjacent to the run start (2) so it
    // stays as a single. The interstitial text at 3 still absorbs.
    const types = ['text', 'other', 'tool-call', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 2, 3, 4])).toEqual([
      { kind: 'single', index: 0 },
      { kind: 'tool-group', startIndex: 2, endIndex: 4, toolCallCount: 2, reasoningCount: 0 },
    ])
  })

  // --- Ungroupable tool types (e.g. AskUserQuestion sentinel) ---
  //
  // The consumer rewrites AskUserQuestion `tool-call` parts to a sentinel
  // string before grouping. The helper itself only knows the literal
  // `'tool-call'` / `'reasoning'` types — anything else is a `single`.
  // These tests pin that contract.

  it('does not merge a non-tool-call sentinel into a tool-call run', () => {
    const types = ['tool-call', 'tool-call-isolated', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 0, toolCallCount: 1, reasoningCount: 0 },
      { kind: 'single', index: 1 },
      { kind: 'tool-group', startIndex: 2, endIndex: 2, toolCallCount: 1, reasoningCount: 0 },
    ])
  })

  it('does not absorb interstitial text across an isolated tool sentinel', () => {
    // [tool, text, isolated, text, tool] — without the rewrite this would
    // be one big group; with the sentinel the run breaks at the isolated
    // tool and the surrounding texts also stay separate (no following
    // adjacent tool-call after each one).
    const types = [
      'tool-call',
      'text',
      'tool-call-isolated',
      'text',
      'tool-call',
    ]
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 0, toolCallCount: 1, reasoningCount: 0 },
      { kind: 'single', index: 1 },
      { kind: 'single', index: 2 },
      { kind: 'single', index: 3 },
      { kind: 'tool-group', startIndex: 4, endIndex: 4, toolCallCount: 1, reasoningCount: 0 },
    ])
  })

  it('keeps clean adjacent multi-tool runs free of absorbed text', () => {
    // OpenAI-style: no Anthropic preamble between tool-calls. The
    // resulting group has zero absorbed-text indices, so consumers'
    // outer-prose path (gated on hasAbsorbedText) never activates.
    const types = ['tool-call', 'tool-call', 'tool-call']
    const result = groupSliceByPartType(types, [0, 1, 2])
    expect(result).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 2, toolCallCount: 3, reasoningCount: 0 },
    ])
    // The range size equals toolCallCount: no text parts inside.
    const range = result[0]
    if (range && range.kind === 'tool-group') {
      expect(range.endIndex - range.startIndex + 1).toBe(range.toolCallCount)
    }
  })
})

describe('renderSliceWithGrouping (every mapped element is keyed)', () => {
  // Every element of the mapped array must carry a key: a lone tool-call unwraps to a bare ToolFallback, and React
  // reconciles keyless ranges by index.
  const allKeyed = (nodes: readonly unknown[]): boolean =>
    nodes.length > 0 &&
    nodes.every(
      n => isValidElement(n) && (n as { key: string | null }).key != null,
    )

  it('keys a lone tool-call range (tool-group count=1 — the bug case)', () => {
    const nodes = renderSliceWithGrouping(['tool-call'], [0])
    expect(nodes.length).toBe(1)
    expect(allKeyed(nodes)).toBe(true)
  })

  it('keys every element of a mixed single + tool-group + reasoning-group slice', () => {
    const nodes = renderSliceWithGrouping(
      // The text between the call and the reasoning keeps the reasoning out
      // of the run, so all three range kinds appear.
      ['text', 'tool-call', 'text', 'reasoning'],
      [0, 1, 2, 3],
    )
    expect(nodes.length).toBeGreaterThan(1)
    expect(allKeyed(nodes)).toBe(true)
  })
})
