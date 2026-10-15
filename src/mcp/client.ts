import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { traceLine } from '../utils/debugLog'
import { createTransport } from './transport'
import type {
  LiveServerLink,
  MCPServerConfig,
  MCPToolDescriptor,
} from './types'

export const CLIENT_NAME = 'nexus-web'
export const CLIENT_VERSION = '0.1.0'

/** How long a browser-transport connect may take before the server is marked
 *  failed — the worker path's bound (workerServers.ts MCP_CONNECT_TIMEOUT_MS).
 *  Without it one unresponsive server holds the whole runtime build, which
 *  awaits every configured server. */
export const MCP_CLIENT_CONNECT_TIMEOUT_MS = 30_000

export type ConnectOptions = {
  cwd: string
  name: string
  config: MCPServerConfig
  /** The booting runtime's fs; omitted → the realm-global slot (tests). */
  fs?: RuntimeFs
  /** Connect bound; defaults to MCP_CLIENT_CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number
}

export async function connectMCPServer(
  options: ConnectOptions,
): Promise<LiveServerLink> {
  const { cwd, name, config } = options
  const connected: LiveServerLink = {
    name,
    config,
    status: 'connecting',
    tools: [],
  }

  try {
    // Failure paths below console.warn (always captured by the worker log
    // ring); the success-path lifecycle is sub-warn so `/debug log on` can
    // reconstruct connect timing without spamming the ring by default.
    traceLine(`[mcp] connecting to "${name}" (${config.type})`)
    const transport = await createTransport({
      cwd,
      serverName: name,
      config,
      fs: options.fs,
    })
    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { capabilities: {} },
    )
    const connectTimeoutMs = options.connectTimeoutMs ?? MCP_CLIENT_CONNECT_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`MCP server "${name}" connection timed out after ${connectTimeoutMs}ms`),
              ),
            connectTimeoutMs,
          )
        }),
      ])
    } catch (err) {
      // A connect that never settles still holds its socket / process.
      await transport.close().catch(() => {})
      throw err
    } finally {
      clearTimeout(timer)
    }

    let tools: MCPToolDescriptor[] = []
    try {
      const list = await client.listTools()
      tools = list.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      }))
    } catch (err) {
      console.warn(`[mcp] Server "${name}" does not support listTools:`, err)
    }

    connected.client = client
    connected.transport = transport
    connected.status = 'connected'
    connected.tools = tools
    traceLine(
      `[mcp] connected to "${name}" — ${tools.length} tool(s)`,
    )
    return connected
  } catch (err) {
    connected.status = 'failed'
    connected.error = err instanceof Error ? err.message : String(err)
    console.warn(`[mcp] Connection to "${name}" failed:`, err)
    return connected
  }
}

export async function disconnectMCPServer(
  server: LiveServerLink,
): Promise<void> {
  try {
    await server.client?.close()
  } catch (err) {
    console.warn(`[mcp] Error closing client for "${server.name}":`, err)
  }
  server.status = 'closed'
  server.client = undefined
  server.transport = undefined
}

export async function invokeServerTool(
  server: LiveServerLink,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!server.client || server.status !== 'connected') {
    throw new Error(
      `MCP server "${server.name}" is not connected (status: ${server.status}).`,
    )
  }
  return server.client.callTool(
    { name: toolName, arguments: args },
    undefined,
    { signal },
  )
}
