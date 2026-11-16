// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { I18nProvider } from '../browser/webview/i18n'
import { NexusTopBar } from '../browser/webview/topbar/NexusTopBar'
import type { RemoteConnectSource } from '../browser/webview/topbar/RemoteConnectButton'
import { qrModules, qrPath } from '../browser/webview/remote/QrCodeSvg'
import type { RemoteAccessState } from '../browser/runtimeHub/remoteAccessDriver'

const clipboard = vi.hoisted(() => ({ writeClipboard: vi.fn<(text: string) => Promise<boolean>>() }))
vi.mock('../utils/clipboard', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/clipboard')>()),
  writeClipboard: clipboard.writeClipboard,
}))

/**
 * The desktop top bar's remote-access connect control (F-24): shown while
 * remote access is enabled, even with no device connected; its popover draws
 * the share link as a QR code and copies it.
 */

const FRAGMENT = 'pair=p1.s3cr3t'
const LINK = `http://192.168.1.20:8765/#${FRAGMENT}`

function access(over: Partial<RemoteAccessState> = {}): RemoteAccessState {
  return {
    supported: true,
    enabled: true,
    bindAddress: '0.0.0.0',
    port: 8765,
    state: 'listening',
    // The virtual adapter comes first; the recommended address is the LAN one.
    addresses: [
      { address: '172.26.0.5', interfaceName: 'vEthernet (WSL)' },
      { address: '192.168.1.20', interfaceName: 'Wi-Fi' },
    ],
    clients: 0,
    ...over,
  }
}

function source(
  over: Partial<RemoteAccessState> = {},
  pairing: unknown = { pairId: 'p1', fragment: FRAGMENT },
): RemoteConnectSource & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => pairing)
  return {
    access: access(over),
    pairingKey: 'p1',
    connection: { request } as unknown as RemoteConnectSource['connection'],
    request,
  }
}

function renderBar(props: Record<string, unknown>) {
  const onOpenSettings = vi.fn()
  const tree = (next: Record<string, unknown>) =>
    createElement(
      I18nProvider,
      { locale: 'en' as const },
      createElement(NexusTopBar, {
        catalog: null,
        selection: null,
        onSelectModel: () => {},
        onOpenSettings,
        ...next,
      } as Parameters<typeof NexusTopBar>[0]),
    )
  const { rerender } = render(tree(props))
  return { onOpenSettings, rerender: (next: Record<string, unknown>) => rerender(tree(next)) }
}

function openPopover() {
  fireEvent.click(screen.getByTestId('topbar-remote-devices'))
}

/** The module grid a rendered QR path draws, for comparing with an encoding. */
function drawnPath(): string {
  const svg = screen.getByTestId('topbar-remote-connect-qr')
  expect(svg.tagName.toLowerCase()).toBe('svg')
  return svg.querySelector('path')?.getAttribute('d') ?? ''
}

