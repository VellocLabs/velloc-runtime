/**
 * MCP tool summaries for the server detail view (F-9): bounded descriptions,
 * required parameters first, a capped parameter list, a capped tool list.
 */
import { describe, expect, it } from 'vitest'
import {
  MCP_TOOL_DESCRIPTION_MAX,
  MCP_TOOL_PARAMS_MAX,
  MCP_TOOL_SUMMARIES_MAX,
  summarizeMcpTools,
} from '../mcp/toolSummary'

describe('summarizeMcpTools', () => {
  it('keeps name, description, read-only and parameters with type and required flag, required first', () => {
    expect(
      summarizeMcpTools([
        {
          name: 'search',
          description: '  Finds issues.\r\n\r\n\r\n\r\nUse filters.  ',
          readOnlyHint: true,
          inputSchema: {
            type: 'object',
            properties: { limit: { type: 'integer' }, query: { type: 'string' }, scope: { type: ['string', 'null'] }, raw: {} },
            required: ['query'],
          },
        },
        { name: 'ping' },
      ]),
    ).toEqual([
      {
        name: 'search',
        description: 'Finds issues.\n\nUse filters.',
        readOnly: true,
        params: [
          { name: 'query', type: 'string', required: true },
          { name: 'limit', type: 'integer' },
          { name: 'scope', type: 'string|null' },
          { name: 'raw' },
        ],
      },
      { name: 'ping' },
    ])
  })

  it('cuts a long description on a word boundary with an ellipsis', () => {
    const description = 'word '.repeat(400)
    const [summary] = summarizeMcpTools([{ name: 'long', description }])
    expect(summary!.description!.length).toBeLessThanOrEqual(MCP_TOOL_DESCRIPTION_MAX + 1)
    expect(summary!.description!.endsWith('word…')).toBe(true)
  })

  it('caps the parameter list and counts what it left out', () => {
    const properties = Object.fromEntries(Array.from({ length: MCP_TOOL_PARAMS_MAX + 3 }, (_, i) => [`p${i}`, { type: 'string' }]))
    const [summary] = summarizeMcpTools([{ name: 'wide', inputSchema: { type: 'object', properties } }])
    expect(summary!.params).toHaveLength(MCP_TOOL_PARAMS_MAX)
    expect(summary!.paramsOmitted).toBe(3)
  })

  it('summarizes at most a fixed number of tools, the first ones in server order', () => {
    const tools = Array.from({ length: MCP_TOOL_SUMMARIES_MAX + 40 }, (_, i) => ({ name: `t${i}`, description: 'd'.repeat(500) }))
    const summaries = summarizeMcpTools(tools)
    expect(summaries).toHaveLength(MCP_TOOL_SUMMARIES_MAX)
    expect(summaries[0]!.name).toBe('t0')
    expect(summaries.at(-1)!.name).toBe(`t${MCP_TOOL_SUMMARIES_MAX - 1}`)
  })

  it('treats a blank description and a schema without properties as absent', () => {
    expect(summarizeMcpTools([{ name: 'bare', description: '   ', inputSchema: { type: 'object' } }])).toEqual([{ name: 'bare' }])
  })
})
