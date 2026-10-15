import { declareTool, type ToolContract } from '../toolkit/toolContract'
import type { MCPPool } from './pool'
import type { McpResourceDescriptor } from './types'

/**
 * MCP resource tools (`ListMcpResources` / `ReadMcpResource`) over the pool.
 * Only browser-transport servers support resources; native servers throw.
 */

export const RESOURCE_INDEX_TOOL_ID = 'ListMcpResources'
export const READ_MCP_RESOURCE_TOOL_NAME = 'ReadMcpResource'

export function formatResourceList(resources: McpResourceDescriptor[]): string {
  if (resources.length === 0) return 'No MCP resources found.'
  return resources
    .map(r => {
      const label = r.name ? `${r.name} (${r.uri})` : r.uri
      const meta = [r.mimeType, r.description].filter(Boolean).join(' — ')
      return `- [${r.server}] ${label}${meta ? `: ${meta}` : ''}`
    })
    .join('\n')
}

function buildListMcpResourcesTool(pool: MCPPool): ToolContract {
  return declareTool({
    name: RESOURCE_INDEX_TOOL_ID,
    fromMcpServer: true,
    argsSchema: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description:
            'Optional MCP server name to filter by. Omit to list resources from every connected server.',
        },
      },
    },
    description: async () =>
      'List the resources advertised by connected MCP servers (resources/list).',
    readsOnly: () => true,
    parallelSafe: () => true,
    async call(input) {
      const raw = (input ?? {}) as Record<string, unknown>
      const server = typeof raw.server === 'string' ? raw.server : undefined
      const collected: McpResourceDescriptor[] = []
      if (server) {
        collected.push(...(await pool.listResources(server)))
      } else {
        for (const s of pool.listServers()) {
          if (s.status !== 'connected' || s.nativeServerId !== undefined) {
            continue
          }
          try {
            collected.push(...(await pool.listResources(s.name)))
          } catch {
            // A server that errors on resources/list is skipped, not fatal.
          }
        }
      }
      return { data: formatResourceList(collected) }
    },
  })
}

function buildReadMcpResourceTool(pool: MCPPool): ToolContract {
  return declareTool({
    name: READ_MCP_RESOURCE_TOOL_NAME,
    fromMcpServer: true,
    argsSchema: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'MCP server name that owns the resource.',
        },
        uri: { type: 'string', description: 'Resource URI to read.' },
      },
      required: ['server', 'uri'],
    },
    description: async () =>
      'Read a specific resource by URI from a connected MCP server (resources/read).',
    readsOnly: () => true,
    parallelSafe: () => true,
    async call(input) {
      const raw = (input ?? {}) as Record<string, unknown>
      const server = typeof raw.server === 'string' ? raw.server : ''
      const uri = typeof raw.uri === 'string' ? raw.uri : ''
      if (!server || !uri) {
        return {
          data: `${READ_MCP_RESOURCE_TOOL_NAME} requires both \`server\` and \`uri\`.`,
        }
      }
      const result = await pool.readResource(server, uri)
      return { data: result }
    },
  })
}

/**
 * The two resource tools, or `[]` when no browser-transport server is
 * connected (native-only / no MCP → nothing to list). Mirrors how
 * `buildMCPToolsFromPool` only yields tools for connected servers.
 */
export function buildMcpResourceToolsFromPool(pool: MCPPool): ToolContract[] {
  const hasResourceCapableServer = pool
    .listServers()
    .some(s => s.status === 'connected' && s.nativeServerId === undefined)
  if (!hasResourceCapableServer) return []
  return [buildListMcpResourcesTool(pool), buildReadMcpResourceTool(pool)]
}