beforeEach(() => {
  clipboard.writeClipboard.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('NexusTopBar remote connect control', () => {
  it('shows while remote access is enabled with no device connected', () => {
    renderBar({ remoteConnect: source(), remoteDeviceCount: 0 })
    const button = screen.getByTestId('topbar-remote-devices')
    expect(button.getAttribute('aria-label')).toBe('Connect a device')
    expect(button.hasAttribute('data-count')).toBe(false)
  })

  it('is absent while remote access is off, and on a remote client page', () => {
    renderBar({ remoteConnect: source({ enabled: false, state: 'off' }) })
    expect(screen.queryByTestId('topbar-remote-devices')).toBeNull()
    cleanup()
    renderBar({
      remoteConnect: source(),
      remoteDeviceCount: 2,
      remoteHost: { address: '192.168.1.10:47615', hostName: 'studio-pc', osName: 'Windows 11' },
      onRemoteLogOut: () => {},
    })
    expect(screen.queryByTestId('topbar-remote-devices')).toBeNull()
  })

  it('draws the recommended address link as a QR code, never as text', async () => {
    const src = source()
    renderBar({ remoteConnect: src })
    // Nothing is read, and no code is drawn, until the popover opens.
    expect(src.request).not.toHaveBeenCalled()
    expect(screen.queryByTestId('topbar-remote-connect-qr')).toBeNull()

    openPopover()
    await screen.findByTestId('topbar-remote-connect-qr')
    expect(src.request).toHaveBeenCalledWith('remote.currentPairing', {})
    expect(drawnPath()).toBe(qrPath(qrModules(LINK)))
    expect(drawnPath()).not.toBe(qrPath(qrModules(`http://172.26.0.5:8765/#${FRAGMENT}`)))
    expect(document.body.textContent).not.toContain(FRAGMENT)
    expect(document.body.innerHTML).not.toContain(FRAGMENT)
  })

  it('falls back to the first address when none is recommended', async () => {
    renderBar({
      remoteConnect: source({
        addresses: [
          { address: '127.0.0.1', interfaceName: 'Loopback' },
          { address: '172.26.0.5', interfaceName: 'vEthernet (WSL)' },
        ],
      }),
    })
    openPopover()
    await screen.findByTestId('topbar-remote-connect-qr')
    expect(drawnPath()).toBe(qrPath(qrModules(`http://172.26.0.5:8765/#${FRAGMENT}`)))
  })

  it('copies exactly that link, and says when the copy fails', async () => {
    clipboard.writeClipboard.mockResolvedValueOnce(true)
    renderBar({ remoteConnect: source() })
    openPopover()
    const copy = await screen.findByTestId('topbar-remote-connect-copy')
    expect(copy.textContent).toBe('Copy link')
    fireEvent.click(copy)
    await waitFor(() => expect(copy.textContent).toBe('Copied'))
    expect(clipboard.writeClipboard).toHaveBeenCalledWith(LINK)

    clipboard.writeClipboard.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(copy)
    await waitFor(() => expect(copy.textContent).toBe('Copy failed'))
    expect(clipboard.writeClipboard).toHaveBeenLastCalledWith(LINK)

    clipboard.writeClipboard.mockResolvedValueOnce(false)
    cleanup()
    renderBar({ remoteConnect: source() })
    openPopover()
    const again = await screen.findByTestId('topbar-remote-connect-copy')
    fireEvent.click(again)
    await waitFor(() => expect(again.textContent).toBe('Copy failed'))
  })

  it.each([
    ['the listener is starting', { state: 'starting' as const }, undefined, 'Remote access is starting…'],
    ['the listener failed', { state: 'error' as const }, undefined, "Remote access couldn't start. Open its settings for details."],
    ['there is no address', { addresses: [] }, undefined, 'This computer has no network address to share yet.'],
    ['the pairing cannot be read', {}, null, "The access link isn't available. Open Remote access settings to create one."],
  ])('says so instead of drawing a code when %s', async (_name, over, pairing, note) => {
    const src = source(over, pairing === undefined ? { pairId: 'p1', fragment: FRAGMENT } : pairing)
    renderBar({ remoteConnect: src })
    openPopover()
    await waitFor(() =>
      expect(screen.getByTestId('topbar-remote-connect-note').textContent).toBe(note),
    )
    expect(screen.queryByTestId('topbar-remote-connect-qr')).toBeNull()
    expect(screen.queryByTestId('topbar-remote-connect-copy')).toBeNull()
  })

  it('reads the link again, while open, when the pairing is regenerated', async () => {
    const { rerender } = renderBar({ remoteConnect: source() })
    openPopover()
    await screen.findByTestId('topbar-remote-connect-qr')
    const next = source({}, { pairId: 'p2', fragment: 'pair=p2.n3w' })
    rerender({ remoteConnect: { ...next, pairingKey: 'p2' } })
    await waitFor(() =>
      expect(drawnPath()).toBe(qrPath(qrModules('http://192.168.1.20:8765/#pair=p2.n3w'))),
    )
  })

  it('carries the connected-device count and opens Remote access settings', async () => {
    const { onOpenSettings } = renderBar({ remoteConnect: source(), remoteDeviceCount: 2 })
    const button = screen.getByTestId('topbar-remote-devices')
    expect(button.getAttribute('data-count')).toBe('2')
    expect(button.textContent).toContain('2')
    expect(button.getAttribute('aria-label')).toBe('2 remote devices connected')

    openPopover()
    expect((await screen.findByTestId('topbar-remote-connect-devices')).textContent).toBe(
      '2 remote devices connected',
    )
    fireEvent.click(screen.getByTestId('topbar-remote-connect-settings'))
    expect(onOpenSettings).toHaveBeenCalledWith('remoteAccess')
    await waitFor(() => expect(screen.queryByTestId('topbar-remote-connect')).toBeNull())
  })

  it('closes on Escape and returns focus to the button', async () => {
    renderBar({ remoteConnect: source() })
    openPopover()
    await screen.findByTestId('topbar-remote-connect-qr')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('topbar-remote-connect')).toBeNull())
    expect(document.activeElement).toBe(screen.getByTestId('topbar-remote-devices'))
  })
})
