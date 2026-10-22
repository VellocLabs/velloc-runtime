import type { MCPToolDescriptor } from './types'

/** One input parameter of an MCP tool, as the server detail view lists it. */
export type McpToolParamSummary = {
  name: string
  /** The JSON-schema `type`; a union joins with `|`. */
  type?: string
  required?: true
}

/** An MCP tool as a UI shows it (F-9): its name, a bounded description and
 *  its parameter names. Small enough to ride on every session snapshot. */
export type McpToolSummary = {
  name: string
  description?: string
  readOnly?: true
  params?: McpToolParamSummary[]
  /** Parameters left out past the listing cap. */
  paramsOmitted?: number
}

/** Longest description kept, in characters; a cut one ends in `…`. */
export const MCP_TOOL_DESCRIPTION_MAX = 600
/** Most parameters listed per tool. */
export const MCP_TOOL_PARAMS_MAX = 24

function boundedDescription(raw: string | undefined): string | undefined {
  const text = raw?.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return undefined
  if (text.length <= MCP_TOOL_DESCRIPTION_MAX) return text
  const head = text.slice(0, MCP_TOOL_DESCRIPTION_MAX)
  const space = head.search(/\s\S*$/)
  const cut = space > MCP_TOOL_DESCRIPTION_MAX * 0.8 ? head.slice(0, space) : head
  return `${cut.trimEnd()}…`
}

function schemaType(prop: unknown): string | undefined {
  if (!prop || typeof prop !== 'object') return undefined
  const type = (prop as { type?: unknown }).type
  if (typeof type === 'string') return type
  if (Array.isArray(type)) {
    const names = type.filter((entry): entry is string => typeof entry === 'string')
    return names.length > 0 ? names.join('|') : undefined
  }
  return undefined
}

/** The summaries of `tools`, in server order. */
export function summarizeMcpTools(tools: readonly MCPToolDescriptor[]): McpToolSummary[] {
  return tools.map((tool) => {
    const summary: McpToolSummary = { name: tool.name }
    const description = boundedDescription(tool.description)
    if (description) summary.description = description
    if (tool.readOnlyHint === true) summary.readOnly = true
    const schema = tool.inputSchema
    const properties = schema?.properties
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const required = new Set(
        Array.isArray(schema.required) ? schema.required.filter((n): n is string => typeof n === 'string') : [],
      )
      const names = Object.keys(properties)
      // Required parameters first, each group in schema order.
      const ordered = [...names.filter((n) => required.has(n)), ...names.filter((n) => !required.has(n))]
      const params = ordered.slice(0, MCP_TOOL_PARAMS_MAX).map((name) => {
        const param: McpToolParamSummary = { name }
        const type = schemaType((properties as Record<string, unknown>)[name])
        if (type) param.type = type
        if (required.has(name)) param.required = true
        return param
      })
      if (params.length > 0) summary.params = params
      if (ordered.length > params.length) summary.paramsOmitted = ordered.length - params.length
    }
    return summary
  })
}
