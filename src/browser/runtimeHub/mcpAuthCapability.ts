/**
 * MCP server sign-in on the runtime protocol: the `mcpAuth/status` topic and
 * `mcpAuth.signIn` / `cancel` / `signOut`; shapes and scopes in
 * `mcp/oauth/mcpAuthProtocol.ts` (F-10).
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  isMcpAuthServerPayload,
  isMcpAuthSignInPayload,
  MCP_AUTH_ACTION_SCOPES,
  MCP_AUTH_CAPABILITY,
  MCP_AUTH_STATUS_EVENT,
  MCP_AUTH_STATUS_TOPIC,
  type McpAuthServerPayload,
  type McpAuthSignInPayload,
  type McpAuthState,
} from '../../mcp/oauth/mcpAuthProtocol'
import { currentMcpOAuthService, onMcpOAuthServiceChanged } from '../../mcp/oauth/mcpOAuthHolder'
import type { McpOAuthService } from '../../mcp/oauth/McpOAuthService'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export type McpAuthCapabilityOptions = {
  /** Default: the holder's service. */
  getService?: () => McpOAuthService | null
  /** Default: the holder's change feed. */
  onServiceChanged?: (listener: () => void) => () => void
}

export function registerMcpAuthCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: McpAuthCapabilityOptions = {},
): { dispose(): void } {
  const getService = options.getService ?? currentMcpOAuthService
  const state = (): McpAuthState => getService()?.getState() ?? { available: false, servers: [] }

  const provider: TopicProvider = {
    matches: (id: TopicId) => id === MCP_AUTH_STATUS_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'manager'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: MCP_AUTH_STATUS_EVENT, payload: state() }
    },
  }
  broker.registerProvider(provider)

  const publish = (payload: McpAuthState): void => {
    if (broker.subscribersOf(MCP_AUTH_STATUS_TOPIC as TopicId).length === 0) return
    broker.publish(MCP_AUTH_STATUS_TOPIC as TopicId, payload, { type: MCP_AUTH_STATUS_EVENT })
  }

  registry.registerCapability({
    cap: MCP_AUTH_CAPABILITY,
    actions: {
      signIn: { scope: MCP_AUTH_ACTION_SCOPES.signIn, guard: isMcpAuthSignInPayload },
      cancel: { scope: MCP_AUTH_ACTION_SCOPES.cancel, guard: isMcpAuthServerPayload },
      signOut: { scope: MCP_AUTH_ACTION_SCOPES.signOut, guard: isMcpAuthServerPayload },
    },
    handle: async request => {
      const service = getService()
      if (!service || !service.getState().available) {
        throw wireError('host_unavailable', 'mcpAuth: this runtime cannot sign in to MCP servers')
      }
      switch (request.route.act) {
        case 'signIn':
          await service.signIn(request.payload as McpAuthSignInPayload)
          return { ok: true }
        case 'cancel':
          await service.cancel((request.payload as McpAuthServerPayload).url)
          return { ok: true }
        case 'signOut':
          await service.signOut((request.payload as McpAuthServerPayload).url)
          return { ok: true }
        default:
          throw wireError('unknown_route', `mcpAuth has no action '${request.route.act}'`)
      }
    },
  })

  let unwatchService: (() => void) | null = null
  const watch = (): void => {
    unwatchService?.()
    const service = getService()
    unwatchService = service ? service.onStateChange(publish) : null
    publish(state())
  }
  const unwatchHolder = (options.onServiceChanged ?? onMcpOAuthServiceChanged)(watch)
  watch()
  return {
    dispose() {
      unwatchHolder()
      unwatchService?.()
    },
  }
}
