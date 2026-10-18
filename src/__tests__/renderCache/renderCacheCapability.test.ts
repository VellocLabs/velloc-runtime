/**
 * `renderCache` on the runtime protocol (P-3): `renderCache/status` is readable
 * at `observe`, `renderCache.purgeNow` needs `manager` (an observe connection is
 * refused), `presence.reportActivity` re-arms the idle purge at `observe`; the
 * installer starts the policy only on a host whose manifest lists the primitive.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  PresenceTable,
  TopicBroker,
  registerPresenceCapability,
  type RuntimeContext,
} from '../../browser/runtimeHub'
import { registerRenderCacheCapability } from '../../browser/runtimeHub/renderCacheCapability'
import { connectRuntime, isRuntimeRequestError } from '../../browser/runtimeClient'
import type { TopicId } from '../../browser/runtimeProtocol'
import { RenderCachePolicy } from '../../renderCache/RenderCachePolicy'
import { RENDER_CACHE_STATUS_TOPIC, type RenderCacheState } from '../../renderCache/renderCacheProtocol'
import {
  configureRenderCachePolicy,
  currentRenderCachePolicy,
  installRuntimeRenderCache,
} from '../../renderCache/runtimeRenderCache'
import type { BrowserBridgeRequest, BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'

const until = async (check: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    error => (isRuntimeRequestError(error) ? error.code : String(error)),
  )

function rig(policy: RenderCachePolicy | null) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const table = new PresenceTable()
  registerPresenceCapability(registry, table)
  registerRenderCacheCapability(registry, broker, table, {
    getPolicy: () => policy,
    onPolicyChanged: () => () => {},
  })
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'render-cache',
    bootstrap: () => undefined,
    onConnectionClosed: info => table.remove(info.connectionId),
  })
  const connect = (scopeCeiling?: 'observe' | 'manager') => {
    const channel = new MessageChannel()
    hub.attach(createMessagePortTransport(channel.port1))
    return connectRuntime({
      transport: createMessagePortTransport(channel.port2),
      client: { clientId: `c-${Math.random()}`, kind: 'desktop-shell' },
      ...(scopeCeiling ? { scopeCeiling } : {}),
    })
  }
  return { table, connect }
}

function fakePolicy() {
  const purge = vi.fn(async () => ({ purged: ['guest', 'gpu'] as const, throttled: [] as const, guestProcesses: 1, gpuProcesses: 1 }))
  const policy = new RenderCachePolicy({
    isAnyBusy: () => false,
    idlePurgeEnabled: async () => true,
    purge: async () => {
      const outcome = await purge()
      return { ...outcome, purged: [...outcome.purged], throttled: [...outcome.throttled] }
    },
    setTimer: () => ({}),
    clearTimer: () => {},
  })
  return { policy, purge }
}

describe('renderCache capability over a connection', () => {
  it('purgeNow is refused at observe and runs at manager', async () => {
    const { policy, purge } = fakePolicy()
    const { connect } = rig(policy)
    const viewer = await connect('observe')
    expect(await codeOf(viewer.request('renderCache.purgeNow', {}))).toBe('forbidden_scope')
    expect(purge).not.toHaveBeenCalled()

    const manager = await connect('manager')
    const record = await manager.request<{ reason: string; purged: string[] }>('renderCache.purgeNow', {})
    expect(record).toMatchObject({ reason: 'manual', purged: ['guest', 'gpu'] })
    expect(purge).toHaveBeenCalledTimes(1)
  })

  it('purgeNow with a payload is bad_payload', async () => {
    const { policy } = fakePolicy()
    const { connect } = rig(policy)
    const manager = await connect('manager')
    expect(await codeOf(manager.request('renderCache.purgeNow', { targets: ['gpu'] }))).toBe('bad_payload')
  })

  it('without a policy the topic says unavailable and purgeNow is host_unavailable', async () => {
    const { connect } = rig(null)
    const client = await connect()
    const states: RenderCacheState[] = []
    client.subscribe<RenderCacheState>(RENDER_CACHE_STATUS_TOPIC as TopicId, event => states.push(event.payload))
    await until(() => states.length > 0, 'the status snapshot')
    expect(states[0]).toEqual({ available: false })
    expect(await codeOf(client.request('renderCache.purgeNow', {}))).toBe('host_unavailable')
  })

  it('an observe client reports activity: the purge re-arms and the page counts as visible until it goes', async () => {
    const { policy } = fakePolicy()
    const noteActivity = vi.spyOn(policy, 'noteActivity')
    const { table, connect } = rig(policy)
    const phone = await connect('observe')
    const states: RenderCacheState[] = []
    phone.subscribe<RenderCacheState>(RENDER_CACHE_STATUS_TOPIC as TopicId, event => states.push(event.payload))
    await until(() => states.length > 0, 'the status snapshot')
    expect(states[0]).toMatchObject({ available: true, visible: false })

    await phone.request('presence.reportActivity', { visible: true })
    expect(noteActivity).toHaveBeenCalledTimes(1)
    expect(table.anyVisible()).toBe(true)
    await until(() => states.at(-1)?.visible === true, 'a visible state')

    expect(await codeOf(phone.request('presence.reportActivity', { visible: 'yes' }))).toBe('bad_payload')
    phone.close()
    await until(() => !table.anyVisible(), 'the closed connection to stop counting')
    // A connection going away is nobody using a page.
    expect(noteActivity).toHaveBeenCalledTimes(1)
  })
})

describe('installRuntimeRenderCache', () => {
  afterEach(() => configureRenderCachePolicy(null))

  function transport() {
    const requests: BrowserBridgeRequest[] = []
    const bridge: BrowserBridgeTransport = {
      async request(request) {
        requests.push(request as BrowserBridgeRequest)
        return {
          id: request.id,
          route: request.route,
          ok: true,
          result: { purged: ['guest', 'gpu'], throttled: [], guestProcesses: 2, agentTabProcesses: 0, gpuProcesses: 1 },
        } as never
      },
      subscribeEvents: () => () => {},
    }
    return { bridge, requests }
  }

  it('stays off on a host whose manifest does not list the primitive', () => {
    const { bridge } = transport()
    const skipped = installRuntimeRenderCache({
      transport: () => bridge,
      manifest: () => ({ capabilities: [], primitives: ['shell.env'] }),
      createRequestId: () => 'r',
      isAnyBusy: () => false,
      idlePurgeEnabled: async () => true,
    })
    expect(skipped).toBe('host_unsupported')
    expect(currentRenderCachePolicy()).toBeNull()
  })

  it('starts once, and a purge asks the host for guest + gpu at critical', async () => {
    const { bridge, requests } = transport()
    const deps = {
      transport: () => bridge,
      manifest: () => ({ capabilities: [], primitives: ['appInfo.purgeRenderCaches'] }),
      createRequestId: () => 'r',
      isAnyBusy: () => false,
      idlePurgeEnabled: async () => true,
    }
    expect(installRuntimeRenderCache(deps)).toBeNull()
    const policy = currentRenderCachePolicy()
    expect(policy).not.toBeNull()
    expect(installRuntimeRenderCache(deps)).toBeNull()
    expect(currentRenderCachePolicy()).toBe(policy)

    const record = await policy!.purgeNow()
    expect(record.guestProcesses).toBe(2)
    expect(record.gpuProcesses).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0].route).toMatchObject({ capability: 'appInfo', action: 'purgeRenderCaches' })
    expect(requests[0].payload).toEqual({ targets: ['guest', 'gpu'], level: 'critical' })
  })
})
