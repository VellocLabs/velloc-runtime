// @vitest-environment happy-dom
import { createElement, useState, type FC } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  MAX_AUTO_RECOVERIES,
  RECOVERY_STABLE_MS,
  ThreadErrorBoundary,
} from '../browser/webview/ThreadErrorBoundary'
import { createTranslate, type TranslateFn } from '../browser/webview/i18n'

/**
 * The boundary's recovery contract: a one-frame read against a list that just shrank (assistant-ui looks rows up BY
 * INDEX) is fixed by RE-MOUNTING the subtree. `StaleIndexChild` captures an index at mount and throws if the list
 * has since shrunk past it; re-rendering in place throws again, only a re-mount recovers.
 */

const crashed = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="thread-crashed"]')

const healthy = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="thread-ok"]')

const list = { length: 3 }

/** A row that captured `list.length - 1` when it mounted. */
const StaleIndexChild: FC = () => {
  const [index] = useState(() => list.length - 1)
  if (index >= list.length) {
    throw new Error(
      `tapClientLookup: Index ${index} out of bounds (length: ${list.length})`,
    )
  }
  return createElement('div', { 'data-testid': 'thread-ok' }, `row ${index}`)
}

const AlwaysThrows: FC = () => {
  throw new Error('tapClientLookup: Index 2 out of bounds (length: 2)')
}

function mount(Child: FC, t?: TranslateFn): { rerender: () => void } {
  const tree = createElement(
    ThreadErrorBoundary,
    { sessionId: 'session-1', children: null, t },
    createElement(Child),
  )
  let view!: ReturnType<typeof render>
  act(() => {
    view = render(tree)
  })
  return {
    rerender: () => {
      act(() => {
        // A fresh element identity forces the child to re-render in place —
        // the stale index is re-read, exactly as a store notification would
        // make a mounted row re-read it.
        view.rerender(
          createElement(
            ThreadErrorBoundary,
            { sessionId: 'session-1', children: null, t },
            createElement(Child),
          ),
        )
      })
    },
  }
}

beforeEach(() => {
  list.length = 3
  vi.useFakeTimers()
  // The boundary logs every catch; keep the suite output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ThreadErrorBoundary', () => {
  it('re-mounts the thread after a stale-index render error instead of dead-ending on the card', () => {
    const { rerender } = mount(StaleIndexChild)
    expect(healthy()?.textContent).toBe('row 2')

    // The conversation list shrank under the mounted row — the shape the
    // API-error card drop produces (3 messages -> 2, index 2 gone).
    list.length = 2
    rerender()
    expect(healthy()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(0)
    })

    // Recovered on its own: re-mounted against the current list.
    expect(crashed()).toBeNull()
    expect(healthy()?.textContent).toBe('row 1')
  })

  it('gives up on a persistently broken thread rather than looping forever', () => {
    mount(AlwaysThrows)

    for (let attempt = 0; attempt < MAX_AUTO_RECOVERIES + 5; attempt += 1) {
      act(() => {
        vi.advanceTimersByTime(1)
      })
    }

    expect(crashed()).not.toBeNull()
    // And it stays given up — no pending timer is still cycling.
    act(() => {
      vi.advanceTimersByTime(RECOVERY_STABLE_MS * 2)
    })
    expect(crashed()).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refills the recovery budget once the thread has stayed up', () => {
    const { rerender } = mount(StaleIndexChild)

    // More blips than the budget, each separated by a healthy stretch longer
    // than the probation window. Without the refill the last one would land
    // on the card even though the thread had been fine for a minute.
    for (let blip = 0; blip < MAX_AUTO_RECOVERIES + 2; blip += 1) {
      list.length -= 1
      rerender()
      act(() => {
        vi.advanceTimersByTime(0)
      })
      expect(crashed()).toBeNull()
      expect(healthy()?.textContent).toBe(`row ${list.length - 1}`)
      act(() => {
        vi.advanceTimersByTime(RECOVERY_STABLE_MS + 1)
      })
      // Give the next blip a row to lose again.
      list.length += 1
      rerender()
    }
  })

  it('keeps the manual Retry, which also restores the full budget', () => {
    mount(AlwaysThrows)
    for (let attempt = 0; attempt < MAX_AUTO_RECOVERIES + 2; attempt += 1) {
      act(() => {
        vi.advanceTimersByTime(1)
      })
    }
    expect(crashed()).not.toBeNull()

    const retry = document.querySelector<HTMLButtonElement>(
      '[data-testid="thread-crashed"] button',
    )
    expect(retry).not.toBeNull()
    act(() => {
      retry!.click()
    })

    // The child is still broken, so the card comes straight back — but the
    // budget was reset, so the boundary is auto-retrying again rather than
    // sitting inert.
    expect(crashed()).not.toBeNull()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it('renders the fallback card through the t() prop, not a hard-coded string', () => {
    // A class component can't call useT(); this proves the card's text comes
    // from whatever TranslateFn the caller passes rather than a literal.
    mount(AlwaysThrows, createTranslate('zh'))

    const card = crashed()
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('对话已崩溃')
    expect(card?.textContent).toContain('此对话出现渲染错误，其他会话不受影响。')
    expect(card?.querySelector('button')?.textContent).toBe('重试')
  })

  it('falls back to English when no t() prop is supplied', () => {
    mount(AlwaysThrows)

    const card = crashed()
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Conversation crashed')
    expect(card?.querySelector('button')?.textContent).toBe('Retry')
  })
})
