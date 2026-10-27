/**
 * The MCP sources a session takes, decided once by its type (F-25).
 * Security: `plugin` confines the session to the plugin that owns its type —
 * its servers and `$.tool.register` tools alone; settings.json servers, the
 * project's server file and other plugins' servers may be local processes and
 * are left out. `none` (`noExecution`) takes nothing; `all` takes every source.
 * Pure filters, shared by the pool build, plugin reload and the engine's list.
 */

import { pluginOfTemplateId } from '../mods/ui/uiManifest'
import type { TemplateConfig } from '../prompting/templateParsing'
import { templateMcpScope } from '../prompting/templateRegistry'
import type { NexusMcpServerLaunchConfig } from './nativeBridge'
import type { PluginMcpServerOwner } from './serverOrigin'
import type { MCPServerConfigWithName } from './types'

export type SessionMcpScope =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'plugin'; plugin: string }

/** The scope of a session of `templateType`; a `plugin` scope names the owner. */
export function sessionMcpScopeOf(templateType: string, config: TemplateConfig | undefined): SessionMcpScope {
  const scope = templateMcpScope(config)
  if (scope === 'plugin') return { kind: 'plugin', plugin: pluginOfTemplateId(templateType) }
  return { kind: scope }
}

/** Whether a server or tool of `plugin` is in `scope`. */
export function pluginInMcpScope(scope: SessionMcpScope, plugin: string): boolean {
  switch (scope.kind) {
    case 'all':
      return true
    case 'none':
      return false
    case 'plugin':
      return scope.plugin === plugin
  }
}

/** The plugin each server name belongs to on `track`, from the owner list. */
function ownerOf(
  owners: readonly PluginMcpServerOwner[],
  name: string,
  track: PluginMcpServerOwner['track'],
): string | undefined {
  return owners.find(owner => owner.name === name && owner.track === track)?.plugin
}

/** The plugin browser-transport servers in `scope`; a server with no known owner is out of every scope but `all`. */
export function pluginMcpServersInScope(
  scope: SessionMcpScope,
  servers: readonly MCPServerConfigWithName[],
  owners: readonly PluginMcpServerOwner[],
): MCPServerConfigWithName[] {
  if (scope.kind === 'all') return [...servers]
  return servers.filter(server => {
    const owner = ownerOf(owners, server.name, 'browser')
    return owner !== undefined && pluginInMcpScope(scope, owner)
  })
}

/** The plugin native (stdio / host-driven) servers in `scope`; same owner rule. */
export function pluginNativeMcpServersInScope<T extends { id: string; config: NexusMcpServerLaunchConfig }>(
  scope: SessionMcpScope,
  servers: readonly T[],
  owners: readonly PluginMcpServerOwner[],
): T[] {
  if (scope.kind === 'all') return [...servers]
  return servers.filter(server => {
    const owner = ownerOf(owners, server.id, 'native')
    return owner !== undefined && pluginInMcpScope(scope, owner)
  })
}

/** The owner entries in `scope`, for origin lookups. */
export function pluginMcpOwnersInScope(
  scope: SessionMcpScope,
  owners: readonly PluginMcpServerOwner[],
): PluginMcpServerOwner[] {
  return owners.filter(owner => pluginInMcpScope(scope, owner.plugin))
}

/** The registered extension tools in `scope`; no scope given reads as `all`. */
export function modToolsInScope<T extends { readonly modPlugin: string }>(
  tools: readonly T[],
  scope: SessionMcpScope | undefined,
): T[] {
  if (!scope || scope.kind === 'all') return [...tools]
  return tools.filter(tool => pluginInMcpScope(scope, tool.modPlugin))
}
