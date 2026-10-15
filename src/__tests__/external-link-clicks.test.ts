// @vitest-environment happy-dom
/**
 * Where an external link opens (`webview/externalLinkClicks.ts`): the shell catches every external http(s) anchor
 * click; a connection that may use `ui.openUrl` asks the host, any other opens a new tab in its own browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  createExternalLinkClickHandler,
  openInClientTab,
  type ExternalLinkOpeners,
} from '../browser/webview/externalLinkClicks'

let host = true
let openers: {
  canOpenOnHost: Mock<() => boolean>
  openOnHost: Mock<(url: string) => Promise<void>>
  openInClient: Mock<(url: string) => void>
}
let listener: (event: MouseEvent) => void

beforeEach(() => {
  host = true
  openers = {
    canOpenOnHost: vi.fn(() => host),
    openOnHost: vi.fn(async () => {}),
    openInClient: vi.fn(),
  }
  listener = createExternalLinkClickHandler(
    openers satisfies ExternalLinkOpeners,
    () => 'http://localhost:5173/',
  )
  document.addEventListener('click', listener, { capture: true })
})

afterEach(() => {
  document.removeEventListener('click', listener, { capture: true })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** Click an anchor (on an inner node, as a real click on link text lands). */
function clickLink(href: string, init: MouseEventInit = {}): MouseEvent {
  const anchor = document.createElement('a')
  anchor.setAttribute('href', href)
  const text = document.createElement('span')
  text.textContent = 'a link'
  anchor.appendChild(text)
  document.body.appendChild(anchor)
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  })
  text.dispatchEvent(event)
  return event
}

describe('external link clicks', () => {
  it('asks the host when the connection may use ui.openUrl', () => {
    const event = clickLink('https://example.com/docs')
    expect(event.defaultPrevented).toBe(true)
    expect(openers.openOnHost).toHaveBeenCalledWith('https://example.com/docs')
    expect(openers.openInClient).not.toHaveBeenCalled()
  })

  it("opens in the client's own browser when it may not, and still never navigates", () => {
    host = false
    const event = clickLink('https://example.com/docs')
    expect(event.defaultPrevented).toBe(true)
    expect(openers.openInClient).toHaveBeenCalledWith('https://example.com/docs')
    expect(openers.openOnHost).not.toHaveBeenCalled()
  })

  it('reads the grant on every click', () => {
    clickLink('https://example.com/one')
    host = false
    clickLink('https://example.com/two')
    expect(openers.openOnHost.mock.calls).toEqual([['https://example.com/one']])
    expect(openers.openInClient.mock.calls).toEqual([['https://example.com/two']])
  })

  it('resolves a relative http link against the page', () => {
    host = false
    clickLink('/help')
    expect(openers.openInClient).toHaveBeenCalledWith('http://localhost:5173/help')
  })

  it('swallows a host refusal (a stale binary without the route)', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      openers.openOnHost.mockRejectedValueOnce(new Error('unknown_route'))
      clickLink('https://example.com/docs')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      expect(openers.openInClient).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it.each([
    ['mailto:', 'mailto:someone@example.com'],
    ['tel:', 'tel:+123'],
  ])('leaves %s to the browser', (_label, href) => {
    host = false
    const event = clickLink(href)
    expect(event.defaultPrevented).toBe(false)
    expect(openers.openOnHost).not.toHaveBeenCalled()
    expect(openers.openInClient).not.toHaveBeenCalled()
  })

  it.each([
    ['a ctrl-click', { ctrlKey: true }],
    ['a meta-click', { metaKey: true }],
    ['a shift-click', { shiftKey: true }],
    ['a middle click', { button: 1 }],
  ])('leaves %s to the browser', (_label, init) => {
    host = false
    const event = clickLink('https://example.com/docs', init)
    expect(event.defaultPrevented).toBe(false)
    expect(openers.openInClient).not.toHaveBeenCalled()
  })
})

describe('openInClientTab', () => {
  it('opens a new tab with no opener and no referrer', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openInClientTab('https://example.com/docs')
    expect(open).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer',
    )
  })
})
