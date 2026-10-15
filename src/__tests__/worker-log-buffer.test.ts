import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkerLogBuffer,
  installWorkerLogCapture,
  isWorkerLogCaptureEnabled,
  setWorkerLogCaptureSource,
} from '../utils/workerLogBuffer'

describe('workerLogBuffer', () => {
  // Collection is OPT-IN: a capture source ('tracer' from the debug gates,
  // 'debug' from /debug log on) must be on before anything lands in the
  // ring. Tests enable the 'debug' source and release it after — releasing
  // the last source clears the ring, which also isolates the tests.
  beforeEach(() => {
    setWorkerLogCaptureSource('debug', true)
  })
  afterEach(() => {
    setWorkerLogCaptureSource('debug', false)
    setWorkerLogCaptureSource('tracer', false)
  })

  it('collects NOTHING while every capture source is off (opt-in regression)', () => {
    setWorkerLogCaptureSource('debug', false)
    setWorkerLogCaptureSource('tracer', false)
    expect(isWorkerLogCaptureEnabled()).toBe(false)
    const buf = getWorkerLogBuffer()
    buf.push('warn', 'dropped-warn')
    buf.push('error', 'dropped-error')
    expect(buf.drain()).toEqual([])
  })

  it('releasing the LAST capture source clears retained entries', () => {
    const buf = getWorkerLogBuffer()
    setWorkerLogCaptureSource('tracer', true)
    buf.push('warn', 'kept-while-on')
    expect(buf.drain().length).toBeGreaterThan(0)
    // 'debug' (from beforeEach) still holds it open — no clear yet.
    setWorkerLogCaptureSource('tracer', false)
    expect(buf.drain().length).toBeGreaterThan(0)
    // Last source released → ring drops everything.
    setWorkerLogCaptureSource('debug', false)
    expect(buf.drain()).toEqual([])
  })

  it('push + drain returns entries oldest→newest', () => {
    const buf = getWorkerLogBuffer()
    const before = buf.drain().length
    buf.push('warn', 'first')
    buf.push('error', 'second')
    const after = buf.drain()
    expect(after.length).toBe(before + 2)
    const last2 = after.slice(-2)
    expect(last2.map(e => e.text)).toEqual(['first', 'second'])
    expect(last2[1]!.level).toBe('error')
  })

  it('parses a leading [tag] as the source', () => {
    const buf = getWorkerLogBuffer()
    buf.push('warn', '[mcp] Native server "github" connect failed: 401')
    const entry = buf.drain().at(-1)!
    expect(entry.source).toBe('mcp')
  })

  it('notifies subscribers on push and stops after unsubscribe', () => {
    const buf = getWorkerLogBuffer()
    const seen: string[] = []
    const unsub = buf.subscribe(e => seen.push(e.text))
    buf.push('error', 'boom')
    expect(seen).toEqual(['boom'])
    unsub()
    buf.push('error', 'after-unsub')
    expect(seen).toEqual(['boom'])
  })

  it('captures console.warn / console.error and calls the originals through', () => {
    const realWarn = console.warn
    const realError = console.error
    const warnSpy = vi.fn()
    const errorSpy = vi.fn()
    // Patch first so installWorkerLogCapture wraps these as the "originals".
    console.warn = warnSpy as unknown as typeof console.warn
    console.error = errorSpy as unknown as typeof console.error
    try {
      installWorkerLogCapture()
      const buf = getWorkerLogBuffer()
      const before = buf.drain().length

      console.warn('[mcp] hi', { a: 1 })
      console.error('bad', new Error('nope'))

      const entries = buf.drain().slice(before)
      expect(entries).toHaveLength(2)
      expect(entries[0]!.level).toBe('warn')
      expect(entries[0]!.text).toContain('[mcp] hi')
      expect(entries[0]!.text).toContain('{"a":1}')
      expect(entries[0]!.source).toBe('mcp')
      expect(entries[1]!.level).toBe('error')
      expect(entries[1]!.text).toContain('nope')

      // Passthrough: the originals still ran.
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledTimes(1)

      // With capture off, the SAME patched console collects nothing —
      // but still passes through. (installWorkerLogCapture patches the
      // realm console at most once, so this must share the install
      // above rather than being its own test.)
      setWorkerLogCaptureSource('debug', false)
      console.warn('[mcp] dropped while off')
      expect(buf.drain()).toEqual([]) // off → ring also cleared
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      console.warn = realWarn
      console.error = realError
    }
  })

  it('caps at the ring size, evicting the oldest', () => {
    const buf = getWorkerLogBuffer()
    for (let i = 0; i < 600; i++) buf.push('warn', `entry-${i}`)
    const all = buf.drain()
    expect(all.length).toBe(500)
    expect(all.at(-1)!.text).toBe('entry-599')
    expect(all.some(e => e.text === 'entry-0')).toBe(false)
  })
})
