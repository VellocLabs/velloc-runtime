/**
 * Page-thread handshake listener of the WebUI ↔ SharedWorker bridge: forwards the outer page's
 * `MessagePort` to the SharedWorker and is then uninvolved.
 *   in:  postMessage({ type: 'nexus-runtime-attach', nexus: true, panelId }, '*', [port])
 *   out: sharedWorkerPort.postMessage({ type: 'bridge.attachRuntimePort', homeDir, panelId }, [port])
 */

import { isTrustedHostOrigin } from './hostTheme'

export type SetupPanelHostBootstrapOptions = {
  /** Window we trust requests from. Same source the `nexus-init`
   *  handshake established (the outer Chromium WebUI page that hosts
   *  `<nexus-page>`). Foreign senders are dropped silently. */
  hostWindow: WindowProxy
  /** Origin we trust. Same value the `nexus-init` handshake captured.
   *  Drops messages from `https://evil.example` even if they somehow
   *  used `event.source` to spoof the host window. */
  hostOrigin: string
  /** The SharedWorker port — `prepared.sharedWorkerPort` from
   *  `nexusBoot`. We post the forwarded message + transferred port
   *  here; the SharedWorker handles `bridge.attachWebUiPort`. */
  sharedWorkerPort: MessagePort
  /** Forwarded into the attach message so the worker-side
   *  `WebUiBridgeContext.homeDir` can be populated without the
   *  SharedWorker having to fetch env over the bridge. */
  homeDir: string
  /** Optional listener target — defaults to `globalThis`. Tests pass
   *  a stub `EventTarget`. */
  target?: EventTarget
}

export type PanelHostBootstrapHandle = {
  /** Stop forwarding new attach messages. The ports already forwarded
   *  remain live in the SharedWorker (they have their own lifetimes).
   *  Idempotent. */
  dispose(): void
}

/**
 * Install the page-thread bootstrap listener. Boot code calls this
 * once after `prepareNexusBoot` resolves; the returned handle is
 * usually kept for the lifetime of the page.
 */
export function setupPanelHostBootstrap(
  options: SetupPanelHostBootstrapOptions,
): PanelHostBootstrapHandle {
  const target = options.target ?? (globalThis as unknown as EventTarget)

  const handler = (raw: Event): void => {
    const event = raw as MessageEvent
    if (event.source !== options.hostWindow) return
    if (event.origin !== options.hostOrigin) return
    // Defence in depth: the origin the handshake captured is itself gated,
    // but a port to the SharedWorker is only ever handed to WebUI.
    if (!isTrustedHostOrigin(event.origin)) return
    const data = event.data as Record<string, unknown> | null
    if (!data || data.type !== 'nexus-runtime-attach' || data.nexus !== true) return
    const port = event.ports?.[0]
    if (!port) {
      // Without a transferred port there's nothing to forward. The
      // outer WebUI is misbehaving — log so the symptom is visible in
      // DevTools, but don't throw (a thrown handler kills no other
      // listeners but leaks an unhandled error to the console).
      console.warn(
        '[panelHostBootstrap] received attach message without a transferred MessagePort; ignoring',
      )
      return
    }
    try {
      options.sharedWorkerPort.postMessage(
        {
          type: 'bridge.attachRuntimePort',
          homeDir: options.homeDir,
          // The panel names itself; the hub binds it at the handshake and
          // refuses a subscription to any other panel's topic.
          ...(typeof data['panelId'] === 'string' ? { panelId: data['panelId'] } : {}),
        },
        [port],
      )
    } catch (e) {
      console.warn(
        `[panelHostBootstrap] failed to forward port to SharedWorker: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  target.addEventListener('message', handler)

  // Readiness beacon to the captured host window, so the panel re-posts attaches it sent before
  // this listener existed.
  try {
    options.hostWindow.postMessage(
      { type: 'nexus-webui-bridge-ready', nexus: true },
      options.hostOrigin,
    )
  } catch (e) {
    console.warn(
      `[panelHostBootstrap] failed to post ready beacon: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  return {
    dispose: () => target.removeEventListener('message', handler),
  }
}
