import { describe, expect, it } from 'vitest'
import { isValidElement } from 'react'
import { BLANK_TEXT_PART, groupSliceByPartType } from '../messages/partGrouping'
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
    // The text in front of the run narrates it; the reply text after it
    // stays separate, and so does the reasoning after the reply.
    const types = ['text', 'tool-call', 'tool-call', 'text', 'reasoning']
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4])).toEqual([
      { kind: 'tool-group', startIndex: 1, endIndex: 2, toolCallCount: 2, reasoningCount: 0, narrationIndex: 0 },
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

  it('splits at the text inside a mixed text/reasoning stretch', () => {
    // [call, thought, text, thought, call]: the first thought trails the
    // first run; the text narrates the second, which takes the thought
    // between the text and its call.
    const types = ['tool-call', 'reasoning', 'text', 'reasoning', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 1, toolCallCount: 1, reasoningCount: 1 },
      { kind: 'tool-group', startIndex: 3, endIndex: 4, toolCallCount: 1, reasoningCount: 1, narrationIndex: 2 },
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

  it('takes the text in front of a call as narration, and leaves a thought before that text alone', () => {
    const types = ['reasoning', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2])).toEqual([
      { kind: 'reasoning-group', startIndex: 0, endIndex: 0 },
      { kind: 'tool-group', startIndex: 2, endIndex: 2, toolCallCount: 1, reasoningCount: 0, narrationIndex: 1 },
    ])
  })

  it('absorbs a thought between the narration and the first call', () => {
    const types = ['text', 'reasoning', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2])).toEqual([
      { kind: 'tool-group', startIndex: 1, endIndex: 2, toolCallCount: 1, reasoningCount: 1, narrationIndex: 0 },
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

  it('text between two tool-calls ends the first run and narrates the second', () => {
    const types = ['tool-call', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 0, toolCallCount: 1, reasoningCount: 0 },
      { kind: 'tool-group', startIndex: 2, endIndex: 2, toolCallCount: 1, reasoningCount: 0, narrationIndex: 1 },
    ])
  })

  it('each narrated call is its own run', () => {
    const types = ['text', 'tool-call', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2, 3])).toEqual([
      { kind: 'tool-group', startIndex: 1, endIndex: 1, toolCallCount: 1, reasoningCount: 0, narrationIndex: 0 },
      { kind: 'tool-group', startIndex: 3, endIndex: 3, toolCallCount: 1, reasoningCount: 0, narrationIndex: 2 },
    ])
  })

  it('calls with no text between them stay one run under one narration', () => {
    const types = ['text', 'tool-call', 'tool-call', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1, 2, 3])).toEqual([
      { kind: 'tool-group', startIndex: 1, endIndex: 3, toolCallCount: 3, reasoningCount: 0, narrationIndex: 0 },
    ])
  })

  it('a single call takes the text in front of it as narration', () => {
    const types = ['text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 1])).toEqual([
      { kind: 'tool-group', startIndex: 1, endIndex: 1, toolCallCount: 1, reasoningCount: 0, narrationIndex: 0 },
    ])
  })

  it('trailing text with no call after it stays a single', () => {
    const types = ['text', 'tool-call', 'text', 'tool-call', 'text']
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4])).toEqual([
      { kind: 'tool-group', startIndex: 1, endIndex: 1, toolCallCount: 1, reasoningCount: 0, narrationIndex: 0 },
      { kind: 'tool-group', startIndex: 3, endIndex: 3, toolCallCount: 1, reasoningCount: 0, narrationIndex: 2 },
      { kind: 'single', index: 4 },
    ])
  })

  it('a long narrated run is one run per narration', () => {
    const types = [
      'text', 'tool-call',
      'text', 'tool-call', 'tool-call',
      'text', 'tool-call',
    ]
    expect(groupSliceByPartType(types, [0, 1, 2, 3, 4, 5, 6])).toEqual([
      { kind: 'tool-group', startIndex: 1, endIndex: 1, toolCallCount: 1, reasoningCount: 0, narrationIndex: 0 },
      { kind: 'tool-group', startIndex: 3, endIndex: 4, toolCallCount: 2, reasoningCount: 0, narrationIndex: 2 },
      { kind: 'tool-group', startIndex: 6, endIndex: 6, toolCallCount: 1, reasoningCount: 0, narrationIndex: 5 },
    ])
  })

  it('blank text neither ends a run nor narrates one', () => {
    expect(
      groupSliceByPartType(['tool-call', BLANK_TEXT_PART, 'tool-call'], [0, 1, 2]),
    ).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 2, toolCallCount: 2, reasoningCount: 0 },
    ])
    // Walking back from the call: the thought and the blank join the run,
    // the real text in front of them narrates it.
    expect(
      groupSliceByPartType(
        ['text', BLANK_TEXT_PART, 'reasoning', 'tool-call'],
        [0, 1, 2, 3],
      ),
    ).toEqual([
      { kind: 'tool-group', startIndex: 1, endIndex: 3, toolCallCount: 1, reasoningCount: 1, narrationIndex: 0 },
    ])
    expect(groupSliceByPartType([BLANK_TEXT_PART, 'tool-call'], [0, 1])).toEqual([
      { kind: 'tool-group', startIndex: 0, endIndex: 1, toolCallCount: 1, reasoningCount: 0 },
    ])
  })

  it('a text under another label never narrates', () => {
    expect(groupSliceByPartType(['text-end-turn', 'tool-call'], [0, 1])).toEqual([
      { kind: 'single', index: 0 },
      { kind: 'tool-group', startIndex: 1, endIndex: 1, toolCallCount: 1, reasoningCount: 0 },
    ])
  })

  it('does not take a non-adjacent text as narration', () => {
    // Underlying parts: [text (0), other (1), tool-call (2), text (3), tool-call (4)].
    // The slice excludes index 1, so the text at 0 is not adjacent to the
    // call at 2. The text at 3 narrates the call at 4.
    const types = ['text', 'other', 'tool-call', 'text', 'tool-call']
    expect(groupSliceByPartType(types, [0, 2, 3, 4])).toEqual([
      { kind: 'single', index: 0 },
      { kind: 'tool-group', startIndex: 2, endIndex: 2, toolCallCount: 1, reasoningCount: 0 },
      { kind: 'tool-group', startIndex: 4, endIndex: 4, toolCallCount: 1, reasoningCount: 0, narrationIndex: 3 },
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

  it('an isolated tool sentinel breaks the run; the text after it narrates the next call', () => {
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
      { kind: 'tool-group', startIndex: 4, endIndex: 4, toolCallCount: 1, reasoningCount: 0, narrationIndex: 3 },
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
