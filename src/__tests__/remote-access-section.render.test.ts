// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { I18nProvider } from '../browser/webview/i18n'
import {
  RemoteAccessSection,
  type RemoteAccessConnection,
} from '../browser/webview/settings/sections/RemoteAccessSection'
import type { RemoteAccessState } from '../browser/runtimeHub/remoteAccessDriver'
import type { RemoteState } from '../browser/runtimeHub/remoteCapability'

/**
 * RemoteAccessSection: all state from the `remote/state` topic; disabled shows only the master toggle; the first
 * enable confirms the risk; no network options; status and device count on separate lines in the switch's card;
 * one recommended address, the rest under "Other available addresses" with their own copy buttons; Access security
 * and Connected devices are their own sections; Regenerate is two-step (`remote.resetSharing`). Pairing fixtures
 * use relative timestamps so they never expire.
 */

function makeAccess(over: Partial<RemoteAccessState> = {}): RemoteAccessState {
  return {
    supported: true,
    enabled: false,
    bindAddress: '',
    port: 7331,
    state: 'off',
    addresses: [
      { address: '127.0.0.1', interfaceName: 'Loopback' },
      { address: '192.168.1.10', interfaceName: 'Wi-Fi' },
      { address: '10.0.0.4', interfaceName: 'Ethernet' },
      { address: '172.26.0.1', interfaceName: 'vEthernet (WSL)' },
    ],
    clients: 0,
    ...over,
  }
}

/** The one long-lived pairing the runtime mints on enable (task #14). */
function makePairing(over: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    pairId: 'pair-1',
    scope: { mode: 'manager', sessions: 'all' },
    label: 'This device',
    createdAt: now - 60_000,
    expiresAt: now + 24 * 60 * 60 * 1000,
    revoked: false,
    lastSeenAt: null,
    connections: 0,
    ...over,
  } as RemoteState['pairings'][number]
}

/** A fake connection. `remote.currentPairing` answers the one pairing's
 *  fragment (the task-#14 read); every other route records its call. */
function makeConn(opts: { fragment?: string | null } = {}) {
  const requests: Array<{ route: string; payload: unknown }> = []
  const fragment = opts.fragment === undefined ? 'rt=abc' : opts.fragment
  const conn = {
    async request(route: string, payload?: unknown) {
      requests.push({ route, payload })
      if (route === 'remote.currentPairing') {
        return fragment === null ? null : { pairId: 'pair-1', fragment }
      }
      return {}
    },
  } as unknown as RemoteAccessConnection
  return { conn, requests }
}

