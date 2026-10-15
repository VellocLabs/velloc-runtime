/**
 * The `notifications` topic (F-24: no reverse call).
 *
 * The runtime used to pop the OS toast itself, so the only person it could
 * reach was whoever sat at this machine. Now it publishes and every client
 * decides how to show it — which is also why a scoped client, the stand-in for
 * a remote one, has to receive them.
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { notificationsTopicProvider } from '../browser/runtimeHub/RuntimeHub'
import type { ConnectionInfo, RuntimeContext } from '../browser/runtimeHub/types'
import {
  NOTIFICATIONS_TOPIC,
  isRuntimeNotification,
  notificationIsForPanel,
  type EvtFrame,
  type RuntimeNotification,
} from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { connectRuntime, subscribeRuntimeNotifications } from '../browser/runtimeClient'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

/** The hub's own provider — the one `RuntimeHub` registers. */
const notificationsProvider = notificationsTopicProvider

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  // A deadline, not a round count: these run alongside 400 other files, and a
  // fixed number of microtask flushes is a different amount of time on a
  // loaded machine than on an idle one.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await flush(2)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function makeRig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  broker.registerProvider(notificationsProvider)
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'n', bootstrap: () => undefined })
  const notify = (notification: RuntimeNotification) =>
    broker.publish(NOTIFICATIONS_TOPIC, notification, { type: 'turnEnd' })
  return { hub, broker, notify }
}

async function connect(rig: ReturnType<typeof makeRig>, scopeCeiling?: 'control' | 'observe') {
  const channel = new MessageChannel()
  rig.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'c', kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

describe('the notifications topic', () => {
  it('reaches a client, which decides how to show it', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const shown: RuntimeNotification[] = []
    const stop = subscribeRuntimeNotifications({
      connection: async () => connection,
      show: notification => shown.push(notification),
    })
    await flush()

    rig.notify({ message: 'Velloc is waiting for your input', title: 'Fix the parser', notificationType: 'turn_complete', sessionId: 's1' })
    await until(() => shown.length === 1, 'the turn-end notification')
    expect(shown[0]).toMatchObject({ title: 'Fix the parser', notificationType: 'turn_complete', sessionId: 's1' })

    stop()
    rig.notify({ message: 'later', notificationType: 'turn_complete' })
    await flush()
    expect(shown).toHaveLength(1)
    connection.close()
  })

  it('a scoped client hears them too — a phone is the point', async () => {
    const rig = makeRig()
    const connection = await connect(rig, 'observe')
    const shown: RuntimeNotification[] = []
    subscribeRuntimeNotifications({ connection: async () => connection, show: n => shown.push(n) })
    await flush()

    rig.notify({ message: 'done', notificationType: 'turn_complete' })
    await until(() => shown.length === 1, 'the observer heard it')
    connection.close()
  })

  it('a connection bound to a list of sessions hears only its sessions’ notifications; one naming no session is withheld', async () => {
    const rig = makeRig()
    const narrow: ConnectionInfo = { connectionId: 'n', clientId: 'n', kind: 'mobile', scope: { mode: 'control', sessions: ['s1'] }, transport: 'websocket', connectedAt: 0 }
    const seen: EvtFrame[] = []
    await rig.broker.subscribe({ conn: narrow, send: e => seen.push(e), bufferedBytes: () => 0 }, NOTIFICATIONS_TOPIC)
    rig.notify({ message: 'done', title: 'Mine', notificationType: 'turn_complete', sessionId: 's1' })
    rig.notify({ message: 'done', title: 'Someone else’s session title', notificationType: 'turn_complete', sessionId: 's2' })
    rig.notify({ message: 'done', notificationType: 'turn_complete' })
    // The withheld ones still spend their seq, as null deltas the client drops.
    expect(seen.slice(1).map(e => [e.seq, e.type, e.payload])).toEqual([
      [1, 'turnEnd', { message: 'done', title: 'Mine', notificationType: 'turn_complete', sessionId: 's1' }],
      [2, undefined, null],
      [3, undefined, null],
    ])
  })

  it('a malformed payload is dropped, not shown', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const shown: RuntimeNotification[] = []
    subscribeRuntimeNotifications({ connection: async () => connection, show: n => shown.push(n) })
    await flush()

    rig.broker.publish(NOTIFICATIONS_TOPIC, { title: 'no message' }, { type: 'turnEnd' })
    rig.broker.publish(NOTIFICATIONS_TOPIC, null, { type: 'turnEnd' })
    await flush()
    expect(shown).toHaveLength(0)

    rig.notify({ message: 'real', notificationType: 'turn_complete' })
    await until(() => shown.length === 1, 'the valid one still arrives')
    connection.close()
  })

  it('isRuntimeNotification pins the shape', () => {
    expect(isRuntimeNotification({ message: 'm', notificationType: 't' })).toBe(true)
    expect(isRuntimeNotification({ message: 'm', notificationType: 't', title: 'x', sessionId: 's', panelId: 'p' })).toBe(true)
    expect(isRuntimeNotification({ message: 'm' })).toBe(false)
    expect(isRuntimeNotification({ notificationType: 't' })).toBe(false)
    expect(isRuntimeNotification({ message: 'm', notificationType: 't', title: 7 })).toBe(false)
    expect(isRuntimeNotification({ message: 'm', notificationType: 't', panelId: 7 })).toBe(false)
    expect(isRuntimeNotification(null)).toBe(false)
  })

  it('only the panel that owns the session turns a notification into a host toast; one naming no panel is any panel’s', () => {
    // Every desktop window hears every notification. Before, each asked the
    // host for its own toast: N windows, N toasts, and the unfocused windows'
    // calls escaped the host's focus suppression.
    const mine: RuntimeNotification = { message: 'm', notificationType: 't', sessionId: 's', panelId: 'panel-2' }
    expect(notificationIsForPanel(mine, 'panel-2')).toBe(true)
    expect(notificationIsForPanel(mine, 'panel-3')).toBe(false)
    expect(notificationIsForPanel(mine, 'panel')).toBe(false)
    expect(notificationIsForPanel({ message: 'm', notificationType: 't' }, 'panel-3')).toBe(true)
  })
})
