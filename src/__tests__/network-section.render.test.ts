// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { BridgeProxySettings } from '../browser/bridge/protocol/network'
import {
  ALLOW_ALL,
  PENDING_GRANT,
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'

/**
 * Network page: only the sections this connection may see; the proxy in force
 * is one summary row whose Edit opens the form in a dialog. The first read
 * waits for the grant, Enter sends only what Save would, Save closes on the
 * host's answer and stays open on a refusal, Cancel sends nothing, a bad PAC
 * scheme gets its own hint, and the private-network note shows for fixed, pac
 * and autoDetect (an OS proxy under `system` cannot be known in advance).
 */

const getProxySettings = vi.fn<(transport: unknown) => Promise<BridgeProxySettings>>()
const setProxySettings = vi.fn<(transport: unknown, payload: unknown) => Promise<BridgeProxySettings>>()

vi.mock('../browser/webview/nexusBridgeActions', () => ({
  getProxySettings: (transport: unknown) => getProxySettings(transport),
  setProxySettings: (transport: unknown, payload: unknown) => setProxySettings(transport, payload),
}))

import { NetworkSection } from '../browser/webview/settings/sections/NetworkSection'
import type { SettingsPartId } from '../browser/webview/settings/settingsNav'

const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport

function settings(patch: Partial<BridgeProxySettings> = {}): BridgeProxySettings {
  return { mode: 'system', source: 'default', editable: true, ...patch }
}

function page(capabilities: CapabilityQuery, parts: SettingsPartId[] = ['proxy']) {
  return createElement(
    RuntimeCapabilitiesContext.Provider,
    { value: capabilities },
    createElement(NetworkSection, { transport, parts, remoteState: null, remoteConn: null }),
  )
}

/** Open the proxy dialog from the summary row. */
async function openDialog() {
  fireEvent.click(await screen.findByTestId('network-proxy-edit'))
  return screen.findByTestId('network-proxy-dialog')
}

beforeEach(() => {
  getProxySettings.mockReset()
  setProxySettings.mockReset()
})

afterEach(() => cleanup())

describe('NetworkSection', () => {
  it('reads the setting only once the grant has landed', async () => {
    getProxySettings.mockResolvedValue(settings())
    const view = render(page(PENDING_GRANT))
    await act(async () => {})
    expect(getProxySettings).not.toHaveBeenCalled()
    expect(screen.queryByTestId('network-proxy-unavailable')).toBeNull()

    view.rerender(page(ALLOW_ALL))
    await screen.findByTestId('network-proxy-summary')
    expect(getProxySettings).toHaveBeenCalledTimes(1)
  })

  it('renders only the sections it is given', async () => {
    getProxySettings.mockResolvedValue(settings())
    render(page(ALLOW_ALL, ['remoteAccess']))
    await screen.findByTestId('settings-remote-access')
    expect(screen.queryByTestId('settings-network-proxy')).toBeNull()
    expect(getProxySettings).not.toHaveBeenCalled()
    cleanup()

    render(page(ALLOW_ALL, ['proxy', 'remoteAccess']))
    await screen.findByTestId('network-proxy-summary')
    expect(screen.getByTestId('settings-remote-access')).toBeTruthy()
  })

  it('shows the proxy in force as a summary row, with no form on the page', async () => {
    getProxySettings.mockResolvedValue(
      settings({ mode: 'fixed', server: 'http://proxy.example.com:3128', username: 'me', source: 'user' }),
    )
    render(page(ALLOW_ALL))
    const summary = await screen.findByTestId('network-proxy-summary')
    expect(summary.getAttribute('data-mode')).toBe('fixed')
    expect(summary.textContent).toContain('http://proxy.example.com:3128')
    expect(summary.textContent).toContain('me')
    expect(screen.queryByTestId('network-proxy-server')).toBeNull()
    expect(screen.queryByTestId('network-proxy-save')).toBeNull()
  })

  it('cannot open the form while a higher store overrides the setting', async () => {
    getProxySettings.mockResolvedValue(settings({ editable: false, source: 'policy' }))
    render(page(ALLOW_ALL))
    expect(await screen.findByTestId('network-proxy-overridden')).toBeTruthy()
    expect((screen.getByTestId('network-proxy-edit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('closes on Save with the host answer shown, and Cancel sends nothing', async () => {
    getProxySettings.mockResolvedValue(settings())
    setProxySettings.mockResolvedValue(settings({ mode: 'direct', source: 'user' }))
    render(page(ALLOW_ALL))
    await openDialog()
    fireEvent.click(screen.getByTestId('network-proxy-cancel'))
    await waitFor(() => expect(screen.queryByTestId('network-proxy-dialog')).toBeNull())
    expect(setProxySettings).not.toHaveBeenCalled()

    await openDialog()
    fireEvent.click(screen.getByTestId('network-proxy-mode'))
    fireEvent.click(await screen.findByTestId('network-proxy-mode-option-direct'))
    fireEvent.click(screen.getByTestId('network-proxy-save'))
    await waitFor(() => expect(screen.queryByTestId('network-proxy-dialog')).toBeNull())
    expect(setProxySettings.mock.calls[0]![1]).toEqual({ mode: 'direct' })
    expect(screen.getByTestId('network-proxy-summary').getAttribute('data-mode')).toBe('direct')
  })

  it('keeps the dialog and the typed values open on a refusal', async () => {
    getProxySettings.mockResolvedValue(settings())
    setProxySettings.mockRejectedValue(new Error('refused'))
    render(page(ALLOW_ALL))
    await openDialog()
    fireEvent.click(screen.getByTestId('network-proxy-mode'))
    fireEvent.click(await screen.findByTestId('network-proxy-mode-option-direct'))
    fireEvent.click(screen.getByTestId('network-proxy-save'))
    expect(await screen.findByTestId('network-proxy-refused')).toBeTruthy()
    expect(screen.getByTestId('network-proxy-dialog')).toBeTruthy()
  })

  it('sends nothing on Enter when the form matches the setting in force', async () => {
    getProxySettings.mockResolvedValue(
      settings({ mode: 'fixed', server: 'http://proxy.example.com:3128', source: 'user' }),
    )
    render(page(ALLOW_ALL))
    await openDialog()
    const server = await screen.findByTestId('network-proxy-server')
    fireEvent.keyDown(server, { key: 'Enter' })
    await act(async () => {})
    expect(setProxySettings).not.toHaveBeenCalled()
  })

  it('sends a typed sign-in, masks the password, and never shows a stored one', async () => {
    const stored = settings({
      mode: 'fixed', server: 'http://proxy.example.com:3128', username: 'me', hasPassword: true, source: 'user',
    })
    getProxySettings.mockResolvedValue(stored)
    setProxySettings.mockResolvedValue(stored)
    render(page(ALLOW_ALL))
    await openDialog()
    const password = (await screen.findByTestId('network-proxy-password')) as HTMLInputElement
    expect(password.type).toBe('password')
    expect(password.value).toBe('')
    expect(password.placeholder).toBe('Saved. Leave empty to keep it.')
    expect((screen.getByTestId('network-proxy-username') as HTMLInputElement).value).toBe('me')

    fireEvent.change(password, { target: { value: 'n3w-pass' } })
    fireEvent.click(screen.getByTestId('network-proxy-save'))
    await waitFor(() => expect(setProxySettings).toHaveBeenCalledTimes(1))
    expect(setProxySettings.mock.calls[0]![1]).toEqual({
      mode: 'fixed', server: 'http://proxy.example.com:3128', username: 'me', password: 'n3w-pass',
    })
    await waitFor(() => expect(screen.queryByTestId('network-proxy-dialog')).toBeNull())
    await openDialog()
    expect((screen.getByTestId('network-proxy-password') as HTMLInputElement).value).toBe('')
  })

  it('asks for the password again when the user name changes', async () => {
    getProxySettings.mockResolvedValue(
      settings({ mode: 'fixed', server: 'http://proxy.example.com:3128', username: 'me', hasPassword: true, source: 'user' }),
    )
    render(page(ALLOW_ALL))
    await openDialog()
    fireEvent.change(await screen.findByTestId('network-proxy-username'), { target: { value: 'you' } })
    fireEvent.click(screen.getByTestId('network-proxy-save'))
    expect((await screen.findByTestId('network-proxy-problem-password')).textContent).toBe('Enter the password.')
    expect(setProxySettings).not.toHaveBeenCalled()
  })

  it('stops saying the password is saved once the server changes', async () => {
    getProxySettings.mockResolvedValue(
      settings({ mode: 'fixed', server: 'http://proxy.example.com:3128', username: 'me', hasPassword: true, source: 'user' }),
    )
    render(page(ALLOW_ALL))
    await openDialog()
    const password = (await screen.findByTestId('network-proxy-password')) as HTMLInputElement
    expect(password.placeholder).toBe('Saved. Leave empty to keep it.')
    fireEvent.change(screen.getByTestId('network-proxy-server'), { target: { value: 'https://proxy.example.com:3128' } })
    expect(password.placeholder).toBe('')
  })

  it('names the PAC schemes, not the proxy server ones, for a PAC address', async () => {
    getProxySettings.mockResolvedValue(settings({ mode: 'pac', pacUrl: '', source: 'user' }))
    render(page(ALLOW_ALL))
    await openDialog()
    const field = await screen.findByTestId('network-proxy-pacUrl')
    fireEvent.change(field, { target: { value: 'file:///C:/corp/proxy.pac' } })
    fireEvent.click(screen.getByTestId('network-proxy-save'))
    const problem = await screen.findByTestId('network-proxy-problem-pacUrl')
    expect(problem.textContent).not.toContain('socks')
    expect(setProxySettings).not.toHaveBeenCalled()
  })

  it('shows the private-network note for each mode that can use a proxy', async () => {
    for (const [mode, shown] of [
      ['system', false],
      ['direct', false],
      ['fixed', true],
      ['pac', true],
      ['autoDetect', true],
    ] as const) {
      getProxySettings.mockResolvedValue(
        settings({ mode, server: 'http://proxy.example.com', pacUrl: 'https://example.com/p.pac' }),
      )
      render(page(ALLOW_ALL))
      await openDialog()
      await waitFor(() =>
        expect(screen.queryByTestId('network-proxy-private-network') !== null).toBe(shown),
      )
      cleanup()
    }
  })
})
