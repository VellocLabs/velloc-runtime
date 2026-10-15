/**
 * (F-24): the relay dialer. The runtime dials
 * OUT only. A control socket carries {open:legId} → a fresh leg socket is
 * dialed and attached as a hub connection; the control socket reconnects with
 * backoff; disconnect() stops reconnecting. Driven with a fake socket factory
 * and a deterministic scheduler.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Frame } from '../browser/runtimeProtocol'
import { createRelayDialer, type RelayDialerState } from '../browser/runtimeHub/relayDialer'
import type { FrameTransport } from '../browser/runtimeTransport'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 1 // OPEN
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  sent: unknown[] = []
  closedWith: number | null = null
  private listeners = new Map<string, Array<(e: { data?: unknown; code?: number }) => void>>()
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  addEventListener(t: string, l: EventListenerOrEventListenerObject): void {
    const fn = l as (e: { data?: unknown; code?: number }) => void
    if (!this.listeners.has(t)) this.listeners.set(t, [])
    this.listeners.get(t)!.push(fn)
  }
  removeEventListener(): void {}
  send(d: unknown): void {
    this.sent.push(d)
  }
  close(code = 1000): void {
    this.closedWith = code
    this.emit('close', { code })
  }
  emit(t: string, e: { data?: unknown; code?: number } = {}): void {
    for (const l of [...(this.listeners.get(t) ?? [])]) l(e)
  }
  open(): void {
    this.emit('open')
  }
  message(data: string): void {
    this.emit('message', { data })
  }
}

function makeRig(options: { entryPath?: string | null } = {}) {
  FakeSocket.instances = []
  const attached: FrameTransport[] = []
  const states: Array<[RelayDialerState, string?]> = []
  const scheduled: Array<{ fn: () => void; ms: number }> = []
  const dialer = createRelayDialer({
    createSocket: url => new FakeSocket(url),
    attachTransport: t => attached.push(t),
    getEntryPath: () => options.entryPath ?? null,
    onState: (s, e) => states.push([s, e]),
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  })
  return { dialer, attached, states, scheduled }
}

const CONTROL = 'ws://127.0.0.1:8787/host/control'

describe('relayDialer (WP-3)', () => {
  it('dials the control socket with the token and sends the hello with the entry path', () => {
    const rig = makeRig({ entryPath: '/v3/b/K/' })
    rig.dialer.connect(CONTROL, 'tok-1')
    expect(FakeSocket.instances).toHaveLength(1)
    const control = FakeSocket.instances[0]
    expect(control.url).toBe(`${CONTROL}?token=tok-1`)
    control.open()
    expect(control.sent[0]).toBe(JSON.stringify({ hello: 1, entryPath: '/v3/b/K/' }))
    expect(rig.states).toContainEqual(['online', undefined])
  })

  it('reports a null entry path on dev', () => {
    const rig = makeRig({ entryPath: null })
    rig.dialer.connect(CONTROL, 'tok')
    FakeSocket.instances[0].open()
    expect(FakeSocket.instances[0].sent[0]).toBe(JSON.stringify({ hello: 1, entryPath: null }))
  })

  it('an {open:legId} on the control socket dials a leg and attaches it', () => {
    const rig = makeRig()
    rig.dialer.connect(CONTROL, 'tok')
    const control = FakeSocket.instances[0]
    control.open()
    control.message(JSON.stringify({ open: 'leg-42' }))
    expect(FakeSocket.instances).toHaveLength(2)
    const leg = FakeSocket.instances[1]
    expect(leg.url).toBe('ws://127.0.0.1:8787/host/leg/leg-42?token=tok')
    expect(rig.attached).toHaveLength(1)
    expect(rig.attached[0].kind).toBe('websocket')
  })

  it('reconnects the control socket with backoff after it closes', () => {
    const rig = makeRig()
    rig.dialer.connect(CONTROL, 'tok')
    FakeSocket.instances[0].open()
    FakeSocket.instances[0].close()   // control dropped
    expect(rig.scheduled.length).toBeGreaterThan(0)
    expect(rig.states.some(([s]) => s === 'error')).toBe(true)
    // Run the scheduled reconnect: a second control socket is dialed.
    rig.scheduled[0].fn()
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2)
    const redialed = FakeSocket.instances[FakeSocket.instances.length - 1]
    expect(redialed.url).toContain('/host/control')
  })

  it('disconnect() tears down and does not reconnect', () => {
    const rig = makeRig()
    rig.dialer.connect(CONTROL, 'tok')
    FakeSocket.instances[0].open()
    rig.dialer.disconnect()
    expect(rig.dialer.state).toBe('off')
    expect(FakeSocket.instances[0].closedWith).not.toBeNull()
    // Running any scheduled reconnect after disconnect must NOT dial again.
    const before = FakeSocket.instances.length
    for (const s of rig.scheduled) s.fn()
    expect(FakeSocket.instances.length).toBe(before)
  })

  it('a new connect() replaces the old control socket', () => {
    const rig = makeRig()
    rig.dialer.connect(CONTROL, 'tok-1')
    FakeSocket.instances[0].open()
    rig.dialer.connect(CONTROL, 'tok-2')
    expect(FakeSocket.instances[0].closedWith).not.toBeNull()
    expect(FakeSocket.instances[FakeSocket.instances.length - 1].url)
      .toBe(`${CONTROL}?token=tok-2`)
  })

  it('a backoff timer scheduled before a reconnect does not dial a second control socket', () => {
    const rig = makeRig()
    rig.dialer.connect(CONTROL, 'tok-1')
    FakeSocket.instances[0].open()
    FakeSocket.instances[0].close()            // schedules a backoff redial
    expect(rig.scheduled).toHaveLength(1)

    // The user reconnects (disconnect + connect) BEFORE that timer fires.
    rig.dialer.disconnect()
    rig.dialer.connect(CONTROL, 'tok-2')
    const live = FakeSocket.instances[FakeSocket.instances.length - 1]
    live.open()
    expect(live.url).toBe(`${CONTROL}?token=tok-2`)

    // The stale timer now fires. It belongs to a dead generation, so it must
    // dial nothing — otherwise it overwrites `control` and orphans `live`,
    // which stays open with nobody owning it.
    const before = FakeSocket.instances.length
    rig.scheduled[0].fn()
    expect(FakeSocket.instances).toHaveLength(before)

    // And the live socket is still the one the dialer drives: its close still
    // schedules the next backoff.
    const scheduledBefore = rig.scheduled.length
    live.close()
    expect(rig.scheduled.length).toBe(scheduledBefore + 1)
  })

  it('a backoff timer from before a plain connect() replacement is inert too', () => {
    const rig = makeRig()
    rig.dialer.connect(CONTROL, 'tok-1')
    FakeSocket.instances[0].open()
    FakeSocket.instances[0].close()
    // No disconnect() this time — connect() alone must disown the pending timer.
    rig.dialer.connect(CONTROL, 'tok-2')
    const before = FakeSocket.instances.length
    rig.scheduled[0].fn()
    expect(FakeSocket.instances).toHaveLength(before)
  })
})
