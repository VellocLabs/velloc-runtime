import { afterEach, describe, expect, it } from 'vitest'
import { ManagerBootServices } from '../browser/worker/ManagerBootServices'
import type { ManagerBootServicesHost } from '../browser/worker/ManagerBootServices'
import type { DirectPortBridgeTransport } from '../browser/bridge/DirectPortBridgeTransport'
import { getTeamRegistry, setTeamRegistry } from '../team/TeamRegistry'
import {
  unconfiguredFs,
  processFs,
  installProcessFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'

/**
 * The team registry is a MANAGER-owned singleton and must not read the shared process fs slot, which every session
 * runtime overwrites at boot (`installProcessFs`); disposing that session must not break `TaskCreate` /
 * `TaskUpdate` elsewhere.
 */

const TEXT = new TextDecoder()

/** A transport that answers `fs` requests out of an in-memory map. */
function fsTransport(files = new Map<string, Uint8Array>()) {
  let live = true
  const transport = {
    async request(req: unknown) {
      if (!live) {
        throw new Error('Runtime scope was disposed.')
      }
      const { route, payload } = req as {
        route: { capability: string; action: string }
        payload: Record<string, unknown>
      }
      const path = String(payload.path ?? '')
      switch (route.action) {
        case 'cwd':
          return { ok: true, result: '/w' }
        case 'mkdir':
          return { ok: true, result: undefined }
        case 'writeFile':
          files.set(path, payload.content as Uint8Array)
          return { ok: true, result: undefined }
        case 'readFile': {
          const v = files.get(path)
          if (!v) {
            return { ok: false, error: { code: 'ENOENT', message: path } }
          }
          return { ok: true, result: v }
        }
        default:
          return { ok: false, error: { code: 'UNSUPPORTED', message: route.action } }
      }
    },
  } as unknown as DirectPortBridgeTransport
  return {
    transport,
    files,
    read: (path: string) => {
      const v = files.get(path)
      return v ? TEXT.decode(v) : undefined
    },
    kill: () => {
      live = false
    },
  }
}

function host(
  transport: DirectPortBridgeTransport | null,
  storagePath: string | null = '/store',
): ManagerBootServicesHost {
  let n = 0
  return {
    getDirectBridgeTransport: () => transport,
    createBridgeRequestId: () => `r-${++n}`,
    getHomeDir: () => '/home',
    storageRoot: () => storagePath,
    spawnHeadlessSession: (() => null) as never,
    deliverRoutineToSession: (() => false) as never,
    canDeliverRoutineToSession: (() => false) as never,
    scheduleSummary: () => {},
    trace: () => {},
  }
}

/** The shape a disposed session runtime leaves in the process slot. */
function deadFs(): RuntimeFs {
  const boom = () => {
    throw new Error('Runtime scope was disposed.')
  }
  return {
    ...unconfiguredFs,
    mkdir: boom,
    readFile: boom,
    writeFile: boom,
  } as unknown as RuntimeFs
}

describe('team registry fs ownership', () => {
  afterEach(() => setTeamRegistry(null))

  it('writes through the MANAGER transport, not the process fs slot', async () => {
    const bridge = fsTransport()
    const services = new ManagerBootServices(host(bridge.transport))
    const before = processFs()
    try {
      // Attaching the direct transport is what boots the registry.
      services.onDirectTransportAttached(bridge.transport)
      await new Promise(resolve => setTimeout(resolve, 0))
      const registry = getTeamRegistry()
      expect(registry).not.toBeNull()

      // A session runtime boots and then is disposed: the slot is left on a
      // transport that rejects everything. This is the whole bug.
      installProcessFs(deadFs())

      await registry!.createTeam({ name: 'lead-1', headSessionId: 'lead-1' })
      const task = await registry!.createTask('lead-1', {
        subject: 's',
        description: 'd',
        owner: 'worker-a',
      })
      await registry!.updateTask('lead-1', task.id, { status: 'completed' })

      // Reached disk through the manager's own transport.
      const log = [...bridge.files.keys()].find(k => k.includes('tasks.jsonl'))
      expect(log, 'the task log was written').toBeTruthy()
      expect(bridge.read(log!)).toContain('"status":"completed"')
    } finally {
      installProcessFs(before)
    }
  })

  it('does not boot the registry onto the fallback fs before a transport exists', async () => {
    // `getManagerFs()` falls back to the process slot while there is no
    // transport, and a registry loaded through that fallback is exactly what
    // this change removes — so boot waits instead.
    const services = new ManagerBootServices(host(null))
    services.onStorageReady()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getTeamRegistry()).toBeNull()
  })
})
