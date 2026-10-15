/**
 * The manager starts the render-cache policy (P-3) whichever arrives last: the
 * host port or the host manifest that lists `appInfo.purgeRenderCaches`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DirectPortBridgeTransport } from '../../browser/bridge/DirectPortBridgeTransport'
import {
  ManagerBootServices,
  type ManagerBootServicesHost,
} from '../../browser/worker/ManagerBootServices'
import {
  configureRenderCachePolicy,
  currentRenderCachePolicy,
} from '../../renderCache/runtimeRenderCache'

type Manifest = { capabilities: string[]; primitives?: string[] }

function boot(manifest: () => Manifest | null) {
  const transport = {
    async request(req: { id: string; route: unknown }) {
      return { id: req.id, route: req.route, ok: true, result: {} }
    },
    subscribeEvents: () => () => {},
  } as unknown as DirectPortBridgeTransport
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
    trace: () => {},
  }
  return { services: new ManagerBootServices(host), transport }
}

describe('render-cache policy boot wiring', () => {
  afterEach(() => configureRenderCachePolicy(null))

  it('a manifest that lands after the port still starts the policy', () => {
    let manifest: Manifest | null = null
    const { services, transport } = boot(() => manifest)
    services.onDirectTransportAttached(transport)
    expect(currentRenderCachePolicy()).toBeNull()

    manifest = { capabilities: [], primitives: ['appInfo.purgeRenderCaches'] }
    services.onHostManifestChanged()
    expect(currentRenderCachePolicy()).not.toBeNull()
  })

  it('a host whose manifest lacks the primitive never starts it', () => {
    const { services, transport } = boot(() => ({ capabilities: [], primitives: ['shell.env'] }))
    services.onDirectTransportAttached(transport)
    services.onHostManifestChanged()
    expect(currentRenderCachePolicy()).toBeNull()
  })
})
