/**
 * Security: a plugin's MCP servers resolved for launch, `${user_config.KEY}`
 * from its own options (settings.json `pluginConfigs`, settled against its
 * `userConfig` fields) (F-14). A `sensitive` option never enters a config as
 * plaintext: it is stored under the plugin's own `plugin:` names and the
 * config carries `{{secret:plugin:…}}`, which the host fills in only in a
 * stdio server's env value (stored `processEnv`) or in a header of a
 * host-driven http server (stored bound to its origin); anywhere else it
 * refuses the server. Neither a plugin's config nor an option's value (whose
 * default the manifest sets) may hold a host placeholder, and the resolved
 * config holds none but the ones written for the plugin's own options, so it
 * can name no secret but those.
 * Provider settings share those options and are settled under their existing
 * keys. `${provider_secret.KEY.NAME}` names a declared credential of an owned
 * provider; it reaches only stdio env or a native HTTPS header bound per server.
 * `${provider_key.KEY}` names the key stored for one of the plugin's own
 * providers (settings.json `providers.configs.<id>.apiKey`, sealed). It
 * stands only in a stdio server's env value and only when that entry's
 * `modOwner` is this plugin: the sealed value is copied to a process-only
 * secret under the plugin's names, so the host alone ever opens it (F-14).
 */

import type { BridgeSecretName } from '../browser/bridge/browserBridgeProtocol'
import { holdsHostPlaceholder } from '../browser/bridge/hostPlaceholders'
import { secretNameSegment, type McpSecretsStore } from '../mcp/mcpServerSecrets'
import type { NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import type { MCPServerConfig } from '../mcp/types'
import { settleOptions } from '../mods/optionValues'
import type { ActivePlugin, PluginUserConfigField } from './pluginModel'
import { resolveLocalizedText } from '../config/localizedText'
import { modProviderId } from '../mods/provider/providerManifest'
import {
  substituteNativePluginMcpVars,
  substitutePluginMcpString,
  substitutePluginMcpVars,
  type PluginMcpVarContext,
  type PluginMcpVarSite,
} from './substituteMcpVars'

/** settings.json `pluginConfigs`, by plugin id. */
export type PluginConfigsMap = Readonly<Record<string, { options?: Readonly<Record<string, unknown>> }>>

/** settings.json `providers.configs`, by provider id: the sealed key and the
 *  install identifier of the plugin that owns the entry. */
export type PluginProviderKeysMap = Readonly<Record<string, {
  apiKey?: string
  modOwner?: string
  /** Sealed named credentials; never exposed to mod scripts or UI clients. */
  secrets?: Readonly<Record<string, string>>
}>>

/** One value to store before the servers launch. */
export type PluginSecretWrite = {
  name: BridgeSecretName
  value: string
  /** Bound origin; absent for a process-only secret. */
  origin?: string
  processEnv?: true
}

export type PluginMcpServer =
  | { kind: 'browser'; config: MCPServerConfig }
  | { kind: 'native'; config: NexusMcpServerLaunchConfig }

export type ResolvedPluginMcpServer =
  | (PluginMcpServer & { ok: true; secrets: PluginSecretWrite[] })
  | { ok: false; reason: string }

export type PluginMcpScope = {
  getEnv: (name: string) => string | undefined
  /** settings.json `pluginConfigs`; absent: every option at its default. */
  configs?: PluginConfigsMap
  /** settings.json `providers.configs`; absent: no provider has a key. */
  providers?: PluginProviderKeysMap
}

/** The store caps a name at this many characters after the namespace. */
const SECRET_NAME_MAX = 128
const NAMESPACE = 'plugin:'
const USER_CONFIG_REF = /\$\{user_config\.([^}]+)\}/g

/** The plugin's id, as `pluginConfigs` is keyed (`modSlot.pluginConfigId`). */
function pluginIdOf(plugin: Pick<ActivePlugin, 'name' | 'installIdentifier'>): string {
  return plugin.installIdentifier ?? `${plugin.name}@inline`
}

/** The prefix of every secret this plugin's servers use. */
export function pluginSecretPrefix(pluginId: string): string {
  return `${NAMESPACE}${secretNameSegment(pluginId)}/`
}

