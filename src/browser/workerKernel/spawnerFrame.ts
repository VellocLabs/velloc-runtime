/**
 * Security: the inline script of the sandboxed spawner frame (opaque `srcdoc`
 * origin), which then acts as `WindowWorkerHost`. Accepts its init (control port
 * and worker URLs) from `parent` only, and only once; spawns `data:` URLs only,
 * which the frame's CSP enforces too. Takes its scope as a parameter for unit
 * tests; the entry passes `self`.
 */

import { installWindowWorkerHost, type WorkerSpawner } from './WindowWorkerHost'

/** Frame → parent: the spawner script is running and listening. */
export type SpawnerFrameReadyMessage = { type: 'workerHost.frameReady' }

/** Parent → frame: the kernel's control port (on the transfer list) and, per
 *  kind, the module-worker `data:` URL to spawn. */
export type SpawnerFrameInitMessage = {
  type: 'workerHost.frameInit'
  workerUrls: Record<string, string>
}

/** What the frame script needs of its global — `self` satisfies it. */
export type SpawnerFrameScope = {
  parent: unknown
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

type PostToParent = { postMessage(message: unknown, targetOrigin: string): void }

/** The longest name a spawn may give its worker; a longer one is cut. */
const WORKER_NAME_MAX = 80

/** What DevTools lists a worker as: `nexus-<kind>`, and `: <name>` when the
 *  spawn names it — a mod's worker reads `nexus-mod: task-queue`. */
export function workerNameOf(kind: string, name?: string): string {
  const named = name?.trim().slice(0, WORKER_NAME_MAX)
  return named ? `nexus-${kind}: ${named}` : `nexus-${kind}`
}

export function installSpawnerFrame(
  scope: SpawnerFrameScope,
  createWorker: (url: string, kind: string, name?: string) => Worker = (url, kind, name) =>
    new Worker(url, { type: 'module', name: workerNameOf(kind, name) }),
): void {
  let installed = false
  scope.addEventListener('message', (event: MessageEvent) => {
    if (installed || event.source !== scope.parent) return
    const msg = event.data as SpawnerFrameInitMessage | null
    if (!msg || msg.type !== 'workerHost.frameInit') return
    const port = event.ports?.[0]
    if (!port) return
    installed = true
    // Null-prototype: the kinds are looked up by a name the kernel sends.
    const spawners: Record<string, WorkerSpawner> = Object.create(null)
    for (const [kind, url] of Object.entries(msg.workerUrls ?? {})) {
      if (typeof url !== 'string' || !url.startsWith('data:')) continue
      spawners[kind] = name => createWorker(url, kind, name)
    }
    installWindowWorkerHost(port, spawners)
  })
  // '*': this document's origin is opaque, and so is what the parent sees of
  // it — there is no origin to name. The parent matches on `event.source`.
  ;(scope.parent as PostToParent).postMessage(
    { type: 'workerHost.frameReady' } satisfies SpawnerFrameReadyMessage,
    '*',
  )
}