/** Render the section the way the shell does: state + conn as props. */
function renderSection(
  remoteState: RemoteState,
  opts: { fragment?: string | null } = {},
) {
  const fake = makeConn(opts)
  render(
    createElement(
      I18nProvider,
      { locale: 'en' as const },
      createElement(RemoteAccessSection, {
        state: {
          access: remoteState.access,
          pairings: remoteState.pairings,
          connections: remoteState.connections ?? [],
        },
        conn: fake.conn,
      }),
    ),
  )
  return fake
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RemoteAccessSection', () => {
  it('while disabled renders ONLY the master toggle', async () => {
    renderSection({ relay: 'off', pairings: [], access: makeAccess() })
    await screen.findByTestId('remote-access-toggle')
    expect(document.body.textContent).toContain('Remote access is off.')
    // No status card, no links section, no network surface, no stop sharing.
    expect(screen.queryByTestId('remote-access-status')).toBeNull()
    expect(screen.queryByTestId('remote-access-links')).toBeNull()
    expect(screen.queryByTestId('remote-access-no-link')).toBeNull()
    expect(screen.queryByTestId('remote-access-security-note')).toBeNull()
    expect(screen.queryByTestId('remote-access-stop-sharing')).toBeNull()
  })

  it('first enable goes through the one-time confirmation before setAccess', async () => {
    const fake = renderSection({
      relay: 'off',
      pairings: [],
      access: makeAccess({ enabled: false }),
    })
    const toggle = (await screen.findByTestId('remote-access-toggle')) as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    fireEvent.click(toggle)
    // The confirmation dialog shows the risk copy.
    const dialog = await screen.findByTestId('remote-access-enable-confirm')
    expect(dialog.textContent).toContain('plain HTTP')
    expect(fake.requests.some(r => r.route === 'remote.setAccess')).toBe(false)
    fireEvent.click(screen.getByTestId('remote-access-enable-confirm-button'))
    await waitFor(() =>
      expect(
        fake.requests.some(
          r => r.route === 'remote.setAccess' && (r.payload as { enabled?: boolean }).enabled === true,
        ),
      ).toBe(true),
    )
  })

  it('disabling with nobody connected calls setAccess with no confirmation', async () => {
    const fake = renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening' }),
    })
    const toggle = (await screen.findByTestId('remote-access-toggle')) as HTMLButtonElement
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(
        fake.requests.some(
          r => r.route === 'remote.setAccess' && (r.payload as { enabled?: boolean }).enabled === false,
        ),
      ).toBe(true),
    )
    expect(screen.queryByTestId('remote-access-enable-confirm')).toBeNull()
    expect(screen.queryByTestId('remote-access-disable-confirm')).toBeNull()
  })

  it('disabling with devices connected asks first, naming how many', async () => {
    const fake = renderSection({
      relay: 'online',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening', clients: 2 }),
    })
    fireEvent.click(await screen.findByTestId('remote-access-toggle'))
    const dialog = await screen.findByTestId('remote-access-disable-confirm')
    expect(dialog.textContent).toContain('2 devices are connected')
    expect(dialog.textContent).toContain('the link works again')
    const turnedOff = () =>
      fake.requests.some(
        r => r.route === 'remote.setAccess' && (r.payload as { enabled?: boolean }).enabled === false,
      )
    expect(turnedOff()).toBe(false)

    fireEvent.click(screen.getByTestId('remote-access-disable-confirm-button'))
    await waitFor(() => expect(turnedOff()).toBe(true))
  })

  it('cancelling the switch-off leaves remote access on', async () => {
    const fake = renderSection({
      relay: 'online',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening', clients: 1 }),
    })
    fireEvent.click(await screen.findByTestId('remote-access-toggle'))
    const dialog = await screen.findByTestId('remote-access-disable-confirm')
    expect(dialog.textContent).toContain('1 device is connected')
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() =>
      expect(screen.queryByTestId('remote-access-disable-confirm')).toBeNull(),
    )
    expect(fake.requests.some(r => r.route === 'remote.setAccess')).toBe(false)
  })

  it('shows the status and client count once enabled', async () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening', clients: 2 }),
    })
    await waitFor(() => {
      const status = screen.getByTestId('remote-access-status')
      expect(status.textContent).toContain('Running')
      expect(screen.getByTestId('remote-access-device-count').textContent).toBe(
        '2 devices connected',
      )
    })
    // The listener state and the device count are two lines, not one
    // "Running · N devices" line that read as "a connection is running".
    const status = screen.getByTestId('remote-access-status')
    expect(status.textContent).not.toContain('·')
    expect(status.contains(screen.getByTestId('remote-access-device-count'))).toBe(true)
    // The card says nothing the section heading above already says: no
    // second "Remote access" label beside the switch.
    const card0 = status.closest('[data-settings-card]')!
    expect(card0.textContent).not.toContain('Remote access')
    // The status is part of the switch's card, not a card of its own.
    const card = status.closest('[data-settings-card]')
    expect(card?.contains(screen.getByTestId('remote-access-toggle'))).toBe(true)
  })

  it('names a single device in the singular', async () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening', clients: 1 }),
    })
    await waitFor(() =>
      expect(screen.getByTestId('remote-access-device-count').textContent).toBe(
        '1 device connected',
      ),
    )
  })

  it('maps port_in_use to its plain-language line', async () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'error', error: 'port_in_use' }),
    })
    await waitFor(() =>
      expect(screen.getByTestId('remote-access-status').textContent).toContain('already in use'),
    )
  })

  it('recommends the private-LAN NIC and puts every other address under Other available addresses, all carrying the same fragment', async () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening' }),
    })
    const links = await screen.findByTestId('remote-access-links')
    await waitFor(() => {
      expect(screen.getAllByTestId('remote-access-address-link').length).toBe(4)
    })
    const rows = screen.getAllByTestId('remote-access-address-link')
    // Recommended first, then: the other NIC, the virtual adapter, loopback.
    expect(rows.map(r => r.getAttribute('data-address'))).toEqual([
      '192.168.1.10',
      '10.0.0.4',
      '172.26.0.1',
      '127.0.0.1',
    ])
    expect(rows[0]!.getAttribute('data-recommended')).toBe('true')
    // The interface is the name, Recommended is a badge beside it, and the
    // address is shown with its port — the part to check on the other device.
    expect(rows[0]!.textContent).toContain('Wi-Fi')
    expect(rows[0]!.textContent).toContain('Recommended')
    expect(rows[0]!.textContent).not.toContain('Wi-Fi · Recommended')
    const labelOf = (row: HTMLElement) =>
      row.querySelector('[data-testid="remote-access-address-label"]')?.textContent
    expect(labelOf(rows[0]!)).toBe('192.168.1.10:7331')
    // The recommended row carries the page's primary action.
    const copyOf = (row: HTMLElement) =>
      row.querySelector('[data-testid="remote-access-copy-link"]')?.textContent
    expect(copyOf(rows[0]!)).toBe('Copy connection link')
    expect(rows.slice(1).every(r => copyOf(r) === 'Copy link')).toBe(true)
    expect(rows.slice(1).every(r => !r.textContent?.includes('Recommended'))).toBe(true)
    expect(rows.slice(1).every(r => r.getAttribute('data-recommended') === null)).toBe(true)
    // The rest sit in the collapsed Other addresses disclosure — still in the
    // DOM (the e2e reads the loopback tooltip off the page), just closed.
    const other = screen.getByTestId('remote-access-other-addresses')
    expect(other.getAttribute('data-state')).toBe('closed')
    for (const row of rows.slice(1)) expect(other.contains(row)).toBe(true)
    expect(other.contains(rows[0]!)).toBe(false)
    expect(other.textContent).toContain('Other available addresses')
    expect(rows[1]!.textContent).toContain('Ethernet')
    expect(labelOf(rows[1]!)).toBe('10.0.0.4:7331')
    expect(rows[2]!.getAttribute('data-kind')).toBe('virtual')
    expect(rows[2]!.textContent).toContain('vEthernet (WSL)')
    expect(rows[3]!.getAttribute('data-kind')).toBe('loopback')
    expect(rows[3]!.textContent).toContain('This device only')
    expect(labelOf(rows[3]!)).toBe('127.0.0.1:7331')
    fireEvent.click(screen.getByTestId('remote-access-other-addresses-toggle'))
    await waitFor(() => expect(other.getAttribute('data-state')).toBe('open'))
    // Every link carries the SAME pairing fragment on its own host:port — in
    // the label's tooltip, and NOT printed on the row.
    for (const row of rows) {
      const url = `http://${row.getAttribute('data-address')}:7331/#rt=abc`
      const label = row.querySelector('[data-testid="remote-access-address-label"]')
      expect(label?.getAttribute('title')).toBe(url)
      expect(row.textContent).not.toContain(url)
      expect(row.textContent).not.toContain('#rt=')
    }
    // Every address keeps its own copy button.
    expect(links.querySelectorAll('[data-testid="remote-access-copy-link"]').length).toBe(4)
  })

  it('never recommends a Windows vEthernet adapter, even when it is listed before Wi-Fi', async () => {
    // The reported layout: Windows lists the Hyper-V/WSL switch (a 172.16/12
    // address, so the old 172.26-only prefix check missed it) ahead of Wi-Fi,
    // and the page used to show it first as if it were a LAN address.
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({
        enabled: true,
        state: 'listening',
        addresses: [
          { address: '127.0.0.1', interfaceName: 'Loopback' },
          { address: '172.21.96.1', interfaceName: 'vEthernet (Default Switch)' },
          { address: '10.199.72.127', interfaceName: 'Wi-Fi' },
        ],
      }),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('remote-access-address-link').length).toBe(3)
    })
    const rows = screen.getAllByTestId('remote-access-address-link')
    expect(rows.map(r => r.getAttribute('data-address'))).toEqual([
      '10.199.72.127',
      '172.21.96.1',
      '127.0.0.1',
    ])
    expect(rows[0]!.getAttribute('data-recommended')).toBe('true')
    expect(rows[1]!.getAttribute('data-kind')).toBe('virtual')
  })

  it('with no physical NIC there is no recommendation and Other addresses starts open', async () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({
        enabled: true,
        state: 'listening',
        addresses: [
          { address: '127.0.0.1', interfaceName: 'Loopback' },
          { address: '172.26.0.1', interfaceName: 'vEthernet (WSL)' },
        ],
      }),
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('remote-access-address-link').length).toBe(2)
    })
    expect(document.querySelector('[data-recommended="true"]')).toBeNull()
    expect(screen.getByTestId('remote-access-other-addresses').getAttribute('data-state')).toBe(
      'open',
    )
  })

  it('Access security is its own section: the password callout, Security details and the regenerate button', async () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening' }),
    })
    const note = await screen.findByTestId('remote-access-security-note')
    expect(note.textContent).toContain('The access link works like a password')
    expect(note.textContent).toContain('Anyone who has it can connect')
    // "Your own devices" was too narrow: sharing with a colleague is fine.
    expect(note.textContent).toContain('Only share it with devices you trust')
    expect(note.textContent).not.toContain('encrypted')
    // The callout, the details and the regenerate button are one section,
    // headed Access security — not a sentence between the links and a button.
    const section = note.closest('section')!
    expect(section.querySelector('h2')?.textContent).toBe('Access security')
    expect(section.contains(screen.getByTestId('remote-access-security-details'))).toBe(true)
    expect(section.contains(screen.getByTestId('remote-access-reset-link'))).toBe(true)
    expect(section.contains(screen.getByTestId('remote-access-links'))).toBe(false)
    const details = screen.getByTestId('remote-access-security-details')
    expect(details.getAttribute('data-state')).toBe('closed')
    fireEvent.click(screen.getByTestId('remote-access-security-details-toggle'))
    await waitFor(() => expect(details.getAttribute('data-state')).toBe('open'))
    expect(details.textContent).toContain('plain HTTP')
  })

  it('says there is no link yet when the pairing read has not answered (task #14 seam)', async () => {
    renderSection(
      {
        relay: 'off',
        pairings: [makePairing()],
        access: makeAccess({ enabled: true, state: 'listening' }),
      },
      { fragment: null },
    )
    await screen.findByTestId('remote-access-no-link')
    // No dead link is handed out.
    expect(screen.queryByTestId('remote-access-links')).toBeNull()
  })

  it('regenerate access link goes through remote.resetSharing, only after the confirmation', async () => {
    const fake = renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening' }),
    })
    const reset = await screen.findByTestId('remote-access-reset-link')
    expect(reset.textContent).toBe('Regenerate access link')
    fireEvent.click(reset)
    const dialog = await screen.findByTestId('remote-access-reset-confirm')
    expect(dialog.textContent).toContain('Regenerate access link?')
    expect(dialog.textContent).toContain('Existing links will stop working immediately')
    expect(fake.requests.some(r => r.route === 'remote.resetSharing')).toBe(false)

    fireEvent.click(await screen.findByTestId('remote-access-reset-confirm-button'))
    await waitFor(() =>
      expect(fake.requests.some(r => r.route === 'remote.resetSharing')).toBe(true),
    )
    // Revoking by id and minting from the page would race the runtime's own
    // renewal — the runtime owns which pairing is the sharing one.
    expect(fake.requests.some(r => r.route === 'remote.pairRevoke')).toBe(false)
    expect(fake.requests.some(r => r.route === 'remote.stopSharing')).toBe(false)
  })

  it('offers the regenerate button even when there is no link, and never a Stop sharing button', async () => {
    // An older build's Stop sharing leaves an enabled listener with no link;
    // Reset access link is the way back to one.
    renderSection(
      {
        relay: 'off',
        pairings: [makePairing({ revoked: true })],
        access: makeAccess({ enabled: true, state: 'listening' }),
      },
      { fragment: null },
    )
    await screen.findByTestId('remote-access-no-link')
    expect(screen.getByTestId('remote-access-reset-link')).toBeTruthy()
    expect(screen.queryByTestId('remote-access-stop-sharing')).toBeNull()
  })
})


