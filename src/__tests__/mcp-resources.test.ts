import { describe, expect, it } from 'vitest'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'
import type { MCPPool } from '../mcp/pool'
import type { McpResourceDescriptor } from '../mcp/types'
import {
  RESOURCE_INDEX_TOOL_ID,
  READ_MCP_RESOURCE_TOOL_NAME,
  buildMcpResourceToolsFromPool,
  formatResourceList,
} from '../mcp/resourceTools'

const CTX = {} as unknown as ToolCallContext
const ALLOW: PermissionDecider = (async () => ({ behavior: 'allow' as const, updatedInput: {} })) as PermissionDecider
const PARENT = {} as unknown as Message

/** Invoke a tool's `call` with the dummy canUseTool / invokingRow args. */
function callTool(tool: ToolContract, input: Record<string, unknown>) {
  return tool.call(input, CTX, ALLOW, PARENT)
}

type FakeServer = {
  name: string
  status: string
  nativeServerId?: string
}

function fakePool(opts: {
  servers: FakeServer[]
  resources?: Record<string, McpResourceDescriptor[]>
  read?: (server: string, uri: string) => unknown
}): MCPPool {
  return {
    listServers: () => opts.servers,
    listResources: async (name: string) => opts.resources?.[name] ?? [],
    readResource: async (name: string, uri: string) =>
      opts.read ? opts.read(name, uri) : { contents: [{ uri }] },
  } as unknown as MCPPool
}

function toolsByName(pool: MCPPool) {
  const tools = buildMcpResourceToolsFromPool(pool)
  return new Map(tools.map(t => [t.name, t]))
}

describe('MCP resources', () => {
  it('exposes no resource tools when no browser-transport server is connected', () => {
    expect(
      buildMcpResourceToolsFromPool(
        fakePool({ servers: [{ name: 'n', status: 'connected', nativeServerId: 'x' }] }),
      ),
    ).toEqual([])
    expect(
      buildMcpResourceToolsFromPool(
        fakePool({ servers: [{ name: 'd', status: 'error' }] }),
      ),
    ).toEqual([])
  })

  it('exposes ListMcpResources + ReadMcpResource when a browser server is connected', () => {
    const byName = toolsByName(
      fakePool({ servers: [{ name: 'docs', status: 'connected' }] }),
    )
    expect(byName.has(RESOURCE_INDEX_TOOL_ID)).toBe(true)
    expect(byName.has(READ_MCP_RESOURCE_TOOL_NAME)).toBe(true)
    // Resources are read-only.
    expect(byName.get(RESOURCE_INDEX_TOOL_ID)!.readsOnly({})).toBe(true)
  })

  it('ListMcpResources aggregates across connected browser servers, skipping native/disconnected', async () => {
    const pool = fakePool({
      servers: [
        { name: 'docs', status: 'connected' },
        { name: 'native', status: 'connected', nativeServerId: 'n1' },
        { name: 'down', status: 'error' },
      ],
      resources: {
        docs: [{ uri: 'doc://a', name: 'A', mimeType: 'text/plain', server: 'docs' }],
        native: [{ uri: 'x://y', server: 'native' }],
      },
    })
    const list = toolsByName(pool).get(RESOURCE_INDEX_TOOL_ID)!
    const out = (await callTool(list, {})) as { data: string }
    expect(out.data).toContain('[docs] A (doc://a)')
    expect(out.data).not.toContain('native') // native server skipped
  })

  it('ListMcpResources filters to one server when `server` is given', async () => {
    const pool = fakePool({
      servers: [{ name: 'docs', status: 'connected' }],
      resources: { docs: [{ uri: 'doc://a', server: 'docs' }] },
    })
    const list = toolsByName(pool).get(RESOURCE_INDEX_TOOL_ID)!
    const out = (await callTool(list, { server: 'docs' })) as { data: string }
    expect(out.data).toContain('doc://a')
  })

  it('ReadMcpResource reads by server + uri and requires both', async () => {
    const pool = fakePool({
      servers: [{ name: 'docs', status: 'connected' }],
      read: (server, uri) => ({ contents: [{ uri, text: `content:${server}:${uri}` }] }),
    })
    const read = toolsByName(pool).get(READ_MCP_RESOURCE_TOOL_NAME)!
    const out = (await callTool(read, { server: 'docs', uri: 'doc://a' })) as {
      data: { contents: Array<{ text: string }> }
    }
    expect(out.data.contents[0]!.text).toBe('content:docs:doc://a')

    const missing = (await callTool(read, { server: 'docs' })) as { data: string }
    expect(missing.data).toContain('requires both')
  })

  it('formatResourceList renders an empty + populated listing', () => {
    expect(formatResourceList([])).toBe('No MCP resources found.')
    expect(
      formatResourceList([
        { uri: 'doc://a', name: 'A', mimeType: 'text/md', description: 'docs', server: 's' },
      ]),
    ).toBe('- [s] A (doc://a): text/md — docs')
  })
})
