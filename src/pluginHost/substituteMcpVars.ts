/**
 * Pure `${...}` substitution for plugin MCP server configs:
 * `${CLAUDE_PLUGIN_ROOT}` and `${NAME}` / `${NAME:-default}` (runtimeConfig env).
 * Unknown placeholders stay literal.
 */

import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { MCPServerConfig } from '../mcp/types'

export type PluginMcpVarContext = {
  /** ${CLAUDE_PLUGIN_ROOT} → the plugin's directory (ActivePlugin.path). */
  pluginRoot: string
  /** General env lookup for ${NAME} / ${NAME:-default}. */
  getEnv: (name: string) => string | undefined
}

/**
 *  this for plugin.path on win32 so substituted URLs stay valid). Virtual
 *  browser paths are already posix-like, so this is a no-op for them. */
function normalizePath(p: string): string {
  return p.includes('\\') ? p.replace(/\\/g, '/') : p
}

/**
 * Substitute `${...}` placeholders in one string in a single pass; unknown vars
 * (no env, no default) are returned literally.
 */
export function substitutePluginMcpString(
  value: string,
  ctx: PluginMcpVarContext,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varContent: string) => {
    if (varContent === 'CLAUDE_PLUGIN_ROOT') {
      return normalizePath(ctx.pluginRoot)
    }

    // `varContent.split(':-', 2)`, read from process env (here: getEnv).
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = ctx.getEnv(varName!)
    if (envValue !== undefined) return envValue
    if (defaultValue !== undefined) return defaultValue

    return match
  })
}

/**
 * Return a copy of an MCP server config with ${...} vars resolved in `url`
 * and every `headers` value. The input is never mutated.
 */
export function substitutePluginMcpVars(
  config: MCPServerConfig,
  ctx: PluginMcpVarContext,
): MCPServerConfig {
  const url = substitutePluginMcpString(config.url, ctx)
  let headers: Record<string, string> | undefined
  if (config.headers) {
    headers = {}
    for (const [key, value] of Object.entries(config.headers)) {
      headers[key] = substitutePluginMcpString(value, ctx)
    }
  }
  return headers ? { ...config, url, headers } : { ...config, url }
}

export function substituteNativePluginMcpVars(
  config: NexusMcpServerLaunchConfig,
  ctx: PluginMcpVarContext,
): NexusMcpServerLaunchConfig {
  const out: NexusMcpServerLaunchConfig = { ...config }
  if (typeof out.command === 'string') {
    out.command = substitutePluginMcpString(out.command, ctx)
  }
  if (out.args) {
    out.args = out.args.map(arg => substitutePluginMcpString(arg, ctx))
  }
  if (out.env) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(out.env)) {
      env[key] = substitutePluginMcpString(value, ctx)
    }
    out.env = env
  }
  if (typeof out.url === 'string') {
    out.url = substitutePluginMcpString(out.url, ctx)
  }
  if (out.headers) {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(out.headers)) {
      headers[key] = substitutePluginMcpString(value, ctx)
    }
    out.headers = headers
  }
  if (typeof out.cwd === 'string') {
    out.cwd = substitutePluginMcpString(out.cwd, ctx)
  }
  return out
}