/**
 * The connected-device list (F-24): each live row is named by its UA claim with the grant it holds; the count above
 * it is the C++ listener's own tally and stays.
 */
describe('RemoteAccessSection connected devices', () => {
  const device = (over: Record<string, unknown> = {}) => ({
    connectionId: 'c1',
    clientId: 'client-1',
    kind: 'browser' as const,
    scope: 'control' as const,
    connectedAt: Date.now() - 5 * 60_000,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    ...over,
  })

  it('names each device by its user agent, its grant and how long it has been on', () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening', clients: 1 }),
      connections: [device()],
    })
    const rows = screen.getAllByTestId('remote-access-device')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Chrome on Android')
    // The scope is rendered as a phrase, never the wire identifier.
    expect(rows[0].textContent).not.toContain('control')
    // The grant reads as a permission badge, apart from the age.
    expect(
      rows[0].querySelector('[data-testid="remote-access-device-scope"]')?.textContent,
    ).toBe('Sessions only')
    expect(rows[0].textContent).toContain('Connected 5 min ago')
    expect(rows[0].getAttribute('data-scope')).toBe('control')
    // The listener's own count is still the headline.
    expect(screen.getByTestId('remote-access-device-count').textContent).toBe(
      '1 device connected',
    )
    // The list is its own Connected devices section, not part of the
    // switch's status card.
    const section = screen.getByTestId('remote-access-devices-section')
    expect(section.querySelector('h2')?.textContent).toBe('Connected devices')
    expect(section.contains(rows[0])).toBe(true)
    expect(screen.getByTestId('remote-access-status').contains(rows[0])).toBe(false)
    expect(screen.queryByTestId('remote-access-devices-empty')).toBeNull()
  })

  it('says No devices connected when the listener counts nobody', () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening', clients: 0 }),
      connections: [],
    })
    expect(screen.getByTestId('remote-access-devices-empty').textContent).toBe(
      'No devices connected',
    )
    expect(screen.queryByTestId('remote-access-devices')).toBeNull()
  })

  it('lists no devices while the listener is not running (starting, or failed to bind)', () => {
    for (const over of [
      { state: 'error' as const, error: 'port_in_use' as const },
      { state: 'starting' as const },
    ]) {
      renderSection({
        relay: 'off',
        pairings: [makePairing()],
        access: makeAccess({ enabled: true, clients: 0, ...over }),
        connections: [],
      })
      // The count is hidden for a listener that is not up, and the device
      // section must agree with it rather than say "No devices connected".
      expect(screen.queryByTestId('remote-access-device-count')).toBeNull()
      expect(screen.queryByTestId('remote-access-devices-section')).toBeNull()
      expect(screen.queryByTestId('remote-access-devices-empty')).toBeNull()
      cleanup()
    }
  })

  it('a device whose UA parses to nothing is still listed, unnamed rather than guessed', () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening', clients: 1 }),
      connections: [device({ userAgent: 'curl/8.4.0' })],
    })
    expect(screen.getByTestId('remote-access-device').textContent).toContain(
      'Unidentified browser',
    )
  })

  it('publishes no list at all from a runtime that sends no rows — the count stands alone', () => {
    renderSection({
      relay: 'off',
      pairings: [makePairing()],
      access: makeAccess({ enabled: true, state: 'listening', clients: 2 }),
    })
    expect(screen.queryByTestId('remote-access-devices')).toBeNull()
    // Nor an empty state: "No devices" under "2 devices connected" would be
    // a contradiction, so the whole section stays out.
    expect(screen.queryByTestId('remote-access-devices-empty')).toBeNull()
    expect(screen.queryByTestId('remote-access-devices-section')).toBeNull()
    expect(screen.getByTestId('remote-access-status').textContent).toContain(
      '2 devices connected',
    )
  })
})
