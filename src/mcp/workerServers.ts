/**
 * Settings-configured MCP servers run by the worker: the SDK `Client` over the
 * primitive transports, implementing `McpBridgeOperations`. A failed connect or
 * call is `{ ok: false, error }`, never a throw; a server with no live
 * connection (including one on a replaced port) answers `MCP server is not
 * connected…`, which `MCPPool.callTool` retries once.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import { createNativePrimitives } from '../browser/bridge/nativePrimitives'
import { CLIENT_NAME, CLIENT_VERSION } from './client'
import type { McpHostAccess } from './mcpHost'
import {
  launchTransportKind,
  type McpBridgeOperations,
  type NexusMcpServerLaunchConfig,
} from './nativeBridge'
import {
  createPrimitiveFetch,
  McpTransportClosedError,
  ShellStdioClientTransport,
  type ShellStdioTransportOptions,
} from './primitiveTransports'
import type { MCPToolDescriptor } from './types'
import { summarizeMcpTools, type McpToolSummary } from './toolSummary'

/** How long a server's connect may take. */
export const MCP_CONNECT_TIMEOUT_MS = 30_000
/** An MCP tool call's timeout — effectively unbounded. */
export const MCP_TOOL_TIMEOUT_MS = 100_000_000

export type McpTestConnectResult = {
  ok: boolean
  serverName?: string
  serverVersion?: string
  toolCount?: number
  tools?: McpToolSummary[]
  error?: string
}

export type WorkerMcpOperations = McpBridgeOperations & {
  /**
   * The settings page's pre-save probe: connect with `config` (plaintext
   * header values, or `{{secret:NAME}}` ones of a saved server), report the
   * server's identity and tool count, and close. Never touches the pool.
   */
  testConnect(config: unknown): Promise<McpTestConnectResult>
}

export type CreateWorkerMcpOperationsOptions = {
  /** The host port + manifest to connect on — the current one at each call. */
  resolveHost: () => McpHostAccess | null
  createRequestId: () => string
  /**
   * Whether an HTTP server may be on loopback / a private network (the
   * egress policy's `allowPrivateNetwork`). True only for a server a person
   * configured — settings.json — never for a plugin's. Default: false.
   */
  allowPrivateNetwork?: (serverId: string) => boolean
  connectTimeoutMs?: number
  toolTimeoutMs?: number
  stdio?: ShellStdioTransportOptions
}

type LiveServer = {
  client: Client
  transport: Transport
  hostTransport: BrowserBridgeTransport
  tools: MCPToolDescriptor[]
  closed: boolean
}

const NOT_CONNECTED = 'MCP server is not connected'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A connect / call failure as one line: an HTTP status leads (`HTTP 401: …`,
 * what the C++ transport reported), and a stdio server that died says how
 * and what it wrote to stderr.
 */
export function describeMcpFailure(error: unknown, transport?: Transport): string {
  let message = errorMessage(error)
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'number' && code >= 400 && code <= 599) {
    message = `HTTP ${code}: ${message.replace(/^Streamable HTTP error: /, '')}`
  }
  if (transport instanceof ShellStdioClientTransport) {
    const reason = transport.closeReason
    if (reason && !message.includes(reason)) {
      message = `${message} (${reason})`
    } else if (!reason) {
      const tail = transport.stderr.trim()
      if (tail && !message.includes(tail)) message = `${message} (stderr: ${tail})`
    }
  }
  return message
}

function parseLaunchConfig(raw: unknown): NexusMcpServerLaunchConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const strings = (input: unknown): string[] | undefined =>
    Array.isArray(input) && input.every(item => typeof item === 'string')
      ? (input as string[])
      : undefined
  const record = (input: unknown): Record<string, string> | undefined => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
    const out: Record<string, string> = {}
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (typeof item === 'string') out[key] = item
    }
    return out
  }
  return {
    ...(value.transport === 'stdio' || value.transport === 'http'
      ? { transport: value.transport }
      : {}),
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
    ...(strings(value.args) ? { args: strings(value.args) } : {}),
    ...(record(value.env) ? { env: record(value.env) } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(record(value.headers) ? { headers: record(value.headers) } : {}),
    ...(typeof value.cwd === 'string' && value.cwd ? { cwd: value.cwd } : {}),
  }
}

