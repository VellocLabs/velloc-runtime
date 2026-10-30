/**
 * `$.mcp.call` and `$.mcp.connect` (F-25): a plugin's call of a tool on one of the
 * engine's MCP servers with the engine's connection, and the connect of a server its
 * own manifest lists. Op events, so a plugin above may deny another's call. No
 * permission prompt: the call, seen by the hooks above, is the grant. Refusals are
 * `unlisted` and `failed`.
 */

import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import { sameMCPServerConfig, type MCPPool } from '../mcp/pool'
import { mcpServerOrigin, type McpServerOriginSources } from '../mcp/serverOrigin'
import { sanitizeSegment } from '../mcp/toolAdapter'
import type { LiveServerLink, MCPServerConfigWithName } from '../mcp/types'

/** One block of an MCP result — `McpContentBlock` in the declaration. */
export type ModMcpContentBlock = {
  type: string
  text?: string
  uri?: string
  mimeType?: string
  [field: string]: unknown
}

/** `$.mcp.call`'s answer — `McpToolResult` in the declaration. */
export type ModMcpToolResult = {
  content: ModMcpContentBlock[]
  isError: boolean
  structuredContent?: unknown
}

/** "Why `$.mcp.connect` left a server unconnected, in one word" — the two of
 *  `McpConnectRefusal` Velloc can answer. */
export type ModMcpConnectRefusal = 'unlisted' | 'failed'

/** `$.mcp.connect`'s answer — `McpConnectResult` in the declaration. */
export type ModMcpConnectResult =
  | { isConnected: true; server: string }
  | { isConnected: false; reason: ModMcpConnectRefusal; message: string }

/** The event `e` of `mcp.call`. */
export type ModMcpCallInput = { server: string; tool: string; args: Record<string, unknown> }

/** A server one plugin's manifest lists, its `${…}` already substituted. */
export type ModMcpManifestServer =
  | { kind: 'browser'; entry: MCPServerConfigWithName }
  | { kind: 'native'; id: string; config: NexusMcpServerLaunchConfig }
  /** Listed, but its config cannot start (`reason` says why). */
  | { kind: 'refused'; reason: string }

type StartableManifestServer = Exclude<ModMcpManifestServer, { kind: 'refused' }>

/** What `$.mcp` needs of the session. */
export type ModMcpHost = {
  call(input: ModMcpCallInput, options: { signal?: AbortSignal }): Promise<ModMcpToolResult>
  connect(plugin: string, server: string): Promise<ModMcpConnectResult>
}

