/**
 * The manager boots the provider-mod scan (F-27), which also feeds the plugin
 * launchers (F-25), as soon as a host port is attached and the home is known:
 * it does not wait for session storage. Once only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectPortBridgeTransport } from '../browser/bridge/DirectPortBridgeTransport'
import {
  ManagerBootServices,
  type ManagerBootServicesHost,
} from '../browser/worker/ManagerBootServices'

const boots = vi.hoisted(() => [] as Array<{ homeDir: string }>)

vi.mock('../mods/provider/providerModBoot', () => ({
  bootProviderMods: async (deps: { homeDir: string }) => {
    boots.push({ homeDir: deps.homeDir })
  },
}))

function rig(options: { home?: () => string | null; resolveHome?: () => Promise<string | null> }) {
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
    getHomeDir: options.home ?? (() => null),
    ...(options.resolveHome ? { resolveHomeDir: options.resolveHome } : {}),
    getHostManifest: () => null,
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

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('provider-mod boot in the manager', () => {
  beforeEach(() => {
    boots.length = 0
  })

  it('starts on the port with the probed home, before storage is ready, and only once', async () => {
    const { services, transport } = rig({ resolveHome: async () => '/home/u' })
    services.onDirectTransportAttached(transport)
    await settle()
    expect(boots).toEqual([{ homeDir: '/home/u' }])

    services.onStorageReady()
    services.onDirectTransportAttached(transport)
    await settle()
    expect(boots).toHaveLength(1)
  })

  it('a second trigger while the home is being asked does not boot twice', async () => {
    let answer!: (home: string) => void
    const { services, transport } = rig({ resolveHome: () => new Promise(resolve => (answer = resolve)) })
    services.onDirectTransportAttached(transport)
    services.onStorageReady()
    answer('/home/u')
    await settle()
    expect(boots).toEqual([{ homeDir: '/home/u' }])
  })

  it('no home from the host: nothing boots until storage knows one', async () => {
    let home: string | null = null
    const { services, transport } = rig({ home: () => home, resolveHome: async () => null })
    services.onDirectTransportAttached(transport)
    await settle()
    expect(boots).toEqual([])

    home = '/home/u'
    services.onStorageReady()
    await settle()
    expect(boots).toEqual([{ homeDir: '/home/u' }])
  })
})
