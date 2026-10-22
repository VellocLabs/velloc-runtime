import type { ToolContract } from '../toolkit/toolContract'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import type { MCPPool } from './pool'
import { buildMCPSkillCommands, buildMCPToolsFromPool, mcpServerSkillNamesFromPool } from './toolAdapter'
import { READ_MCP_RESOURCE_TOOL_NAME, RESOURCE_INDEX_TOOL_ID, buildMcpResourceToolsFromPool } from './resourceTools'

/**
 * What a session offers from its MCP pool (F-10): the connected servers'
 * tool contracts (the resource tools included), one deferral unit per
 * server, the `Skill('mcp__<server>')` commands, and the servers' names.
 * Read at session start and again after a plugin reload, so the four stay
 * one picture of the pool.
 */
export type McpSessionOffering = {
  tools: ToolContract[]
  skillNames: string[]
  commands: ChromiumPromptCommand[]
  servers: Set<string>
}

export function mcpSessionOffering(pool: MCPPool): McpSessionOffering {
  return {
    tools: [...buildMCPToolsFromPool(pool), ...buildMcpResourceToolsFromPool(pool)],
    skillNames: mcpServerSkillNamesFromPool(pool),
    commands: buildMCPSkillCommands(pool),
    servers: new Set(
      pool.listServers().filter(server => server.status === 'connected').map(server => server.name),
    ),
  }
}

/** Whether a tool in a session's list came from the MCP offering. */
export function isMcpSessionTool(tool: ToolContract): boolean {
  return (
    tool.mcpInfo !== undefined
    || tool.name === RESOURCE_INDEX_TOOL_ID
    || tool.name === READ_MCP_RESOURCE_TOOL_NAME
  )
}
