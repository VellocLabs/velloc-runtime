// In-memory model of a plugin: its manifest, the loaded form, and load issues.

import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { MCPServerConfig } from '../mcp/types'
import type { HookTableByEvent } from '../lifecycleHooks/hookTypes'
import type { ProviderManifest, ResolvedProvider } from '../mods/provider/providerManifest'

export type PluginUserConfigField = {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description: string
  required?: boolean
  /** Not checked against `type`. */
  default?: string | number | boolean | string[]
  multiple?: boolean
  sensitive?: boolean
  min?: number
  max?: number
  options?: readonly string[]
}

type PathOrPaths = string | string[]

export type PluginDescriptor = {
  name: string
  version?: string
  description?: string
  author?: { name: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  commands?: PathOrPaths
  agents?: PathOrPaths
  skills?: PathOrPaths
  hooks?: PathOrPaths | HookTableByEvent
  mcpServers?: PathOrPaths | Record<string, MCPServerConfig | NexusMcpServerLaunchConfig>
  userConfig?: Record<string, PluginUserConfigField>
  /** Provider mods: model providers this plugin adds, by provider key
   *  (`mods/provider/providerManifest.ts`). */
  providers?: Record<string, ProviderManifest>
}

export type ActivePlugin = {
  name: string
  manifest: PluginDescriptor
  /** Absolute plugin directory. */
  path: string
  /** `user:<root>`, `project:<root>` or `marketplace:<id>`. */
  source: string
  enabled?: boolean
  commandFolder?: string
  commandFolders?: string[]
  agentsPath?: string
  agentsPaths?: string[]
  skillsPath?: string
  skillsPaths?: string[]
  hooksConfig?: HookTableByEvent
  /** Absolute hook module paths; absent when there are none. */
  hookModules?: string[]
  /** The plugin's provider mods, ids and module paths resolved; absent when
   *  there are none. A provider's module is a different kind from a hooks
   *  module — which it is, is decided by where the manifest lists it. */
  providers?: ResolvedProvider[]
  mcpServers?: Record<string, MCPServerConfig>
  nativeMcpServers?: Record<string, NexusMcpServerLaunchConfig>
  /** `<name>@<marketplace>` for marketplace installs; turns on the settings enable check. */
  installIdentifier?: string
}

export type ComponentKind = 'commands' | 'agents' | 'skills' | 'hooks' | 'providers'

export type PluginLoadIssue = { source: string } & (
  | { type: 'path-not-found'; plugin?: string; path: string; component: ComponentKind }
  | { type: 'manifest-parse-error'; plugin?: string; manifestPath: string; parseError: string }
  | {
      type: 'manifest-validation-error'
      plugin?: string
      manifestPath: string
      validationErrors: string[]
    }
  | { type: 'mcp-config-invalid'; plugin: string; serverName: string; validationError: string }
  | {
      type: 'mcp-server-suppressed-duplicate'
      plugin: string
      serverName: string
      duplicateOf: string
    }
  | { type: 'hook-load-failed'; plugin: string; hookPath: string; reason: string }
  | {
      type: 'component-load-failed'
      plugin: string
      component: ComponentKind
      path: string
      reason: string
    }
  | { type: 'generic-error'; plugin?: string; error: string }
)

export type PluginScan = {
  enabled: ActivePlugin[]
  disabled: ActivePlugin[]
  errors: PluginLoadIssue[]
}

function duplicateOwner(duplicateOf: string): string {
  if (!duplicateOf.startsWith('plugin:')) return `already-configured "${duplicateOf}"`
  const owner = duplicateOf.split(':')[1] || '?'
  return `server provided by plugin "${owner}"`
}

/** One-line text for a load issue, as shown to the user. */
export function describePluginError(issue: PluginLoadIssue): string {
  switch (issue.type) {
    case 'generic-error':
      return issue.error
    case 'path-not-found':
      return `Path not found: ${issue.path} (${issue.component})`
    case 'manifest-parse-error':
      return `Manifest parse error: ${issue.parseError}`
    case 'manifest-validation-error':
      return `Manifest validation failed: ${issue.validationErrors.join(', ')}`
    case 'mcp-config-invalid':
      return `MCP server ${issue.serverName} invalid: ${issue.validationError}`
    case 'mcp-server-suppressed-duplicate':
      return `MCP server "${issue.serverName}" skipped — same name as ${duplicateOwner(issue.duplicateOf)}`
    case 'hook-load-failed':
      return `Hook load failed: ${issue.reason}`
    case 'component-load-failed':
      return `${issue.component} load failed from ${issue.path}: ${issue.reason}`
  }
}
