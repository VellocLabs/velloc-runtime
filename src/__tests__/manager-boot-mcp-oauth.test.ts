/**
 * The manager installs the MCP sign-in service (F-10) once a host port is
 * attached and the home is known, whichever arrives last; a storage ready that
 * leaves no home tells waiting connects that no service will come.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DirectPortBridgeTransport } from '../browser/bridge/DirectPortBridgeTransport'
import {
  ManagerBootServices,
  type ManagerBootServicesHost,
} from '../browser/worker/ManagerBootServices'
import { setMcpHostProvider } from '../mcp/mcpHost'
import {
  configureMcpOAuthService,
  currentMcpOAuthService,
  whenMcpOAuthService,
} from '../mcp/oauth/mcpOAuthHolder'

function rig(home: () => string | null) {
  const transport = {
    async request(req: { id: string; route: unknown }) {
      return { id: req.id, route: req.route, ok: false, error: { message: 'ENOENT' } }
    },
    subscribeEvents: () => () => {},
  } as unknown as DirectPortBridgeTransport
  let n = 0
  const host: ManagerBootServicesHost = {
    getDirectBridgeTransport: () => transport,
    createBridgeRequestId: () => `r-${++n}`,
    getHomeDir: home,
    resolveHomeDir: async () => null,
    getHostManifest: () => null,
    storageRoot: () => null,
    spawnHeadlessSession: (() => null) as never,
    deliverRoutineToSession: (() => false) as never,
    canDeliverRoutineToSession: (() => false) as never,
    scheduleSummary: () => {},
    isAnySessionBusy: () => false,
    trace: () => {},
  }
  setMcpHostProvider(() => ({ transport }))
  return { services: new ManagerBootServices(host), transport }
}

describe('MCP sign-in service boot in the manager', () => {
  afterEach(() => {
    configureMcpOAuthService(null)
    setMcpHostProvider(null)
  })

  it('a home learnt at storage ready, after the port, installs the service', async () => {
    let home: string | null = null
    const { services, transport } = rig(() => home)
    services.onDirectTransportAttached(transport)
    expect(currentMcpOAuthService()).toBeNull()
    const waiting = whenMcpOAuthService(60_000)

    home = '/home/u'
    services.onStorageReady()
    expect(currentMcpOAuthService()).not.toBeNull()
    expect(await waiting).toBe(currentMcpOAuthService())
  })

  it('storage ready with no home ends the wait at once, with no service', async () => {
    const { services, transport } = rig(() => null)
    services.onDirectTransportAttached(transport)
    const waiting = whenMcpOAuthService(60_000)

    services.onStorageReady()
    expect(await waiting).toBeNull()
    expect(await whenMcpOAuthService(60_000)).toBeNull()
  })
})
