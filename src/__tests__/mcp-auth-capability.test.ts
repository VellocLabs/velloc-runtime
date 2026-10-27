import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { registerMcpAuthCapability } from '../browser/runtimeHub/mcpAuthCapability'
import type { ConnectionInfo } from '../browser/runtimeHub/types'
import {
  isMcpAuthServerPayload,
  isMcpAuthSignInPayload,
  MCP_AUTH_ACTION_SCOPES,
  MCP_AUTH_STATUS_TOPIC,
  readMcpAuthState,
  type McpAuthState,
} from '../mcp/oauth/mcpAuthProtocol'
import { configureMcpOAuthService } from '../mcp/oauth/mcpOAuthHolder'
import type { McpOAuthService } from '../mcp/oauth/McpOAuthService'

const URL_ = 'https://mcp.example.test/mcp'

function fakeService(initial: McpAuthState) {
  let state = initial
  const listeners = new Set<(s: McpAuthState) => void>()
  const service = {
    getState: () => state,
    onStateChange: (l: (s: McpAuthState) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    signIn: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }
  const set = (next: McpAuthState) => {
    state = next
    for (const l of listeners) l(next)
  }
  return { service, set }
}

const conn = (mode: 'observe' | 'manager' | 'full') =>
  ({ connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode, sessions: 'all' }, transport: 'message-port' }) as ConnectionInfo

function rig(getService: () => McpOAuthService | null) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  registerMcpAuthCapability(registry, broker, { getService, onServiceChanged: () => () => {} })
  const events: McpAuthState[] = []
  const subscribe = (c: ConnectionInfo) =>
    broker.subscribe(
      { conn: c, send: evt => events.push((evt as unknown as { payload: McpAuthState }).payload), bufferedBytes: () => 0 },
      MCP_AUTH_STATUS_TOPIC,
    )
  const act = (act: 'signIn' | 'cancel' | 'signOut', payload: unknown) =>
    registry
      .resolve('mcpAuth', act)!
      .handle({ id: '1', route: { cap: 'mcpAuth', act }, payload, conn: conn('full') } as never, {} as never)
  return { registry, broker, events, subscribe, act }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => configureMcpOAuthService(null))

describe('mcpAuth capability', () => {
  it('sign-in is full scope; cancel and sign-out are manager scope', () => {
    const { registry } = rig(() => null)
    expect(MCP_AUTH_ACTION_SCOPES).toEqual({ signIn: 'full', cancel: 'manager', signOut: 'manager' })
    expect(registry.resolve('mcpAuth', 'signIn')!.spec.scope).toBe('full')
    expect(registry.resolve('mcpAuth', 'signOut')!.spec.scope).toBe('manager')
  })

  it('guards the payloads', () => {
    expect(isMcpAuthSignInPayload({ url: URL_ })).toBe(true)
    expect(isMcpAuthSignInPayload({ url: URL_, clientId: 'id', clientSecret: 's' })).toBe(true)
    expect(isMcpAuthSignInPayload({ url: URL_, clientSecret: 's' })).toBe(false)
    expect(isMcpAuthSignInPayload({ url: 42 })).toBe(false)
    expect(isMcpAuthSignInPayload({ url: URL_, extra: 1 })).toBe(false)
    expect(isMcpAuthSignInPayload({ url: 'x'.repeat(5000) })).toBe(false)
    expect(isMcpAuthSignInPayload({ url: URL_, windowTitle: 'Sign in to notion' })).toBe(true)
    expect(isMcpAuthSignInPayload({ url: URL_, windowTitle: '' })).toBe(false)
    expect(isMcpAuthSignInPayload({ url: URL_, windowTitle: 7 })).toBe(false)
    expect(isMcpAuthSignInPayload({ url: URL_, windowTitle: 't'.repeat(1001) })).toBe(false)
    expect(isMcpAuthServerPayload({ url: URL_ })).toBe(true)
    expect(isMcpAuthServerPayload({})).toBe(false)
  })

  it('without a service the topic says unavailable and actions are host_unavailable', async () => {
    const r = rig(() => null)
    r.subscribe(conn('manager'))
    await settle()
    expect(r.events).toEqual([{ available: false, servers: [] }])
    await expect(r.act('signIn', { url: URL_ })).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('an observer cannot read sign-in state', async () => {
    const fake = fakeService({ available: true, servers: [{ url: URL_, phase: 'needs-sign-in' }] })
    const r = rig(() => fake.service as unknown as McpOAuthService)
    expect(r.broker.authorize(MCP_AUTH_STATUS_TOPIC, conn('observe'))).toBe('forbidden')
    expect(r.broker.authorize(MCP_AUTH_STATUS_TOPIC, conn('manager'))).toBe('ok')
  })

  it('publishes state changes and routes actions to the service', async () => {
    const fake = fakeService({ available: true, servers: [] })
    const r = rig(() => fake.service as unknown as McpOAuthService)
    r.subscribe(conn('manager'))
    await settle()
    fake.set({ available: true, servers: [{ url: URL_, phase: 'signing-in' }] })
    expect(r.events.at(-1)).toEqual({ available: true, servers: [{ url: URL_, phase: 'signing-in' }] })
    await expect(r.act('signIn', { url: URL_, clientId: 'id' })).resolves.toEqual({ ok: true })
    expect(fake.service.signIn).toHaveBeenCalledWith({ url: URL_, clientId: 'id' })
    await r.act('cancel', { url: URL_ })
    await r.act('signOut', { url: URL_ })
    expect(fake.service.cancel).toHaveBeenCalledWith(URL_)
    expect(fake.service.signOut).toHaveBeenCalledWith(URL_)
  })

  it('the client reader accepts the published shape and rejects others', () => {
    const state = {
      available: true,
      servers: [{ url: URL_, phase: 'needs-sign-in', needsClient: true, redirectUri: 'http://127.0.0.1:47643/callback' }],
    }
    expect(readMcpAuthState(state)).toEqual(state)
    expect(readMcpAuthState({ available: true, servers: [{ url: URL_, phase: 'asleep' }] })).toBeNull()
    expect(readMcpAuthState(null)).toBeNull()
  })
})
