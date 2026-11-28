// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import { useTopbarRemoteAccess } from '../browser/webview/remote/useTopbarRemoteAccess'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import type { CapabilityQuery } from '../browser/webview/useCan'
import { __setUiChannelForTest } from '../branding/updateChannels'

/**
 * The top bar's remote-access inputs (F-24): the device count and the connect
 * button's source exist only while remote access is on and its settings
 * section is one this connection may open.
 */

type Listener = (event: { payload: unknown }) => void

function fakeConnection() {
  let listener: Listener | null = null
  const connection = {
    subscribe: vi.fn((_topic: string, l: Listener) => {
      listener = l
      return () => {
        listener = null
      }
    }),
    request: vi.fn(),
  }
  return {
    connect: () => Promise.resolve(connection as unknown as RuntimeConnection),
    connection,
    publish: (payload: unknown) => act(() => listener?.({ payload })),
  }
}

const all: CapabilityQuery = { can: () => true }
const access = (over: Record<string, unknown> = {}) => ({
  supported: true,
  enabled: true,
  bindAddress: '0.0.0.0',
  port: 8765,
  state: 'listening',
  addresses: [{ address: '192.168.1.20', interfaceName: 'Wi-Fi' }],
  clients: 2,
  ...over,
})
const pairings = [
  { pairId: 'old', revoked: true, expiresAt: Date.now() + 60_000 },
  { pairId: 'live', revoked: false, expiresAt: Date.now() + 60_000 },
]

describe('useTopbarRemoteAccess', () => {
  beforeEach(() => __setUiChannelForTest('stable'))
  afterEach(() => __setUiChannelForTest(null))

  it('gives the count and the source while remote access is on, and nothing once off', async () => {
    const fake = fakeConnection()
    const { result } = renderHook(() => useTopbarRemoteAccess(fake.connect, all, false))
    await waitFor(() => expect(fake.connection.subscribe).toHaveBeenCalled())
    expect(result.current.remoteConnect).toBeUndefined()

    fake.publish({ access: access(), pairings })
    expect(result.current.remoteDeviceCount).toBe(2)
    expect(result.current.remoteConnect?.pairingKey).toBe('live')
    expect(result.current.remoteConnect?.connection).toBe(fake.connection)

    fake.publish({ access: access({ enabled: false, clients: 0 }), pairings })
    expect(result.current.remoteDeviceCount).toBe(0)
    expect(result.current.remoteConnect).toBeUndefined()
  })

  it('gives nothing on a remote client page, or without the grant', async () => {
    const remote = fakeConnection()
    const onRemote = renderHook(() => useTopbarRemoteAccess(remote.connect, all, true))
    await waitFor(() => expect(remote.connection.subscribe).toHaveBeenCalled())
    remote.publish({ access: access(), pairings })
    expect(onRemote.result.current.remoteConnect).toBeUndefined()
    expect(onRemote.result.current.remoteDeviceCount).toBe(0)

    const none: CapabilityQuery = { can: () => false }
    const denied = fakeConnection()
    const noGrant = renderHook(() => useTopbarRemoteAccess(denied.connect, none, false))
    expect(denied.connection.subscribe).not.toHaveBeenCalled()
    expect(noGrant.result.current.remoteConnect).toBeUndefined()
  })
})
