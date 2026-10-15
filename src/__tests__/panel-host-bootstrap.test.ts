import { describe, expect, it, vi } from 'vitest'
import { setupPanelHostBootstrap } from '../browser/boot/panelHostBootstrap'

/**
 * Build a rig that simulates:
 *   - the outer Chromium WebUI window posting messages to the page thread
 *   - the SharedWorker port the page thread forwards messages to
 *
 * We use a real `EventTarget` for the listener and capture the
 * forwarded messages on a stub `MessagePort`.
 */
function makeRig(opts: { origin?: string } = {}) {
  const target = new EventTarget()
  const origin = opts.origin ?? 'chrome://custom-browser-nexus'
  const hostWindow = {} as WindowProxy
  const forwarded: Array<{
    message: unknown
    transfer: ReadonlyArray<Transferable>
  }> = []
  const sharedWorkerPort = {
    postMessage: vi.fn((message: unknown, transfer: Transferable[] = []) => {
      forwarded.push({ message, transfer })
    }),
  } as unknown as MessagePort

  const dispatch = (
    body: unknown,
    ports: Transferable[] = [],
    source: WindowProxy | null = hostWindow,
    eventOrigin: string = origin,
  ) => {
    const event = new Event('message') as unknown as MessageEvent
    Object.defineProperty(event, 'data', { value: body })
    Object.defineProperty(event, 'source', { value: source })
    Object.defineProperty(event, 'origin', { value: eventOrigin })
    Object.defineProperty(event, 'ports', { value: ports })
    target.dispatchEvent(event)
  }

  return { target, hostWindow, origin, sharedWorkerPort, forwarded, dispatch }
}

describe('setupPanelHostBootstrap', () => {
  // The panel host asks for a PROTOCOL connection. Its port becomes
  // `bridge.attachRuntimePort` carrying the panel it named, which is what binds
  // it to `shell/<panelId>` — the legacy settings attach is a different message
  // and keeps its own shape until the outer page stops using it.
  it("forwards the panel host's port as a runtime port, with the panel it named", () => {
    const rig = makeRig()
    setupPanelHostBootstrap({
      hostWindow: rig.hostWindow,
      hostOrigin: rig.origin,
      sharedWorkerPort: rig.sharedWorkerPort,
      homeDir: '/home/alice',
      target: rig.target,
    })

    const channel = new MessageChannel()
    rig.dispatch(
      { type: 'nexus-runtime-attach', nexus: true, panelId: 'panel-7' },
      [channel.port2],
    )

    expect(rig.forwarded).toHaveLength(1)
    expect(rig.forwarded[0]?.message).toEqual({
      type: 'bridge.attachRuntimePort',
      homeDir: '/home/alice',
      panelId: 'panel-7',
    })
    expect(rig.forwarded[0]?.transfer).toEqual([channel.port2])
  })

  it('a panel host that names no panel still gets a runtime port', () => {
    const rig = makeRig()
    setupPanelHostBootstrap({
      hostWindow: rig.hostWindow,
      hostOrigin: rig.origin,
      sharedWorkerPort: rig.sharedWorkerPort,
      homeDir: '/home/alice',
      target: rig.target,
    })

    const channel = new MessageChannel()
    rig.dispatch({ type: 'nexus-runtime-attach', nexus: true }, [channel.port2])

    expect(rig.forwarded[0]?.message).toEqual({
      type: 'bridge.attachRuntimePort',
      homeDir: '/home/alice',
    })
  })

  it('drops attach messages from a different source window', () => {
    const rig = makeRig()
    setupPanelHostBootstrap({
      hostWindow: rig.hostWindow,
      hostOrigin: rig.origin,
      sharedWorkerPort: rig.sharedWorkerPort,
      homeDir: '/h',
      target: rig.target,
    })

    const channel = new MessageChannel()
    const evil = {} as WindowProxy
    rig.dispatch(
      { type: 'nexus-runtime-attach', nexus: true, panelId: 'panel-1' },
      [channel.port2],
      evil,
    )
    expect(rig.forwarded).toHaveLength(0)
    channel.port1.close()
    channel.port2.close()
  })

  it('drops attach messages from a different origin', () => {
    const rig = makeRig()
    setupPanelHostBootstrap({
      hostWindow: rig.hostWindow,
      hostOrigin: rig.origin,
      sharedWorkerPort: rig.sharedWorkerPort,
      homeDir: '/h',
      target: rig.target,
    })

    const channel = new MessageChannel()
    rig.dispatch(
      { type: 'nexus-runtime-attach', nexus: true, panelId: 'panel-1' },
      [channel.port2],
      rig.hostWindow,
      'https://evil.example',
    )
    expect(rig.forwarded).toHaveLength(0)
    channel.port1.close()
    channel.port2.close()
  })

  it('never forwards a port to a non-WebUI origin, even one the handshake captured', () => {
    // Defence in depth behind the `nexus-init` origin gate: the SharedWorker
    // port is only ever handed to a chrome:// / chrome-untrusted:// page.
    const rig = makeRig({ origin: 'https://evil.example' })
    setupPanelHostBootstrap({
      hostWindow: rig.hostWindow,
      hostOrigin: rig.origin,
      sharedWorkerPort: rig.sharedWorkerPort,
      homeDir: '/h',
      target: rig.target,
    })

    const channel = new MessageChannel()
    rig.dispatch(
      { type: 'nexus-runtime-attach', nexus: true, panelId: 'panel-1' },
      [channel.port2],
    )
    expect(rig.forwarded).toHaveLength(0)
    channel.port1.close()
    channel.port2.close()
  })

  it('ignores attach messages without a transferred port', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rig = makeRig()
    setupPanelHostBootstrap({
      hostWindow: rig.hostWindow,
      hostOrigin: rig.origin,
      sharedWorkerPort: rig.sharedWorkerPort,
      homeDir: '/h',
      target: rig.target,
    })

    rig.dispatch({ type: 'nexus-runtime-attach', nexus: true, panelId: 'panel-1' }, [])
    expect(rig.forwarded).toHaveLength(0)
    // The bootstrap logs the misbehaviour for diagnostics.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ignores unrelated message shapes (the legacy features handler is not affected)', () => {
    const rig = makeRig()
    setupPanelHostBootstrap({
      hostWindow: rig.hostWindow,
      hostOrigin: rig.origin,
      sharedWorkerPort: rig.sharedWorkerPort,
      homeDir: '/h',
      target: rig.target,
    })

    const channel = new MessageChannel()
    // Right type but missing nexus tag.
    rig.dispatch(
      { type: 'nexus-runtime-attach', panelId: 'panel-1' },
      [channel.port2],
    )
    // Unrelated type.
    rig.dispatch(
      { type: 'nexus-features-request', nexus: true, request: {} },
      [channel.port2],
    )
    // Junk values.
    rig.dispatch(null, [])
    rig.dispatch(42, [])

    expect(rig.forwarded).toHaveLength(0)
    channel.port1.close()
    channel.port2.close()
  })

  it('dispose() detaches the listener so later attaches are ignored', () => {
    const rig = makeRig()
    const handle = setupPanelHostBootstrap({
      hostWindow: rig.hostWindow,
      hostOrigin: rig.origin,
      sharedWorkerPort: rig.sharedWorkerPort,
      homeDir: '/h',
      target: rig.target,
    })
    handle.dispose()

    const channel = new MessageChannel()
    rig.dispatch(
      { type: 'nexus-runtime-attach', nexus: true, panelId: 'panel-1' },
      [channel.port2],
    )
    expect(rig.forwarded).toHaveLength(0)
    channel.port1.close()
    channel.port2.close()
  })
})
