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
 * Network page: the first proxy read waits for the runtime grant, Enter sends
 * only what Apply would, a PAC address with the wrong scheme gets its own
 * hint, and the private-network note shows for every mode that can put a
 * proxy in the path.
 */

const getProxySettings = vi.fn<(transport: unknown) => Promise<BridgeProxySettings>>()
const setProxySettings = vi.fn<(transport: unknown, payload: unknown) => Promise<BridgeProxySettings>>()

vi.mock('../browser/webview/nexusBridgeActions', () => ({
  getProxySettings: (transport: unknown) => getProxySettings(transport),
  setProxySettings: (transport: unknown, payload: unknown) => setProxySettings(transport, payload),
}))

import { NetworkSection } from '../browser/webview/settings/sections/NetworkSection'

const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport

function settings(patch: Partial<BridgeProxySettings> = {}): BridgeProxySettings {
  return { mode: 'system', source: 'default', editable: true, ...patch }
}

function page(capabilities: CapabilityQuery) {
  return createElement(
    RuntimeCapabilitiesContext.Provider,
    { value: capabilities },
    createElement(NetworkSection, { transport }),
  )
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
    await screen.findByTestId('settings-network')
    expect(getProxySettings).toHaveBeenCalledTimes(1)
  })

  it('sends nothing on Enter when the form matches the setting in force', async () => {
    getProxySettings.mockResolvedValue(
      settings({ mode: 'fixed', server: 'http://proxy.example.com:3128', source: 'user' }),
    )
    render(page(ALLOW_ALL))
    const server = await screen.findByTestId('network-proxy-server')
    fireEvent.keyDown(server, { key: 'Enter' })
    await act(async () => {})
    expect(setProxySettings).not.toHaveBeenCalled()
  })

  it('names the PAC schemes, not the proxy server ones, for a PAC address', async () => {
    getProxySettings.mockResolvedValue(settings({ mode: 'pac', pacUrl: '', source: 'user' }))
    render(page(ALLOW_ALL))
    const field = await screen.findByTestId('network-proxy-pacUrl')
    fireEvent.change(field, { target: { value: 'file:///C:/corp/proxy.pac' } })
    fireEvent.click(screen.getByTestId('network-proxy-apply'))
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
      await screen.findByTestId('settings-network')
      await waitFor(() =>
        expect(screen.queryByTestId('network-proxy-private-network') !== null).toBe(shown),
      )
      cleanup()
    }
  })
})
