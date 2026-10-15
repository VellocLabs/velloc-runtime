import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../../browser/runtimeHub/TopicBroker'
import { registerAppUpdateCapability } from '../../browser/runtimeHub/appUpdateCapability'
import type { ConnectionInfo } from '../../browser/runtimeHub/types'
import {
  APP_UPDATE_ACTION_SCOPES,
  APP_UPDATE_STATUS_TOPIC,
  isAppUpdateRelaunchPayload,
  readAppUpdateState,
  type AppUpdateState,
} from '../../appUpdate/appUpdateProtocol'
import {
  configureAppUpdateService,
  currentAppUpdateService,
  onAppUpdateServiceChanged,
} from '../../appUpdate/appUpdateHolder'
import type { AppUpdateService } from '../../appUpdate/AppUpdateService'

function fakeService(initial: AppUpdateState) {
  let state = initial
  const listeners = new Set<(s: AppUpdateState) => void>()
  const calls: string[] = []
  const service = {
    getState: () => state,
    onStateChange: (l: (s: AppUpdateState) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    relaunch: async () => {
      calls.push('relaunch')
    },
  } as unknown as AppUpdateService
  const set = (next: AppUpdateState) => {
    state = next
    for (const l of listeners) l(next)
  }
  return { service, calls, set }
}

const conn = (mode: 'observe' | 'manager' | 'full' = 'full') =>
  ({ connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode, sessions: 'all' }, transport: 'message-port' }) as ConnectionInfo

function rig(getService: () => AppUpdateService | null, onServiceChanged = (_l: () => void) => () => {}) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const reg = registerAppUpdateCapability(registry, broker, { getService, onServiceChanged })
  const events: AppUpdateState[] = []
  const subscribe = (c = conn('observe')) =>
    broker.subscribe(
      { conn: c, send: evt => events.push((evt as unknown as { payload: AppUpdateState }).payload), bufferedBytes: () => 0 },
      APP_UPDATE_STATUS_TOPIC,
    )
  const relaunch = (payload: unknown = {}) => {
    const entry = registry.resolve('appUpdate', 'relaunch')!
    expect(entry.spec.guard?.(payload, conn(), {} as never) ?? true).toBe(true)
    return entry.handle({ id: '1', route: { cap: 'appUpdate', act: 'relaunch' }, payload, conn: conn() } as never, {} as never)
  }
  return { registry, reg, events, subscribe, relaunch }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => configureAppUpdateService(null))

describe('appUpdate capability', () => {
  it('relaunch is full scope and takes no payload', () => {
    expect(APP_UPDATE_ACTION_SCOPES.relaunch).toBe('full')
    const { registry } = rig(() => null)
    expect(registry.resolve('appUpdate', 'relaunch')!.spec.scope).toBe('full')
    expect(isAppUpdateRelaunchPayload({})).toBe(true)
    expect(isAppUpdateRelaunchPayload({ force: true })).toBe(false)
  })

  it('without a service the topic says unavailable and relaunch is host_unavailable', async () => {
    const r = rig(() => null)
    r.subscribe()
    await settle()
    expect(r.events).toEqual([{ available: false }])
    await expect(r.relaunch()).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('publishes every service state change to an observer', async () => {
    const fake = fakeService({ available: true, phase: 'idle', current: '1.149.2.4' })
    const r = rig(() => fake.service)
    r.subscribe()
    await settle()
    fake.set({ available: true, phase: 'ready', current: '1.149.2.4', target: '1.149.2.5' })
    expect(r.events.at(-1)).toEqual({ available: true, phase: 'ready', current: '1.149.2.4', target: '1.149.2.5' })
  })

  it('relaunch is refused until an update is installed, then reaches the service', async () => {
    const fake = fakeService({ available: true, phase: 'downloading', target: '1.149.2.5' })
    const r = rig(() => fake.service)
    await expect(r.relaunch()).rejects.toMatchObject({ code: 'conflict' })
    fake.set({ available: true, phase: 'ready', target: '1.149.2.5' })
    await expect(r.relaunch()).resolves.toEqual({ ok: true })
    expect(fake.calls).toEqual(['relaunch'])
  })

  it('follows the holder: a service configured later is published and watched', async () => {
    const r = rig(currentAppUpdateService, onAppUpdateServiceChanged)
    r.subscribe()
    await settle()
    const fake = fakeService({ available: true, phase: 'idle' })
    configureAppUpdateService(fake.service)
    expect(r.events.at(-1)).toEqual({ available: true, phase: 'idle' })
    fake.set({ available: true, phase: 'checking' })
    expect(r.events.at(-1)).toEqual({ available: true, phase: 'checking' })
    r.reg.dispose()
  })

  it('the client reader accepts the published shape and rejects others', () => {
    expect(readAppUpdateState({ available: true, phase: 'ready', target: '1.149.2.5', checkedAt: 5 })).toEqual({
      available: true,
      phase: 'ready',
      target: '1.149.2.5',
      checkedAt: 5,
    })
    expect(readAppUpdateState({ available: true, phase: 'sleeping' })).toBeNull()
    expect(readAppUpdateState({ phase: 'ready' })).toBeNull()
    expect(readAppUpdateState({ available: true, target: 5 })).toBeNull()
  })
})
