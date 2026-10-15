// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { I18nProvider } from '../browser/webview/i18n'
import { NexusTopBar } from '../browser/webview/topbar/NexusTopBar'
import {
  remoteHostFromBootstrap,
  userNameFromHomeDir,
} from '../browser/webview/remote/hostIdentity'
import { parseUserAgent, describeUserAgent } from '../browser/webview/remote/userAgentLabel'

/**
 * F-24: the topbar has two shapes. The desktop shows the connected-devices link and reserves the caption strip; a
 * remote page shows the host indicator (tooltip, log-out menu) there instead. Pinned in both directions.
 */

function renderBar(props: Record<string, unknown> = {}) {
  const onOpenSettings = vi.fn()
  render(
    createElement(
      I18nProvider,
      { locale: 'en' as const },
      createElement(NexusTopBar, {
        catalog: null,
        selection: null,
        onSelectModel: () => {},
        onOpenSettings,
        ...props,
      } as Parameters<typeof NexusTopBar>[0]),
    ),
  )
  return { onOpenSettings }
}

const HOST = { address: '192.168.1.10:47615', hostName: 'studio-pc', osName: 'Windows 11' }

afterEach(() => {
  cleanup()
})

describe('NexusTopBar on a remote page', () => {
  it('hides the connected-devices link even when a count is passed', () => {
    // The count reaching the topbar is not hypothetical: a loopback remote
    // holds `manager`, so the shell's capability gate lets it read
    // `remote/state` and compute a non-zero count. Page identity is what
    // suppresses the button.
    renderBar({ remoteDeviceCount: 3, remoteHost: HOST, onRemoteLogOut: () => {} })
    expect(screen.queryByTestId('topbar-remote-devices')).toBeNull()
  })

  it('renders the host indicator, with the machine in its accessible name', () => {
    renderBar({ remoteHost: HOST, onRemoteLogOut: () => {} })
    const button = screen.getByTestId('topbar-remote-host')
    expect(button.getAttribute('aria-label')).toBe('Connected to studio-pc')
  })

  it('names the address when the host is too old to report a machine name', () => {
    renderBar({
      remoteHost: { address: '192.168.1.10:47615' },
      onRemoteLogOut: () => {},
    })
    expect(screen.getByTestId('topbar-remote-host').getAttribute('aria-label')).toBe(
      'Connected to 192.168.1.10:47615',
    )
  })

  it('the tooltip names the machine once: the headline, then only what it does not say', async () => {
    // Reported: the tooltip read "Connected to studio-pc" and then
    // "studio-pc" again on the next line. The headline already names it.
    renderBar({ remoteHost: { ...HOST, userName: 'ada' }, onRemoteLogOut: () => {} })
    await act(async () => {
      fireEvent.focus(screen.getByTestId('topbar-remote-host'))
    })
    // Radix renders a visually-hidden copy for screen readers; the first is
    // the visible one.
    const tooltip = (await screen.findAllByTestId('topbar-remote-host-tooltip'))[0]!
    const rows = Array.from(tooltip.children).map((row) => row.textContent)
    expect(rows).toEqual([
      'Connected to studio-pc',
      'Windows 11',
      'ada',
      '192.168.1.10:47615',
    ])
  })

  it('an older host with no machine name does not repeat the address either', async () => {
    renderBar({ remoteHost: { address: '192.168.1.10:47615' }, onRemoteLogOut: () => {} })
    await act(async () => {
      fireEvent.focus(screen.getByTestId('topbar-remote-host'))
    })
    const tooltip = (await screen.findAllByTestId('topbar-remote-host-tooltip'))[0]!
    const rows = Array.from(tooltip.children).map((row) => row.textContent)
    expect(rows).toEqual(['Connected to 192.168.1.10:47615'])
  })

  it('opens a menu whose Log out calls back', () => {
    const onRemoteLogOut = vi.fn()
    renderBar({ remoteHost: HOST, onRemoteLogOut })
    expect(screen.queryByTestId('topbar-remote-log-out')).toBeNull()

    fireEvent.click(screen.getByTestId('topbar-remote-host'))
    const menu = screen.getByTestId('topbar-remote-host-menu')
    // The menu repeats the identity the tooltip shows — the machine, its OS
    // and the address it was reached at.
    expect(menu.textContent).toContain('studio-pc')
    expect(menu.textContent).toContain('Windows 11')
    expect(menu.textContent).toContain('192.168.1.10:47615')

    fireEvent.click(screen.getByTestId('topbar-remote-log-out'))
    expect(onRemoteLogOut).toHaveBeenCalledTimes(1)
  })

  it('is absent on the desktop, which keeps its devices link', () => {
    renderBar({ remoteDeviceCount: 2 })
    expect(screen.queryByTestId('topbar-remote-host')).toBeNull()
    expect(screen.getByTestId('topbar-remote-devices')).toBeTruthy()
  })
})

