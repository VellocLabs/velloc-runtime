/**
 * `registerWebUiBridgeHandler('mcpSettings', ...)` wires `refreshNativeServers()` on every session's pool into
 * `broadcastChanged` beside `ctx.broadcastEvent`. The pool itself: mcp-pool-settings-loader.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories must be hoisted before any `await import(...)` so
// the module-under-test sees the mocked surface from the start. Two open
// session pools share one spy, so each write must refresh both.
const refreshNativeServers = vi.fn(async () => {})
vi.mock('../mcp/sessionPools', () => ({
  listSessionMCPPools: () => [{ refreshNativeServers }, { refreshNativeServers }],
}))

// We also stub the adapter to skip the real settings.json write path
// — this test pins the broadcast hook, not the disk semantics.
vi.mock('../browser/bridge/adapter/mcpSettingsBridgeAdapter', () => ({
  handleMcpSettingsBridgeRequest: vi.fn(
    async (
      request: unknown,
      ctx: { broadcastChanged?: (payload: { servers: unknown }) => void },
    ) => {
      // Simulate a successful write by firing the broadcast — that's
      // the surface this test is pinning.
      ctx.broadcastChanged?.({ servers: { stub: { transport: 'stdio' } } })
      return {
        id: 'stub',
        route: { namespace: 'nexus', capability: 'mcpSettings', action: 'upsert' },
        ok: true,
        result: { ok: true, servers: { stub: { transport: 'stdio' } } },
      }
    },
  ),
}))

// Skip the other capability handlers' side-effects — none are
// relevant here and `installStockSkills` would otherwise force a
// registry init we don't need.
vi.mock('../browser/bridge/adapter/agentBridgeAdapter', () => ({
  handleAgentBridgeRequest: vi.fn(),
}))
vi.mock('../browser/bridge/adapter/featuresBridgeAdapter', () => ({
  handleFeaturesBridgeRequest: vi.fn(),
}))
vi.mock('../browser/bridge/adapter/pluginsBridgeAdapter', () => ({
  handlePluginsBridgeRequest: vi.fn(),
}))
vi.mock('../skillLibrary/builtin/catalog', () => ({
  installStockSkills: vi.fn(),
}))

describe('initBuiltinWebUiBridgeHandlers — mcpSettings broadcast hook', () => {
  beforeEach(() => {
    refreshNativeServers.mockClear()
  })
  afterEach(() => {
    vi.resetModules()
  })

  it('triggers pool.refreshNativeServers when a write fires broadcastChanged', async () => {
    const {
      initBuiltinWebUiBridgeHandlers,
      __resetBuiltinWebUiBridgeHandlersForTests,
    } = await import('../browser/worker/webUiBridge/initBuiltinHandlers')
    const { getWebUiBridgeHandler } = await import(
      '../browser/worker/webUiBridge/registry'
    )
    __resetBuiltinWebUiBridgeHandlersForTests()
    initBuiltinWebUiBridgeHandlers()

    const handler = getWebUiBridgeHandler('mcpSettings')
    expect(handler).toBeDefined()

    const broadcastEvent = vi.fn()
    const ctx = {
      homeDir: '/tmp/fake-home',
      fs: {} as never,
      broadcastEvent,
      directBridge: null,
    }
    await handler!(
      {
        id: 'req-1',
        route: { namespace: 'nexus', capability: 'mcpSettings', action: 'upsert' },
        payload: { id: 'stub', config: { transport: 'stdio', command: 'foo' } },
      },
      ctx as never,
    )

    // The broadcast event must still fan out to attached WebUI ports —
    // that's how cross-tab UI refresh works.
    expect(broadcastEvent).toHaveBeenCalledTimes(1)
    expect(broadcastEvent).toHaveBeenCalledWith(
      { namespace: 'nexus', capability: 'mcpSettings', action: 'changed' },
      { servers: { stub: { transport: 'stdio' } } },
    )

    // And the in-process pool refresh must fire — this is the
    // mid-session pickup that this test exists to pin. The hook is
    // synchronous (fire-and-forget); flush the microtask queue to
    // observe the call.
    await Promise.resolve()
    expect(refreshNativeServers).toHaveBeenCalledTimes(2)
  })

  it('survives a refreshNativeServers rejection without throwing through the handler', async () => {
    refreshNativeServers.mockImplementationOnce(async () => {
      throw new Error('simulated boom')
    })
    const {
      initBuiltinWebUiBridgeHandlers,
      __resetBuiltinWebUiBridgeHandlersForTests,
    } = await import('../browser/worker/webUiBridge/initBuiltinHandlers')
    const { getWebUiBridgeHandler } = await import(
      '../browser/worker/webUiBridge/registry'
    )
    __resetBuiltinWebUiBridgeHandlersForTests()
    initBuiltinWebUiBridgeHandlers()

    const handler = getWebUiBridgeHandler('mcpSettings')!
    const broadcastEvent = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        handler(
          {
            id: 'req-2',
            route: { namespace: 'nexus', capability: 'mcpSettings', action: 'upsert' },
            payload: { id: 'stub', config: { transport: 'stdio', command: 'foo' } },
          },
          {
            homeDir: '/tmp/fake-home',
            fs: {} as never,
            broadcastEvent,
            directBridge: null,
          } as never,
        ),
      ).resolves.toBeDefined()
      // Flush the rejection's microtask.
      await Promise.resolve()
      await Promise.resolve()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('pool refresh failed'),
        expect.anything(),
      )
    } finally {
      warn.mockRestore()
    }
  })
})
