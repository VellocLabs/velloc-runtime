import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import type { NexusMcpServerLaunchConfig } from './nativeBridge'

export type MCPServerHTTPConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type MCPServerSSEConfig = {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export type MCPServerWebSocketConfig = {
  type: 'websocket'
  url: string
  headers?: Record<string, string>
}

export type MCPServerConfig =
  | MCPServerHTTPConfig
  | MCPServerSSEConfig
  | MCPServerWebSocketConfig

export type MCPServerConfigWithName = MCPServerConfig & { name: string }

export type MCPServersConfigFile = {
  mcpServers: Record<string, MCPServerConfig>
}

export type MCPToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** A resource advertised by an MCP server (`resources/list`). Mirrors the
 *  SDK's `Resource` shape, plus the owning server name so the aggregated
 *  `ListMcpResources` listing can show provenance. */
export type McpResourceDescriptor = {
  uri: string
  name?: string
  description?: string
  mimeType?: string
  server: string
}

export type MCPServerStatus = 'connecting' | 'connected' | 'failed' | 'closed'

export type LiveServerLink = {
  name: string
  /**
   * Browser-transport config (http / sse / websocket). Absent for
   * settings-configured servers — those carry `nativeServerId` and
   * `nativeConfig` instead. Exactly one of `config` / `nativeServerId` is
   * set.
   */
  config?: MCPServerConfig
  /**
   * Id of a settings-configured server (settings.json `mcp.servers` or a
   * plugin's stdio server). When set, the pool routes `callTool` /
   * teardown through `MCPPoolOptions.nativeBridge` (the worker's
   * host-primitive transports) instead of its own SDK `client` (which
   * stays `undefined` for these servers).
   */
  nativeServerId?: string
  /**
   * The launch config a settings-configured server was connected with (set
   * on every one; undefined on browser-transport servers). Pool bookkeeping:
   * `refreshNativeServers` compares it against the latest settings.json
   * entry to detect a "replace" (config drifted; disconnect + reconnect),
   * and a reconnect after a lost host port reuses it.
   */
  nativeConfig?: NexusMcpServerLaunchConfig
  status: MCPServerStatus
  client?: Client
  transport?: Transport
  tools: MCPToolDescriptor[]
  error?: string
}

export type MCPOAuthTokens = {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_at?: number
  scope?: string
}

export type MCPAuthStore = Record<string, MCPOAuthTokens>
