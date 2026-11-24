/**
 * `runtime.getRestartReadiness`: the pure `computeRestartReadiness` (every
 * blocker, unreadable sources, which connections are the caller's own window)
 * and the action as registered on the session surface (scope `full`, wired to
 * the host's work inputs and the hub's connection list).
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { connectRuntime } from '../browser/runtimeClient'
import {
  CapabilityRegistry,
  ConnectionHub,
  TopicBroker,
  computeRestartReadiness,
  installSessionSurface,
  type RestartReadinessInputs,
  type RestartWorkInputs,
  type RuntimeContext,
  type SessionSurfaceHost,
} from '../browser/runtimeHub'

const SELF = { connectionId: 'c1', panelId: 'p1', transport: 'message-port' as const }

function idle(over: Partial<RestartReadinessInputs> = {}): RestartReadinessInputs {
  return {
    sessions: [{ sessionId: 's1', idle: true, needsAnswer: false }],
    liveTaskCount: 0,
    teammateStatuses: ['stopped'],
    headlessRunCount: 0,
    caller: SELF,
    connections: [SELF],
    ...over,
  }
}

describe('computeRestartReadiness', () => {
  it('all idle, only the caller connected -> ready', () => {
    expect(computeRestartReadiness(idle())).toEqual({ ready: true, reasons: [] })
    expect(computeRestartReadiness(idle({ sessions: [], teammateStatuses: [] })).ready).toBe(true)
  })

  const cases: Array<[string, Partial<RestartReadinessInputs>]> = [
    ['turn_running', { sessions: [{ sessionId: 's1', idle: false, needsAnswer: false }] }],
    ['task_running', { liveTaskCount: 1 }],
    ['awaiting_answer', { sessions: [{ sessionId: 's1', idle: true, needsAnswer: true }] }],
    ['team_live', { teammateStatuses: ['stopped', 'idle'] }],
    ['team_live', { teammateStatuses: ['active'] }],
    ['routine_running', { headlessRunCount: 2 }],
    ['other_clients', { connections: [SELF, { connectionId: 'r', transport: 'websocket' }] }],
  ]
  it.each(cases)('%s blocks on its own', (reason, over) => {
    expect(computeRestartReadiness(idle(over))).toEqual({ ready: false, reasons: [reason] })
  })

  it('an unreadable source blocks', () => {
    expect(computeRestartReadiness(idle({ sessions: null })).reasons).toEqual(['turn_running', 'awaiting_answer'])
    expect(computeRestartReadiness(idle({ sessions: [{ sessionId: 's', idle: null, needsAnswer: null }] })).reasons)
      .toEqual(['turn_running', 'awaiting_answer'])
    expect(computeRestartReadiness(idle({ liveTaskCount: null })).reasons).toEqual(['task_running'])
    expect(computeRestartReadiness(idle({ teammateStatuses: null })).reasons).toEqual(['team_live'])
    expect(computeRestartReadiness(idle({ headlessRunCount: null })).reasons).toEqual(['routine_running'])
    expect(computeRestartReadiness(idle({ connections: null })).reasons).toEqual(['other_clients'])
  })

  it('the caller window with two connections (guest + panel host, same panelId) is ready', () => {
    const panelHost = { connectionId: 'c2', panelId: 'p1', transport: 'message-port' as const }
    expect(computeRestartReadiness(idle({ connections: [SELF, panelHost] })).ready).toBe(true)
  })

  it('another panel, a remote on the same panelId, or an unidentified caller -> other_clients', () => {
    const other = { connectionId: 'c2', panelId: 'p2', transport: 'message-port' as const }
    expect(computeRestartReadiness(idle({ connections: [SELF, other] })).reasons).toEqual(['other_clients'])
    const remote = { connectionId: 'c3', panelId: 'p1', transport: 'websocket' as const }
    expect(computeRestartReadiness(idle({ connections: [SELF, remote] })).reasons).toEqual(['other_clients'])
    const noPanel = { connectionId: 'c1', transport: 'message-port' as const }
    const same = { connectionId: 'c2', panelId: 'p1', transport: 'message-port' as const }
    expect(computeRestartReadiness(idle({ caller: noPanel, connections: [noPanel, same] })).reasons)
      .toEqual(['other_clients'])
  })
})

// ---- the action over the hub ---------------------------------------------------

function makeRig(work: () => RestartWorkInputs, withConnections = true, retireRuntime = vi.fn()) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  let hub!: ConnectionHub
  const host = { getRestartReadinessInputs: work, retireRuntime } as unknown as SessionSurfaceHost
  installSessionSurface(
    { registry, broker, ...(withConnections ? { connections: { list: () => hub.list() } } : {}) },
    host,
  )
  const context: RuntimeContext = {
    fs: {} as RuntimeFs, host: null, homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'rr', bootstrap: () => undefined })
  return { registry, hub, retireRuntime }
}

let seq = 0
function connect(hub: ConnectionHub, panelId: string) {
  const channel = new MessageChannel()
  hub.attach(createMessagePortTransport(channel.port1), { panelId })
  seq += 1
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: `c-${panelId}-${seq}`, kind: 'desktop-shell' },
  })
}

const IDLE_WORK: RestartWorkInputs = { sessions: [], liveTaskCount: 0, teammateStatuses: [], headlessRunCount: 0 }

describe('runtime.getRestartReadiness', () => {
  it('is registered at scope full only', () => {
    const { registry } = makeRig(() => IDLE_WORK)
    const acts = (mode: 'observe' | 'control' | 'manager' | 'full') =>
      registry.advertise({ mode, sessions: 'all' }).find(c => c.cap === 'runtime')?.acts ?? []
    expect(acts('full')).toContain('getRestartReadiness')
    expect(acts('manager')).not.toContain('getRestartReadiness')
    expect(acts('control')).not.toContain('getRestartReadiness')
    expect(acts('observe')).not.toContain('getRestartReadiness')
  })

  it('same-panel connections are ready; another panel blocks', async () => {
    const { hub } = makeRig(() => IDLE_WORK)
    const a = await connect(hub, 'p1')
    const b = await connect(hub, 'p1')
    expect(await a.request('runtime.getRestartReadiness', {})).toEqual({ ready: true, reasons: [] })
    const c = await connect(hub, 'p2')
    expect(await a.request('runtime.getRestartReadiness', {})).toEqual({ ready: false, reasons: ['other_clients'] })
    for (const x of [a, b, c]) x.close()
  })

  it('reports the host work sources; a throwing host or missing connection list blocks', async () => {
    const busy = makeRig(() => ({ ...IDLE_WORK, liveTaskCount: 3 }))
    const a = await connect(busy.hub, 'p1')
    expect(await a.request('runtime.getRestartReadiness', {})).toEqual({ ready: false, reasons: ['task_running'] })
    a.close()

    const broken = makeRig(() => { throw new Error('nope') }, false)
    const b = await connect(broken.hub, 'p1')
    const result = await b.request('runtime.getRestartReadiness', {}) as { ready: boolean; reasons: string[] }
    expect(result.ready).toBe(false)
    expect(result.reasons).toEqual([
      'turn_running', 'task_running', 'awaiting_answer', 'team_live', 'routine_running', 'other_clients',
    ])
    b.close()
  })
})

describe('runtime.retireForUpdate', () => {
  it('is registered at scope full only', () => {
    const { registry } = makeRig(() => IDLE_WORK)
    const acts = (mode: 'observe' | 'control' | 'manager' | 'full') =>
      registry.advertise({ mode, sessions: 'all' }).find(c => c.cap === 'runtime')?.acts ?? []
    expect(acts('full')).toContain('retireForUpdate')
    for (const mode of ['manager', 'control', 'observe'] as const) {
      expect(acts(mode)).not.toContain('retireForUpdate')
    }
  })

  it('retires an idle runtime for its only window', async () => {
    const rig = makeRig(() => IDLE_WORK)
    const a = await connect(rig.hub, 'p1')
    expect(await a.request('runtime.retireForUpdate', {})).toEqual({ retired: true, reasons: [] })
    expect(rig.retireRuntime).toHaveBeenCalledTimes(1)
    a.close()
  })

  it('leaves a busy runtime, or one with another client, running', async () => {
    const busy = makeRig(() => ({ ...IDLE_WORK, liveTaskCount: 1 }))
    const a = await connect(busy.hub, 'p1')
    expect(await a.request('runtime.retireForUpdate', {})).toEqual({ retired: false, reasons: ['task_running'] })
    expect(busy.retireRuntime).not.toHaveBeenCalled()
    a.close()

    const shared = makeRig(() => IDLE_WORK)
    const b = await connect(shared.hub, 'p1')
    const c = await connect(shared.hub, 'p2')
    expect(await b.request('runtime.retireForUpdate', {})).toEqual({ retired: false, reasons: ['other_clients'] })
    expect(shared.retireRuntime).not.toHaveBeenCalled()
    for (const x of [b, c]) x.close()
  })

  it('asking for readiness never retires', async () => {
    const rig = makeRig(() => IDLE_WORK)
    const a = await connect(rig.hub, 'p1')
    await a.request('runtime.getRestartReadiness', {})
    expect(rig.retireRuntime).not.toHaveBeenCalled()
    a.close()
  })
})
