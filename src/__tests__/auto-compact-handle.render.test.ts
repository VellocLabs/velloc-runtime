// @vitest-environment happy-dom
// The context popover's auto-compact handle, rendered: the figure under the
// bar follows a drag or keys live, one save goes out when the drag ends or
// the keys settle, Escape saves nothing, and the handle is read-only when
// another settings file decides the window. Behaviour spec:
// F-3.
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TokenUsageIndicator } from '../browser/webview/TokenUsageIndicator'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Message } from '../runtime/RuntimeTypes'
import type { AutoCompactView } from '../browser/worker/workerProtocol'

afterEach(cleanup)

const ONE_M = 'claude-opus[1m]' // 1M window, 20K reserve: auto fires at 967k

function usedMessages(tokens: number): Message[] {
  return [{
    type: 'assistant',
    uuid: 'a-1',
    message: { role: 'assistant', content: [], model: 'm', usage: { input_tokens: tokens } },
  } as unknown as Message]
}

function openPopover(props: {
  autoCompact?: AutoCompactView
  onSet?: (value: number | 'auto') => void
  used?: number
}) {
  const { rerender } = render(
    createElement(
      TooltipProvider,
      null,
      createElement(TokenUsageIndicator, {
        messages: props.used ? usedMessages(props.used) : [],
        liveEvents: [],
        modelId: ONE_M,
        isStreaming: false,
        autoCompact: props.autoCompact ?? { enabled: true, canSave: true },
        onSetAutoCompactWindow: props.onSet,
      }),
    ),
  )
  fireEvent.click(screen.getByTestId('composer-context-usage'))
  return { rerender }
}

const until = () => screen.getByTestId('composer-until-auto-compact').textContent
const handle = () => screen.getByTestId('composer-auto-compact-handle')

/** happy-dom lays nothing out: give the strip a 1000px box at x = 0. */
function layTrack() {
  const track = screen.getByTestId('composer-auto-compact-track')
  track.getBoundingClientRect = () =>
    ({ left: 0, width: 1000, top: 0, height: 16, right: 1000, bottom: 16, x: 0, y: 0 }) as DOMRect
  return track
}

const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 450)))

