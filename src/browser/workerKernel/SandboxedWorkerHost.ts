/**
 * Security: puts the kernel's workers outside the app's origin (F-21).
 *
 *   page ── <iframe sandbox="allow-scripts" srcdoc=…> ── new Worker('data:…')
 *
 *   1. Opaque origin: no `allow-same-origin`, and a `data:` worker gets a fresh
 *      opaque origin: no app SharedWorker, no IndexedDB / Cache / OPFS, no
 *      credentials.
 *   2. Inherited CSP: the frame's `default-src 'none'` (only `data:` scripts and
 *      workers) refuses `fetch`, `WebSocket` and dynamic `import('https://…')`.
 *   3. `hardenWorkerRealm` on top, as defense in depth.
 * The worker's one way out is the kernel's data port and its closed noun table.
 * This is the page side: it creates the frame, waits for `frameReady` and hands
 * over the control port; the frame's document owns the workers. No fallback to
 * the page's own origin: if the frame never announces itself, every spawn is
 * answered `worker.error`.
 */

import type { WorkerControlToKernel, WorkerControlToWindow } from './kernelProtocol'
import type { SpawnerFrameInitMessage, SpawnerFrameReadyMessage } from './spawnerFrame'

export type SandboxedWorkerHostOptions = {
  /** The spawner frame's whole document (`virtual:isolated-worker-sources`). */
  srcdoc: string
  /** kind → the module-worker `data:` URL the frame spawns for it. */
  workerUrls: Readonly<Record<string, string>>
  /** How long the frame has to announce itself. */
  readyTimeoutMs?: number
  /** Test seams — default to the page's own. */
  document?: Document
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

export type SandboxedWorkerHostHandle = {
  /** Remove the frame (terminating its workers) and stop listening. Idempotent. */
  dispose(): void
}

/** Generous: the frame is a `srcdoc` document with one inline script, but a
 *  machine under a full e2e run can take seconds to commit it. */
export const SANDBOX_READY_TIMEOUT_MS = 15_000

export const SANDBOX_FRAME_FAILED_MESSAGE =
  'the sandboxed worker host did not start (its frame never announced itself)'

export function installSandboxedWorkerHost(
  controlPort: MessagePort,
  options: SandboxedWorkerHostOptions,
): SandboxedWorkerHostHandle {
  const doc = options.document ?? document
  const win = options.window ?? window
  let disposed = false
  let handedOver = false

  const frame = doc.createElement('iframe')
  // `allow-scripts` and nothing else: no `allow-same-origin` (that is the
  // point), no forms, popups, navigation or modals.
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('tabindex', '-1')
  frame.setAttribute('data-nexus-worker-host', '')
  frame.style.display = 'none'
  frame.srcdoc = options.srcdoc

  const onMessage = (event: MessageEvent): void => {
    if (handedOver || event.source !== frame.contentWindow) return
    const msg = event.data as SpawnerFrameReadyMessage | null
    if (!msg || msg.type !== 'workerHost.frameReady') return
    handedOver = true
    clearTimeout(readyTimer)
    win.removeEventListener('message', onMessage)
    const init: SpawnerFrameInitMessage = {
      type: 'workerHost.frameInit',
      workerUrls: { ...options.workerUrls },
    }
    // '*': the frame's origin is opaque — there is no origin to name. The
    // message goes to this one window object and carries nothing secret. The
    // control port is transferred UNSTARTED, so anything the kernel already
    // queued on it is delivered once the frame starts it.
    frame.contentWindow?.postMessage(init, '*', [controlPort])
  }
  win.addEventListener('message', onMessage)

  const readyTimer = setTimeout(() => {
    if (handedOver || disposed) return
    handedOver = true
    win.removeEventListener('message', onMessage)
    console.error(`[sandboxedWorkerHost] ${SANDBOX_FRAME_FAILED_MESSAGE}`)
    // Keep the port and answer for the frame, so a run fails with the reason
    // instead of waiting out the kernel's spawn-ack deadline.
    controlPort.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as WorkerControlToWindow | null
      if (!msg || msg.type !== 'worker.spawn') return
      try {
        controlPort.postMessage({
          type: 'worker.error',
          key: msg.key,
          message: SANDBOX_FRAME_FAILED_MESSAGE,
        })
      } catch {
        /* control channel gone */
      }
    })
    controlPort.start()
  }, options.readyTimeoutMs ?? SANDBOX_READY_TIMEOUT_MS)

  ;(doc.body ?? doc.documentElement).appendChild(frame)

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      clearTimeout(readyTimer)
      win.removeEventListener('message', onMessage)
      frame.remove()
    },
  }
}

