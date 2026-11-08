/**
 * `$.mcp` of an app's background module (F-40): a pool of the module's own,
 * holding the servers its plugin's manifest lists and nothing else. The pool
 * is built at the module's first `$.mcp` call and closed when the module
 * stops; `$.mcp.connect(key)` brings a manifest server up, `$.mcp.call`
 * reaches the servers the module connected.
 *
 * Security: no settings.json server, project server or other plugin's server
 * is ever in the pool, so none can be named. A server's config is resolved
 * from the plugin's manifest as a session resolves it, with the settings
 * (plugin options, provider keys) read at the connect.
 */

import type { ActivePlugin } from '../../pluginHost/pluginModel'
import { pluginMcpServer } from '../../pluginHost'
import type { PluginMcpScope } from '../../pluginHost/pluginMcpUserConfig'
import type { McpServerOriginSources, PluginMcpServerOwner } from '../../mcp/serverOrigin'
import { poolModMcp, type ModMcpHost, type ModMcpPool } from '../modMcp'

/** The plugin's manifest, as far as resolving one of its MCP servers needs it. */
export type AppBackgroundMcpOwner = Pick<
  ActivePlugin,
  'name' | 'path' | 'installIdentifier' | 'manifest' | 'providers' | 'mcpServers' | 'nativeMcpServers'
>

/** What the host needs of a pool of its own; `MCPPool` satisfies it. */
export type AppBackgroundMcpPool = ModMcpPool & {
  init(): Promise<void>
  shutdown(): Promise<void>
}

export type AppBackgroundMcpOptions = {
  owner: AppBackgroundMcpOwner
  /** The app's folder: the pool's `cwd`. */
  folder: string
  /** The settings a server's `${user_config.*}` and `${provider_key.*}` resolve with, read at each connect. */
  scope: () => Promise<Pick<PluginMcpScope, 'configs' | 'providers'>>
  getEnv?: (name: string) => string | undefined
  createPool: (options: { cwd: string }) => AppBackgroundMcpPool
  report: (line: string) => void
}

export type AppBackgroundMcp = {
  host: ModMcpHost
  /** Shuts the pool down; final. */
  close(): Promise<void>
}

/** `owner`, reduced to what resolving its MCP servers reads. */
export function appBackgroundMcpOwner(plugin: AppBackgroundMcpOwner): AppBackgroundMcpOwner {
  return {
    name: plugin.name,
    path: plugin.path,
    installIdentifier: plugin.installIdentifier,
    manifest: plugin.manifest,
    providers: plugin.providers,
    mcpServers: plugin.mcpServers,
    nativeMcpServers: plugin.nativeMcpServers,
  }
}

export function sameMcpOwner(a: AppBackgroundMcpOwner | undefined, b: AppBackgroundMcpOwner | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.name === b.name &&
    a.path === b.path &&
    a.installIdentifier === b.installIdentifier &&
    JSON.stringify(a.mcpServers ?? null) === JSON.stringify(b.mcpServers ?? null) &&
    JSON.stringify(a.nativeMcpServers ?? null) === JSON.stringify(b.nativeMcpServers ?? null)
  )
}

const named = (name: string, message: string): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

export function createAppBackgroundMcp(options: AppBackgroundMcpOptions): AppBackgroundMcp {
  const { owner } = options
  let pool: AppBackgroundMcpPool | null = null
  let opening: Promise<AppBackgroundMcpPool> | null = null
  let closed = false
  let scope: Pick<PluginMcpScope, 'configs' | 'providers'> = {}
  const origins: McpServerOriginSources = {
    settingsIds: new Set(),
    pluginServers: [
      ...Object.keys(owner.nativeMcpServers ?? {}).map((name): PluginMcpServerOwner => ({ name, plugin: owner.name, track: 'native' })),
      ...Object.keys(owner.mcpServers ?? {}).map((name): PluginMcpServerOwner => ({ name, plugin: owner.name, track: 'browser' })),
    ],
  }
  const ready = (): Promise<AppBackgroundMcpPool> => {
    if (closed) return Promise.reject(named('NotSupportedError', '$.mcp is not available: the background module is stopped'))
    if (pool) return Promise.resolve(pool)
    if (!opening) {
      const built = options.createPool({ cwd: options.folder })
      opening = built
        .init()
        .then(() => {
          pool = built
          return built
        })
        .catch(error => {
          opening = null
          void built.shutdown().catch(() => undefined)
          throw error
        })
    }
    return opening
  }
  const inner = poolModMcp({
    pool: () => pool,
    // Security: the calling plugin is the module's own, and the key is one of
    // its own manifest; any other pair is unlisted.
    manifestServer: (plugin, key) =>
      plugin === owner.name
        ? pluginMcpServer(owner, key, { getEnv: options.getEnv ?? (() => undefined), ...scope })
        : undefined,
    origins: () => origins,
  })
  return {
    host: {
      async call(input, callOptions) {
        await ready()
        return inner.call(input, callOptions)
      },
      async connect(plugin, key) {
        await ready()
        try {
          scope = await options.scope()
        } catch (error) {
          options.report(`${owner.name}: the plugin's settings could not be read for $.mcp.connect; options and keys unresolved (${error instanceof Error ? error.message : String(error)})`)
          scope = {}
        }
        return inner.connect(plugin, key)
      },
    },
    async close() {
      if (closed) return
      closed = true
      const live = pool ?? (opening ? await opening.catch(() => null) : null)
      pool = null
      opening = null
      if (live) await live.shutdown().catch(() => undefined)
    },
  }
}
