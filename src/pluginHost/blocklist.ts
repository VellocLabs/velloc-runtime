/**
 * Security: install-time plugin blocklist. Plugins ship executable hooks, MCP
 * server configs and slash commands, so a known-malicious plugin is refused at
 * install. An entry matches `<name>@<marketplace>` or the bare `<name>` (any
 * marketplace, including git-url installs). Empty by default.
 */

const DEFAULT_BLOCKED: ReadonlySet<string> = new Set<string>([
  // Intentionally empty. Add audited malicious `<name>@<marketplace>` (or bare
  // `<name>`) ids here, or load them from a signed overlay in a later phase.
])

let blocked: ReadonlySet<string> = DEFAULT_BLOCKED

/** Whether a plugin identifier (or its bare name) is on the blocklist. */
export function isPluginBlocked(identifier: string): boolean {
  if (blocked.has(identifier)) return true
  const bare = identifier.split('@')[0]
  return Boolean(bare) && bare !== identifier && blocked.has(bare)
}

/** Human-readable refusal text, or `null` when the plugin is not blocked. */
export function pluginBlockReason(identifier: string): string | null {
  if (!isPluginBlocked(identifier)) return null
  return (
    `Plugin "${identifier}" is on the security blocklist and was not installed. ` +
    `Plugins run executable hooks, MCP servers, and slash commands, so blocked ` +
    `plugins are refused. If this is a mistake, remove it from the blocklist in ` +
    `your build.`
  )
}

/** Test seam — override the blocklist; returns a restore function. */
export function __setPluginBlocklistForTests(
  ids: readonly string[],
): () => void {
  const prev = blocked
  blocked = new Set(ids)
  return () => {
    blocked = prev
  }
}