/** One frame of several: its document and the kinds it spawns. */
export type SandboxedWorkerFrame = {
  srcdoc: string
  workerUrls: Readonly<Record<string, string>>
}

export type SandboxedWorkerHostsOptions = Pick<
  SandboxedWorkerHostOptions,
  'readyTimeoutMs' | 'document' | 'window'
> & {
  /** Each frame takes the kinds its `workerUrls` name. A kind named by two
   *  frames goes to the first. */
  frames: readonly SandboxedWorkerFrame[]
}

/**
 * Contract: several frames, each with its own policy, behind the kernel's one
 * control port. The page relays `worker.spawn` to the frame serving the kind and
 * `worker.terminate` to the frame that spawned the key, and returns each frame's
 * answers; each frame keeps the no-fallback failure path, so one that never
 * starts fails only its own kinds. An unserved kind is answered `worker.error`.
 */
export function installSandboxedWorkerHosts(
  controlPort: MessagePort,
  options: SandboxedWorkerHostsOptions,
): SandboxedWorkerHostHandle {
  const seams = {
    ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
    ...(options.document !== undefined ? { document: options.document } : {}),
    ...(options.window !== undefined ? { window: options.window } : {}),
  }
  const toKernel = (message: WorkerControlToKernel): void => {
    try {
      controlPort.postMessage(message)
    } catch {
      /* control channel gone */
    }
  }
  type Frame = { port: MessagePort; kinds: Set<string>; handle: SandboxedWorkerHostHandle }
  /** key → the frame that spawned it, for `worker.terminate`. */
  const owners = new Map<string, Frame>()
  const frames = options.frames.map((frame): Frame => {
    const channel = new MessageChannel()
    const handle = installSandboxedWorkerHost(channel.port2, { ...frame, ...seams })
    channel.port1.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as WorkerControlToKernel | null
      if (!msg || (msg.type !== 'worker.spawned' && msg.type !== 'worker.error')) return
      // A failed spawn leaves nothing to terminate; drop its key from `owners`.
      if (msg.type === 'worker.error') owners.delete(msg.key)
      toKernel(msg)
    })
    channel.port1.start()
    return { port: channel.port1, kinds: new Set(Object.keys(frame.workerUrls)), handle }
  })
  const onControl = (event: MessageEvent): void => {
    const msg = event.data as WorkerControlToWindow | null
    if (!msg) return
    if (msg.type === 'worker.terminate') {
      const owner = owners.get(msg.key)
      if (!owner) return
      owners.delete(msg.key)
      try {
        owner.port.postMessage(msg)
      } catch {
        /* frame gone */
      }
      return
    }
    if (msg.type === 'worker.spawn') {
      const owner = frames.find(frame => frame.kinds.has(msg.kind))
      if (!owner) {
        toKernel({
          type: 'worker.error',
          key: msg.key,
          message: `no worker host is installed for kind "${msg.kind}"`,
        })
        return
      }
      owners.set(msg.key, owner)
      try {
        owner.port.postMessage(msg, [...(event.ports ?? [])])
      } catch (error) {
        owners.delete(msg.key)
        toKernel({
          type: 'worker.error',
          key: msg.key,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  controlPort.addEventListener('message', onControl)
  controlPort.start()
  // A reload or a close takes the frames, and every worker in them, along.
  // The kernel cannot see this port die, so it is told — or a long-lived
  // worker (a mod) would be waited on for good. A page kept in the
  // back/forward cache (`persisted`) is frozen, not gone.
  const win = options.window ?? window
  const onPageHide = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted) return
    toKernel({ type: 'window.leaving' })
  }
  win.addEventListener('pagehide', onPageHide)
  let disposed = false
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      win.removeEventListener('pagehide', onPageHide)
      controlPort.removeEventListener('message', onControl)
      for (const frame of frames) {
        frame.handle.dispose()
        frame.port.close()
      }
    },
  }
}
