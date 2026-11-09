/**
 * The tools an app's agent run keeps (F-40). Security: an allowlist, so a tool
 * added later stays out until named here: the run reads and writes files,
 * tracks its work, loads skills and calls MCP servers; it starts no shell, no
 * sub-agent, no session or teammate, no routine, and asks nobody anything.
 */

import { TOOL_GROUPS } from '../../toolkit/builtin/toolGroups'

const KEPT: ReadonlySet<string> = new Set<string>([
  ...TOOL_GROUPS.read,
  ...TOOL_GROUPS.edit,
  ...TOOL_GROUPS.todo,
  ...TOOL_GROUPS.skills,
  ...TOOL_GROUPS.webfetch,
  ...TOOL_GROUPS.superedit,
])

const MCP_TOOL_PREFIX = 'mcp__'

/** Whether an app's agent run keeps the tool named `name`. */
export function appRunKeepsTool(name: string): boolean {
  return KEPT.has(name) || name.startsWith(MCP_TOOL_PREFIX)
}

/** The tools of `tools` an app's agent run keeps. */
export function appRunTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(tool => appRunKeepsTool(tool.name))
}
