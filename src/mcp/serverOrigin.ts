/**
 * Where a session's MCP server was configured, and the transport it runs
 * over, for the page's server list (F-10).
 */
import { launchTransportKind } from './nativeBridge'
import type { LiveServerLink } from './types'

/** A server a plugin's manifest contributes, and the pool track it runs on. */
export type PluginMcpServerOwner = {
  name: string
  plugin: string
  track: 'browser' | 'native'
}

export type McpServerOrigin =
  | { kind: 'settings' }
  | { kind: 'project' }
  | { kind: 'plugin'; plugin: string }

export type McpServerTransportKind = 'stdio' | 'http' | 'sse' | 'websocket'

/** What a runtime knows about where its pool's servers came from. */
export type McpServerOriginSources = {
  /** Ids settings.json `mcp.servers` names. */
  settingsIds: ReadonlySet<string>
  pluginServers: readonly PluginMcpServerOwner[]
  /** Names the project's `.nexus/mcp.json` holds in the pool. */
  projectNames?: ReadonlySet<string>
}

const settingsIdsByHome = new Map<string, Set<string>>()

/** The ids settings.json `mcp.servers` names under `homeDir`, as last read;
 *  one set per home for the whole realm. */
export function settingsMcpServerIds(homeDir: string): Set<string> {
  let ids = settingsIdsByHome.get(homeDir)
  if (!ids) {
    ids = new Set()
    settingsIdsByHome.set(homeDir, ids)
  }
  return ids
}

/**
 * The origin of one pool entry, following the pool's own precedence: on the
 * native track a settings.json server wins over a plugin's of the same name;
 * on the browser track the project file's wins, and a server that is not a
 * plugin's is the project file's.
 */
export function mcpServerOrigin(
  link: Pick<LiveServerLink, 'name' | 'nativeServerId'>,
  sources: McpServerOriginSources,
): McpServerOrigin {
  const native = link.nativeServerId !== undefined
  const id = link.nativeServerId ?? link.name
  if (native && sources.settingsIds.has(id)) return { kind: 'settings' }
  if (!native && sources.projectNames?.has(id)) return { kind: 'project' }
  const owner = sources.pluginServers.find(
    entry => entry.name === id && entry.track === (native ? 'native' : 'browser'),
  )
  if (owner) return { kind: 'plugin', plugin: owner.plugin }
  return native ? { kind: 'settings' } : { kind: 'project' }
}

/** The transport a pool entry runs over; undefined when its config names none. */
export function mcpServerTransport(
  link: Pick<LiveServerLink, 'config' | 'nativeConfig'>,
): McpServerTransportKind | undefined {
  if (link.nativeConfig) return launchTransportKind(link.nativeConfig) ?? undefined
  return link.config?.type
}
