// @vitest-environment happy-dom
import { createElement, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { SettingsScreen } from '../browser/webview/settings/SettingsScreen'
import { NexusTopBar } from '../browser/webview/topbar/NexusTopBar'
import {
  computeRegions,
  useWindowDragRegions,
} from '../browser/webview/topbar/useWindowDragRegions'

/**
 * Settings replaces the topbar (F-18): its header closes settings from one
 * back control holding the arrow and the title, and is the window's drag
 * surface.
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
  it('closes from one back control that holds the arrow and the title', () => {
    const { onClose } = renderSettings()
    const back = screen.getByTestId('settings-back')
    expect(back.tagName).toBe('BUTTON')
    expect(back.contains(screen.getByTestId('settings-title'))).toBe(true)
    expect(screen.getByTestId('settings-header').querySelectorAll('button')).toHaveLength(1)
    fireEvent.click(back)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('settings-title'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('paints the header with the topbar background, so the OS caption buttons stay legible', () => {
    renderSettings()
    expect(screen.getByTestId('settings-header').className.split(/\s+/)).toContain('bg-toolbar')
  })

  it('drags the window from the header, except over the back control', () => {
    renderSettings()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const id = this.getAttribute('data-testid')
      const x = id === 'settings-back' ? 12 : 0
      const width = id === 'settings-header' ? 800 : 90
      return { left: x, top: 0, width, height: 56 } as DOMRect
    })
    const regions = computeRegions(screen.getByTestId('settings-header'))
    expect(regions).toEqual([
      { x: 0, y: 0, width: 800, height: 56, draggable: true },
      { x: 12, y: 0, width: 90, height: 56, draggable: false },
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

  it('is exactly as tall as the topbar it replaces', () => {
    renderSettings()
    const heightOf = (className: string) =>
      className.split(/\s+/).filter(c => /^h-/.test(c))
    const topbar = renderToStaticMarkup(
      createElement(NexusTopBar, {
        catalog: null,
        selection: null,
        onSelectModel: () => {},
        onOpenSettings: () => {},
      }),
    )
    const topbarClass =
      /<header[^>]*data-slot="nexus-topbar"[^>]*class="([^"]*)"/.exec(topbar)?.[1] ??
      /<header[^>]*class="([^"]*)"[^>]*data-slot="nexus-topbar"/.exec(topbar)?.[1] ??
      ''
    expect(heightOf(topbarClass)).toEqual(['h-11'])
    expect(heightOf(screen.getByTestId('settings-header').className)).toEqual(['h-11'])
  })

  it('reserves the OS caption strip on the desktop only', () => {
    renderSettings()
    expect(screen.queryByTestId('settings-caption-inset')).not.toBeNull()
    cleanup()
    renderSettings({ remoteClient: true })
    expect(screen.queryByTestId('settings-caption-inset')).toBeNull()
  })
})