describe('auto-compact handle', () => {
  it('sits at the threshold and tells it in its value text', () => {
    openPopover({ onSet: vi.fn() })
    expect(handle().getAttribute('aria-valuetext')).toBe('Auto · compacts at 967k')
    expect(until()).toBe('967k until auto-compact')
  })

  it('updates the figure live while dragging and saves once on release', () => {
    const onSet = vi.fn()
    openPopover({ onSet })
    const track = layTrack()

    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 400 })
    expect(until()).toBe('400k until auto-compact')
    expect(screen.getByTestId('composer-auto-compact-bubble').textContent)
      .toBe('Compacts at 400k')
    // No scope hint under the bar while dragging: it reflowed the card.
    expect(screen.queryByTestId('composer-auto-compact-scope')).toBeNull()

    fireEvent.pointerMove(track, { pointerId: 1, clientX: 500 })
    const expected = 500_000
    expect(until()).toBe('500k until auto-compact')
    expect(onSet).not.toHaveBeenCalled()

    fireEvent.pointerUp(track, { pointerId: 1, clientX: 500 })
    expect(onSet).toHaveBeenCalledTimes(1)
    expect(onSet).toHaveBeenCalledWith(expected)
    expect(screen.queryByTestId('composer-auto-compact-bubble')).toBeNull()
    // Held at the saved value until the snapshot carries it.
    expect(handle().getAttribute('data-value')).toBe(String(expected))
  })

  it('cancels a drag on Escape and saves nothing', () => {
    const onSet = vi.fn()
    openPopover({ onSet })
    const track = layTrack()
    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 367 })
    fireEvent.keyDown(handle(), { key: 'Escape' })
    expect(until()).toBe('967k until auto-compact')
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 367 })
    expect(onSet).not.toHaveBeenCalled()
    // The popover stays open.
    expect(screen.getByTestId('composer-context-popover')).toBeTruthy()
  })

  it('warns once the threshold is at or below the current usage', () => {
    openPopover({ onSet: vi.fn(), used: 300_000 })
    const track = layTrack()
    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 100 })
    expect(until()).toBe('Compacts on the next message')
  })

  it('steps with keys live and saves once they settle', async () => {
    const onSet = vi.fn()
    openPopover({ onSet })
    fireEvent.keyDown(handle(), { key: 'End' })
    fireEvent.keyDown(handle(), { key: 'PageDown' })
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    // auto (967K) → 920K (widest fixed 965K, less 50K + one step) → 915K.
    expect(until()).toBe('915k until auto-compact')
    expect(onSet).not.toHaveBeenCalled()
    await settle()
    expect(onSet).toHaveBeenCalledTimes(1)
    expect(onSet).toHaveBeenCalledWith(915_000)
  })

  it('drops unsaved keys on Escape', async () => {
    const onSet = vi.fn()
    openPopover({ onSet })
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(until()).toBe('100k until auto-compact')
    fireEvent.keyDown(handle(), { key: 'Escape' })
    expect(until()).toBe('967k until auto-compact')
    await settle()
    expect(onSet).not.toHaveBeenCalled()
  })

  it('goes back to auto on double-click', () => {
    const onSet = vi.fn()
    openPopover({ onSet, autoCompact: { enabled: true, windowTokens: 300_000, canSave: true } })
    expect(until()).toBe('300k until auto-compact')
    fireEvent.doubleClick(handle())
    expect(onSet).toHaveBeenCalledWith('auto')
  })

  it('is read-only and says why when another settings file decides the window', async () => {
    const onSet = vi.fn()
    openPopover({
      onSet,
      autoCompact: { enabled: true, windowTokens: 300_000, canSave: true, lockedBy: 'projectSettings' },
    })
    expect(handle().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('composer-auto-compact-locked').textContent)
      .toBe('Auto-compact window is set by project settings')
    fireEvent.keyDown(handle(), { key: 'Home' })
    fireEvent.doubleClick(handle())
    await settle()
    expect(until()).toBe('300k until auto-compact')
    expect(onSet).not.toHaveBeenCalled()
  })

  it('shows a failed save', () => {
    openPopover({ onSet: vi.fn(), autoCompact: { enabled: true, canSave: true, saveError: 'EACCES' } })
    expect(screen.getByTestId('composer-auto-compact-error').textContent)
      .toBe("Couldn't save the auto-compact window: EACCES")
  })

  it('measures the ring and headline against the auto-compact window', () => {
    openPopover({ onSet: vi.fn(), used: 200_000 })
    const popover = () => screen.getByTestId('composer-context-popover').textContent
    // Auto on a 1M model: 200k of 1M.
    expect(popover()).toContain('200k / 1.00M (20%)')
    cleanup()
    openPopover({
      onSet: vi.fn(),
      used: 200_000,
      autoCompact: { enabled: true, windowTokens: 500_000, canSave: true },
    })
    expect(popover()).toContain('200k / 500k (40%)')
    // The bar itself spans the model window, so the handle can reach it all.
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('20')
    // The headline follows a drag live: Home previews the 100K window.
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(popover()).toContain('200k / 100k (100%)')
    expect(until()).toBe('Compacts on the next message')
  })

  it('keeps the model window while auto-compact is off', () => {
    openPopover({
      onSet: vi.fn(),
      used: 200_000,
      autoCompact: { enabled: false, windowTokens: 500_000, canSave: true },
    })
    expect(screen.getByTestId('composer-context-popover').textContent)
      .toContain('200k / 1.00M (20%)')
  })

  it('has no handle without a settings file, a save path, or with auto-compact off', () => {
    openPopover({ onSet: vi.fn(), autoCompact: { enabled: true, canSave: false } })
    expect(screen.queryByTestId('composer-auto-compact-handle')).toBeNull()
    cleanup()
    openPopover({})
    expect(screen.queryByTestId('composer-auto-compact-handle')).toBeNull()
    cleanup()
    openPopover({ onSet: vi.fn(), autoCompact: { enabled: false, canSave: true } })
    expect(screen.queryByTestId('composer-auto-compact-handle')).toBeNull()
    expect(until()).toBe('Auto-compact is off')
  })
})
