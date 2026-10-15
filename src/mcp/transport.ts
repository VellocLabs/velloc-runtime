import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { buildAuthHeaders, getStoredTokens } from './auth'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { MCPServerConfig } from './types'

export type CreateTransportOptions = {
  cwd: string
  serverName: string
  config: MCPServerConfig
  /** The booting runtime's fs; omitted → the realm-global slot (tests). */
  fs?: RuntimeFs
}

export async function createTransport(
  options: CreateTransportOptions,
): Promise<Transport> {
  const { cwd, serverName, config } = options
  const tokens = await getStoredTokens(cwd, serverName, options.fs)
  const mergedHeaders: Record<string, string> = {
    ...(config.headers ?? {}),
    ...buildAuthHeaders(tokens),
  }

  const url = new URL(config.url)

  switch (config.type) {
    case 'http': {
      return new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: mergedHeaders,
        },
      })
    }
    case 'sse': {
      return new SSEClientTransport(url, {
        requestInit: { headers: mergedHeaders },
        eventSourceInit: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              headers: { ...(init?.headers ?? {}), ...mergedHeaders },
            }),
        },
      })
    }
    case 'websocket': {
      return new WebSocketClientTransport(url)
    }
    default: {
      const exhaustive: never = config
      throw new Error(`Unsupported MCP transport: ${JSON.stringify(exhaustive)}`)
    }
  }
}