/**
 * The host's own working directory (`fs.cwd` — the install root the fs
 * adapter anchors at, which the C++ MCP host defaulted a stdio server to).
 * `shell.spawn` takes no default: an empty cwd is INVALID_CWD.
 */
const hostCwdByTransport = new WeakMap<BrowserBridgeTransport, Promise<string>>()
function hostCwd(transport: BrowserBridgeTransport, createRequestId: () => string): Promise<string> {
  let cached = hostCwdByTransport.get(transport)
  if (!cached) {
    cached = transport
      .request({ id: createRequestId(), route: createBridgeRoute('fs', 'cwd'), payload: {} })
      .then(response => {
        if (!response.ok || typeof response.result !== 'string' || !response.result) {
          throw new Error('The host has no working directory for a stdio MCP server; set `cwd`.')
        }
        return response.result
      })
    cached.catch(() => hostCwdByTransport.delete(transport))
    hostCwdByTransport.set(transport, cached)
  }
  return cached
}

export function createWorkerMcpOperations(
  options: CreateWorkerMcpOperationsOptions,
): WorkerMcpOperations {
  const live = new Map<string, LiveServer>()
  /** The connect in flight per server: a second caller shares it rather
   *  than spawning a second child and orphaning the first. */
  const connecting = new Map<string, ReturnType<WorkerMcpOperations['connect']>>()
  const connectTimeoutMs = options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS
  const toolTimeoutMs = options.toolTimeoutMs ?? MCP_TOOL_TIMEOUT_MS

  function buildTransport(
    host: McpHostAccess,
    config: NexusMcpServerLaunchConfig,
    allowPrivateNetwork: boolean,
  ): Transport {
    const primitives = createNativePrimitives({
      transport: host.transport,
      createRequestId: options.createRequestId,
      manifest: host.manifest,
    })
    const kind = launchTransportKind(config)
    if (kind === 'stdio') {
      if (!config.command) throw new Error('stdio transport requires a `command`')
      return new ShellStdioClientTransport(
        primitives,
        {
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        },
        options.stdio,
      )
    }
    if (kind === 'http') {
      if (!config.url) throw new Error('http transport requires a `url`')
      return new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: createPrimitiveFetch(primitives.network, { allowPrivateNetwork }),
        requestInit: { headers: { ...(config.headers ?? {}) } },
      })
    }
    throw new Error("transport must be 'stdio' or 'http'")
  }

  /** Connect a client within `MCP_CONNECT_TIMEOUT_MS`; closes the
   *  transport and throws a described error on failure. */
  async function open(
    label: string,
    config: NexusMcpServerLaunchConfig,
    allowPrivateNetwork: boolean,
  ): Promise<{ client: Client; transport: Transport; hostTransport: BrowserBridgeTransport }> {
    const host = options.resolveHost()
    if (!host) throw new Error('No host bridge port is attached.')
    if (launchTransportKind(config) === 'stdio' && !config.cwd) {
      config = { ...config, cwd: await hostCwd(host.transport, options.createRequestId) }
    }
    const transport = buildTransport(host, config, allowPrivateNetwork)
    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { capabilities: {} },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `MCP server "${label}" connection timed out after ${connectTimeoutMs}ms`,
                ),
              ),
            connectTimeoutMs,
          )
        }),
      ])
    } catch (error) {
      const described = describeMcpFailure(error, transport)
      await transport.close().catch(() => {})
      throw new Error(described)
    } finally {
      clearTimeout(timer)
    }
    return { client, transport, hostTransport: host.transport }
  }

  async function listTools(label: string, client: Client): Promise<MCPToolDescriptor[]> {
    try {
      const list = await client.listTools()
      return list.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
        ...(tool.annotations?.readOnlyHint === true ? { readOnlyHint: true } : {}),
      }))
    } catch (error) {
      console.warn(`[mcp] Server "${label}" does not support listTools:`, error)
      return []
    }
  }

  function isStale(server: LiveServer): boolean {
    return server.closed || options.resolveHost()?.transport !== server.hostTransport
  }

  async function drop(serverId: string, server: LiveServer): Promise<void> {
    if (live.get(serverId) === server) live.delete(serverId)
    server.closed = true
    await server.client.close().catch(error => {
      console.warn(`[mcp] Error closing "${serverId}":`, errorMessage(error))
    })
  }

  const connectNow: WorkerMcpOperations['connect'] = async (serverId, config) => {
    const existing = live.get(serverId)
    if (existing && !isStale(existing)) {
      return { ok: true, tools: existing.tools }
    }
    if (existing) await drop(serverId, existing)
    if (!config) {
      return { ok: false, tools: [], error: `MCP server "${serverId}" has no launch config.` }
    }
    try {
      const opened = await open(
        serverId,
        config,
        options.allowPrivateNetwork?.(serverId) ?? false,
      )
      const server: LiveServer = { ...opened, tools: [], closed: false }
      opened.client.onclose = () => {
        server.closed = true
      }
      opened.client.onerror = error => {
        console.warn(`[mcp] Server "${serverId}" transport error:`, errorMessage(error))
      }
      server.tools = await listTools(serverId, opened.client)
      live.set(serverId, server)
      return { ok: true, tools: server.tools }
    } catch (error) {
      return { ok: false, tools: [], error: errorMessage(error) }
    }
  }

  return {
    connect(serverId, config) {
      const pending = connecting.get(serverId)
      if (pending) return pending
      const run = connectNow(serverId, config)
      connecting.set(serverId, run)
      const settle = () => {
        if (connecting.get(serverId) === run) connecting.delete(serverId)
      }
      run.then(settle, settle)
      return run
    },

    async callTool(serverId, toolName, args, signal) {
      const server = live.get(serverId)
      if (!server || isStale(server)) {
        if (server) await drop(serverId, server)
        return { ok: false, error: `${NOT_CONNECTED}: "${serverId}"` }
      }
      try {
        const result = await server.client.callTool(
          { name: toolName, arguments: args },
          undefined,
          { signal, timeout: toolTimeoutMs },
        )
        return { ok: true, result }
      } catch (error) {
        if (error instanceof McpTransportClosedError) {
          // The frame never left: the child was already gone. Safe to retry
          // on a fresh connection, which the pool does on this answer.
          await drop(serverId, server)
          return { ok: false, error: `${NOT_CONNECTED}: "${serverId}" (${error.message})` }
        }
        return { ok: false, error: describeMcpFailure(error, server.transport) }
      }
    },

    async disconnect(serverId) {
      // A connect still opening would land after this and stay live.
      await connecting.get(serverId)?.catch(() => undefined)
      const server = live.get(serverId)
      if (server) await drop(serverId, server)
    },

    async testConnect(raw) {
      const config = parseLaunchConfig(raw)
      if (!config || !launchTransportKind(config)) {
        return {
          ok: false,
          error:
            'Invalid server config. Check the transport and its required fields (URL for http, command for stdio).',
        }
      }
      let opened: Awaited<ReturnType<typeof open>>
      try {
        // A server the user is typing into the settings form: theirs, so a
        // local one is reachable.
        opened = await open('test', config, true)
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
      try {
        const tools = await listTools('test', opened.client)
        const identity = opened.client.getServerVersion()
        return {
          ok: true,
          toolCount: tools.length,
          tools: summarizeMcpTools(tools),
          ...(identity?.name ? { serverName: identity.name } : {}),
          ...(identity?.version ? { serverVersion: identity.version } : {}),
        }
      } finally {
        await opened.client.close().catch(() => {})
      }
    },
  }
}
