/** The topic → emulator glue and the input batcher (F-31), without xterm.js. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  INPUT_FLUSH_FALLBACK_MS,
  InputBatcher,
  applyTerminalTopicEvent,
  scheduleInputFlush,
  splitForWire,
  type MirroredTerminal,
} from '@/browser/webview/terminal/xtermBinding'

function emulator() {
  return { reset: vi.fn(), write: vi.fn() }
}

const snapshot = (over: Partial<Record<string, unknown>> = {}) => ({
  form: 'snapshot' as const,
  payload: { cols: 100, rows: 30, title: 'pwsh', state: { kind: 'running' }, scrollback: 'hello\r\n', ...over },
})

describe('applyTerminalTopicEvent', () => {
  it('a snapshot resets the screen, replays the scrollback and mirrors the record', () => {
    const em = emulator()
    const mirror = applyTerminalTopicEvent(em, null, snapshot())
    expect(em.reset).toHaveBeenCalledTimes(1)
    expect(em.write).toHaveBeenCalledWith('hello\r\n')
    expect(mirror).toEqual({ cols: 100, rows: 30, title: 'pwsh', state: { kind: 'running' } })
  })

  it('an empty scrollback writes nothing; a malformed snapshot changes nothing', () => {
    const em = emulator()
    applyTerminalTopicEvent(em, null, snapshot({ scrollback: '' }))
    expect(em.write).not.toHaveBeenCalled()
    const before: MirroredTerminal = { cols: 1, rows: 1, title: 'x', state: { kind: 'starting' } }
    expect(applyTerminalTopicEvent(em, before, { form: 'snapshot', payload: { cols: 'wide' } })).toBe(before)
    expect(em.reset).toHaveBeenCalledTimes(1)
  })

  it('output is written; resize, title and state update the mirror; unknown deltas are ignored', () => {
    const em = emulator()
    const base = applyTerminalTopicEvent(em, null, snapshot())
    expect(applyTerminalTopicEvent(em, base, { form: 'delta', type: 'output', payload: { data: 'ab' } })).toBe(base)
    expect(em.write).toHaveBeenLastCalledWith('ab')
    const resized = applyTerminalTopicEvent(em, base, { form: 'delta', type: 'resize', payload: { cols: 80, rows: 24 } })
    expect(resized).toEqual({ ...base, cols: 80, rows: 24 })
    expect(applyTerminalTopicEvent(em, resized, { form: 'delta', type: 'resize', payload: { cols: 80, rows: 24 } })).toBe(resized)
    const titled = applyTerminalTopicEvent(em, resized, { form: 'delta', type: 'title', payload: { title: 'vim' } })
    expect(titled?.title).toBe('vim')
    const exited = applyTerminalTopicEvent(em, titled, { form: 'delta', type: 'state', payload: { state: { kind: 'exited', exitCode: 1 } } })
    expect(exited?.state).toEqual({ kind: 'exited', exitCode: 1 })
    expect(applyTerminalTopicEvent(em, exited, { form: 'delta', type: 'bell', payload: {} })).toBe(exited)
    expect(em.write).toHaveBeenCalledTimes(2)
  })

  it('a restart (exited → starting) clears the screen; a repeated starting does not', () => {
    const em = emulator()
    const base = applyTerminalTopicEvent(em, null, snapshot({ state: { kind: 'exited', exitCode: 0 } }))
    expect(em.reset).toHaveBeenCalledTimes(1)
    const starting = applyTerminalTopicEvent(em, base, { form: 'delta', type: 'state', payload: { state: { kind: 'starting' } } })
    expect(starting?.state).toEqual({ kind: 'starting' })
    expect(em.reset).toHaveBeenCalledTimes(2)
    applyTerminalTopicEvent(em, starting, { form: 'delta', type: 'state', payload: { state: { kind: 'starting' } } })
    expect(em.reset).toHaveBeenCalledTimes(2)
    const running = applyTerminalTopicEvent(em, starting, { form: 'delta', type: 'state', payload: { state: { kind: 'running' } } })
    expect(running?.state).toEqual({ kind: 'running' })
    expect(em.reset).toHaveBeenCalledTimes(2)
  })
})

describe('splitForWire', () => {
  it('one piece when it fits, none for the empty string', () => {
    expect(splitForWire('abc', 10)).toEqual(['abc'])
    expect(splitForWire('', 10)).toEqual([])
  })

  it('splits on UTF-8 byte size without cutting a character', () => {
    // '€' is three bytes: six of them are 18 bytes, a cap of 7 fits two per piece.
    expect(splitForWire('€€€€€€', 7)).toEqual(['€€', '€€', '€€'])
    // An astral character (four bytes) is never split across a surrogate pair.
    expect(splitForWire('a😀b', 4)).toEqual(['a', '😀', 'b'])
  })
})

describe('InputBatcher', () => {
  it('collects pushes into one send per tick, in wire-sized pieces', () => {
    const send = vi.fn()
    let tick: (() => void) | null = null
    const batcher = new InputBatcher(send, flush => {
      tick = flush
    })
    batcher.push('a')
    batcher.push('b')
    expect(send).not.toHaveBeenCalled()
    tick!()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('ab')
    tick = null
    batcher.push('c')
    expect(tick).not.toBeNull()
    batcher.dispose()
    tick!()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('an escape sequence is sent at once, with what was pending before it', () => {
    const send = vi.fn()
    let tick: (() => void) | null = null
    const batcher = new InputBatcher(send, flush => {
      tick = flush
    })
    batcher.push('a')
    expect(send).not.toHaveBeenCalled()
    batcher.push('\u001b[2;9R')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('a\u001b[2;9R')
    // The tick that was pending finds nothing left.
    tick!()
    expect(send).toHaveBeenCalledTimes(1)
    batcher.push('\u001b[A')
    expect(send).toHaveBeenLastCalledWith('\u001b[A')
  })

  describe('the default tick', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('flushes on the animation frame when one comes', () => {
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
      const flush = vi.fn()
      scheduleInputFlush(flush)
      expect(flush).not.toHaveBeenCalled()
      frames.forEach(cb => cb(16))
      expect(flush).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(INPUT_FLUSH_FALLBACK_MS * 2)
      expect(flush).toHaveBeenCalledTimes(1)
    })

    it('flushes on the timer when no frame comes, once', () => {
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
      const flush = vi.fn()
      scheduleInputFlush(flush)
      vi.advanceTimersByTime(INPUT_FLUSH_FALLBACK_MS - 1)
      expect(flush).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(flush).toHaveBeenCalledTimes(1)
      // A frame that arrives late does not flush again.
      frames.forEach(cb => cb(5000))
      expect(flush).toHaveBeenCalledTimes(1)
    })

    it('a batcher on the default tick sends its input without any frame', () => {
      vi.stubGlobal('requestAnimationFrame', () => 0)
      const send = vi.fn()
      const batcher = new InputBatcher(send)
      batcher.push('ls')
      batcher.push('\r')
      vi.advanceTimersByTime(INPUT_FLUSH_FALLBACK_MS)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith('ls\r')
    })
  })
})