function optionText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return Array.isArray(value) ? value.map(String).join(',') : String(value)
}

/** The origin a secret may be bound to: https only, since a plugin's
 *  host-driven server may not reach loopback or the LAN. */
function secretOriginOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

/** Whether every header and env value of `config` is text. */
function textValuesOnly(config: object): boolean {
  const maps = [(config as { headers?: unknown }).headers, (config as { env?: unknown }).env]
  return maps.every(map =>
    map === undefined || (typeof map === 'object' && map !== null && Object.values(map).every(value => typeof value === 'string')),
  )
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

function referencedKeys(values: readonly string[]): string[] {
  return values.flatMap(value => [...value.matchAll(USER_CONFIG_REF)].map(match => match[1]!))
}

/** Provider settings share pluginConfigs options with top-level userConfig.
 * Labels are presentation-only; incompatible value/security contracts refuse
 * the server rather than silently choosing a declaration's sensitivity. */
function mcpOptionFields(plugin: Pick<ActivePlugin, 'manifest' | 'providers'>): {
  fields: Record<string, PluginUserConfigField>
  conflicts: string[]
} {
  const fields: Record<string, PluginUserConfigField> = { ...plugin.manifest.userConfig }
  const conflicts: string[] = []
  const contract = (field: PluginUserConfigField) => JSON.stringify({
    type: field.type, sensitive: field.sensitive === true, required: field.required === true,
    multiple: field.multiple === true, default: field.default,
    min: field.min, max: field.max, options: field.options,
  })
  for (const provider of plugin.providers ?? []) {
    for (const [key, field] of Object.entries(provider.manifest.settings ?? {})) {
      const normalized: PluginUserConfigField = {
        ...field,
        title: resolveLocalizedText(field.title, 'en'),
        description: field.description === undefined ? '' : resolveLocalizedText(field.description, 'en'),
      }
      if (Object.hasOwn(fields, key) && contract(fields[key]!) !== contract(normalized)) {
        conflicts.push(`option "${key}" has conflicting declarations`)
      } else {
        Object.defineProperty(fields, key, { value: normalized, enumerable: true, configurable: true, writable: true })
      }
    }
  }
  return { fields, conflicts }
}

/**
 * Resolve one server of `plugin`'s manifest for launch. `secrets` lists what
 * must be stored before it starts; `ok: false` names why it cannot start.
 * Pure: nothing is stored here.
 */
export function resolvePluginMcpServer(
  plugin: Pick<ActivePlugin, 'name' | 'path' | 'installIdentifier' | 'manifest' | 'providers'>,
  serverName: string,
  server: PluginMcpServer,
  scope: PluginMcpScope,
): ResolvedPluginMcpServer {
  if (!textValuesOnly(server.config)) {
    return { ok: false, reason: 'a header or env value is not text' }
  }
  if (strings(server.config).some(holdsHostPlaceholder)) {
    return { ok: false, reason: 'holds a host placeholder ({{secret:…}} or {{oauth:…}}), which a plugin cannot use' }
  }
  const pluginId = pluginIdOf(plugin)
  const { fields, conflicts } = mcpOptionFields(plugin)
  if (conflicts.length > 0) return { ok: false, reason: conflicts.join('; ') }
  const values = settleOptions(fields, scope.configs?.[pluginId]?.options).values
  const isSensitive = (key: string) => Object.hasOwn(fields, key) && fields[key]!.sensitive === true

  // An http server whose headers take a sensitive option is driven by the
  // host, which alone can fill a stored secret into a request.
  let launch: PluginMcpServer = server
  const headerValues = Object.values(server.config.headers ?? {})
  if (server.kind === 'browser' && (referencedKeys(headerValues).some(isSensitive)
    || headerValues.some(value => value.includes('${provider_secret')))) {
    if (server.config.type !== 'http') {
      return { ok: false, reason: `a sensitive option can reach only a stdio or http server, not ${server.config.type}` }
    }
    launch = {
      kind: 'native',
      config: { transport: 'http', url: server.config.url, ...(server.config.headers ? { headers: server.config.headers } : {}) },
    }
  }

  const problems = new Set<string>()
  const secrets = new Map<string, PluginSecretWrite>()
  let headerOrigin: string | undefined
  const nameFor = (rest: string): BridgeSecretName | undefined => {
    const name = `${pluginSecretPrefix(pluginId)}${rest}`
    if (name.length - NAMESPACE.length > SECRET_NAME_MAX) {
      problems.add('the plugin and option names are too long to store a sensitive value')
      return undefined
    }
    return name as BridgeSecretName
  }
  const userConfig = (key: string, site: PluginMcpVarSite): string | undefined => {
    if (!Object.hasOwn(fields, key)) return undefined
    const text = optionText(values[key])
    // A value may come from the manifest's own `default`: plugin-controlled.
    if (holdsHostPlaceholder(text)) {
      problems.add(`option "${key}" holds a host placeholder ({{secret:…}} or {{oauth:…}}), which a plugin cannot use`)
      return undefined
    }
    if (!isSensitive(key) || text === '') return text
    if (site === 'env') {
      const name = nameFor(`env/${secretNameSegment(key)}`)
      if (!name) return undefined
      secrets.set(name, { name, value: text, processEnv: true })
      return `{{secret:${name}}}`
    }
    if (site === 'header' && launch.kind === 'native') {
      if (!headerOrigin) {
        problems.add(`sensitive option "${key}" needs an https server URL`)
        return undefined
      }
      const name = nameFor(`mcp/${secretNameSegment(serverName)}/${secretNameSegment(key)}`)
      if (!name) return undefined
      secrets.set(name, { name, value: text, origin: headerOrigin })
      return `{{secret:${name}}}`
    }
    problems.add(`sensitive option "${key}" can stand only in an env value or a header value`)
    return undefined
  }
  // Security: only a provider this plugin's own manifest declares (its id is
  // `mod.<this plugin>.<key>`), and only an entry recorded as this install's.
  const providerKey = (key: string, site: PluginMcpVarSite): string | undefined => {
    const provider = plugin.providers?.find(candidate => candidate.key === key)
    if (!provider) {
      problems.add(`\${provider_key.${key}} names no provider this plugin declares`)
      return undefined
    }
    if (site !== 'env') {
      problems.add(`\${provider_key.${key}} can stand only in a stdio server's env value`)
      return undefined
    }
    const stored = scope.providers && Object.hasOwn(scope.providers, provider.id) ? scope.providers[provider.id] : undefined
    const sealed = typeof stored?.apiKey === 'string' ? stored.apiKey : ''
    if (sealed === '') return ''
    if (stored?.modOwner !== pluginId) {
      problems.add(`the key stored for provider ${provider.id} is not recorded as this plugin's`)
      return undefined
    }
    const name = nameFor(`provider/${secretNameSegment(key)}`)
    if (!name) return undefined
    secrets.set(name, { name, value: sealed, processEnv: true })
    return `{{secret:${name}}}`
  }
  const providerSecret = (reference: string, site: PluginMcpVarSite): string | undefined => {
    // Provider keys cannot contain dots; secret names may (the manifest's charset).
    const parts = /^([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_.-]{1,64})$/.exec(reference)
    const provider = parts && plugin.providers?.find(candidate => candidate.key === parts[1]
      && candidate.id === modProviderId(plugin.name, candidate.key))
    const secret = parts?.[2]
    if (!provider || !secret || !provider.manifest.credentials?.secrets?.some(decl => decl.name === secret)) {
      problems.add('a provider_secret reference must name a declared secret of this plugin\'s own provider')
      return undefined
    }
    const stored = scope.providers && Object.hasOwn(scope.providers, provider.id) ? scope.providers[provider.id] : undefined
    if (stored?.modOwner !== pluginId) {
      problems.add(`the secrets stored for provider ${provider.id} are not recorded as this plugin's`)
      return undefined
    }
    const value = stored.secrets && Object.hasOwn(stored.secrets, secret) ? stored.secrets[secret] : undefined
    if (typeof value !== 'string' || value.trim() === '') {
      problems.add(`provider ${provider.id} has no stored secret "${secret}"`)
      return undefined
    }
    const suffix = `${secretNameSegment(provider.key)}/${secretNameSegment(secret)}`
    if (site === 'env' && launch.kind === 'native' && launch.config.transport === 'stdio') {
      const name = nameFor(`provider-secret/env/${suffix}`)
      if (!name) return undefined
      secrets.set(name, { name, value, processEnv: true })
      return `{{secret:${name}}}`
    }
    if (site === 'header' && launch.kind === 'native' && launch.config.transport === 'http' && headerOrigin) {
      // Each server has its own binding: another server cannot rebind this secret.
      const name = nameFor(`provider-secret/mcp/${secretNameSegment(serverName)}/${suffix}`)
      if (!name) return undefined
      secrets.set(name, { name, value, origin: headerOrigin })
      return `{{secret:${name}}}`
    }
    problems.add('a provider_secret can stand only in a stdio env value or a native https server header')
    return undefined
  }
  const ctx: PluginMcpVarContext = { pluginRoot: plugin.path, getEnv: scope.getEnv, userConfig, providerKey, providerSecret }

  // The resolved config may carry no host placeholder but the ones written
  // above for this plugin's own options, however the substituted pieces join.
  const foreignPlaceholder = (config: unknown): boolean => {
    const own = [...secrets.keys()].map(name => `{{secret:${name}}}`)
    return strings(config).some(value => holdsHostPlaceholder(own.reduce((rest, mark) => rest.split(mark).join(''), value)))
  }
  const settle = (resolved: PluginMcpServer): ResolvedPluginMcpServer => {
    // Fail closed for malformed, indirect, or otherwise unhandled references,
    // including references in map keys and unsupported config fields.
    if (JSON.stringify(resolved.config).includes('${provider_secret')) {
      problems.add('an unresolved or malformed provider_secret reference remains')
    }
    if (foreignPlaceholder(resolved.config)) {
      problems.add('resolves to a host placeholder ({{secret:…}} or {{oauth:…}}) the plugin does not own')
    }
    if (problems.size > 0) return { ok: false, reason: [...problems].join('; ') }
    return { ...resolved, ok: true, secrets: [...secrets.values()] }
  }

  if (launch.kind === 'native') {
    if (typeof launch.config.url === 'string') {
      headerOrigin = secretOriginOf(substitutePluginMcpString(launch.config.url, ctx))
    }
    return settle({ kind: 'native', config: substituteNativePluginMcpVars(launch.config, ctx) })
  }
  return settle({ kind: 'browser', config: substitutePluginMcpVars(launch.config, ctx) })
}

/**
 * Store `writes` (the values the resolved servers carry placeholders for) and,
 * when `prune` holds, delete the secrets of `pluginIds` that no server uses
 * any more. Pass `prune: false` when the options were not read from the
 * settings file: defaults would drop values live servers still use. A failure
 * is reported through `warn`; the server that needed the value then fails
 * to start, naming the missing secret.
 */
export async function storePluginSecrets(
  writes: readonly PluginSecretWrite[],
  pluginIds: readonly string[],
  store: Pick<McpSecretsStore, 'set' | 'delete' | 'listNames'>,
  warn: (message: string) => void,
  { prune = true }: { prune?: boolean } = {},
): Promise<void> {
  const wanted = new Set(writes.map(write => write.name))
  for (const write of writes) {
    try {
      await store.set(write.name, write.value, write.origin, write.processEnv ? { processEnv: true } : undefined)
    } catch (error) {
      warn(`[plugins] could not store ${write.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!prune || pluginIds.length === 0) return
  try {
    const prefixes = pluginIds.map(pluginSecretPrefix)
    for (const { name } of await store.listNames('plugin')) {
      if (!wanted.has(name as BridgeSecretName) && prefixes.some(prefix => name.startsWith(prefix))) {
        await store.delete(name as BridgeSecretName)
      }
    }
  } catch (error) {
    warn(`[plugins] could not prune plugin secrets: ${error instanceof Error ? error.message : String(error)}`)
  }
}
