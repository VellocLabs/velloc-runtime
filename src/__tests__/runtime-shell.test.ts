/**
 * The `shell` capability and its `shell/<panelId>` topic: the hosting panel hears its own guest, a late subscriber
 * gets a snapshot, and another panel is refused.
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import {
  DEFAULT_PANEL_ID,
  ShellStateTable,
  registerShellCapability,
  shellTopicProvider,
} from '../browser/runtimeHub/shellCapability'
import type { RuntimeContext } from '../browser/runtimeHub/types'
import { topic } from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { connectRuntime, createShellChannel, type TopicEvent } from '../browser/runtimeClient'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

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
  const table = new ShellStateTable()
  broker.registerProvider(shellTopicProvider(table))
  registerShellCapability(registry, broker, table)
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'sh', bootstrap: () => undefined })
  return { registry, broker, hub, table }
}

async function connect(
  rig: ReturnType<typeof makeRig>,
  options: { panelId?: string; scopeCeiling?: 'manager' | 'control' | 'observe' } = {},
) {
  const channel = new MessageChannel()
  rig.hub.attach(createMessagePortTransport(channel.port1), {
    ...(options.panelId !== undefined ? { panelId: options.panelId } : {}),
  })
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: {
      clientId: 'c',
      kind: 'desktop-shell',
      ...(options.panelId !== undefined ? { panelId: options.panelId } : {}),
    },
    ...(options.scopeCeiling ? { scopeCeiling: options.scopeCeiling } : {}),
  })
}

const LAYOUT = { visible: true, rect: { left: 10, top: 20, width: 300, height: 400 } }

describe('the shell capability', () => {
  it("publishes a panel's chrome to that panel", async () => {
    const rig = makeRig()
    const connection = await connect(rig, { panelId: 'panel-1' })
    const shell = createShellChannel({ connection: async () => connection })
    const seen: TopicEvent[] = []
    connection.subscribe(topic.shell('panel-1'), event => seen.push(event))
    await until(() => seen.length === 1, 'the snapshot')
    expect(seen[0]).toMatchObject({
      form: 'snapshot',
      payload: { layout: null, bootProgress: null, buildInfo: null, dismissed: false },
    })

    shell.publishLayout(LAYOUT)
    shell.publishBootProgress('rendering')
    shell.publishBuildInfo('2026-09-16T00:00:00.000Z')
    shell.dismissBootWelcome()
    await until(() => seen.length === 5, 'the four deltas')
    expect(seen.slice(1).map(e => e.type)).toEqual(['layout', 'bootProgress', 'buildInfo', 'dismissed'])
    expect(seen[1]?.payload).toEqual(LAYOUT)
    connection.close()
  })

  // A `?rtScope=` desktop guest (NEXUS_E2E_SCOPE): its boot chrome rides its
  // unscoped desktop connection, so the splash lifts on the guest's own signal
  // instead of the panel's 25 s fallback. Its layout rides the scoped UI
  // connection and is refused there, as a remote client's would be.
  it('a scoped guest sends its boot chrome over the desktop connection, and its layout over the scoped one', async () => {
    const rig = makeRig()
    const desktop = await connect(rig, { panelId: 'panel-1' })
    const ui = await connect(rig, { panelId: 'panel-1', scopeCeiling: 'manager' })
    const panel = await connect(rig, { panelId: 'panel-1' })
    const errors: unknown[] = []
    const shell = createShellChannel({
      connection: async () => ui,
      bootConnection: async () => desktop,
      onError: error => errors.push(error),
    })
    const seen: TopicEvent[] = []
    panel.subscribe(topic.shell('panel-1'), event => seen.push(event))
    await until(() => seen.length === 1, 'the snapshot')

    shell.publishLayout(LAYOUT)
    shell.publishBootProgress('rendering')
    shell.publishBuildInfo('2026-09-16T00:00:00.000Z')
    shell.dismissBootWelcome()
    await until(() => seen.length === 4 && errors.length === 1, 'three deltas and one refusal')
    expect(seen.slice(1).map(e => e.type)).toEqual(['bootProgress', 'buildInfo', 'dismissed'])
    expect(errors[0]).toMatchObject({ code: 'forbidden_scope' })
    desktop.close()
    ui.close()
    panel.close()
  })

  it('a panel that attaches late gets the state, not silence', async () => {
    const rig = makeRig()
    const guest = await connect(rig, { panelId: 'panel-1' })
    const shell = createShellChannel({ connection: async () => guest })
    shell.publishLayout(LAYOUT)
    shell.publishBuildInfo('2026-09-16T00:00:00.000Z')
    await flush()

    const panel = await connect(rig, { panelId: 'panel-1' })
    const seen: TopicEvent[] = []
    panel.subscribe(topic.shell('panel-1'), event => seen.push(event))
    await until(() => seen.length === 1, 'the replayed snapshot')
    expect(seen[0]).toMatchObject({
      form: 'snapshot',
      payload: { layout: LAYOUT, buildInfo: { buildTime: '2026-09-16T00:00:00.000Z' }, dismissed: false },
    })
    guest.close()
    panel.close()
  })

  it("one panel never hears another's chrome, and a scoped client hears none of it", async () => {
    const rig = makeRig()
    const one = await connect(rig, { panelId: 'panel-1' })
    const two = await connect(rig, { panelId: 'panel-2' })
    const seenTwo: TopicEvent[] = []
    two.subscribe(topic.shell('panel-2'), event => seenTwo.push(event))
    await until(() => seenTwo.length === 1, "panel-2's snapshot")

    createShellChannel({ connection: async () => one }).publishLayout(LAYOUT)
    await flush()
    expect(seenTwo).toHaveLength(1)

    // Subscribing to someone else's panel is refused, not merely empty.
    const refused: TopicEvent[] = []
    two.subscribe(topic.shell('panel-1'), event => refused.push(event))
    await flush()
    expect(refused).toHaveLength(0)

    // A remote client has its own chrome: `full` only.
    const scoped = await connect(rig, { panelId: 'panel-1', scopeCeiling: 'control' })
    await expect(scoped.request('shell.publishLayout', LAYOUT)).rejects.toMatchObject({
      code: 'forbidden_scope',
    })
    one.close()
    two.close()
    scoped.close()
  })

  it('without a panelId the guest and its panel still meet — on the default panel', async () => {
    const rig = makeRig()
    const guest = await connect(rig)
    const panel = await connect(rig)
    const seen: TopicEvent[] = []
    panel.subscribe(topic.shell(DEFAULT_PANEL_ID), event => seen.push(event))
    await until(() => seen.length === 1, 'the snapshot')

    createShellChannel({ connection: async () => guest }).publishBootProgress('sessions')
    await until(() => seen.length === 2, 'the delta')
    expect(seen[1]).toMatchObject({ type: 'bootProgress', payload: { stage: 'sessions' } })
    guest.close()
    panel.close()
  })
})
