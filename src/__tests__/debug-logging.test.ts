import { afterEach, describe, expect, it } from 'vitest'
import {
  disableDebugLogging,
  startTraceCapture,
  isTraceCapturing,
  traceLine,
} from '../utils/debugLog'
import {
  getWorkerLogBuffer,
  setWorkerLogCaptureSource,
} from '../utils/workerLogBuffer'

/**
 * `traceLine` (`src/utils/debugLog.ts`) against the worker log ring's opt-in gate: with every capture source off
 * nothing lands; warn/error land when any source is on; debug/info also need the runtime switch
 * (`startTraceCapture()` / `/debug log on`); verbose is dropped; `[tag]` prefixes parse into `entry.source`.
 */

function marker(): string {
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function bufferTexts(): string[] {
  return getWorkerLogBuffer()
    .drain()
    .map(entry => entry.text)
}

afterEach(() => {
  disableDebugLogging()
  setWorkerLogCaptureSource('tracer', false)
})

describe('traceLine — level gating', () => {
  it('captures NOTHING while every source is off — even warn/error (opt-in regression)', () => {
    disableDebugLogging()
    setWorkerLogCaptureSource('tracer', false)
    const warnMark = marker()
    const errorMark = marker()
    traceLine(`[test] ${warnMark}`, { level: 'warn' })
    traceLine(`[test] ${errorMark}`, { level: 'error' })
    const texts = bufferTexts()
    expect(texts.some(t => t.includes(warnMark))).toBe(false)
    expect(texts.some(t => t.includes(errorMark))).toBe(false)
  })

  it('captures warn/error when the tracer source is on, without the debug switch', () => {
    disableDebugLogging()
    setWorkerLogCaptureSource('tracer', true)
    const warnMark = marker()
    const errorMark = marker()
    traceLine(`[test] ${warnMark}`, { level: 'warn' })
    traceLine(`[test] ${errorMark}`, { level: 'error' })
    const texts = bufferTexts()
    expect(texts.some(t => t.includes(warnMark))).toBe(true)
    expect(texts.some(t => t.includes(errorMark))).toBe(true)
  })

  it('drops debug/info while the debug switch is off (tracer source on)', () => {
    disableDebugLogging()
    setWorkerLogCaptureSource('tracer', true)
    const debugMark = marker()
    const infoMark = marker()
    traceLine(`[test] ${debugMark}`) // default level: debug
    traceLine(`[test] ${infoMark}`, { level: 'info' })
    const texts = bufferTexts()
    expect(texts.some(t => t.includes(debugMark))).toBe(false)
    expect(texts.some(t => t.includes(infoMark))).toBe(false)
  })

  it('captures debug/info while the switch is on (switch opens the ring itself)', () => {
    startTraceCapture()
    const debugMark = marker()
    const infoMark = marker()
    traceLine(`[test] ${debugMark}`)
    traceLine(`[test] ${infoMark}`, { level: 'info' })
    const texts = bufferTexts()
    expect(texts.some(t => t.includes(debugMark))).toBe(true)
    expect(texts.some(t => t.includes(infoMark))).toBe(true)
  })

  it('drops verbose even while the switch is on (min level = debug)', () => {
    startTraceCapture()
    const verboseMark = marker()
    traceLine(`[test] ${verboseMark}`, { level: 'verbose' })
    expect(bufferTexts().some(t => t.includes(verboseMark))).toBe(false)
  })
})

describe('traceLine — entry shape', () => {
  it('parses the [tag] prefix into entry.source and stamps the level', () => {
    startTraceCapture()
    const mark = marker()
    traceLine(`[tool] ${mark} start`, { level: 'debug' })
    const entry = getWorkerLogBuffer()
      .drain()
      .find(e => e.text.includes(mark))
    expect(entry).toBeDefined()
    expect(entry!.source).toBe('tool')
    expect(entry!.level).toBe('debug')
  })
})

describe('enable/disable switch', () => {
  it('startTraceCapture returns whether it was already active', () => {
    disableDebugLogging()
    expect(isTraceCapturing()).toBe(false)
    expect(startTraceCapture()).toBe(false) // was off
    expect(isTraceCapturing()).toBe(true)
    expect(startTraceCapture()).toBe(true) // already on
    disableDebugLogging()
    expect(isTraceCapturing()).toBe(false)
  })

  it('disabling the last source clears the ring — nothing stays resident', () => {
    startTraceCapture()
    const mark = marker()
    traceLine(`[test] ${mark}`, { level: 'error' })
    expect(bufferTexts().some(t => t.includes(mark))).toBe(true)
    disableDebugLogging()
    expect(bufferTexts()).toEqual([])
  })
})
