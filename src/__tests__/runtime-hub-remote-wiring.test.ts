/**
 * (F-24) The hub hands remote access the moments it cannot see itself: a replaced host bridge
 * reaches the driver, and a desktop shell's first build reaches the relay dialer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirectPortBridgeTransport } from '../browser/bridge/DirectPortBridgeTransport'
import type { RemoteAccessStatus } from '../browser/bridge/protocol/remoteAccess'
import { connectRuntime } from '../browser/runtimeClient'
import { RuntimeHub } from '../browser/runtimeHub/RuntimeHub'
import { createMessagePortTransport } from '../browser/runtimeTransport'

const STARTING: RemoteAccessStatus = {
  enabled: true, bindAddress: '192.168.1.10', port: 47615, state: 'starting', addresses: [], clients: 0,
}
const LISTENING: RemoteAccessStatus = {
  ...STARTING, state: 'listening',
  controlUrl: 'ws://192.168.1.10:47615/host/control', controlToken: 'tok',
}

/** A host bridge answering `remoteAccess.getStatus` with `status`; counts its event subscriptions and their releases. */
function hostBridge(status: RemoteAccessStatus) {
  const actions: string[] = []
  let subscriptions = 0
  let released = 0
  const transport = {
    async request(req: unknown) {
      const { route } = req as { route: { capability: string; action: string } }
      actions.push(`${route.capability}.${route.action}`)
      if (route.capability === 'remoteAccess' && route.action === 'getStatus') return { ok: true, result: status }
      return { ok: false, error: { code: 'UNSUPPORTED', message: route.action } }
    },
    subscribeEvents: () => { subscriptions += 1; return () => { released += 1 } },
  } as unknown as DirectPortBridgeTransport
  return { transport, actions, subscriptions: () => subscriptions, released: () => released }
}

describe('runtime hub remote-access wiring', () => {
  const hubs: RuntimeHub[] = []
  afterEach(() => {
    for (const hub of hubs.splice(0)) hub.dispose()
    vi.restoreAllMocks()
  })

  function makeHub(initial: DirectPortBridgeTransport) {
    let transport: DirectPortBridgeTransport | null = initial
    let n = 0
    const hub = new RuntimeHub({
      getDirectBridgeTransport: () => transport,
      createBridgeRequestId: () => `r-${++n}`,
      applyAgentSettingsToAllSessions: () => {},
      reloadPluginsOnAllSessions: () => {},
      runtimeVersion: 'test',
      resolveHomeDir: async () => '/home/u',
    })
    hubs.push(hub)
    hub.handleDirectTransportChanged(initial)
    return {
      hub,
      swap(next: DirectPortBridgeTransport) {
        transport = next
        hub.handleDirectTransportChanged(next)
      },
    }
  }

  it('a replaced host bridge re-subscribes the driver there and reads the status it missed', async () => {
    const first = hostBridge(STARTING)
    const { hub, swap } = makeHub(first.transport)
    const connect = vi.spyOn(hub.relay, 'connect').mockImplementation(() => {})
    hub.setRemoteAccessSupported(true)
    await vi.waitFor(() => expect(hub.remoteAccess.access().state).toBe('starting'))
    expect(first.subscriptions()).toBe(1)

    const second = hostBridge(LISTENING)
    swap(second.transport)
    await vi.waitFor(() => expect(hub.remoteAccess.access().state).toBe('listening'))
    expect(first.released()).toBe(1)
    expect(second.subscriptions()).toBe(1)
    expect(second.actions).toContain('remoteAccess.getStatus')
    expect(connect).toHaveBeenCalledWith(LISTENING.controlUrl, LISTENING.controlToken)
  })

  it('a desktop shell reporting the first build tells the relay dialer, and only the first', async () => {
    const { hub } = makeHub(hostBridge(STARTING).transport)
    const entryPathChanged = vi.spyOn(hub.relay, 'entryPathChanged').mockImplementation(() => {})
    const hello = async (build: string) => {
      const channel = new MessageChannel()
      hub.attachPort(channel.port1, '/home/u')
      await connectRuntime({
        transport: createMessagePortTransport(channel.port2),
        client: { clientId: `c-${build}`, kind: 'desktop-shell', build },
      })
    }
    await hello('2026-09-17T10:30:00.000Z')
    expect(entryPathChanged).toHaveBeenCalledTimes(1)
    await hello('2026-09-18T11:31:00.000Z')
    expect(entryPathChanged).toHaveBeenCalledTimes(1)
  })
})
