/**
 * The runtime's own host port for the MCP client, not a session's scoped view:
 * stdio servers' events arrive any time and the pool outlives sessions.
 * `getMcpHost()` answers the current port; a connection on an older one is
 * gone. Absent in unit tests and the mock host.
 */
import type {
  BrowserBridgeTransport,
  BrowserHostManifest,
} from '../browser/bridge/browserBridgeProtocol'

export type McpHostAccess = {
  transport: BrowserBridgeTransport
  manifest?: Pick<BrowserHostManifest, 'capabilities' | 'primitives'>
}

let provider: (() => McpHostAccess | null) | null = null

export function setMcpHostProvider(next: (() => McpHostAccess | null) | null): void {
  provider = next
}

export function getMcpHost(): McpHostAccess | null {
  return provider?.() ?? null
}

/** The primitives the worker MCP client needs, by manifest entry. */
export const MCP_STDIO_PRIMITIVE = 'shell.spawn.argv'
export const MCP_HTTP_PRIMITIVE = 'network.streamOpen'

/** Whether a host can run settings-configured MCP servers at all. */
export function hostServesWorkerMcp(
  manifest: Pick<BrowserHostManifest, 'primitives'> | undefined,
): boolean {
  const primitives = manifest?.primitives ?? []
  return primitives.includes(MCP_STDIO_PRIMITIVE) || primitives.includes(MCP_HTTP_PRIMITIVE)
}
