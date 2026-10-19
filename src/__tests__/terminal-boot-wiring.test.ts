/**
 * The manager's boot services own the runtime's TerminalService (F-31): it
 * reads the host port and manifest the services hold, learns the shells when
 * a port attaches or the manifest changes, starts terminals in the session's
 * folder, and ends them when the port goes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DirectPortBridgeTransport } from '../browser/bridge/DirectPortBridgeTransport'
import type { BrowserHostManifest } from '../browser/bridge/protocol/manifest'
import { ManagerBootServices, type ManagerBootServicesHost } from '../browser/worker/ManagerBootServices'
import { fakePtyHost, PTY_MANIFEST, routeOf, settle } from './_helpers/fakePtyHost'

vi.mock('../mods/provider/providerModBoot', () => ({
  bootProviderMods: async () => {},
}))

function rig() {
  const fake = fakePtyHost()
  let transport: DirectPortBridgeTransport | null = fake.transport as unknown as DirectPortBridgeTransport
  let manifest: BrowserHostManifest | null = PTY_MANIFEST as BrowserHostManifest
  let n = 0
  const host: ManagerBootServicesHost = {
    getDirectBridgeTransport: () => transport,
    createBridgeRequestId: () => `r-${++n}`,
    getHomeDir: () => null,
    getHostManifest: () => manifest,
    getSessionCwd: sessionId => (sessionId === 'sess' ? '/work/tree' : undefined),
    storageRoot: () => null,
    spawnHeadlessSession: (() => null) as never,
    deliverRoutineToSession: (() => false) as never,
    canDeliverRoutineToSession: (() => false) as never,
    scheduleSummary: () => {},
    isAnySessionBusy: () => false,
    trace: () => {},
  }
  const services = new ManagerBootServices(host)
  return {
    services,
    fake,
    attach: () => services.onDirectTransportAttached(transport!),
    detach: () => {
      transport = null
      services.onDirectTransportDetached()
    },
    setManifest: (next: BrowserHostManifest | null) => {
      manifest = next
      services.onHostManifestChanged()
    },
  }
}

describe('terminals in the manager boot services', () => {
  it('learns the shells when the port attaches and starts a terminal in the session folder', async () => {
    const r = rig()
    expect(r.services.terminals.available).toBe(true)
    expect(r.services.terminals.list().shells).toEqual([])
    r.attach()
    await settle()
    expect(r.services.terminals.list().shells.map(s => s.id)).toEqual(['pwsh', 'powershell', 'cmd', 'bash'])
    expect(r.fake.requests.map(routeOf)).toContain('exec.listShells')

    const id = await r.services.terminals.create({ sessionId: 'sess', cols: 80, rows: 24 })
    expect(r.fake.shellRequests('spawn')[0]!.payload).toMatchObject({ file: 'pwsh', cwd: '/work/tree', pty: { cols: 80, rows: 24 } })
    expect(r.services.terminals.list().terminals[0]).toMatchObject({ id, sessionId: 'sess', state: { kind: 'running' } })
    await expect(r.services.terminals.create({ sessionId: 'unknown', cols: 80, rows: 24 })).rejects.toSatisfy(
      e => (e as { code?: string }).code === 'not_found',
    )
  })

  it('follows the manifest: no shell.spawn.pty, no terminals', async () => {
    const r = rig()
    r.attach()
    await settle()
    r.setManifest({ capabilities: ['fs', 'shell', 'exec'], primitives: ['shell.spawn.argv'] } as BrowserHostManifest)
    expect(r.services.terminals.available).toBe(false)
    expect(r.services.terminals.list()).toEqual({ available: false, shells: [], terminals: [] })
    r.setManifest(PTY_MANIFEST as BrowserHostManifest)
    await settle()
    expect(r.services.terminals.list().shells.length).toBe(4)
  })

  it('a detached port ends the running terminals without a code', async () => {
    const r = rig()
    r.attach()
    await settle()
    const id = await r.services.terminals.create({ sessionId: 'sess', cols: 80, rows: 24 })
    r.detach()
    expect(r.services.terminals.available).toBe(false)
    expect((await r.services.terminals.snapshot(id))!.state).toEqual({ kind: 'exited', exitCode: null })
    expect(r.fake.shellRequests('streamKill')).toHaveLength(0)
  })
})
