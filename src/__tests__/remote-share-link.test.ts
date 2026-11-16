import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { SRC, staticClosure } from './_helpers/staticImportGraph'

import {
  preferredShareLink,
  readCurrentPairing,
  shareLinkRows,
  splitAddresses,
} from '../browser/webview/remote/shareLink'

/**
 * The share link Settings → Remote access and the top bar's connect popover
 * both hand out (F-24): the same pairing fragment on every address, and one
 * preferred address.
 */

const access = (addresses: Array<{ address: string; interfaceName: string }>) => ({
  addresses,
  port: 8765,
})

describe('remote access share link', () => {
  it('builds one http link per address with the pairing fragment', () => {
    const rows = shareLinkRows(access([{ address: '192.168.1.20', interfaceName: 'Wi-Fi' }]), 'pair=x')
    expect(rows).toEqual([
      { address: '192.168.1.20', interfaceName: 'Wi-Fi', kind: 'physical', url: 'http://192.168.1.20:8765/#pair=x' },
    ])
  })

  it('prefers a physical NIC on a private LAN, then any physical NIC', () => {
    const rows = shareLinkRows(
      access([
        { address: '172.26.0.5', interfaceName: 'vEthernet (WSL)' },
        { address: '203.0.113.9', interfaceName: 'Ethernet' },
        { address: '10.0.0.7', interfaceName: 'Wi-Fi' },
      ]),
      'f',
    )
    expect(splitAddresses(rows).recommended?.address).toBe('10.0.0.7')
    expect(
      splitAddresses(rows.filter(r => r.address !== '10.0.0.7')).recommended?.address,
    ).toBe('203.0.113.9')
  })

  it('hands out the recommended link, else the first remaining one, else none', () => {
    expect(
      preferredShareLink(
        access([
          { address: '172.26.0.5', interfaceName: 'vEthernet (WSL)' },
          { address: '192.168.1.20', interfaceName: 'Wi-Fi' },
        ]),
        'f',
      ),
    ).toBe('http://192.168.1.20:8765/#f')
    // No physical NIC: virtual adapters sort ahead of loopback.
    expect(
      preferredShareLink(
        access([
          { address: '127.0.0.1', interfaceName: 'Loopback' },
          { address: '172.26.0.5', interfaceName: 'vEthernet (WSL)' },
        ]),
        'f',
      ),
    ).toBe('http://172.26.0.5:8765/#f')
    expect(preferredShareLink(access([]), 'f')).toBeNull()
  })

  it('reads the current pairing, and degrades to null on none, a blank fragment or an error', async () => {
    const ok = { request: vi.fn(async () => ({ pairId: 'p', fragment: 'f' })) }
    expect(await readCurrentPairing(ok as never)).toEqual({ pairId: 'p', fragment: 'f' })
    expect(ok.request).toHaveBeenCalledWith('remote.currentPairing', {})
    expect(await readCurrentPairing({ request: async () => null } as never)).toBeNull()
    expect(await readCurrentPairing({ request: async () => ({ pairId: 'p', fragment: '' }) } as never)).toBeNull()
    expect(
      await readCurrentPairing({ request: async () => { throw new Error('denied') } } as never),
    ).toBeNull()
  })
})

describe('the QR encoder stays off the boot chunk', () => {
  it("is not on the shell's static import graph", () => {
    const shell = staticClosure([join(SRC, 'browser', 'webview', 'MultiSessionShell.tsx')])
    expect(shell.has(join(SRC, 'browser', 'webview', 'topbar', 'RemoteConnectButton.tsx'))).toBe(true)
    expect(shell.has(join(SRC, 'browser', 'webview', 'remote', 'QrCodeSvg.tsx'))).toBe(false)
  })
})
