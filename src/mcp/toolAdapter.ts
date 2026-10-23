import { declareTool, type ToolContract, type ToolArgsJsonShape } from '../toolkit/toolContract'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import type { LiveServerLink, MCPToolDescriptor } from './types'
import type { MCPPool } from './pool'
import { summarizeMcpInstructions } from './instructions'

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

/** Largest total tool-definition size, in characters, of a server offered inline. */
export const MCP_INLINE_SCHEMA_BUDGET_CHARS = 10_000

/** The size of a server's tool definitions as a request carries them: each
 *  tool's name, description and input schema, serialized. */
export function mcpServerSchemaChars(server: Pick<LiveServerLink, 'tools'>): number {
  let total = 0
  for (const tool of server.tools) {
    total += JSON.stringify({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? {},
    }).length
  }
  return total
}

/**
 * Whether a server's tools are offered inline instead of deferred (F-10): it
 * sent no instructions, so nothing outside its tool definitions says what it
 * is for, and those definitions fit `MCP_INLINE_SCHEMA_BUDGET_CHARS`.
 */
export function isMcpServerInline(server: Pick<LiveServerLink, 'instructions' | 'tools'>): boolean {
  return server.instructions === undefined && mcpServerSchemaChars(server) <= MCP_INLINE_SCHEMA_BUDGET_CHARS
}

/**
 * Skill-bucket names of the connected servers whose tools are deferred:
 * hidden from tools[] until ToolSearch / Skill activates the bucket. Inline
 * servers (`isMcpServerInline`) are left out, so their tools stay listed.
 * Empty when no server is connected.
 */
export function mcpServerSkillNamesFromPool(pool: MCPPool): string[] {
  const names = new Set<string>()
  for (const server of pool.listServers()) {
    if (server.status !== 'connected' || isMcpServerInline(server)) continue
    names.add(mcpServerSkillName(server.name))
  }
  return [...names]
}

/**
 * Every connected server's instructions, for the prompt's `$mcp_servers`
 * section. Servers without instructions are left out.
 */
export function mcpServerInstructionsFromPool(
  pool: Pick<MCPPool, 'listServers'>,
): Array<{ name: string; instructions: string }> {
  const out: Array<{ name: string; instructions: string }> = []
  for (const server of pool.listServers()) {
    if (server.status !== 'connected' || server.instructions === undefined) continue
    out.push({ name: server.name, instructions: server.instructions })
  }
  return out
}

/** How many tool names a Skill description lists before eliding the rest. */
const SKILL_DESCRIPTION_TOOL_NAMES = 8

/** A server's tools for its Skill description when it sent no instructions:
 *  the tool names, then the first tool description's opening summary. */
function summarizeMcpTools(tools: ReadonlyArray<MCPToolDescriptor>): string | undefined {
  if (tools.length === 0) return undefined
  const shown = tools.slice(0, SKILL_DESCRIPTION_TOOL_NAMES).map(tool => tool.name)
  const names = tools.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ')
  const described = tools.find(tool => tool.description?.trim())
  const lead = described?.description ? summarizeMcpInstructions(described.description) : undefined
  return lead ? `Tools: ${names}. ${lead}` : `Tools: ${names}.`
}

/** The one-line description of a server's Skill: what loading it gives, then
 *  the server's own summary when it sent instructions, else its tools. */
export function mcpServerSkillDescription(
  server: Pick<LiveServerLink, 'name' | 'instructions'> & Partial<Pick<LiveServerLink, 'tools'>>,
): string {
  const lead = `Loads the tools of the "${server.name}" MCP server.`
  const summary =
    server.instructions !== undefined
      ? summarizeMcpInstructions(server.instructions)
      : summarizeMcpTools(server.tools ?? [])
  return summary ? `${lead} ${summary}` : lead
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
      description: mcpServerSkillDescription(server),
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