describe('userNameFromHomeDir', () => {
  it('reads the account off either separator', () => {
    expect(userNameFromHomeDir('C:\\Users\\alice')).toBe('alice')
    expect(userNameFromHomeDir('/home/ada')).toBe('ada')
    expect(userNameFromHomeDir('/home/ada/')).toBe('ada')
  })

  it('names nobody rather than an empty string', () => {
    expect(userNameFromHomeDir(undefined)).toBeUndefined()
    expect(userNameFromHomeDir('')).toBeUndefined()
    expect(userNameFromHomeDir('/')).toBeUndefined()
  })
})

describe('remoteHostFromBootstrap', () => {
  it('carries only what the desktop reported', () => {
    expect(
      remoteHostFromBootstrap('10.0.0.4:47615', {
        homeDir: '/home/ada',
        hostName: 'studio',
        osName: 'Linux 6.8',
      }),
    ).toEqual({
      address: '10.0.0.4:47615',
      hostName: 'studio',
      osName: 'Linux 6.8',
      userName: 'ada',
    })
  })

  it('an older desktop (no bootstrap at all) leaves just the address', () => {
    expect(remoteHostFromBootstrap('10.0.0.4:47615', undefined)).toEqual({
      address: '10.0.0.4:47615',
    })
  })
})

describe('parseUserAgent', () => {
  // The whole point of the table's order: every Chromium browser says
  // "Chrome", and Chrome itself says "Safari". A table walked in the wrong
  // order reports every device as Safari.
  it('prefers the most specific browser a string claims', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
      ),
    ).toEqual({ browser: 'Edge', os: 'Windows' })
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      ),
    ).toEqual({ browser: 'Chrome', os: 'Android' })
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toEqual({ browser: 'Safari', os: 'macOS' })
  })

  it('files an iPad ahead of macOS, whichever order the string names them', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1',
      ).os,
    ).toBe('iOS')
  })

  it('reports nothing rather than guessing', () => {
    expect(parseUserAgent(undefined)).toEqual({})
    expect(parseUserAgent('curl/8.4.0')).toEqual({})
    expect(describeUserAgent('curl/8.4.0', (b, o) => `${b}/${o}`)).toBeUndefined()
  })

  it('joins only when both halves parsed, and degrades to the half that did', () => {
    const join = (b: string, o: string) => `${b} on ${o}`
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36',
        join,
      ),
    ).toBe('Chrome on Android')
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0)', join)).toBe('Windows')
  })
})

/**
 * The remote right column sits flush against the page edge: the caption reserve (`var(--nexus-caption-inset)`) is
 * rendered only on the desktop, pinned in both directions.
 */
