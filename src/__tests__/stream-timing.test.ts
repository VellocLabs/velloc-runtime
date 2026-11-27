import { afterEach, describe, expect, it } from 'vitest'
import {
  publishStreamTimings,
  resetStreamTimings,
  STREAM_TIMINGS_MAX,
  StreamTimingTracker,
  takeStreamTimings,
} from '../models/drivers/streamTiming'

afterEach(() => resetStreamTimings())

function clocked() {
  let now = 1000
  const tracker = new StreamTimingTracker(() => now)
  return { tracker, at: (ms: number) => { now = ms } }
}

describe('stream timing tracker', () => {
  it('starts at the first event with content, not at message_start or an empty delta', () => {
    const { tracker, at } = clocked()
    at(1100)
    tracker.note([{ type: 'message_start', model: 'm' }, { type: 'text_delta', text: '' }, { type: 'reasoning_delta', text: '' }])
    at(1250)
    tracker.note([{ type: 'reasoning_delta', text: 'hm' }])
    at(1300)
    tracker.note([{ type: 'finish', finishReason: 'stop' }])
    expect(tracker.timings()).toEqual({ queuedMs: 0, firstContentAt: 1250, maxGapMs: 50 })
  })

  it('counts tool-call events as content, and the wait to the end as a gap', () => {
    const { tracker, at } = clocked()
    at(2000)
    tracker.note([{ type: 'tool_call_start', id: 't1', name: 'Read' }])
    at(2100)
    tracker.note([{ type: 'tool_call_delta', id: 't1', argsTextDelta: '{"a"' }])
    at(2400)
    tracker.note([{ type: 'tool_call_delta', id: 't1', argsTextDelta: ':1}' }])
    at(2450)
    tracker.note([{ type: 'tool_call', id: 't1' }])
    at(3200)
    tracker.note([{ type: 'finish', finishReason: 'tool_calls' }])
    expect(tracker.timings()).toEqual({ queuedMs: 0, firstContentAt: 2000, maxGapMs: 750 })
  })

  it('stops at the first finish or error', () => {
    const { tracker, at } = clocked()
    at(10)
    tracker.note([{ type: 'text_delta', text: 'a' }])
    at(20)
    tracker.note([{ type: 'error', message: 'broken' }])
    at(5000)
    tracker.note([{ type: 'text_delta', text: 'late' }, { type: 'finish', finishReason: 'stop' }])
    expect(tracker.timings()).toEqual({ queuedMs: 0, firstContentAt: 10, maxGapMs: 10 })
  })

  it('counts the wait to an end with no finish or error as a gap, once', () => {
    const { tracker, at } = clocked()
    at(100)
    tracker.note([{ type: 'text_delta', text: 'a' }])
    at(150)
    tracker.note([{ type: 'text_delta', text: 'b' }])
    at(5150)
    tracker.end()
    at(9000)
    tracker.end()
    tracker.note([{ type: 'text_delta', text: 'late' }])
    expect(tracker.timings()).toEqual({ queuedMs: 0, firstContentAt: 100, maxGapMs: 5000 })
  })

  it('reports only the queue wait for a stream that carried no content', () => {
    const { tracker, at } = clocked()
    tracker.queuedFor(300)
    tracker.queuedFor(-5)
    at(1500)
    tracker.note([{ type: 'error', message: 'HTTP 500' }])
    expect(tracker.timings()).toEqual({ queuedMs: 300 })
  })
})

describe('published stream timings', () => {
  it('are taken once', () => {
    publishStreamTimings('s1', { queuedMs: 4 })
    expect(takeStreamTimings('s1')).toEqual({ queuedMs: 4 })
    expect(takeStreamTimings('s1')).toBeUndefined()
  })

  it('forget the oldest past the cap', () => {
    for (let i = 0; i <= STREAM_TIMINGS_MAX; i += 1) publishStreamTimings(`s${i}`, { queuedMs: i })
    expect(takeStreamTimings('s0')).toBeUndefined()
    expect(takeStreamTimings('s1')).toEqual({ queuedMs: 1 })
    expect(takeStreamTimings(`s${STREAM_TIMINGS_MAX}`)).toEqual({ queuedMs: STREAM_TIMINGS_MAX })
  })
})
