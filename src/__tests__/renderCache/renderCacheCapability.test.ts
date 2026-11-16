/**
 * `renderCache` on the runtime protocol (P-3): `renderCache/status` is readable
 * at `observe`, `renderCache.purgeNow` needs `manager` (an observe connection is
 * refused), `presence.reportActivity` re-arms the idle purge at `observe` and the
 * last active window losing activation runs the inactive purge; the installer
 * starts the policy only on a host whose manifest lists the primitive.
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
import { RENDER_CACHE_IDLE_PURGE_MS, RenderCachePolicy } from '../../renderCache/RenderCachePolicy'
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
  const purge = vi.fn(async (_targets: readonly string[]) => ({ purged: ['guest', 'gpu'] as const, throttled: [] as const, guestProcesses: 1, gpuProcesses: 1 }))
  const policy = new RenderCachePolicy({
    isAnyBusy: () => false,
    idlePurgeEnabled: async () => true,
    purge: async targets => {
      const outcome = await purge(targets)
      return { ...outcome, purged: [...outcome.purged], throttled: [...outcome.throttled] }
    },
    startupGraceMs: 0,
    minIntervalMs: 0,
    inactiveSettleMs: 0,
    // The idle timer never fires here; the settle delay and the gate do.
    setTimer: (fn, ms) => (ms >= RENDER_CACHE_IDLE_PURGE_MS ? null : setTimeout(fn, ms)),
    clearTimer: handle => {
      if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
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

  it('an observe client reports activity: the purge re-arms and the page counts as visible and active until it goes', async () => {
    const { policy } = fakePolicy()
    const noteActivity = vi.spyOn(policy, 'noteActivity')
    const { table, connect } = rig(policy)
    const phone = await connect('observe')
    const states: RenderCacheState[] = []
    phone.subscribe<RenderCacheState>(RENDER_CACHE_STATUS_TOPIC as TopicId, event => states.push(event.payload))
    await until(() => states.length > 0, 'the status snapshot')
    expect(states[0]).toMatchObject({ available: true, visible: false, active: false })

    await phone.request('presence.reportActivity', { visible: true, active: true })
    expect(noteActivity).toHaveBeenCalledTimes(1)
    expect(table.anyVisible()).toBe(true)
    expect(table.anyActive()).toBe(true)
    await until(() => states.at(-1)?.visible === true && states.at(-1)?.active === true, 'a visible, active state')

    expect(await codeOf(phone.request('presence.reportActivity', { visible: 'yes' }))).toBe('bad_payload')
    expect(await codeOf(phone.request('presence.reportActivity', { visible: true, active: 1 }))).toBe('bad_payload')
    expect(await codeOf(phone.request('presence.reportActivity', { visible: true, focus: true }))).toBe('bad_payload')
    phone.close()
    await until(() => !table.anyVisible() && !table.anyActive(), 'the closed connection to stop counting')
    // A connection going away is nobody using a page.
    expect(noteActivity).toHaveBeenCalledTimes(1)
  })

  it('the only active window losing activation runs the inactive purge; a second active window holds it back', async () => {
    const { policy, purge } = fakePolicy()
    const { connect } = rig(policy)
    const desktop = await connect('observe')
    const phone = await connect('observe')
    await desktop.request('presence.reportActivity', { visible: true, active: true })
    await phone.request('presence.reportActivity', { visible: true, active: true })

    await desktop.request('presence.reportActivity', { visible: true, active: false })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(purge).not.toHaveBeenCalled()

    await phone.request('presence.reportActivity', { visible: true, active: false })
    await until(() => purge.mock.calls.length === 1, 'the inactive purge')
    expect(purge.mock.calls[0][0]).toEqual(['guest', 'gpu', 'agentTabs'])
    expect(policy.getState().last?.reason).toBe('inactive')
  })

  it('a client that does not report activation counts as active while visible', async () => {
    const { policy, purge } = fakePolicy()
    const { connect } = rig(policy)
    const desktop = await connect('observe')
    await desktop.request('presence.reportActivity', { visible: true })
    await desktop.request('presence.reportActivity', { visible: false })
    await until(() => purge.mock.calls.length === 1, 'the inactive purge')
  })

  it('a window reported active before the policy is installed purges on its first deactivation', async () => {
    const { policy, purge } = fakePolicy()
    let current: RenderCachePolicy | null = null
    let changed: () => void = () => {}
    const registry = new CapabilityRegistry()
    const table = new PresenceTable()
    registerRenderCacheCapability(registry, new TopicBroker(), table, {
      getPolicy: () => current,
      onPolicyChanged: listener => {
        changed = listener
        return () => {}
      },
    })
    table.reportActivity('desktop', true, true)
    current = policy
    changed()

    table.reportActivity('desktop', true, false)
    await until(() => purge.mock.calls.length === 1, 'the inactive purge')
    expect(purge.mock.calls[0][0]).toEqual(['guest', 'gpu', 'agentTabs'])
  })

  it('the last active connection going away runs the inactive purge', async () => {
    const { policy, purge } = fakePolicy()
    const { connect } = rig(policy)
    const desktop = await connect('observe')
    await desktop.request('presence.reportActivity', { visible: true, active: true })
    desktop.close()
    await until(() => purge.mock.calls.length === 1, 'the inactive purge')
    expect(purge.mock.calls[0][0]).toEqual(['guest', 'gpu', 'agentTabs'])
  })

  it('purgeNow inside the startup grace is host_unavailable with the reason and retry time', async () => {
    const policy = new RenderCachePolicy({
      isAnyBusy: () => false,
      idlePurgeEnabled: async () => true,
      purge: async () => ({ purged: [], throttled: [], guestProcesses: 0, gpuProcesses: 0 }),
      now: () => 5_000,
      setTimer: () => null,
      clearTimer: () => {},
    })
    const { connect } = rig(policy)
    const manager = await connect('manager')
    const error = await manager.request('renderCache.purgeNow', {}).then(
      () => null,
      (failure: unknown) => failure,
    )
    expect(isRuntimeRequestError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'host_unavailable', data: { reason: 'startup_grace', retryAt: 65_000 } })
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

  it('keeps the startup grace, unless the host is a test build that lists the testing primitive', async () => {
    const { bridge } = transport()
    const install = (primitives: string[]) => {
      configureRenderCachePolicy(null)
      installRuntimeRenderCache({
        transport: () => bridge,
        manifest: () => ({ capabilities: [], primitives }),
        createRequestId: () => 'r',
        isAnyBusy: () => false,
        idlePurgeEnabled: async () => true,
      })
      return currentRenderCachePolicy()!
    }
    await expect(install(['appInfo.purgeRenderCaches']).purgeNow()).rejects.toMatchObject({ reason: 'startup_grace' })
    const record = await install(['appInfo.purgeRenderCaches', 'appInfo.purgeRenderCaches.forTesting']).purgeNow()
    expect(record.reason).toBe('manual')
  })

  it('starts once, and a purge asks the host for guest + gpu at critical', async () => {
    const { bridge, requests } = transport()
    let primitives = ['appInfo.purgeRenderCaches']
    const deps = {
      transport: () => bridge,
      manifest: () => ({ capabilities: [], primitives }),
      createRequestId: () => 'r',
      isAnyBusy: () => false,
      idlePurgeEnabled: async () => true,
      startupGraceMs: 0,
      minIntervalMs: 0,
      inactiveSettleMs: 0,
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

    // A host that lists neither the trim nor the foreground input is sent neither.
    const deactivate = async (count: number) => {
      policy!.noteActive(true)
      policy!.noteActive(false)
      for (let i = 0; i < 400 && requests.length < count; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    }
    await deactivate(2)
    expect(requests[1].payload).toEqual({ targets: ['guest', 'gpu', 'agentTabs'], level: 'critical' })

    primitives = [
      'appInfo.purgeRenderCaches',
      'appInfo.purgeRenderCaches.trimWorkingSet',
      'appInfo.purgeRenderCaches.onlyWhenAppInactive',
    ]
    await deactivate(3)
    expect(requests[2].payload).toEqual({
      targets: ['guest', 'gpu', 'agentTabs'],
      level: 'critical',
      trimWorkingSet: true,
      onlyWhenAppInactive: true,
    })
  })
})
