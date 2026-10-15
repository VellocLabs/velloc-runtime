import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { registerCatalogCapability } from '../browser/runtimeHub/catalogCapability'
import type { ConnectionInfo } from '../browser/runtimeHub/types'
import {
  CATALOG_ACTION_SCOPES,
  CATALOG_STATUS_TOPIC,
  isCatalogRefreshPayload,
  readCatalogStatusState,
  type CatalogStatusState,
} from '../catalog/catalogProtocol'
import {
  acquireModelCatalog,
  configureModelCatalogSource,
  onModelCatalogSourceChanged,
} from '../catalog/modelCatalogHolder'
import type { ModelCatalog } from '../catalog/modelCatalog'
import type { CatalogStatus } from '../catalog/types'

/** The seam: a fake service that implements only what the runtime action and topic use. */
function fakeService(first: CatalogStatus, afterRefresh: CatalogStatus) {
  let current = first
  const calls: string[] = []
  const service = {
    status: async () => current,
    refresh: async () => {
      calls.push('refresh')
      current = afterRefresh
      return current
    },
  } as unknown as ModelCatalog
  return { service, calls }
}

const conn = (mode: 'observe' | 'full' = 'full') =>
  ({ connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode, sessions: 'all' }, transport: 'message-port' }) as ConnectionInfo

function rig(getService: () => Promise<ModelCatalog | undefined>) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const reg = registerCatalogCapability(registry, broker, {
    getService,
    onSourceChanged: () => () => {},
    report: () => {},
  })
  const events: CatalogStatusState[] = []
  const subscribe = (c = conn()) =>
    broker.subscribe(
      { conn: c, send: evt => events.push((evt as unknown as { payload: CatalogStatusState }).payload), bufferedBytes: () => 0 },
      CATALOG_STATUS_TOPIC,
    )
  const ask = async (payload: unknown = {}) => {
    const entry = registry.resolve('catalog', 'refresh')!
    expect(entry.spec.guard?.(payload, conn(), {} as never) ?? true).toBe(true)
    return entry.handle({ id: '1', route: { cap: 'catalog', act: 'refresh' }, payload, conn: conn() } as never, {} as never)
  }
  return { registry, broker, reg, events, subscribe, ask }
}

const SNAP: CatalogStatus = { source: 'snapshot', generatedAt: 5, models: 3 }
const LIVE: CatalogStatus = { source: 'live', fetchedAt: 9, generatedAt: 9, models: 4 }

describe('catalog capability', () => {
  it('declares one manager action and refuses a payload', () => {
    expect(CATALOG_ACTION_SCOPES).toEqual({ refresh: 'manager' })
    expect(isCatalogRefreshPayload(undefined)).toBe(true)
    expect(isCatalogRefreshPayload({})).toBe(true)
    expect(isCatalogRefreshPayload({ url: 'http://x' })).toBe(false)
    expect(isCatalogRefreshPayload([])).toBe(false)
    const r = rig(async () => undefined)
    expect(r.registry.resolve('catalog', 'refresh')!.spec.scope).toBe('manager')
  })

  it('snapshots the service status and publishes the new status after a refresh', async () => {
    const { service, calls } = fakeService(SNAP, LIVE)
    const r = rig(async () => service)
    await r.subscribe()
    expect(r.events.at(-1)).toEqual({ available: true, status: SNAP })

    const result = (await r.ask()) as CatalogStatusState
    expect(calls).toEqual(['refresh'])
    expect(result).toEqual({ available: true, status: LIVE })
    expect(r.events.at(-1)).toEqual({ available: true, status: LIVE })
  })

  it('a failed refresh is the status lastError, not a thrown error', async () => {
    const failing: CatalogStatus = { ...SNAP, lastError: 'catalog source answered HTTP 503' }
    const { service } = fakeService(SNAP, failing)
    const r = rig(async () => service)
    expect(((await r.ask()) as CatalogStatusState).status?.lastError).toMatch(/503/)
  })

  it('without a service the topic says unavailable and the action is host_unavailable', async () => {
    const r = rig(async () => undefined)
    await r.subscribe()
    expect(r.events.at(-1)).toEqual({ available: false })
    await expect(r.ask()).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('the topic needs observe, and a source change republishes to readers', async () => {
    const { service } = fakeService(SNAP, LIVE)
    let listener: () => void = () => {}
    let svc: ModelCatalog | undefined
    const registry = new CapabilityRegistry()
    const broker = new TopicBroker()
    registerCatalogCapability(registry, broker, {
      getService: async () => svc,
      onSourceChanged: l => {
        listener = l
        return () => {}
      },
    })
    const events: CatalogStatusState[] = []
    await broker.subscribe(
      { conn: conn('observe'), send: evt => events.push((evt as unknown as { payload: CatalogStatusState }).payload), bufferedBytes: () => 0 },
      CATALOG_STATUS_TOPIC,
    )
    expect(events.at(-1)).toEqual({ available: false })
    svc = service
    listener()
    await new Promise(r => setTimeout(r, 0))
    expect(events.at(-1)).toEqual({ available: true, status: SNAP })
  })

  it('the holder seam supplies the service and tells listeners when it changes', async () => {
    const { service } = fakeService(SNAP, LIVE)
    let heard = 0
    const off = onModelCatalogSourceChanged(() => void heard++)
    expect(await acquireModelCatalog()).toBeUndefined()
    configureModelCatalogSource(() => service)
    expect(await acquireModelCatalog()).toBe(service)
    configureModelCatalogSource(null)
    expect(await acquireModelCatalog()).toBeUndefined()
    expect(heard).toBe(2)
    off()
  })

  it('reads only well-formed topic payloads', () => {
    expect(readCatalogStatusState({ available: false })).toEqual({ available: false })
    expect(readCatalogStatusState({ available: true, status: LIVE })).toEqual({ available: true, status: LIVE })
    expect(readCatalogStatusState({ available: true, status: { source: 'bogus', models: 1 } })).toBeNull()
    expect(readCatalogStatusState(null)).toBeNull()
    expect(readCatalogStatusState({ status: LIVE })).toBeNull()
  })
})
