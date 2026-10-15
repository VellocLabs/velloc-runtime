/**
 * The remote-access driver (F-24): before setSupported(true) no host call is made; a 'listening' status dials
 * controlUrl + controlToken, anything else disconnects; the published access object never carries them.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createRemoteAccessDriver,
  type RemoteAccessDriver,
} from '../browser/runtimeHub/remoteAccessDriver'
import type { RemoteAccessStatus } from '../browser/bridge/protocol/remoteAccess'
import type { HostBridge } from '../browser/runtimeHub/types'
import type { RelayDialer } from '../browser/runtimeHub/relayDialer'

type EventHandler = (event: { route: { capability: string; action: string }; payload: unknown }) => void

function makeRig(overrides: {
  hostResults?: Partial<Record<string, RemoteAccessStatus>>
} = {}) {
  const calls: Array<{ capability: string; action: string; payload: unknown }> = []
  const dialer = {
    state: 'off' as 'off' | 'connecting' | 'online' | 'error',
    connect: vi.fn((url: string, token: string) => { dialer.state = 'online' }),
    disconnect: vi.fn(() => { dialer.state = 'off' }),
  }
  // Mutable so a test can re-stub a host response mid-flight (e.g. flip the
  // configure stub from LISTENING to OFF before driving the disable path).
  const hostResults: Partial<Record<string, RemoteAccessStatus>> = { ...overrides.hostResults }
  const publishState = vi.fn()
  let eventHandler: EventHandler | null = null

  const host: HostBridge = {
    request: vi.fn(async (route: { capability: string; action: string }, payload: unknown) => {
      calls.push({ capability: route.capability, action: route.action, payload })
      const key = `${route.capability}.${route.action}`
      const result = hostResults[key]
      if (!result) return { ok: false as const, error: { code: 'x', message: 'no stub' } }
      return { ok: true as const, result }
    }),
  }

  const onStatusApplied = vi.fn()
  const driver = createRemoteAccessDriver({
    host: () => host,
    subscribeEvents: handler => { eventHandler = handler; return () => { eventHandler = null } },
    dialer: dialer as unknown as RelayDialer,
    publishState,
    onStatusApplied,
  })
  return { driver, calls, dialer, publishState, onStatusApplied, host, hostResults, emit: (e: Parameters<EventHandler>[0]) => eventHandler?.(e) }
}

const LISTENING: RemoteAccessStatus = {
  enabled: true, bindAddress: '192.168.1.10', port: 47615, state: 'listening',
  controlUrl: 'ws://192.168.1.10:47615/host/control', controlToken: 'tok',
  addresses: [{ address: '192.168.1.10', interfaceName: 'Ethernet' }], clients: 0,
}
const OFF: RemoteAccessStatus = {
  enabled: false, bindAddress: '192.168.1.10', port: 47615, state: 'off',
  addresses: [], clients: 0,
}

describe('remoteAccessDriver manifest gate', () => {
  it('makes ZERO host calls before setSupported(true) (older binary)', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': LISTENING } })
    // getAccess/setAccess before the gate must not touch the host.
    const res = await rig.driver.getAccess()
    expect(res).toEqual({ supported: false })
    expect(rig.calls).toHaveLength(0)
    expect(rig.driver.access().supported).toBe(false)
    await expect(rig.driver.setAccess({ enabled: true })).rejects.toThrow()
    expect(rig.calls).toHaveLength(0)
    expect(rig.dialer.connect).not.toHaveBeenCalled()
  })

  it('setSupported(false) after armed disarms: no further calls, dialer off', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': LISTENING } })
    rig.driver.setSupported(true)
    await flush()
    expect(rig.dialer.connect).toHaveBeenCalledTimes(1)
    rig.driver.setSupported(false)
    expect(rig.dialer.disconnect).toHaveBeenCalled()
    expect(rig.driver.access().supported).toBe(false)
    const before = rig.calls.length
    await rig.driver.getAccess()
    expect(rig.calls.length).toBe(before)  // no new host call
  })
})

describe('remoteAccessDriver dial/disconnect', () => {
  it('the initial getStatus dials when listening (with the token)', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': LISTENING } })
    rig.driver.setSupported(true)
    await flush()
    expect(rig.calls.some(c => c.action === 'getStatus')).toBe(true)
    expect(rig.dialer.connect).toHaveBeenCalledWith(LISTENING.controlUrl, LISTENING.controlToken)
  })

  it('the initial getStatus does NOT dial when off', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': OFF } })
    rig.driver.setSupported(true)
    await flush()
    expect(rig.dialer.connect).not.toHaveBeenCalled()
    expect(rig.dialer.disconnect).toHaveBeenCalled()
  })

  it('a manual dial (remote.connectRelay) survives a non-listening reconcile', async () => {
    // The ?rtDevRelay= regression: boot wires the manual connectRelay BEFORE
    // publishHostEnvironment arms the driver, so the one initial getStatus
    // (listener off by default) lands AFTER the manual connect — its 'off'
    // reconcile must not disconnect the control socket the manual dial just
    // opened, or remote/state.relay never leaves 'off'.
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': OFF } })
    // connectRelay's half: dial first, then tell the driver it was manual.
    rig.dialer.connect('ws://127.0.0.1:4100/host/control', 'dev-token')
    rig.driver.noteManualDial()

    rig.driver.setSupported(true)
    await flush()
    // The 'off' reconcile ran — and left the manual dial alone.
    expect(rig.dialer.disconnect).not.toHaveBeenCalled()
    expect(rig.dialer.state).toBe('online')

    // And a non-listening onStatusChanged re-read must not disconnect it either.
    rig.emit({ route: { capability: 'remoteAccess', action: 'onStatusChanged' }, payload: OFF })
    await flush()
    expect(rig.dialer.disconnect).not.toHaveBeenCalled()
  })

  it('a driver-owned dial resumes ownership: the next non-listening status disconnects', async () => {
    const rig = makeRig({
      hostResults: {
        'remoteAccess.getStatus': OFF,
        'remoteAccess.configure': LISTENING,
      },
    })
    rig.dialer.connect('ws://127.0.0.1:4100/host/control', 'dev-token')
    rig.driver.noteManualDial()
    rig.driver.setSupported(true)
    await flush()
    expect(rig.dialer.disconnect).not.toHaveBeenCalled()

    // Enabling the listener makes the driver dial its own run — ownership
    // returns to the driver, and a later 'off' DOES disconnect.
    await rig.driver.setAccess({ enabled: true, bindAddress: '192.168.1.10', port: 47615 })
    expect(rig.dialer.connect).toHaveBeenCalledWith(LISTENING.controlUrl, LISTENING.controlToken)
    rig.hostResults['remoteAccess.getStatus'] = OFF
    rig.hostResults['remoteAccess.configure'] = OFF
    const disconnectsBefore = rig.dialer.disconnect.mock.calls.length
    await rig.driver.setAccess({ enabled: false })
    expect(rig.dialer.disconnect).toHaveBeenCalledTimes(disconnectsBefore + 1)
    expect(rig.dialer.state).toBe('off')
  })

  it('setAccess(enabled) dials; setAccess(disabled→off) disconnects', async () => {
    const rig = makeRig({
      hostResults: {
        'remoteAccess.getStatus': OFF,
        'remoteAccess.configure': LISTENING,
      },
    })
    rig.driver.setSupported(true)
    await flush()
    expect(rig.dialer.connect).not.toHaveBeenCalled()
    // enable → listening → dial
    await rig.driver.setAccess({ enabled: true, bindAddress: '192.168.1.10', port: 47615 })
    expect(rig.calls.some(c => c.action === 'configure')).toBe(true)
    expect(rig.dialer.connect).toHaveBeenCalledWith(LISTENING.controlUrl, LISTENING.controlToken)
    // disable → off → disconnect
    rig.hostResults['remoteAccess.configure'] = OFF
    const disconnectsBefore = rig.dialer.disconnect.mock.calls.length
    await rig.driver.setAccess({ enabled: false })
    // The disable itself disconnects the dialer (the dial from the enable is
    // torn down). Counting calls (not just toHaveBeenCalled) pins the
    // disconnect to THIS transition — the initial off getStatus already
    // disconnected once, so a bare toHaveBeenCalled would pass vacuously.
    expect(rig.dialer.disconnect).toHaveBeenCalledTimes(disconnectsBefore + 1)
    expect(rig.dialer.state).toBe('off')
  })

  it('an onStatusChanged event re-reads getStatus and reconciles the dialer', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': LISTENING } })
    rig.driver.setSupported(true)
    await flush()
    expect(rig.dialer.connect).toHaveBeenCalledTimes(1)
    // Simulate the host pushing a token-free 'off' status change; the driver
    // re-reads getStatus (still LISTENING in this stub) — the point is the
    // event triggers a fresh getStatus, not a blind dial.
    rig.emit({ route: { capability: 'remoteAccess', action: 'onStatusChanged' }, payload: OFF })
    await flush()
    const getStatusCalls = rig.calls.filter(c => c.action === 'getStatus').length
    expect(getStatusCalls).toBeGreaterThanOrEqual(2)
  })

  it("'starting' does not dial; the 'listening' event that follows does", async () => {
    // The host binds asynchronously: configure answers 'starting' (no token),
    // and the outcome arrives as an onStatusChanged.
    const STARTING: RemoteAccessStatus = { ...OFF, enabled: true, state: 'starting' }
    const rig = makeRig({
      hostResults: { 'remoteAccess.getStatus': OFF, 'remoteAccess.configure': STARTING },
    })
    rig.driver.setSupported(true)
    await flush()
    await rig.driver.setAccess({ enabled: true, bindAddress: '192.168.1.10', port: 47615 })
    expect(rig.driver.access().state).toBe('starting')
    expect(rig.dialer.connect).not.toHaveBeenCalled()

    rig.hostResults['remoteAccess.getStatus'] = LISTENING
    rig.emit({ route: { capability: 'remoteAccess', action: 'onStatusChanged' }, payload: { ...LISTENING, controlToken: undefined } })
    await flush()
    expect(rig.dialer.connect).toHaveBeenCalledTimes(1)
    expect(rig.dialer.connect).toHaveBeenCalledWith(LISTENING.controlUrl, LISTENING.controlToken)
  })

  it('a status repeating the run already dialed does NOT redial; a new token does', async () => {
    // connect() replaces the control socket, and the listener answers a
    // replaced control socket by closing every client still waiting for its
    // leg (4001). So a repeat of the same run — an address-list refresh, a
    // polled setAccess — must leave the live socket alone.
    const rig = makeRig({
      hostResults: { 'remoteAccess.getStatus': LISTENING, 'remoteAccess.configure': LISTENING },
    })
    rig.driver.setSupported(true)
    await flush()
    expect(rig.dialer.connect).toHaveBeenCalledTimes(1)

    rig.emit({ route: { capability: 'remoteAccess', action: 'onStatusChanged' }, payload: LISTENING })
    await flush()
    await rig.driver.setAccess({ enabled: true })
    expect(rig.dialer.connect).toHaveBeenCalledTimes(1)

    // A restarted listener mints a new token: that IS a new run.
    rig.hostResults['remoteAccess.getStatus'] = { ...LISTENING, controlToken: 'tok2' }
    rig.emit({ route: { capability: 'remoteAccess', action: 'onStatusChanged' }, payload: LISTENING })
    await flush()
    expect(rig.dialer.connect).toHaveBeenCalledTimes(2)

    // And a dialer that fell over is redialed even for the same run.
    rig.dialer.state = 'error'
    rig.emit({ route: { capability: 'remoteAccess', action: 'onStatusChanged' }, payload: LISTENING })
    await flush()
    expect(rig.dialer.connect).toHaveBeenCalledTimes(3)
  })

  it('ignores events for other capabilities/actions', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': LISTENING } })
    rig.driver.setSupported(true)
    await flush()
    const before = rig.calls.length
    rig.emit({ route: { capability: 'shell', action: 'onExit' }, payload: {} })
    rig.emit({ route: { capability: 'remoteAccess', action: 'getStatus' }, payload: {} })
    await flush()
    expect(rig.calls.length).toBe(before)
  })
})

describe('remoteAccessDriver default bind (task #13)', () => {
  const CONFIGURE_LISTENING_ANY: RemoteAccessStatus = {
    ...LISTENING, bindAddress: '0.0.0.0',
  }

  it('enabling with no bindAddress sends the 0.0.0.0 default to the host', async () => {
    const rig = makeRig({
      hostResults: {
        'remoteAccess.getStatus': OFF,
        'remoteAccess.configure': CONFIGURE_LISTENING_ANY,
      },
    })
    rig.driver.setSupported(true)
    await flush()
    await rig.driver.setAccess({ enabled: true })
    const configure = rig.calls.find(c => c.action === 'configure')
    expect(configure?.payload).toEqual({ enabled: true, bindAddress: '0.0.0.0' })
  })

  it('an explicit bindAddress overrides the default (the future Advanced NIC picker)', async () => {
    const rig = makeRig({
      hostResults: {
        'remoteAccess.getStatus': OFF,
        'remoteAccess.configure': LISTENING,
      },
    })
    rig.driver.setSupported(true)
    await flush()
    await rig.driver.setAccess({ enabled: true, bindAddress: '192.168.1.10' })
    const configure = rig.calls.find(c => c.action === 'configure')
    expect(configure?.payload).toEqual({ enabled: true, bindAddress: '192.168.1.10' })
  })

  it('a disable-only configure sends no bindAddress (leaves the stored bind alone)', async () => {
    const rig = makeRig({
      hostResults: {
        'remoteAccess.getStatus': LISTENING,
        'remoteAccess.configure': OFF,
      },
    })
    rig.driver.setSupported(true)
    await flush()
    await rig.driver.setAccess({ enabled: false })
    const configure = rig.calls.find(c => c.action === 'configure')
    expect(configure?.payload).toEqual({ enabled: false })
  })
})

describe('remoteAccessDriver token hygiene', () => {
  it('the access object never carries controlUrl/controlToken', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': LISTENING } })
    rig.driver.setSupported(true)
    await flush()
    const access = rig.driver.access()
    expect(access.state).toBe('listening')
    expect('controlToken' in access).toBe(false)
    expect('controlUrl' in access).toBe(false)
    expect(JSON.stringify(access)).not.toContain('tok')
  })

  it('the setAccess answer never carries controlUrl/controlToken either', async () => {
    // remote.setAccess returns this to a (manager) remote; the raw configure
    // result carries the per-run token that only full-trust getStatus may.
    const rig = makeRig({
      hostResults: { 'remoteAccess.getStatus': OFF, 'remoteAccess.configure': LISTENING },
    })
    rig.driver.setSupported(true)
    await flush()
    const result = await rig.driver.setAccess({ enabled: true })
    expect(result.state).toBe('listening')
    expect('controlToken' in result).toBe(false)
    expect('controlUrl' in result).toBe(false)
    expect(JSON.stringify(result)).not.toContain('tok')
  })
})

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

// The sharing-pairing gate waits on this callback: until
// a status has been APPLIED, `access().enabled` is the pre-boot default and
// anything that branches on it is reading a lie.
describe('remoteAccessDriver onStatusApplied (the sharing-pairing gate)', () => {
  it('does not fire before the first getStatus lands, and access().enabled is false until then', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': LISTENING } })
    expect(rig.onStatusApplied).not.toHaveBeenCalled()
    rig.driver.setSupported(true)
    // Armed but not landed: this is exactly the tick the old inline ensure ran in.
    expect(rig.driver.access().enabled).toBe(false)
    expect(rig.onStatusApplied).not.toHaveBeenCalled()

    await flush()
    expect(rig.driver.access().enabled).toBe(true)
    expect(rig.onStatusApplied).toHaveBeenCalledTimes(1)
  })

  it('fires again for setAccess and for an event-driven status', async () => {
    const rig = makeRig({
      hostResults: { 'remoteAccess.getStatus': OFF, 'remoteAccess.configure': LISTENING },
    })
    rig.driver.setSupported(true)
    await flush()
    expect(rig.onStatusApplied).toHaveBeenCalledTimes(1)

    await rig.driver.setAccess({ enabled: true })
    expect(rig.onStatusApplied).toHaveBeenCalledTimes(2)

    rig.hostResults['remoteAccess.getStatus'] = LISTENING
    rig.emit({ route: { capability: 'remoteAccess', action: 'onStatusChanged' }, payload: {} })
    await flush()
    expect(rig.onStatusApplied).toHaveBeenCalledTimes(3)
  })

  it('never fires while unsupported (no host call is made at all)', async () => {
    const rig = makeRig({ hostResults: { 'remoteAccess.getStatus': LISTENING } })
    rig.driver.setSupported(false)
    await flush()
    expect(rig.calls).toHaveLength(0)
    expect(rig.onStatusApplied).not.toHaveBeenCalled()
  })
})
