// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { I18nProvider } from '../browser/webview/i18n'
import { NexusTopBar } from '../browser/webview/topbar/NexusTopBar'

/**
 * The topbar's remote-access button without a connect source (F-24): a QR
 * icon with the count of remote devices, just before the search control,
 * that opens Settings → Remote access. Absent while nobody is connected;
 * the shell decides the count (and passes 0 when the page is not reachable).
 * With a `remoteConnect` source the control is RemoteConnectButton instead,
 * covered by topbar-remote-connect.render.test.ts.
 */

function renderBar(props: { remoteDeviceCount?: number; searchSlot?: unknown } = {}) {
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

afterEach(() => {
  cleanup()
})

describe('NexusTopBar connected remote devices', () => {
  it('is absent while no remote device is connected', () => {
    renderBar({ remoteDeviceCount: 0 })
    expect(screen.queryByTestId('topbar-remote-devices')).toBeNull()
    cleanup()
    renderBar({})
    expect(screen.queryByTestId('topbar-remote-devices')).toBeNull()
  })

  it('shows the count and names it, and opens Remote access settings', () => {
    const { onOpenSettings } = renderBar({ remoteDeviceCount: 2 })
    const button = screen.getByTestId('topbar-remote-devices')
    expect(button.textContent).toContain('2')
    expect(button.getAttribute('aria-label')).toBe('2 remote devices connected')

    fireEvent.click(button)
    expect(onOpenSettings).toHaveBeenCalledWith('remoteAccess')
  })

  it('uses the singular for one device', () => {
    renderBar({ remoteDeviceCount: 1 })
    expect(screen.getByTestId('topbar-remote-devices').getAttribute('aria-label')).toBe(
      '1 remote device connected',
    )
  })

  it('sits just before the search control', () => {
    renderBar({
      remoteDeviceCount: 3,
      searchSlot: createElement('div', { 'data-testid': 'search-stub' }),
    })
    const button = screen.getByTestId('topbar-remote-devices')
    const divider = screen.getByTestId('topbar-search-divider')
    // DOCUMENT_POSITION_FOLLOWING: the divider (and the search after it)
    // comes right after the button.
    expect(button.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(button.closest('[data-app-region="no-drag"]')?.lastElementChild
      ?.getAttribute('data-testid')).toBe('search-stub')
  })
})
