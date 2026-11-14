/**
 * The tools an app's agent run keeps (F-40). Security: an allowlist, so a tool
 * added later stays out until named here: the run reads and writes files,
 * loads skills and calls its own plugin's MCP servers; it starts no shell, no
 * sub-agent, no session or teammate, no routine, asks nobody anything and
 * keeps no step list: nobody watches its conversation.
 */

import type { SessionMcpScope } from '../../mcp/sessionMcpScope'
import { TOOL_GROUPS, TURN_BOARD_TOOL_NAMES } from '../../toolkit/builtin/toolGroups'
import { pluginOfTemplateId } from '../ui/uiManifest'

const KEPT: ReadonlySet<string> = new Set<string>([
  ...TOOL_GROUPS.read,
  ...TOOL_GROUPS.edit,
  ...TOOL_GROUPS.skills,
  ...TOOL_GROUPS.webfetch,
  ...TOOL_GROUPS.superedit,
])

const MCP_TOOL_PREFIX = 'mcp__'

/** Whether an app's agent run keeps the tool named `name`. */
export function appRunKeepsTool(name: string): boolean {
  return KEPT.has(name) || (name.startsWith(MCP_TOOL_PREFIX) && !TURN_BOARD_TOOL_NAMES.includes(name))
}

/** The tools of `tools` an app's agent run keeps. */
export function appRunTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(tool => appRunKeepsTool(tool.name))
}

/**
 * The MCP sources of an app's agent run of type `templateType`. Security: its
 * plugin's servers and registered tools alone, whatever the type declares; the
 * person's settings.json and project servers may reach outside the app's folder.
 */
export function appRunMcpScope(templateType: string): SessionMcpScope {
  return { kind: 'plugin', plugin: pluginOfTemplateId(templateType) }
}
