/**
 * The settings surface on the runtime connection.
 *
 * What the ~20 settings files depend on: a request answered by the worker's
 * legacy handler, a `*.changed` push arriving as the legacy envelope they
 * match on, and a failure arriving as the `"<code>: <message>"` Error they
 * display. None of it goes through a second port any more.
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { registerLegacyWebUiCapabilities } from '../browser/runtimeHub/legacyWebUiCapabilities'
import type { RuntimeContext, TopicProvider } from '../browser/runtimeHub/types'
import { isBlobRef, topic, type TopicId } from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { connectRuntime, createSettingsBridgeOverConnection } from '../browser/runtimeClient'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

/** Delta-only, like the hub's. */
const settingsProvider: TopicProvider = {
  matches: (id: TopicId) => id.startsWith('settings/'),
  authorize: () => true,
  // eslint-disable-next-line require-yield
  async *snapshot() {
    /* no baseline */
  },
}

async function flush(rounds = 6): Promise<void> {
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

function makeRig(handler?: (request: { id: string; route: { capability: string; action: string }; payload: unknown }) => unknown) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  broker.registerProvider(settingsProvider)
  const legacy = vi.fn(async (request: { id: string; route: { capability: string; action: string }; payload: unknown }) => {
    const answer = handler?.(request)
    if (answer instanceof Error) {
      return { id: request.id, route: request.route, ok: false as const, error: { code: 'FS_ERROR', message: answer.message } }
    }
    return { id: request.id, route: request.route, ok: true as const, result: answer ?? { action: request.route.action } }
  })
  registerLegacyWebUiCapabilities(registry, {
    primeLegacyHandlers: () => {},
    getHandler: () => legacy as never,
  })
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'sb', bootstrap: () => undefined })
  return { registry, broker, hub, legacy }
}

async function connect(rig: ReturnType<typeof makeRig>) {
  const channel = new MessageChannel()
  rig.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'c', kind: 'desktop-shell' },
  })
}

const route = (capability: string, action: string) =>
  ({ namespace: 'nexus', capability, action }) as never

describe('createSettingsBridgeOverConnection', () => {
  it('sends a settings request as `<cap>.<act>` and returns the handler result', async () => {
    const rig = makeRig(request => ({ servers: { a: {} }, saw: request.payload }))
    const connection = await connect(rig)
    const bridge = createSettingsBridgeOverConnection({ connection: async () => connection })

    const result = await bridge.request(route('mcpSettings', 'list'), {} as never)
    expect(result).toMatchObject({ servers: { a: {} } })
    expect(rig.legacy.mock.calls[0]?.[0]).toMatchObject({ route: { capability: 'mcpSettings', action: 'list' } })

    await bridge.request(route('features', 'setEnabled'), { patch: { x: true } } as never)
    expect(rig.legacy.mock.calls[1]?.[0]).toMatchObject({ payload: { patch: { x: true } } })

    bridge.dispose()
    connection.close()
  })

  it('bytes in a result travel as blobs (JSON-safe on the wire) and come back as bytes', async () => {
    // `sessionImport.readSession` answers the transcript and each sub-agent's
    // as `Uint8Array`. A MessagePort clones those as they are, but a remote
    // page's websocket carries JSON frames, so import failed on every remote
    // page. The wire result must hold BlobRefs; the bridge must
    // hand the caller the bytes again.
    const rig = makeRig(() => ({
      sessionId: 's',
      skipped: false,
      bytes: new Uint8Array([1, 2, 3]),
      subagents: [{ agentId: 'a', path: 'p', bytes: new Uint8Array([4, 5]) }],
    }))
    const connection = await connect(rig)

    const raw = await connection.request<{ bytes: unknown; subagents: Array<{ bytes: unknown }> }>(
      'sessionImport.readSession',
      { source: 'claude-code', path: 'x' },
    )
    expect(isBlobRef(raw.bytes)).toBe(true)
    expect(isBlobRef(raw.subagents[0]?.bytes)).toBe(true)
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw)

    const bridge = createSettingsBridgeOverConnection({ connection: async () => connection })
    const result = (await bridge.request(
      route('sessionImport', 'readSession'),
      { source: 'claude-code', path: 'x' } as never,
    )) as unknown as { sessionId: string; bytes: Uint8Array; subagents: Array<{ agentId: string; bytes: Uint8Array }> }
    expect(result.sessionId).toBe('s')
    expect(result.bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(result.bytes)).toEqual([1, 2, 3])
    expect(result.subagents[0]?.agentId).toBe('a')
    expect(Array.from(result.subagents[0]!.bytes)).toEqual([4, 5])

    bridge.dispose()
    connection.close()
  })

  it('a handler failure is the `"<code>: <message>"` Error the settings pages display', async () => {
    const rig = makeRig(() => new Error('marketplace unreachable'))
    const connection = await connect(rig)
    const bridge = createSettingsBridgeOverConnection({ connection: async () => connection })

    await expect(bridge.request(route('plugins', 'install'), { identifier: 'x' } as never)).rejects.toThrow(
      /marketplace unreachable/,
    )
    bridge.dispose()
    connection.close()
  })

  it('a `*.changed` broadcast arrives as the legacy envelope, and the subscription is dropped with the last handler', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const bridge = createSettingsBridgeOverConnection({ connection: async () => connection })
    const seen: Array<{ capability?: string; action?: string; payload: unknown }> = []
    const off = bridge.subscribeEvents(envelope => {
      const r = envelope.route as { capability?: string; action?: string }
      seen.push({ capability: r.capability, action: r.action, payload: envelope.payload })
    })
    await flush()

    rig.broker.publish(topic.settings('providers'), { configs: { openai: {} } }, { type: 'changed' })
    await until(() => seen.length === 1, 'the providers push')
    expect(seen[0]).toMatchObject({ capability: 'providers', action: 'changed', payload: { configs: { openai: {} } } })

    rig.broker.publish(topic.settings('mcpSettings'), { servers: {} }, { type: 'changed' })
    await until(() => seen.length === 2, 'the mcp push')
    expect(seen[1]).toMatchObject({ capability: 'mcpSettings', action: 'changed' })

    off()
    rig.broker.publish(topic.settings('providers'), { configs: {} }, { type: 'changed' })
    await flush()
    expect(seen).toHaveLength(2)

    bridge.dispose()
    connection.close()
  })

  it('dispose stops delivering, and a later subscribe is inert', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const bridge = createSettingsBridgeOverConnection({ connection: async () => connection })
    const seen: unknown[] = []
    bridge.subscribeEvents(envelope => seen.push(envelope))
    await flush()

    bridge.dispose()
    rig.broker.publish(topic.settings('agent'), { x: 1 }, { type: 'changed' })
    await flush()
    expect(seen).toHaveLength(0)

    bridge.subscribeEvents(envelope => seen.push(envelope))
    rig.broker.publish(topic.settings('agent'), { x: 2 }, { type: 'changed' })
    await flush()
    expect(seen).toHaveLength(0)
    connection.close()
  })
})
