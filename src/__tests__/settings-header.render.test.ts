// @vitest-environment happy-dom
import { createElement, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { SettingsScreen } from '../browser/webview/settings/SettingsScreen'
import {
  computeRegions,
  useWindowDragRegions,
} from '../browser/webview/topbar/useWindowDragRegions'

/**
 * Settings replaces the topbar (F-18): its header closes settings from the
 * back arrow or the title, and is the window's drag surface.
 */
function makeTransport(): BrowserBridgeTransport {
  return {
    request: vi.fn(async () => ({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'not in this test' },
    })),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
}

function renderSettings(extra: Record<string, unknown> = {}) {
  const onClose = vi.fn()
  const view = render(
    createElement(SettingsScreen, {
      section: 'general' as const,
      onNavigate: () => {},
      onClose,
      catalog: null,
      transport: makeTransport(),
      ...extra,
    }),
  )
  return { onClose, ...view }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('settings header', () => {
  it('closes from the back arrow and from the title', () => {
    const { onClose } = renderSettings()
    fireEvent.click(screen.getByTestId('settings-back'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('settings-title'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('drags the window from the header, except over the two close controls', () => {
    renderSettings()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const id = this.getAttribute('data-testid')
      const x = id === 'settings-back' ? 12 : id === 'settings-title' ? 48 : 0
      const width = id === 'settings-header' ? 800 : 30
      return { left: x, top: 0, width, height: 56 } as DOMRect
    })
    const regions = computeRegions(screen.getByTestId('settings-header'))
    expect(regions).toEqual([
      { x: 0, y: 0, width: 800, height: 56, draggable: true },
      { x: 12, y: 0, width: 30, height: 56, draggable: false },
      { x: 48, y: 0, width: 30, height: 56, draggable: false },
    ])
  })

  it('clears the host drag map when settings closes', () => {
    const onDragRegionsChange = vi.fn()
    const { unmount } = renderSettings({ onDragRegionsChange })
    unmount()
    expect(onDragRegionsChange).toHaveBeenLastCalledWith([])
  })

  it('a hidden topbar clears the host map and reports again once shown', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 44,
    } as DOMRect)
    const report = vi.fn()
    function Bar({ hidden }: { hidden: boolean }) {
      const ref = useRef<HTMLElement | null>(null)
      useWindowDragRegions(ref, hidden ? undefined : report)
      return createElement('header', { ref })
    }
    const bar = { x: 0, y: 0, width: 800, height: 44, draggable: true }
    const { rerender } = render(createElement(Bar, { hidden: false }))
    await waitFor(() => expect(report).toHaveBeenLastCalledWith([bar]))

    rerender(createElement(Bar, { hidden: true }))
    expect(report).toHaveBeenLastCalledWith([])

    report.mockClear()
    rerender(createElement(Bar, { hidden: false }))
    await waitFor(() => expect(report).toHaveBeenLastCalledWith([bar]))
  })

  it('reserves the OS caption strip on the desktop only', () => {
    renderSettings()
    expect(screen.queryByTestId('settings-caption-inset')).not.toBeNull()
    cleanup()
    renderSettings({ remoteClient: true })
    expect(screen.queryByTestId('settings-caption-inset')).toBeNull()
  })
})
