/**
 * Daily-log date rollover: a `date_change` attachment is emitted in every mode, and under
 * `memoryMaintenance === 'dailyLog'` `sessionTranscriptModule.rollOverAtMidnight` also fires.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { collectDateChangeAttachments } from '../messages/contextAttachments'
import * as sessionTranscriptModule from '../sessions/transcriptWriter'

const DAY1 = 1_700_000_000_000
const DAY2 = DAY1 + 2 * 24 * 60 * 60 * 1000 // two calendar days later

function makeRc(nowMs: number): RuntimeConfig {
  return {
    getEnv: () => undefined,
    flagOn: () => false,
    now: () => nowMs,
    createUUID: () => 'uuid',
    createTimestamp: () => '2026-05-13T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

function makeContext(mode?: 'off' | 'periodic' | 'dailyLog'): ToolCallContext {
  let appState = { attachmentState: {} as Record<string, unknown> }
  return {
    options: {
      memorySettings: mode ? { memoryMaintenance: mode } : undefined,
    },
    messages: [{ uuid: 'm1' }],
    readAppState: () => appState,
    writeAppState: (f: (prev: typeof appState) => typeof appState) => {
      appState = f(appState)
    },
  } as unknown as ToolCallContext
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('date rollover — daily-log transcript flush', () => {
  it('flushes the transcript on rollover under memoryMaintenance "dailyLog"', () => {
    const spy = vi.spyOn(sessionTranscriptModule, 'rollOverAtMidnight')
    const ctx = makeContext('dailyLog')

    // First call seeds lastReportedDate, no emit.
    expect(collectDateChangeAttachments(ctx, makeRc(DAY1))).toEqual([])

    // Rollover → emits date_change AND flushes the transcript.
    const out = collectDateChangeAttachments(ctx, makeRc(DAY2))
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('date_change')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('emits date_change but does NOT flush in non-daily-log modes', () => {
    const spy = vi.spyOn(sessionTranscriptModule, 'rollOverAtMidnight')
    for (const mode of [undefined, 'off', 'periodic'] as const) {
      spy.mockClear()
      const ctx = makeContext(mode)
      expect(collectDateChangeAttachments(ctx, makeRc(DAY1))).toEqual([])
      const out = collectDateChangeAttachments(ctx, makeRc(DAY2))
      expect(out, `mode=${mode}`).toHaveLength(1)
      expect(spy, `mode=${mode}`).not.toHaveBeenCalled()
    }
  })
})
