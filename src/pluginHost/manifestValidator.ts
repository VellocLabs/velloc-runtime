// Checks a parsed `plugin.json`. A bad name rejects the whole manifest; any
// other bad field is dropped with an error and the rest is kept.

import {
  isStdioMCPServerConfig,
  parseMCPServerConfig,
  parseNativeMCPServerConfig,
} from '../mcp/config'
import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { MCPServerConfig } from '../mcp/types'
import { parseHooksSettings } from '../lifecycleHooks/hookTypes'
import { checkProviderManifests } from '../mods/provider/providerManifest'
import { checkTemplateDecls, checkUiDecl } from '../mods/ui/uiManifest'
import { checkRequires } from './pluginRequirements'
import type { PluginDescriptor } from './pluginModel'
import { readUserConfigFields } from './userConfigFields'

export type ManifestCheck = { manifest: PluginDescriptor | null; errors: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const insidePlugin = (p: string): boolean => p.startsWith('./') && !p.includes('..')

/** Validates a path field; returns the kept value or undefined. */
function pathField(
  field: string,
  value: unknown,
  errors: string[],
  suffix?: string,
): string | string[] | undefined {
  const accept = (entry: unknown): entry is string => {
    if (typeof entry !== 'string' || !insidePlugin(entry)) {
      const shown = typeof entry === 'string' ? `"${entry}"` : String(entry)
      errors.push(`${field}: ${shown} must be a relative path starting with "./" and without ".."`)
      return false
    }
    if (suffix && !entry.toLowerCase().endsWith(suffix)) {
      errors.push(`${field}: "${entry}" must end with ${suffix}`)
      return false
    }
    return true
  }
  if (typeof value === 'string') return accept(value) ? value : undefined
  if (Array.isArray(value)) {
    const kept = value.filter(accept)
    return kept.length > 0 ? kept : undefined
  }
  errors.push(`${field}: expected a path string or an array of path strings`)
  return undefined
}

function commandSources(map: Record<string, unknown>, errors: string[]): string[] | undefined {
  const sources: string[] = []
  for (const [name, entry] of Object.entries(map)) {
    if (!isRecord(entry)) {
      errors.push(`commands.${name}: expected an object with a "source"`)
    } else if (typeof entry.source === 'string' && insidePlugin(entry.source)) {
      sources.push(entry.source)
    } else if ('content' in entry) {
      errors.push(`commands.${name}: inline "content" commands are not supported yet — use "source"`)
    } else {
      errors.push(`commands.${name}: "source" must be a relative path`)
    }
  }
  return sources.length > 0 ? sources : undefined
}

function inlineServers(
  map: Record<string, unknown>,
  errors: string[],
): Record<string, MCPServerConfig | NexusMcpServerLaunchConfig> | undefined {
  const servers: Record<string, MCPServerConfig | NexusMcpServerLaunchConfig> = {}
  for (const [name, raw] of Object.entries(map)) {
    const config = isStdioMCPServerConfig(raw)
      ? parseNativeMCPServerConfig(name, raw)
      : parseMCPServerConfig(name, raw) ?? parseNativeMCPServerConfig(name, raw)
    if (config) servers[name] = config
    else errors.push(`mcpServers.${name}: invalid or unsupported server config`)
  }
  return Object.keys(servers).length > 0 ? servers : undefined
}

const TEXT_KEYS = ['version', 'description', 'homepage', 'repository', 'license'] as const

export function checkPluginDescriptor(value: unknown): ManifestCheck {
  if (!isRecord(value)) return { manifest: null, errors: ['Manifest must be a JSON object'] }
  const { name } = value
  if (typeof name !== 'string' || name === '') {
    return { manifest: null, errors: ['name: required and must be a non-empty string'] }
  }
  if (name.includes(' ')) {
    return {
      manifest: null,
      errors: ['name: cannot contain spaces — use kebab-case (e.g., "my-plugin")'],
    }
  }

  const errors: string[] = []
  const manifest: PluginDescriptor = { name }
  const set = <K extends keyof PluginDescriptor>(key: K, v: PluginDescriptor[K] | undefined) => {
    if (v !== undefined) manifest[key] = v
  }

  for (const key of TEXT_KEYS) {
    if (value[key] === undefined) continue
    if (typeof value[key] === 'string') manifest[key] = value[key] as string
    else errors.push(`${key}: expected a string`)
  }

  const author = value.author
  if (author !== undefined) {
    if (!isRecord(author)) {
      errors.push('author: expected an object with a "name"')
    } else if (typeof author.name !== 'string' || author.name === '') {
      errors.push('author.name: required and must be a non-empty string')
    } else {
      manifest.author = { name: author.name }
      if (typeof author.email === 'string') manifest.author.email = author.email
      if (typeof author.url === 'string') manifest.author.url = author.url
    }
  }

  const keywords = value.keywords
  if (keywords !== undefined) {
    if (!Array.isArray(keywords)) errors.push('keywords: expected an array of strings')
    else {
      const words = keywords.filter((k): k is string => typeof k === 'string')
      if (words.length > 0) manifest.keywords = words
    }
  }

  if (value.commands !== undefined) {
    set(
      'commands',
      isRecord(value.commands)
        ? commandSources(value.commands, errors)
        : pathField('commands', value.commands, errors),
    )
  }
  if (value.agents !== undefined) set('agents', pathField('agents', value.agents, errors, '.md'))
  if (value.skills !== undefined) set('skills', pathField('skills', value.skills, errors))

  if (value.hooks !== undefined) {
    if (isRecord(value.hooks)) {
      const hooks = parseHooksSettings(value.hooks)
      if (hooks && Object.keys(hooks).length > 0) manifest.hooks = hooks
      else errors.push('hooks: inline hooks object contained no valid entries')
    } else {
      set('hooks', pathField('hooks', value.hooks, errors, '.json'))
    }
  }

  if (value.mcpServers !== undefined) {
    set(
      'mcpServers',
      isRecord(value.mcpServers)
        ? inlineServers(value.mcpServers, errors)
        : pathField('mcpServers', value.mcpServers, errors, '.json'),
    )
  }

  if (value.userConfig !== undefined) {
    if (isRecord(value.userConfig)) {
      manifest.userConfig = readUserConfigFields(value.userConfig, errors)
    } else {
      errors.push('userConfig: expected an object of fields')
    }
  }

  if (value.providers !== undefined) {
    set('providers', checkProviderManifests(name, value.providers, errors))
  }
  if (value.templates !== undefined) set('templates', checkTemplateDecls(name, value.templates, errors))
  if (value.ui !== undefined) set('ui', checkUiDecl(name, value.ui, errors))
  if (value.requires !== undefined) {
    set('requires', checkRequires(value.requires, Object.keys(manifest.providers ?? {}), errors))
  }

  return { manifest, errors }
}
