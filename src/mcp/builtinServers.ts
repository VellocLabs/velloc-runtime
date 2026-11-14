/**
 * Contract: built-in MCP servers (F-10) are servers the runtime itself
 * implements. A built-in server has no transport and no process; its tools
 * are functions that run in the session's own loop, offered under the same
 * `mcp__<server>__<tool>` names as a connected server's. A server is
 * registered once per realm and decides per session whether it is on
 * (`isEnabled`). A built-in name outranks a configured server of the same
 * name: the configured one's tools are left out of the session's list.
 * Security: a built-in tool runs with no permission prompt of its own beyond
 * the session's rules, so a server may only do what its tools declare; a tool
 * that changes anything outside the session's own state must not be marked
 * `readOnly`.
 */
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { declareTool, type ToolArgsJsonShape, type ToolContract } from '../toolkit/toolContract'
import type { McpSessionOffering } from './sessionOffering'
import { mcpServerSkillName, mcpToolName, sanitizeSegment } from './toolAdapter'

/** What a server's `isEnabled` decides on. */
export type BuiltinMcpSession = {
  templateType: string
  /** A loop under another session: a sub-agent or a teammate. */
  nested: boolean
  /** Nobody watches the session's conversation. */
  headless: boolean
}

export type BuiltinMcpToolResult = {
  text: string
  /** The call was refused or failed; the text says why. */
  isError?: boolean
}

export type BuiltinMcpTool = {
  name: string
  description: string
  inputSchema: ToolArgsJsonShape
  /** Changes nothing outside the session's own state: allowed in plan mode
   *  and run alongside other calls of the step. */
  readOnly?: boolean
  call(
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<BuiltinMcpToolResult> | BuiltinMcpToolResult
}

export type BuiltinMcpServer = {
  /** The `<server>` of `mcp__<server>__<tool>`; `[A-Za-z0-9_-]` only. */
  name: string
  /** Listed in every request. Without it the server's tools are deferred
   *  like a connected server's and loaded on demand. */
  alwaysLoad?: boolean
  isEnabled(session: BuiltinMcpSession): boolean
  tools: readonly BuiltinMcpTool[]
}

const registry = new Map<string, BuiltinMcpServer>()

/**
 * Register a server for every session of this realm. Throws on a name that
 * is not its own sanitized form, a name already registered, or two tools of
 * one name. Returns the unregister.
 */
export function registerBuiltinMcpServer(server: BuiltinMcpServer): () => void {
  if (!server.name || sanitizeSegment(server.name) !== server.name) {
    throw new RangeError(`[mcp] built-in server name must match [A-Za-z0-9_-]+: ${JSON.stringify(server.name)}`)
  }
  if (registry.has(server.name)) {
    throw new Error(`[mcp] built-in server "${server.name}" is already registered.`)
  }
  const seen = new Set<string>()
  for (const tool of server.tools) {
    if (!tool.name || sanitizeSegment(tool.name) !== tool.name || seen.has(tool.name)) {
      throw new RangeError(`[mcp] built-in server "${server.name}" has a bad or repeated tool name: ${JSON.stringify(tool.name)}`)
    }
    seen.add(tool.name)
  }
  registry.set(server.name, server)
  return () => {
    if (registry.get(server.name) === server) registry.delete(server.name)
  }
}

export function listBuiltinMcpServers(): BuiltinMcpServer[] {
  return Array.from(registry.values())
}

/** Whether `serverName`, as configured or as sanitized, is a built-in's. */
export function isBuiltinMcpServerName(serverName: string): boolean {
  return registry.has(sanitizeSegment(serverName))
}

function buildBuiltinTool(server: BuiltinMcpServer, tool: BuiltinMcpTool): ToolContract {
  const readOnly = tool.readOnly === true
  return declareTool({
    name: mcpToolName(server.name, tool.name),
    fromMcpServer: true,
    ...(server.alwaysLoad ? {} : { skill: mcpServerSkillName(server.name) }),
    mcpInfo: { serverName: server.name, toolName: tool.name },
    argsSchema: tool.inputSchema,
    description: async () => tool.description,
    parallelSafe: () => readOnly,
    readsOnly: () => readOnly,
    async call(input, context) {
      const result = await tool.call((input ?? {}) as Record<string, unknown>, context)
      return result.isError ? { data: result.text, isError: true } : { data: result.text }
    },
  })
}

function deferredServerCommand(server: BuiltinMcpServer): ChromiumPromptCommand {
  const skillName = mcpServerSkillName(server.name)
  const toolLines = server.tools
    .map(tool => `- ${mcpToolName(server.name, tool.name)}: ${tool.description.trim()}`)
    .join('\n')
  return {
    type: 'prompt',
    name: skillName,
    description: `Loads the tools of the built-in "${server.name}" server.`,
    content: `The built-in "${server.name}" server is now active. You can call its tools:\n\n${toolLines}`,
    path: `<mcp-skill>/${skillName}`,
    loadedFrom: 'bundled',
    source: 'bundled',
    permittedTools: server.tools.map(tool => mcpToolName(server.name, tool.name)),
  }
}

/**
 * What the enabled built-in servers offer `session`, in the shape of a
 * pool's offering: tool contracts, a deferral unit and a Skill command per
 * server that is not `alwaysLoad`, and the servers' names.
 */
export function builtinMcpOffering(
  session: BuiltinMcpSession,
  servers: readonly BuiltinMcpServer[] = listBuiltinMcpServers(),
): McpSessionOffering {
  const offering: McpSessionOffering = { tools: [], skillNames: [], commands: [], servers: new Set() }
  for (const server of servers) {
    if (!server.isEnabled(session)) continue
    offering.servers.add(server.name)
    for (const tool of server.tools) offering.tools.push(buildBuiltinTool(server, tool))
    if (!server.alwaysLoad) {
      offering.skillNames.push(mcpServerSkillName(server.name))
      offering.commands.push(deferredServerCommand(server))
    }
  }
  return offering
}

/**
 * A pool's offering with the built-in one laid over it. A connected server
 * that sanitizes to an enabled built-in's name gives up its tools, its
 * deferral unit and its Skill command.
 */
export function withBuiltinMcpOffering(
  pool: McpSessionOffering,
  builtin: McpSessionOffering,
): McpSessionOffering {
  if (builtin.servers.size === 0) return pool
  const shadowed = (serverName: string): boolean => builtin.servers.has(sanitizeSegment(serverName))
  const shadowedSkills = new Set(Array.from(builtin.servers, mcpServerSkillName))
  return {
    tools: [
      ...pool.tools.filter(tool => !(tool.mcpInfo && shadowed(tool.mcpInfo.serverName))),
      ...builtin.tools,
    ],
    skillNames: [...pool.skillNames.filter(name => !shadowedSkills.has(name)), ...builtin.skillNames],
    commands: [...pool.commands.filter(command => !shadowedSkills.has(command.name)), ...builtin.commands],
    servers: new Set([...Array.from(pool.servers).filter(name => !shadowed(name)), ...builtin.servers]),
  }
}
