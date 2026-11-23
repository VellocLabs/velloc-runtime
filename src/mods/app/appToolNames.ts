/**
 * The names of the tools the host adds to an app's session (F-40).
 * Security: a plugin's hooks are not raised for these (`tool.describe`,
 * `tool.check`, `tool.call`), so a plugin cannot rewrite, deny, approve or
 * answer them; a plugin's own tools are named `mcp__<plugin>__<name>` and
 * never bear one of these names.
 */

export const BUILD_APP_TOOL_NAME = 'BuildApp'

export const APP_ACTION_TOOL_NAME = 'AppAction'

const APP_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([BUILD_APP_TOOL_NAME, APP_ACTION_TOOL_NAME])

export function isAppBuiltinTool(name: string): boolean {
  return APP_BUILTIN_TOOL_NAMES.has(name)
}
