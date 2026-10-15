import { declareTool, type ToolContract, type ToolArgsJsonShape } from '../toolkit/toolContract'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import type { LiveServerLink, MCPToolDescriptor } from './types'
import type { MCPPool } from './pool'

const MCP_TOOL_NAME_PREFIX = 'mcp__'
const NAME_SEPARATOR = '__'

/** A name as the `mcp__<server>__<tool>` spelling has it: anything outside
 *  `[A-Za-z0-9_-]` becomes `_`. `$.mcp.call` accepts a server by it too. */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${sanitizeSegment(serverName)}${NAME_SEPARATOR}${sanitizeSegment(toolName)}`
}

/**
 * Skill bucket name for an MCP server (`mcp__` prefix): the server's tools
 * activate together as one deferred skill.
 */
export function mcpServerSkillName(serverName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${sanitizeSegment(serverName)}`
}

function normalizeInputSchema(
  schema: Record<string, unknown> | undefined,
): ToolArgsJsonShape {
  if (schema && typeof schema === 'object' && schema.type === 'object') {
    return schema as ToolArgsJsonShape
  }
  return { type: 'object', properties: {} }
}

function buildMCPTool(
  pool: MCPPool,
  serverName: string,
  descriptor: MCPToolDescriptor,
): ToolContract {
  const fullName = mcpToolName(serverName, descriptor.name)
  const humanDescription =
    descriptor.description?.trim() ||
    `Tool "${descriptor.name}" from MCP server "${serverName}".`

  return declareTool({
    name: fullName,
    fromMcpServer: true,
    // Per-server skill bucket. Combined with registering this skill as
    // deferred, this makes MCP tools progressive-disclosure eligible
    // (every MCP tool is deferred). When the deferral master switch is
    // off the skill is registered-but-inert, so MCP tools stay inline, as
    // in 'standard' (non-tool-search) mode.
    skill: mcpServerSkillName(serverName),
    mcpInfo: { serverName, toolName: descriptor.name },
    argsSchema: normalizeInputSchema(descriptor.inputSchema),
    description: async () => humanDescription,
    parallelSafe: () => true,
    readsOnly: () => false,
    async call(input, context) {
      const signal = context.cancelSource?.signal
      const args = (input ?? {}) as Record<string, unknown>
      const result = await pool.callTool(
        serverName,
        descriptor.name,
        args,
        signal,
      )
      return { data: result }
    },
  })
}

export function buildMCPToolsFromPool(pool: MCPPool): ToolContract[] {
  const tools: ToolContract[] = []
  for (const server of pool.listServers()) {
    if (server.status !== 'connected') continue
    for (const descriptor of server.tools) {
      tools.push(buildMCPTool(pool, server.name, descriptor))
    }
  }
  return tools
}

export function buildMCPToolsForServer(
  pool: MCPPool,
  server: LiveServerLink,
): ToolContract[] {
  if (server.status !== 'connected') return []
  return server.tools.map(descriptor =>
    buildMCPTool(pool, server.name, descriptor),
  )
}

/**
 * Distinct skill-bucket names for every connected server in the pool.
 * Register these as deferred (every MCP tool is) so MCP tools are hidden
 * from tools[] until ToolSearch / Skill activates the server's bucket.
 * Empty when no server is connected.
 */
export function mcpServerSkillNamesFromPool(pool: MCPPool): string[] {
  const names = new Set<string>()
  for (const server of pool.listServers()) {
    if (server.status !== 'connected') continue
    names.add(mcpServerSkillName(server.name))
  }
  return [...names]
}

/**
 * A model-invocable `Skill('mcp__<server>')` per connected server, activating
 * its deferred tools. `name` must equal `mcpServerSkillName`.
 */
export function buildMCPSkillCommands(pool: MCPPool): ChromiumPromptCommand[] {
  const commands: ChromiumPromptCommand[] = []
  for (const server of pool.listServers()) {
    if (server.status !== 'connected') continue
    const toolLines = server.tools
      .map(d => {
        const full = mcpToolName(server.name, d.name)
        const desc = d.description?.trim()
        return desc ? `- ${full}: ${desc}` : `- ${full}`
      })
      .join('\n')
    commands.push({
      type: 'prompt',
      name: mcpServerSkillName(server.name),
      description: `Load the tools from the "${server.name}" MCP server.`,
      content:
        `The "${server.name}" MCP server is now active. You can call its ` +
        `tools:\n\n${toolLines || '(no tools advertised)'}`,
      path: `<mcp-skill>/${mcpServerSkillName(server.name)}`,
      loadedFrom: 'bundled',
      source: 'bundled',
      permittedTools: server.tools.map(d => mcpToolName(server.name, d.name)),
    })
  }
  return commands
}
