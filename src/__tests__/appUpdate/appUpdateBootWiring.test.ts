/**
 * The manager starts the update service (F-30) whichever arrives last: the
 * host port or the host manifest that lists the update primitives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirectPortBridgeTransport } from '../../browser/bridge/DirectPortBridgeTransport'
import {
  ManagerBootServices,
  type ManagerBootServicesHost,
} from '../../browser/worker/ManagerBootServices'
import { APP_UPDATE_PRIMITIVES } from '../../appUpdate/bridgeAppUpdateHost'
import { configureAppUpdateService, currentAppUpdateService } from '../../appUpdate/appUpdateHolder'

vi.mock('../../branding/updateChannels', async importOriginal => ({
  ...(await importOriginal<typeof import('../../branding/updateChannels')>()),
  currentUpdateChannel: () => 'stable',
}))

type Manifest = { capabilities: string[]; primitives?: string[] }

function boot(manifest: () => Manifest | null) {
  const transport = {
    async request(req: { id: string; route: { capability: string; action: string } }) {
      const route = `${req.route.capability}.${req.route.action}`
      if (route === 'appInfo.getVersionInfo') {
        return { id: req.id, route: req.route, ok: true, result: { appVersion: '1.0.0.0', osName: 'Windows NT 10.0' } }
      }
      return { id: req.id, route: req.route, ok: false, error: { code: 'NOT_IMPLEMENTED', message: route } }
    },
    subscribeEvents: () => () => {},
  } as unknown as DirectPortBridgeTransport
  const traces: Array<{ name: string; data: unknown }> = []
  let n = 0
  const host: ManagerBootServicesHost = {
    getDirectBridgeTransport: () => transport,
    createBridgeRequestId: () => `r-${++n}`,
    getHomeDir: () => null,
    getHostManifest: manifest,
    storageRoot: () => null,
    spawnHeadlessSession: (() => null) as never,
    deliverRoutineToSession: (() => false) as never,
    canDeliverRoutineToSession: (() => false) as never,
    scheduleSummary: () => {},
    isAnySessionBusy: () => false,
    trace: (name: string, data: unknown) => traces.push({ name, data }),
  }
  return { services: new ManagerBootServices(host), transport, traces }
}

afterEach(() => {
  currentAppUpdateService()?.dispose()
  configureAppUpdateService(null)
})

describe('app update boot wiring', () => {
  it('a manifest that lands after the port still starts the service', async () => {
    let manifest: Manifest | null = null
    const { services, transport, traces } = boot(() => manifest)
    services.onDirectTransportAttached(transport)
    await vi.waitFor(() => expect(traces.some(t => t.name === 'app_update.skipped')).toBe(true))
    expect(currentAppUpdateService()).toBeNull()

    manifest = { capabilities: [], primitives: [...APP_UPDATE_PRIMITIVES] }
    services.onHostManifestChanged()
    await vi.waitFor(() => expect(currentAppUpdateService()).not.toBeNull())
  })

  it('a host whose manifest lacks the primitives never starts it', async () => {
    const { services, transport, traces } = boot(() => ({ capabilities: [], primitives: ['shell.env'] }))
    services.onDirectTransportAttached(transport)
    services.onHostManifestChanged()
    await vi.waitFor(() => expect(traces.filter(t => t.name === 'app_update.skipped')).toHaveLength(2))
    expect(currentAppUpdateService()).toBeNull()
  })
})
