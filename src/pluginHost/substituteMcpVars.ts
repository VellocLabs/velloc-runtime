/**
 * Pure `${...}` substitution for plugin MCP server configs: the plugin root,
 * `${user_config.KEY}` (the plugin's own options), `${provider_key.KEY}`
 * (the key stored for the plugin's own provider `KEY`),
 * `${provider_secret.KEY.NAME}` (a declared named credential) and `${NAME}` /
 * `${NAME:-default}` (runtimeConfig env).
 * Unknown placeholders stay literal.
 */

import { holdsHostPlaceholder } from '../browser/bridge/hostPlaceholders'
import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { MCPServerConfig } from '../mcp/types'

/** Where a value stands: a stdio server's env value, a header value, or any
 *  other text (command, args, url, cwd). */
export type PluginMcpVarSite = 'env' | 'header' | 'text'

export type PluginMcpVarContext = {
  /** ${CLAUDE_PLUGIN_ROOT} → the plugin's directory (ActivePlugin.path). */
  pluginRoot: string
  /** General env lookup for ${NAME} / ${NAME:-default}. */
  getEnv: (name: string) => string | undefined
  /** ${user_config.KEY} → the text standing for the plugin's option `KEY`
   *  at `site`; undefined leaves the placeholder literal. Absent: every
   *  `${user_config.*}` stays literal. */
  userConfig?: (key: string, site: PluginMcpVarSite) => string | undefined
  /** ${provider_key.KEY} → the text standing for the key stored for the
   *  plugin's provider `KEY` at `site`; undefined leaves the placeholder
   *  literal. Absent: every `${provider_key.*}` stays literal. */
  providerKey?: (key: string, site: PluginMcpVarSite) => string | undefined
  /** ${provider_secret.PROVIDER.NAME}; runtime-only, never a general env lookup. */
  providerSecret?: (reference: string, site: PluginMcpVarSite) => string | undefined
}

const USER_CONFIG_PREFIX = 'user_config.'
const PROVIDER_KEY_PREFIX = 'provider_key.'
const PROVIDER_SECRET_PREFIX = 'provider_secret.'

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
  site: PluginMcpVarSite = 'text',
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varContent: string) => {
    if (varContent === 'CLAUDE_PLUGIN_ROOT') {
      return normalizePath(ctx.pluginRoot)
    }
    if (varContent.startsWith(USER_CONFIG_PREFIX)) {
      return ctx.userConfig?.(varContent.slice(USER_CONFIG_PREFIX.length), site) ?? match
    }
    if (varContent.startsWith(PROVIDER_KEY_PREFIX)) {
      return ctx.providerKey?.(varContent.slice(PROVIDER_KEY_PREFIX.length), site) ?? match
    }

    if (varContent.startsWith(PROVIDER_SECRET_PREFIX)) {
      return ctx.providerSecret?.(varContent.slice(PROVIDER_SECRET_PREFIX.length), site) ?? match
    }
    // Reserve the namespace even for malformed references; never read it as env.
    if (varContent === 'provider_secret') return match

    // `varContent.split(':-', 2)`, read from process env (here: getEnv).
    // Security: an env value holding a host placeholder is not taken, so
    // the environment cannot name a stored secret for the plugin.
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = ctx.getEnv(varName!)
    if (envValue !== undefined && !holdsHostPlaceholder(envValue)) return envValue
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
      headers[key] = substitutePluginMcpString(value, ctx, 'header')
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
      env[key] = substitutePluginMcpString(value, ctx, 'env')
    }
    out.env = env
  }
  if (typeof out.url === 'string') {
    out.url = substitutePluginMcpString(out.url, ctx)
  }
  if (out.headers) {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(out.headers)) {
      headers[key] = substitutePluginMcpString(value, ctx, 'header')
    }
    out.headers = headers
  }
  if (typeof out.cwd === 'string') {
    out.cwd = substitutePluginMcpString(out.cwd, ctx)
  }
  return out
}
