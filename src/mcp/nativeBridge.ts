/** A tool a settings-configured server advertises (its `tools/list`). */
export type McpBridgeToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** Set, to `true`, only when the server annotates the tool read-only. */
  readOnlyHint?: boolean
}

/**
 * Result of `connect`: `ok` with the server's tools, or `ok: false` and a
 * human-readable `error` (spawn failure, handshake timeout, …). In-band, so
 * one bad server cannot fail pool init.
 */
export type McpBridgeConnectResult = {
  ok: boolean
  tools: McpBridgeToolDescriptor[]
  error?: string
}

/**
 * Result of `callTool`: the raw MCP `tools/call` result (`{ content,
 * isError, … }`) when `ok`, else `error`.
 */
export type McpBridgeCallToolResult = {
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * Launch config of a settings-configured ("native") MCP server — the
 * on-disk `NexusMcpServerConfig` (`settings/settingsTypes.ts`) minus its
 * display metadata, read from `~/.velloc/settings.json` `mcp.servers` (or a
 * plugin manifest's stdio servers). `headers` values of a server saved
 * through the settings page carry `{{secret:mcp:…}}` placeholders, which the
 * host substitutes on the way out (`mcpServerSecrets.ts`).
 */
export type NexusMcpServerLaunchConfig = {
  transport?: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  cwd?: string
}

/** The transport a launch config selects: explicit `transport`, else
 *  `command` → stdio, `url` → http; null when it names neither. */
export function launchTransportKind(
  config: NexusMcpServerLaunchConfig,
): 'stdio' | 'http' | null {
  if (config.transport === 'stdio' || config.transport === 'http') return config.transport
  if (config.transport !== undefined) return null
  if (typeof config.command === 'string' && config.command) return 'stdio'
  if (typeof config.url === 'string' && config.url) return 'http'
  return null
}

/**
 * How `MCPPool` drives its settings-configured servers. Implemented in the
 * worker by `createWorkerMcpOperations` (`workerServers.ts`) over the host's
 * primitives. It once wrapped the C++ `mcp` bridge capability (removed under
 * interface 1), whose result shapes the types above keep.
 * Failures are in-band (`ok: false`), and `MCP server is not connected…`
 * means "reconnect and retry".
 */
export type McpBridgeOperations = {
  /** Connect (or answer the live connection of) a server and return its
   *  tools. Idempotent while the connection lives. */
  connect(
    serverId: string,
    config: NexusMcpServerLaunchConfig,
  ): Promise<McpBridgeConnectResult>
  /** Invoke one tool on a connected server. */
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpBridgeCallToolResult>
  /** Best-effort teardown (a stdio server's child is stopped). */
  disconnect(serverId: string): Promise<void>
}
