/**
 * The e2e bridge trace records each guest → host request exactly once, with
 * the label of the path it took: the page's
 * host calls on `runtime`, the runtime's relayed calls on `direct`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/protocol/core'
import { traceTransport } from '../browser/bridge/tracer'

function ok(): BrowserBridgeTransport {
  return {
    request: (async (r: { id: string; route: unknown }) => ({ id: r.id, route: r.route, ok: true, result: {} })) as never,
  }
}

const req = (capability: string, action: string) =>
  ({ id: `${capability}.${action}`, route: { namespace: 'nexus', capability, action }, payload: {} }) as never

afterEach(() => {
  globalThis.__NEXUS_BRIDGE_TRACE__ = undefined
})

describe('bridge tracer', () => {
  it('records each request once, labelled with the transport that carried it', async () => {
    const direct = traceTransport(ok(), 'direct')
    const runtime = traceTransport(ok(), 'runtime')

    await runtime.request(req('ui', 'setActiveSessionTitle'))
    await direct.request(req('mcp', 'nativeCall'))

    const requests = (globalThis.__NEXUS_BRIDGE_TRACE__ ?? []).filter(e => e.dir === 'request')
    expect(requests.map(e => `${e.transport}:${e.capability}.${e.action}`)).toEqual([
      'runtime:ui.setActiveSessionTitle',
      'direct:mcp.nativeCall',
    ])
    const responses = (globalThis.__NEXUS_BRIDGE_TRACE__ ?? []).filter(e => e.dir === 'response')
    expect(responses).toHaveLength(2)
    expect(responses.every(e => e.ok === true)).toBe(true)
  })
})