describe('NexusTopBar right column alignment', () => {
  it('renders no caption reserve on a remote page', () => {
    renderBar({ remoteHost: HOST, onRemoteLogOut: () => {} })
    expect(screen.queryByTestId('topbar-caption-inset')).toBeNull()
  })

  it('keeps the caption reserve on the desktop', () => {
    renderBar({})
    expect(screen.getByTestId('topbar-caption-inset')).toBeTruthy()
  })

  it('ends the remote column with the fullscreen toggle, right of the host', () => {
    withFullscreenApi(() => {
      renderBar({ remoteHost: HOST, onRemoteLogOut: () => {} })
      const host = screen.getByTestId('topbar-remote-host')
      const toggle = screen.getByTestId('topbar-remote-fullscreen')
      expect(
        host.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      // Nothing after it: the column's last element child is the toggle (or
      // the tooltip wrapper that holds it), so it is the one at the edge.
      const column = host.closest('header')!.lastElementChild!
      expect(column.lastElementChild!.contains(toggle)).toBe(true)
    })
  })
})

/** Install a controllable Fullscreen API on `document` for one test. happy-dom
 *  does not implement it, and the component reads it at render time. */
function withFullscreenApi(
  run: (api: {
    request: ReturnType<typeof vi.fn>
    exit: ReturnType<typeof vi.fn>
    setElement: (el: Element | null) => void
  }) => void,
  enabled = true,
) {
  let element: Element | null = null
  const request = vi.fn(() => Promise.resolve())
  const exit = vi.fn(() => Promise.resolve())
  const doc = document as unknown as Record<string, unknown>
  const root = document.documentElement as unknown as Record<string, unknown>
  Object.defineProperty(doc, 'fullscreenEnabled', { configurable: true, get: () => enabled })
  Object.defineProperty(doc, 'fullscreenElement', { configurable: true, get: () => element })
  Object.defineProperty(doc, 'exitFullscreen', { configurable: true, value: exit })
  Object.defineProperty(root, 'requestFullscreen', { configurable: true, value: request })
  try {
    run({
      request,
      exit,
      setElement: (el) => {
        element = el
        act(() => {
          document.dispatchEvent(new Event('fullscreenchange'))
        })
      },
    })
  } finally {
    cleanup()
    delete doc.fullscreenEnabled
    delete doc.fullscreenElement
    delete doc.exitFullscreen
    delete root.requestFullscreen
  }
}

describe('RemoteFullscreenToggle', () => {
  it('asks the document root for fullscreen, and follows the browser back out', () => {
    withFullscreenApi(({ request, exit, setElement }) => {
      renderBar({ remoteHost: HOST, onRemoteLogOut: () => {} })
      const button = screen.getByTestId('topbar-remote-fullscreen')
      expect(button.getAttribute('aria-label')).toBe('Enter full screen')
      expect(button.getAttribute('aria-pressed')).toBe('false')

      fireEvent.click(button)
      expect(request).toHaveBeenCalledTimes(1)
      expect(exit).not.toHaveBeenCalled()

      // The icon follows the document's event, not the click: the browser
      // may refuse, and it leaves fullscreen on Esc without asking the page.
      setElement(document.documentElement)
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(button.getAttribute('aria-label')).toBe('Exit full screen')

      fireEvent.click(button)
      expect(exit).toHaveBeenCalledTimes(1)

      setElement(null)
      expect(button.getAttribute('aria-pressed')).toBe('false')
    })
  })

  it('is not offered where the browser has no fullscreen (iPhone Safari)', () => {
    withFullscreenApi(() => {
      renderBar({ remoteHost: HOST, onRemoteLogOut: () => {} })
      expect(screen.queryByTestId('topbar-remote-fullscreen')).toBeNull()
      // The host indicator is unaffected.
      expect(screen.getByTestId('topbar-remote-host')).toBeTruthy()
    }, false)
  })

  it('is absent on the desktop, whose window has its own maximise', () => {
    withFullscreenApi(() => {
      renderBar({})
      expect(screen.queryByTestId('topbar-remote-fullscreen')).toBeNull()
    })
  })
})
