/**
 * Contract: the runtime host page is the one guest of the desktop shell's runtime host page: this
 * same document, marked `#role=runtime-host`. It renders nothing. Its renderer is the runtime's:
 * the SharedWorker runs here whichever document asked for it first, and this page gives the
 * worker what only a document can: the host's bridge port, and the frames that spawn mod and
 * run_js workers. A window's page can then be reloaded or destroyed without touching the runtime.
 * The mark travels in the fragment only, so both documents stay one HTTP-cache entry and name the
 * same worker script. (P-2)
 */
import { isTrustedHostOrigin } from './hostTheme'
import { holdRuntimeKeepAliveLock } from './runtimeKeepAlive'
import type { SharedWorkerInboundMessage } from '../worker/sharedWorkerProtocol'

/** Fragment parameter and value that mark the runtime host page. */
export const RUNTIME_HOST_ROLE_PARAM = 'role'
export const RUNTIME_HOST_ROLE = 'runtime-host'

/** Whether `hash` (a `location.hash`, with or without the `#`) marks the runtime host page. */
export function isRuntimeHostPage(hash: string | null | undefined): boolean {
  if (!hash) return false
  try {
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
    return params.get(RUNTIME_HOST_ROLE_PARAM) === RUNTIME_HOST_ROLE
  } catch {
    return false
  }
}

/** The page's end of the SharedWorker: where the runtime host hands things over. */
export type RuntimeHostWorkerPort = {
  postMessage(message: SharedWorkerInboundMessage, transfer: Transferable[]): void
}

export type RuntimeHostPageDeps = {
  /** The page's port to the runtime SharedWorker. */
  workerPort: RuntimeHostWorkerPort
  /** Installs the sandboxed worker spawner on the window end of a control channel. */
  installKernelHost: (controlPort: MessagePort) => unknown
  /** Where the shell's handshake messages arrive; the window by default. */
  target?: Pick<typeof globalThis, 'addEventListener' | 'removeEventListener'>
  holdLock?: () => boolean
  isTrustedOrigin?: (origin: string) => boolean
}

/**
 * Run the runtime host page: hold the keep-alive lock, attach the worker spawner as the runtime
 * host's control port, then answer the shell's handshake and hand the worker its bridge port.
 * Resolves once the port is handed over.
 *
 * Security: only a trusted shell origin is answered, and the bridge ports are accepted only from
 * the window and origin that sent `nexus-init`.
 */
export function runRuntimeHostPage(deps: RuntimeHostPageDeps): Promise<void> {
  const target = deps.target ?? globalThis
  const trusted = deps.isTrustedOrigin ?? isTrustedHostOrigin
  ;(deps.holdLock ?? holdRuntimeKeepAliveLock)()

  const control = new MessageChannel()
  deps.workerPort.postMessage(
    { type: 'workerHost.attachControlPort', role: RUNTIME_HOST_ROLE },
    [control.port2],
  )
  deps.installKernelHost(control.port1)

  return new Promise(resolve => {
    let shell: { source: MessageEventSource; origin: string } | null = null
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; nexus?: unknown } | null
      if (!shell) {
        if (data?.type !== 'nexus-init' || data.nexus !== true || !event.source) return
        if (!trusted(event.origin)) return
        shell = { source: event.source, origin: event.origin }
        try {
          ;(event.source as WindowProxy).postMessage({ type: 'nexus-init-ack' }, event.origin)
        } catch {
          // The shell went away; a reload of this page starts over.
        }
        return
      }
      if (
        event.source !== shell.source ||
        event.origin !== shell.origin ||
        data?.type !== 'nexus-bridge-bootstrap' ||
        data.nexus !== true ||
        !event.ports ||
        event.ports.length < 2
      ) {
        return
      }
      target.removeEventListener('message', onMessage as EventListener)
      // This page makes no host calls of its own: only the worker's port is used.
      event.ports[0].close()
      deps.workerPort.postMessage(
        { type: 'bridge.setPort', owner: RUNTIME_HOST_ROLE },
        [event.ports[1]],
      )
      resolve()
    }
    target.addEventListener('message', onMessage as EventListener)
  })
}
