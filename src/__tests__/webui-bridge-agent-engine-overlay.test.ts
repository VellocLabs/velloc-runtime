/**
 * The agent registration site fans a successful `setField` write out to BOTH the cross-tab broadcast and the live
 * engine push (applyAgentSettingsToAllSessions).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the adapter so we can pin the broadcast hook independent of the
// real settings.json write semantics — those are exercised in
// `agent-bridge-adapter.test.ts`. Here we fire the broadcastChanged
// callback directly when the handler runs.
vi.mock('../browser/bridge/adapter/agentBridgeAdapter', () => ({
  handleAgentBridgeRequest: vi.fn(
    async (
      request: unknown,
      ctx: {
        broadcastChanged?: (payload: {
          values: { maxTurns: number; log: boolean; trace: boolean }
        }) => void
      },
    ) => {
      ctx.broadcastChanged?.({
        values: { maxTurns: 99, log: true, trace: false },
      })
      return {
        id: 'stub',
        route: { namespace: 'nexus', capability: 'agent', action: 'setField' },
        ok: true,
        result: {
          ok: true,
          values: { maxTurns: 99, log: true, trace: false },
        },
      }
    },
  ),
}))

// Other capabilities — empty stubs to keep the init from doing real work.
vi.mock('../browser/bridge/adapter/featuresBridgeAdapter', () => ({
  handleFeaturesBridgeRequest: vi.fn(),
}))
vi.mock('../browser/bridge/adapter/mcpSettingsBridgeAdapter', () => ({
  handleMcpSettingsBridgeRequest: vi.fn(),
}))
vi.mock('../browser/bridge/adapter/pluginsBridgeAdapter', () => ({
  handlePluginsBridgeRequest: vi.fn(),
}))
vi.mock('../mcp/globalPool', () => ({
  getMCPPool: () => null,
}))
vi.mock('../skillLibrary/builtin/catalog', () => ({
  installStockSkills: vi.fn(),
}))

describe('initBuiltinWebUiBridgeHandlers — agent broadcast hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.resetModules()
  })

  it('fires applyAgentSettingsToAllSessions AND broadcasts agent.changed on setField', async () => {
    const {
      initBuiltinWebUiBridgeHandlers,
      __resetBuiltinWebUiBridgeHandlersForTests,
    } = await import('../browser/worker/webUiBridge/initBuiltinHandlers')
    const { getWebUiBridgeHandler } = await import(
      '../browser/worker/webUiBridge/registry'
    )
    __resetBuiltinWebUiBridgeHandlersForTests()
    initBuiltinWebUiBridgeHandlers()

    const handler = getWebUiBridgeHandler('agent')
    expect(handler).toBeDefined()

    const broadcastEvent = vi.fn()
    const applyAgentSettingsToAllSessions = vi.fn()
    await handler!(
      {
        id: 'req-1',
        route: { namespace: 'nexus', capability: 'agent', action: 'setField' },
        payload: { patch: { maxTurns: 99 } },
      },
      {
        homeDir: '/tmp/fake-home',
        fs: {} as never,
        broadcastEvent,
        directBridge: null,
        applyAgentSettingsToAllSessions,
      } as never,
    )

    // Cross-tab broadcast — other tabs with About re-render against
    // the new disk state.
    expect(broadcastEvent).toHaveBeenCalledTimes(1)
    expect(broadcastEvent).toHaveBeenCalledWith(
      { namespace: 'nexus', capability: 'agent', action: 'changed' },
      {
        values: { maxTurns: 99, log: true, trace: false },
      },
    )
    // Live engine overlay — every active session's runtime worker
    // receives the new dict (engine applies what it recognises).
    expect(applyAgentSettingsToAllSessions).toHaveBeenCalledTimes(1)
    expect(applyAgentSettingsToAllSessions).toHaveBeenCalledWith({
      maxTurns: 99,
      log: true,
      trace: false,
    })
  })

  it('survives a context with no applyAgentSettingsToAllSessions (legacy test rigs)', async () => {
    const {
      initBuiltinWebUiBridgeHandlers,
      __resetBuiltinWebUiBridgeHandlersForTests,
    } = await import('../browser/worker/webUiBridge/initBuiltinHandlers')
    const { getWebUiBridgeHandler } = await import(
      '../browser/worker/webUiBridge/registry'
    )
    __resetBuiltinWebUiBridgeHandlersForTests()
    initBuiltinWebUiBridgeHandlers()

    const handler = getWebUiBridgeHandler('agent')!
    const broadcastEvent = vi.fn()
    await expect(
      handler(
        {
          id: 'req-1',
          route: { namespace: 'nexus', capability: 'agent', action: 'setField' },
          payload: { patch: { log: true } },
        },
        {
          homeDir: '/tmp/fake-home',
          fs: {} as never,
          broadcastEvent,
          directBridge: null,
          // NO applyAgentSettingsToAllSessions — degenerate test rig.
        } as never,
      ),
    ).resolves.toBeDefined()
    // Broadcast still fires (cross-tab UI consistency is independent
    // of the engine push surface).
    expect(broadcastEvent).toHaveBeenCalledTimes(1)
  })
})
