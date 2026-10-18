/** The topic → emulator glue and the input batcher (F-31), without xterm.js. */
import { describe, expect, it, vi } from 'vitest'

import {
  InputBatcher,
  applyTerminalTopicEvent,
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
})
