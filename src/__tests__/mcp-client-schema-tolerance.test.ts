import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// A remote server's declared output schemas must never cost Velloc its tools
// or a correct call: one `pattern` the unicode regexp mode rejects made the
// SDK's listTools throw (so every tool of the server was lost), and a result
// carrying a field its own schema forbids made callTool throw. Velloc reads a
// result as content; the validator warns and passes it through.
const link: { transport?: Transport } = {}
vi.mock('../mcp/transport', () => ({
  createTransport: async () => link.transport,
}))

import { connectMCPServer, disconnectMCPServer, invokeServerTool } from '../mcp/client'
import { createTolerantSchemaValidator } from '../mcp/schemaValidator'

const HTTPS_PATTERN = '^https\\://'

const STRICT_OK_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  additionalProperties: false,
}

async function serveTools(
  tools: Array<{ name: string; outputSchema?: Record<string, unknown> }>,
  results: Record<string, { content: unknown[]; structuredContent?: unknown }>,
) {
  const server = new Server({ name: 'fixture', version: '0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({
      ...tool,
      description: `${tool.name} description`,
      inputSchema: { type: 'object' },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result = results[request.params.name]
    if (!result) throw new Error(`no fixture result for ${request.params.name}`)
    return result
  })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  await server.connect(serverEnd)
  link.transport = clientEnd
  const live = await connectMCPServer({
    cwd: '/p',
    name: 'fixture',
    config: { type: 'http', url: 'http://localhost:1/mcp' },
  })
  return { live, server }
}

describe('MCP client output-schema tolerance', () => {
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    link.transport = undefined
  })

  it('the fixture pattern is the one the unicode regexp mode rejects', () => {
    expect(() => new RegExp(HTTPS_PATTERN, 'u')).toThrow(SyntaxError)
    expect(() => new RegExp(HTTPS_PATTERN)).not.toThrow()
  })

  it('lists every tool when one output schema carries such a pattern', async () => {
    const { live } = await serveTools(
      [
        {
          name: 'create_order',
          outputSchema: {
            type: 'object',
            properties: { href: { type: 'string', pattern: HTTPS_PATTERN } },
          },
        },
        { name: 'plain' },
      ],
      {},
    )
    expect(live.status).toBe('connected')
    expect(live.tools.map(tool => tool.name).sort()).toEqual(['create_order', 'plain'])
    expect(warn.mock.calls.map(call => String(call[0]))).not.toContainEqual(
      expect.stringContaining('does not support listTools'),
    )
    await disconnectMCPServer(live)
  })

  it('returns a result that disagrees with its declared output schema, warning once', async () => {
    const result = {
      content: [{ type: 'text', text: '{"ok":true,"extra":1}' }],
      structuredContent: { ok: true, extra: 1 },
    }
    const { live } = await serveTools(
      [{ name: 'list_transactions', outputSchema: STRICT_OK_SCHEMA }],
      { list_transactions: result },
    )
    expect(live.tools.map(tool => tool.name)).toEqual(['list_transactions'])

    const first = await invokeServerTool(live, 'list_transactions', {})
    const second = await invokeServerTool(live, 'list_transactions', {})
    expect(first).toMatchObject(result)
    expect(second).toMatchObject(result)
    const schemaWarnings = warn.mock.calls
      .map(call => String(call[0]))
      .filter(line => line.includes('declared output schema'))
    expect(schemaWarnings).toHaveLength(1)
    expect(schemaWarnings[0]).toMatch(/^\[mcp\] /)
    expect(schemaWarnings[0]).toContain('additional properties')
    await disconnectMCPServer(live)
  })

  it('passes a matching result through a well-formed schema silently', async () => {
    const result = {
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { ok: true },
    }
    const { live } = await serveTools(
      [{ name: 'ping', outputSchema: STRICT_OK_SCHEMA }],
      { ping: result },
    )
    expect(await invokeServerTool(live, 'ping', {})).toMatchObject(result)
    expect(warn).not.toHaveBeenCalled()
    await disconnectMCPServer(live)
  })
})

describe('createTolerantSchemaValidator', () => {
  it('accepts every value for a schema that does not compile', () => {
    const warnings: string[] = []
    const validator = createTolerantSchemaValidator(message => warnings.push(message))
    const validate = validator.getValidator({ type: 'string', pattern: '(' })
    expect(validate(42)).toEqual({ valid: true, data: 42, errorMessage: undefined })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^\[mcp\] .*does not compile/)
  })

  it('keeps formats and reports a mismatch once per schema', () => {
    const warnings: string[] = []
    const validator = createTolerantSchemaValidator(message => warnings.push(message))
    const validate = validator.getValidator({ type: 'string', format: 'uri' })
    expect(validate('https://example.test/').valid).toBe(true)
    expect(validate('not a uri').valid).toBe(true)
    expect(validate('still not').valid).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('format "uri"')
  })
})
