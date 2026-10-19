// @vitest-environment happy-dom
/**
 * The browser pane's tab strip and address field (F-9): the strip draws the
 * session's tabs with the active one marked and reports presses and closes;
 * the field shows the active tab's URL, follows it unless being edited,
 * sends Enter to the host and restores on Escape.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import {
  BrowserAddressBar,
  BrowserTabStrip,
  displayAddress,
  tabLabel,
} from '@/browser/webview/panes/BrowserPaneChrome'
import type { SessionTabEntry } from '@/browser/bridge/protocol/session'

afterEach(cleanup)

const TABS: SessionTabEntry[] = [
  { id: 11, title: 'Docs', url: 'https://example.com/docs', active: false },
  { id: 12, title: '', url: 'https://news.example.org/today', active: true },
  { id: 13, title: '', url: 'chrome://newtab/', active: false },
]

describe('tab labels and addresses', () => {
  it('a blank page shows no address', () => {
    expect(displayAddress('chrome://newtab/')).toBe('')
    expect(displayAddress('about:blank')).toBe('')
    expect(displayAddress(undefined)).toBe('')
    expect(displayAddress('https://example.com/')).toBe('https://example.com/')
  })

  it('labels by title, then host, then the fallback', () => {
    expect(tabLabel(TABS[0], 'New tab')).toBe('Docs')
    expect(tabLabel(TABS[1], 'New tab')).toBe('news.example.org')
    expect(tabLabel(TABS[2], 'New tab')).toBe('New tab')
  })
})

describe('BrowserTabStrip', () => {
  it('draws every tab in order, marks the active one, and reports presses', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    render(createElement(BrowserTabStrip, { tabs: TABS, onActivate, onClose }))
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(el => el.textContent)).toEqual(['Docs', 'news.example.org', 'New tab'])
    expect(tabs.map(el => el.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(screen.getByTestId('pane-browser-tab:12').getAttribute('data-active')).toBe('true')

    fireEvent.click(screen.getByTestId('pane-browser-tab-activate:11'))
    expect(onActivate).toHaveBeenCalledWith(11)
    const close = screen.getByTestId('pane-browser-tab-close:11')
    expect(close.getAttribute('aria-label')).toBe('Close Docs')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledWith(11)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })
})

describe('BrowserAddressBar', () => {
  const field = () => screen.getByTestId('pane-browser-address') as HTMLInputElement

  it('shows the active tab URL, blank for a new tab, and is disabled without a tab', () => {
    const { rerender } = render(
      createElement(BrowserAddressBar, { tab: TABS[1], onNavigate: vi.fn() }),
    )
    expect(field().value).toBe('https://news.example.org/today')
    expect(field().getAttribute('aria-label')).toBe('Address')
    rerender(createElement(BrowserAddressBar, { tab: TABS[2], onNavigate: vi.fn() }))
    expect(field().value).toBe('')
    expect(field().placeholder).toBe('Enter an address or search')
    rerender(createElement(BrowserAddressBar, { tab: null, onNavigate: vi.fn() }))
    expect(field().disabled).toBe(true)
  })

  it('Enter sends the trimmed text for the active tab; empty text sends nothing', () => {
    const onNavigate = vi.fn()
    render(createElement(BrowserAddressBar, { tab: TABS[2], onNavigate }))
    fireEvent.change(field(), { target: { value: '  example.com  ' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith(13, 'example.com')
    fireEvent.change(field(), { target: { value: '   ' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('follows the tab URL while idle, keeps an edit in progress, and resets on a tab switch or Escape', () => {
    const { rerender } = render(
      createElement(BrowserAddressBar, { tab: TABS[0], onNavigate: vi.fn() }),
    )
    // Idle: a navigation in the same tab updates the field.
    rerender(
      createElement(BrowserAddressBar, {
        tab: { ...TABS[0], url: 'https://example.com/docs/2' },
        onNavigate: vi.fn(),
      }),
    )
    expect(field().value).toBe('https://example.com/docs/2')
    // Editing: the same tab's URL changing does not clobber the draft.
    fireEvent.change(field(), { target: { value: 'typing' } })
    rerender(
      createElement(BrowserAddressBar, {
        tab: { ...TABS[0], url: 'https://example.com/docs/3' },
        onNavigate: vi.fn(),
      }),
    )
    expect(field().value).toBe('typing')
    // A tab switch resets even mid-edit.
    rerender(createElement(BrowserAddressBar, { tab: TABS[1], onNavigate: vi.fn() }))
    expect(field().value).toBe('https://news.example.org/today')
    // Escape restores the tab's URL.
    fireEvent.change(field(), { target: { value: 'half' } })
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field().value).toBe('https://news.example.org/today')
  })
})
