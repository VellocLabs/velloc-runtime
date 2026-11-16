/**
 * The context-window figures the composer's ring and the phone shell's usage sheet share (F-24):
 * a streaming turn counts its live usage, a settled session its transcript estimate, and usage is
 * measured against the saved auto-compact window unless auto-compact is off.
 */
import { describe, expect, it } from 'vitest'

import { contextUsageShares, contextWindowOf } from '../engine/contextWindow'
import { estimateTranscriptTokens } from '../engine/tokenCounts'
import { thresholdForChoice } from '../context/compaction/windowSlider'
import { contextMeasureWindow, contextTokensUsed, contextUsageFigures } from '../browser/webview/contextUsage'

const liveEvents = [
  { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 500 } } } },
  { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 250 } } },
] as never[]

const messages = [
  { type: 'user', uuid: 'u0', message: { role: 'user', content: [{ type: 'text', text: 'plan the trip' }] } },
] as never[]

describe('contextUsage', () => {
  it('counts the live turn while one streams, else the transcript', () => {
    expect(contextTokensUsed(messages, liveEvents)).toBe(1750)
    expect(contextTokensUsed(messages, [])).toBe(estimateTranscriptTokens(messages))
  })

  it('measures against the saved auto-compact window, or the model window while off or auto', () => {
    const model = contextWindowOf('mock', 'demo')
    expect(contextMeasureWindow('mock', 'demo', undefined, 'auto')).toBe(model)
    expect(contextMeasureWindow('mock', 'demo', { enabled: true, canSave: true }, 100_000)).toBe(
      thresholdForChoice(100_000, 'mock', 'demo'),
    )
    expect(contextMeasureWindow('mock', 'demo', { enabled: false, canSave: true }, 100_000)).toBe(model)
  })

  it('reports used, window, percent and warning together', () => {
    const autoCompact = { enabled: true, windowTokens: 100_000, canSave: true }
    const figures = contextUsageFigures({ messages, liveEvents, modelId: 'mock', providerId: 'demo', autoCompact })
    const windowTokens = thresholdForChoice(100_000, 'mock', 'demo')
    expect(figures).toEqual({
      usedTokens: 1750,
      windowTokens,
      percent: contextUsageShares(1750, windowTokens).usedPercentage,
      warning: 'none',
    })
  })
})
