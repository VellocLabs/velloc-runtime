/**
 * The page side of an app page's runtime link (F-42). The sandboxed frame gets
 * one end of a fresh channel; this side forwards it to a capped runtime port,
 * so the page can end the connection when the frame goes, whatever the frame does.
 */

/** The message that hands the frame its port: `{ kind }` with the port in `ports[0]`. */
export const APP_PAGE_PORT_MESSAGE = 'velloc.runtimePort'

export type AppPageRelay = {
  /** The end the frame speaks the runtime protocol on. */
  readonly pagePort: MessagePort
  /** Says goodbye to the runtime and closes both ends; idempotent. */
  close(): void
}

export function relayAppPagePort(runtimePort: MessagePort): AppPageRelay {
  const channel = new MessageChannel()
  const inner = channel.port1
  let closed = false
  runtimePort.onmessage = event => inner.postMessage(event.data)
  inner.onmessage = event => {
    if (!closed) runtimePort.postMessage(event.data)
  }
  return {
    pagePort: channel.port2,
    close() {
      if (closed) return
      closed = true
      runtimePort.postMessage({ kind: 'bye', code: 'shutting_down' })
      runtimePort.onmessage = null
      inner.onmessage = null
      runtimePort.close()
      inner.close()
    },
  }
}