/** What the host needs of the pool. `MCPPool` satisfies it. */
export type ModMcpPool = Pick<MCPPool, 'listServers' | 'callTool' | 'addServer' | 'launchNativeServer'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{ server, tool, args }` from `$.mcp.call(server, tool, args?)`. Also
 *  re-checks an `e` a hook above rewrote, before core spends it. */
export function mcpCallInput(args: readonly unknown[]): ModMcpCallInput {
  const [server, tool, toolArgs] = args
  return checkCallInput({ server, tool, args: toolArgs })
}

export function checkCallInput(e: unknown): ModMcpCallInput {
  const input = isRecord(e) ? e : {}
  if (typeof input.server !== 'string' || input.server === '') {
    throw new TypeError('$.mcp.call(server, tool, args): server must be a non-empty string')
  }
  if (typeof input.tool !== 'string' || input.tool === '') {
    throw new TypeError('$.mcp.call(server, tool, args): tool must be a non-empty string')
  }
  if (input.args !== undefined && !isRecord(input.args)) {
    throw new TypeError('$.mcp.call(server, tool, args): args must be an object')
  }
  return { server: input.server, tool: input.tool, args: { ...((input.args as Record<string, unknown>) ?? {}) } }
}

/** `{ server }` from `$.mcp.connect(server)`. */
export function mcpConnectInput(args: readonly unknown[]): { server: string } {
  return { server: checkConnectServer({ server: args[0] }) }
}

export function checkConnectServer(e: unknown): string {
  const server = isRecord(e) ? e.server : undefined
  if (typeof server !== 'string' || server === '') {
    throw new TypeError('$.mcp.connect(server): server must be a non-empty string')
  }
  return server
}

/**
 * The pool's name for `server`: the name as listed, else the one server whose
 * `mcp__` spelling it is ("the tool-name spelling `claude_ai_Gmail` is
 * accepted too"). Rejects — naming what is listed — for no match, and for a
 * spelling two servers share.
 */
export function resolveMcpServerName(names: readonly string[], server: string): string {
  if (names.includes(server)) return server
  const spelled = names.filter(name => sanitizeSegment(name) === server)
  if (spelled.length === 1) return spelled[0]!
  if (spelled.length > 1) {
    throw new Error(`$.mcp.call: "${server}" is the spelling of ${spelled.map(n => `"${n}"`).join(' and ')}; name the server as listed`)
  }
  const error = new Error(
    `$.mcp.call: no MCP server "${server}" (listed: ${names.length > 0 ? names.map(n => `"${n}"`).join(', ') : 'none'})`,
  )
  error.name = 'NotFoundError'
  throw error
}

function contentBlockOf(block: unknown): ModMcpContentBlock {
  if (isRecord(block) && typeof block.type === 'string') return { ...block, type: block.type }
  return { type: 'text', text: typeof block === 'string' ? block : JSON.stringify(block) ?? '' }
}

/**
 * `McpToolResult` off what the pool returned: the SDK's `CallToolResult`
 * (`content`, `isError`, `structuredContent`) for a browser-transport server,
 * the host's result for a native one. The older `{ toolResult }` form, and
 * anything else, become one text block — the answer is always plain data the
 * worker can take.
 */
export function mcpToolResultOf(raw: unknown): ModMcpToolResult {
  if (isRecord(raw) && Array.isArray(raw.content)) {
    return {
      content: raw.content.map(contentBlockOf),
      isError: raw.isError === true,
      ...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
    }
  }
  const value = isRecord(raw) && 'toolResult' in raw ? raw.toolResult : raw
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) ?? '' }],
    isError: false,
  }
}

function configOf(server: StartableManifestServer) {
  if (server.kind === 'native') return server.config
  const { name: _name, ...config } = server.entry
  return config
}

/** Whether the pool's `running` is the manifest's `server`, under any name. */
function isSameServer(running: LiveServerLink, server: StartableManifestServer): boolean {
  if (server.kind === 'native') {
    return running.nativeServerId !== undefined && sameMCPServerConfig(running.nativeConfig, server.config)
  }
  return running.nativeServerId === undefined && sameMCPServerConfig(running.config, configOf(server))
}

function failed(message: string): ModMcpConnectResult {
  return { isConnected: false, reason: 'failed', message }
}

/**
 * `$.mcp` over the session's pool. `manifestServer(plugin, key)` is the
 * server under `key` in that plugin's own manifest, or undefined.
 * `onNativeLaunched(name)` runs once for each stdio server `connect` brought
 * up, after it connected — the session offers its tools from then on.
 * `origins` says whose each pool entry is: only a failed stdio entry under
 * the plugin's own id is launched again with the manifest's current config.
 */
export function poolModMcp(options: {
  pool: () => ModMcpPool | null
  manifestServer: (plugin: string, key: string) => ModMcpManifestServer | undefined
  onNativeLaunched?: (name: string) => void
  origins?: () => McpServerOriginSources
}): ModMcpHost {
  const poolOrThrow = (): ModMcpPool => {
    const pool = options.pool()
    if (!pool) {
      const error = new Error('$.mcp is not available: the MCP pool is not built')
      error.name = 'NotSupportedError'
      throw error
    }
    return pool
  }
  /** In-flight stdio launches by name; concurrent connects share one. */
  const launches = new Map<string, Promise<LiveServerLink | undefined>>()
  /** Whether the native entry under `name` is `plugin`'s own: the pool keeps the first
   *  holder of an id, so the origin of the name decides, never the config. */
  const ownsNative = (plugin: string, name: string): boolean => {
    const sources = options.origins?.()
    if (!sources) return false
    const origin = mcpServerOrigin({ name, nativeServerId: name }, sources)
    return origin.kind === 'plugin' && origin.plugin === plugin
  }
  const launchNative = (
    pool: ModMcpPool,
    name: string,
    server: Extract<StartableManifestServer, { kind: 'native' }>,
    replaceConfig: boolean,
  ): Promise<LiveServerLink | undefined> => {
    const inFlight = launches.get(name)
    if (inFlight) return inFlight
    const run = pool.launchNativeServer(name, server.config, { replaceConfig }).then(link => {
      if (link?.status === 'connected' && isSameServer(link, server)) {
        try {
          options.onNativeLaunched?.(link.name)
        } catch (error) {
          console.warn(`[mods] $.mcp.connect: offering "${link.name}" failed:`, error)
        }
      }
      return link
    }).finally(() => {
      launches.delete(name)
    })
    launches.set(name, run)
    return run
  }
  return {
    async call(input, { signal }) {
      const pool = poolOrThrow()
      const name = resolveMcpServerName(pool.listServers().map(s => s.name), input.server)
      return mcpToolResultOf(await pool.callTool(name, input.tool, input.args, signal))
    },
    async connect(plugin, key) {
      const server = options.manifestServer(plugin, key)
      if (!server) {
        return { isConnected: false, reason: 'unlisted', message: `"${key}" is not an MCP server in ${plugin}'s manifest` }
      }
      if (server.kind === 'refused') return failed(`"${key}" cannot start: ${server.reason}`)
      const pool = options.pool()
      if (!pool) return failed(`"${key}" was not connected: the MCP pool is not built`)
      const running = pool.listServers().filter(s => isSameServer(s, server))
      const connected = running.find(s => s.status === 'connected')
      // "The same server run under another name answers with that name."
      if (connected) return { isConnected: true, server: connected.name }
      // A stdio server that failed, or that the session never started, is
      // launched again under the name it holds, else its manifest id. A
      // failed entry under the plugin's own id whose config has since changed
      // (a runtime installed, a key saved) is replaced by the current one;
      // one another owner holds under that id is answered as it is.
      const name = server.kind === 'native' ? running[0]?.name ?? server.id : server.entry.name
      try {
        const added = server.kind === 'native'
          ? await launchNative(pool, name, server, running.length === 0 && ownsNative(plugin, name))
          : await pool.addServer(server.entry)
        if (!added) return failed(`"${key}" was not connected: this session cannot start stdio servers`)
        if (!isSameServer(added, server)) {
          return failed(`"${name}" is another MCP server's name in this session`)
        }
        if (added.status === 'connected') return { isConnected: true, server: added.name }
        return failed(`"${added.name}" did not connect${added.error ? `: ${added.error}` : ''}`)
      } catch (error) {
        return failed(`"${key}" did not connect: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
