// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ThreadMessageLike } from '@assistant-ui/react'

import {
  DEFAULT_SHOW_REASONING,
  REASONING_ONLY_ROW_KEY,
  SHOW_REASONING_STORAGE_KEY,
  readShowReasoning,
  subscribeShowReasoning,
  useShowReasoning,
  withoutReasoningParts,
  writeShowReasoning,
} from '../browser/webview/showReasoning'
import { AppearanceSection } from '../browser/webview/settings/sections/AppearanceSection'

// This vitest realm's `localStorage` is not a working Storage; the store
// reads it at call time, so a Map-backed stub stands in.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('show reasoning preference', () => {
  it('defaults to shown on a fresh client and on junk storage', () => {
    expect(DEFAULT_SHOW_REASONING).toBe(true)
    expect(readShowReasoning()).toBe(true)
    localStorage.setItem(SHOW_REASONING_STORAGE_KEY, 'nope')
    expect(readShowReasoning()).toBe(true)
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    }
    expect(readShowReasoning(throwing)).toBe(true)
  })

  it('round-trips a write and notifies subscribers', () => {
    const seen: boolean[] = []
    const dispose = subscribeShowReasoning(() => seen.push(readShowReasoning()))
    writeShowReasoning(false)
    expect(localStorage.getItem(SHOW_REASONING_STORAGE_KEY)).toBe('0')
    expect(readShowReasoning()).toBe(false)
    writeShowReasoning(true)
    expect(readShowReasoning()).toBe(true)
    dispose()
    writeShowReasoning(false)
    expect(seen).toEqual([false, true])
  })

  // A client whose localStorage is blocked or absent: the switch must hold
  // the choice for the page's lifetime, not snap back to the default.
  it('honours a choice made without storage for this page', () => {
    function Probe() {
      return createElement('span', { 'data-testid': 'probe' }, String(useShowReasoning()))
    }
    render(createElement(Probe))
    expect(screen.getByTestId('probe').textContent).toBe('true')
    act(() => writeShowReasoning(false, null))
    expect(screen.getByTestId('probe').textContent).toBe('false')
    // A write that reaches storage hands the value back to it.
    act(() => writeShowReasoning(true))
    expect(screen.getByTestId('probe').textContent).toBe('true')
    expect(localStorage.getItem(SHOW_REASONING_STORAGE_KEY)).toBe('1')
  })

  it('re-reads on a storage event from another window of this origin', () => {
    const listener = vi.fn()
    const dispose = subscribeShowReasoning(listener)
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated.key' }))
    expect(listener).not.toHaveBeenCalled()
    window.dispatchEvent(new StorageEvent('storage', { key: SHOW_REASONING_STORAGE_KEY }))
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
  })
})

describe('withoutReasoningParts', () => {
  const assistant = (content: unknown[], custom?: Record<string, unknown>) =>
    ({
      role: 'assistant',
      content,
      ...(custom ? { metadata: { custom } } : {}),
    }) as unknown as ThreadMessageLike

  it('drops reasoning parts from assistant content and keeps everything else in order', () => {
    const msg = assistant([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: {} },
      { type: 'reasoning', text: 'now the answer' },
      { type: 'text', text: 'Done.' },
    ])
    const [out] = withoutReasoningParts([msg])
    expect((out!.content as unknown as Array<{ type: string }>).map((p) => p.type)).toEqual([
      'text',
      'tool-call',
      'text',
    ])
    // The source row is not mutated — the memoized transcript reuses it.
    expect((msg.content as unknown[]).length).toBe(5)
  })

  it('filters the positional partLines list in step with the content', () => {
    const msg = assistant(
      [
        { type: 'reasoning', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'reasoning', text: 'c' },
        { type: 'text', text: 'd' },
      ],
      { partLines: '3 3 7 7', textLines: '3 7' },
    )
    const [out] = withoutReasoningParts([msg])
    const custom = (out!.metadata as { custom: Record<string, unknown> }).custom
    expect(custom.partLines).toBe('3 7')
    expect(custom.textLines).toBe('3 7')
  })

  it('drops a partLines list that does not line up with the content', () => {
    // Three lines for four parts (a merged row whose one side carried none):
    // filtering it by position would map every later part to the wrong line.
    const msg = assistant(
      [
        { type: 'reasoning', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'reasoning', text: 'c' },
        { type: 'text', text: 'd' },
      ],
      { partLines: '3 7 9', textLines: '3 7' },
    )
    const [out] = withoutReasoningParts([msg])
    const custom = (out!.metadata as { custom: Record<string, unknown> }).custom
    expect(custom).not.toHaveProperty('partLines')
    expect(custom.textLines).toBe('3 7')
  })

  it('returns rows without reasoning, and non-assistant rows, by identity', () => {
    const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] } as ThreadMessageLike
    const plain = assistant([{ type: 'text', text: 'hello' }])
    const out = withoutReasoningParts([user, plain])
    expect(out[0]).toBe(user)
    expect(out[1]).toBe(plain)
  })

  it('keeps a reasoning-only row in place, marked for the thread to collapse', () => {
    // The live row while the model is still thinking, or a turn aborted
    // mid-thought. Dropping it would shift every later row's index (the search
    // jump and the virtualizer count rows one-for-one); left unmarked it
    // rendered as a blank assistant bubble.
    const thinking = assistant([{ type: 'reasoning', text: 'hmm' }], { lineFrom: 4 })
    const answered = assistant([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'Hi.' },
    ])
    const out = withoutReasoningParts([thinking, answered])
    expect(out).toHaveLength(2)
    expect(out[0]!.content).toEqual([])
    const custom = (row: ThreadMessageLike) =>
      (row.metadata as { custom?: Record<string, unknown> } | undefined)?.custom
    expect(custom(out[0]!)?.[REASONING_ONLY_ROW_KEY]).toBe(true)
    expect(custom(out[0]!)?.lineFrom).toBe(4)
    expect(custom(out[1]!)?.[REASONING_ONLY_ROW_KEY]).toBeUndefined()
  })

  it('returns the same stripped copy for the same source row across calls', () => {
    const msg = assistant([
      { type: 'reasoning', text: 'x' },
      { type: 'text', text: 'y' },
    ])
    const first = withoutReasoningParts([msg])[0]
    const second = withoutReasoningParts([msg])[0]
    expect(first).not.toBe(msg)
    expect(second).toBe(first)
  })
})

describe('AppearanceSection · Show reasoning', () => {
  it('is on by default and writes the choice when toggled', () => {
    render(createElement(AppearanceSection))
    const toggle = screen.getByTestId('appearance-show-reasoning')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Show reasoning')
    fireEvent.click(toggle)
    expect(localStorage.getItem(SHOW_REASONING_STORAGE_KEY)).toBe('0')
    expect(screen.getByTestId('appearance-show-reasoning').getAttribute('aria-checked')).toBe('false')
  })

  it('reads a stored hidden choice', () => {
    localStorage.setItem(SHOW_REASONING_STORAGE_KEY, '0')
    render(createElement(AppearanceSection))
    expect(screen.getByTestId('appearance-show-reasoning').getAttribute('aria-checked')).toBe('false')
  })
})
