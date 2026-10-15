import { describe, expect, it } from 'vitest'
import {
  aggregateToolGroupStatus,
  summarizeToolNames,
} from '../utils/toolGroupStatus'

describe('aggregateToolGroupStatus', () => {
  it('returns zero counts for an empty group', () => {
    const status = aggregateToolGroupStatus([])

    expect(status.callTotal).toBe(0)
    expect(status.runningToolName).toBeUndefined()
    expect(status.runningSliceOffset).toBeUndefined()
    expect(status.hasError).toBe(false)
    expect(status.hasCancelled).toBe(false)
    expect(status.allCancelled).toBe(false)
    expect(status.allComplete).toBe(false)
    expect(status.toolNames).toEqual([])
  })

  it('ignores non-tool parts mixed into the group', () => {
    const status = aggregateToolGroupStatus([
      { type: 'text' },
      { type: 'reasoning' },
    ])

    expect(status.callTotal).toBe(0)
    expect(status.toolNames).toEqual([])
    expect(status.allComplete).toBe(false)
  })

  it('marks a single completed tool as allComplete', () => {
    const status = aggregateToolGroupStatus([
      {
        type: 'tool-call',
        toolName: 'browser_navigate',
        status: { type: 'complete' },
      },
    ])

    expect(status.callTotal).toBe(1)
    expect(status.toolNames).toEqual(['browser_navigate'])
    expect(status.allComplete).toBe(true)
    expect(status.runningToolName).toBeUndefined()
    expect(status.runningSliceOffset).toBeUndefined()
  })

  it('reports the most recent running tool and its 1-based position', () => {
    const status = aggregateToolGroupStatus([
      {
        type: 'tool-call',
        toolName: 'browser_navigate',
        status: { type: 'complete' },
      },
      {
        type: 'tool-call',
        toolName: 'browser_click',
        status: { type: 'running' },
      },
      {
        type: 'tool-call',
        toolName: 'browser_click',
        status: { type: 'running' },
      },
    ])

    expect(status.callTotal).toBe(3)
    // Agents run tools sequentially; the latest "running" entry is the one
    // actually in flight.
    expect(status.runningToolName).toBe('browser_click')
    expect(status.runningPosition).toBe(3)
    // Slice offset matches the array position of the latest running entry;
    // no text parts interleaved here so position-1 == slice-offset.
    expect(status.runningSliceOffset).toBe(2)
    expect(status.allComplete).toBe(false)
    expect(status.hasError).toBe(false)
  })

  it('returns the slice offset of the running tool when text parts are interleaved', () => {
    // Mirrors the Anthropic-bundled shape after grouping absorbs preamble
    // texts: [text, tool-call, text, tool-call, …]. The slice offset is
    // the array index inside the slice, NOT the 1-based tool position —
    // the consumer adds its own `startIndex` to recover the absolute
    // message-parts index for locating the running tool's preamble.
    const status = aggregateToolGroupStatus([
      { type: 'text' },
      {
        type: 'tool-call',
        toolName: 'browser_search',
        status: { type: 'complete' },
      },
      { type: 'text' },
      {
        type: 'tool-call',
        toolName: 'browser_navigate',
        status: { type: 'running' },
      },
    ])

    expect(status.callTotal).toBe(2)
    expect(status.runningToolName).toBe('browser_navigate')
    // 1-based position counts only tool-calls → 2.
    expect(status.runningPosition).toBe(2)
    // Slice offset counts all parts → 3 (the running tool sits at array
    // index 3 inside the slice, with the text preamble at slice[2]).
    expect(status.runningSliceOffset).toBe(3)
  })

  it('does not report a runningPosition or slice offset when nothing is running', () => {
    const status = aggregateToolGroupStatus([
      {
        type: 'tool-call',
        toolName: 'browser_navigate',
        status: { type: 'complete' },
      },
      {
        type: 'tool-call',
        toolName: 'browser_click',
        status: { type: 'complete' },
      },
    ])

    expect(status.runningToolName).toBeUndefined()
    expect(status.runningPosition).toBeUndefined()
    expect(status.runningSliceOffset).toBeUndefined()
    expect(status.allComplete).toBe(true)
  })

  it('flags non-cancelled incomplete results as errors', () => {
    const status = aggregateToolGroupStatus([
      {
        type: 'tool-call',
        toolName: 'browser_navigate',
        status: { type: 'complete' },
      },
      {
        type: 'tool-call',
        toolName: 'browser_click',
        status: { type: 'incomplete', reason: 'error' },
      },
    ])

    expect(status.hasError).toBe(true)
    expect(status.hasCancelled).toBe(false)
    expect(status.allCancelled).toBe(false)
  })

  it('treats cancellation separately from error', () => {
    const status = aggregateToolGroupStatus([
      {
        type: 'tool-call',
        toolName: 'browser_navigate',
        status: { type: 'incomplete', reason: 'cancelled' },
      },
      {
        type: 'tool-call',
        toolName: 'browser_click',
        status: { type: 'incomplete', reason: 'cancelled' },
      },
    ])

    expect(status.hasCancelled).toBe(true)
    expect(status.hasError).toBe(false)
    expect(status.allCancelled).toBe(true)
  })

  it('does not mark allCancelled when only some parts cancelled', () => {
    const status = aggregateToolGroupStatus([
      {
        type: 'tool-call',
        toolName: 'browser_navigate',
        status: { type: 'complete' },
      },
      {
        type: 'tool-call',
        toolName: 'browser_click',
        status: { type: 'incomplete', reason: 'cancelled' },
      },
    ])

    expect(status.hasCancelled).toBe(true)
    expect(status.allCancelled).toBe(false)
  })
})

describe('summarizeToolNames', () => {
  it('returns an empty string for no names', () => {
    expect(summarizeToolNames([])).toBe('')
  })

  it('joins distinct names within the cap', () => {
    expect(summarizeToolNames(['a', 'b'])).toBe('a, b')
  })

  it('deduplicates repeated tool names while preserving order', () => {
    expect(
      summarizeToolNames(['browser_navigate', 'browser_click', 'browser_navigate']),
    ).toBe('browser_navigate, browser_click')
  })

  it('truncates with an ellipsis when distinct names exceed the cap', () => {
    expect(summarizeToolNames(['a', 'b', 'c', 'd', 'e'], 3)).toBe('a, b, c…')
  })

  it('does not truncate when distinct names equal the cap exactly', () => {
    expect(summarizeToolNames(['a', 'b', 'c'], 3)).toBe('a, b, c')
  })
})
