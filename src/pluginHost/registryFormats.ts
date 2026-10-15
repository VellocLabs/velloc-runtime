// On-disk shapes of the marketplace catalog, the known-marketplaces list and
// the installed-plugins registry. Field names are the file format.

export type PluginOrigin =
  | { source: 'github'; repo: string; sha?: string; ref?: string }
  | { source: 'url'; url: string; sha?: string; ref?: string }
  | { source: 'git-subdir'; url: string; path: string; sha?: string; ref?: string }
  | { source: 'https'; url: string; sha256?: string }
  | { source: 'local'; path: string }
  | { source: 'directory'; path: string }
  | { source: 'inline'; plugins: CatalogListing[] }

type ContactInfo = { name?: string; email?: string; url?: string }

export type CatalogListing = {
  name: string
  description?: string
  source: PluginOrigin
  version?: string
  category?: string
  homepage?: string
  author?: ContactInfo
  /** `false`: the built-in seeder installs it disabled. A manual install
   *  ignores it. Absent = on. */
  onByDefault?: boolean
  /** `true`: listed and seeded only on the beta channel. Absent = every channel. */
  betaOnly?: boolean
}

/** Contents of a `marketplace.json`. */
export type MarketplaceCatalog = {
  name: string
  description?: string
  owner?: ContactInfo
  plugins: CatalogListing[]
}

export type CatalogRecord = {
  source: PluginOrigin
  installLocation: string
  /** ISO 8601 */
  lastUpdated: string
  autoUpdate?: boolean
}

/** `known_marketplaces.json`: a bare object keyed by marketplace name. */
export type KnownMarketplacesRegistry = Record<string, CatalogRecord>

export const INSTALLED_REGISTRY_FORMAT_VERSION = 2 as const

export type InstallScope = 'managed' | 'user' | 'project' | 'local'

/** `<name>@<marketplace>` */
export type PluginInstallKey = string

export type PluginSetupRecord = {
  scope: InstallScope
  /** Set for project and local scopes. */
  projectPath?: string
  installPath: string
  version?: string
  installedAt?: string
  lastUpdated?: string
  gitCommitSha?: string
  /** Where an `https` install came from: the archive URL and the digest of its bytes. */
  origin?: { source: 'https'; url: string; sha256?: string }
}

/** `installed_plugins.json`; one entry per scope a plugin is installed in. */
export type InstalledPluginsFile = {
  version: typeof INSTALLED_REGISTRY_FORMAT_VERSION
  plugins: Record<PluginInstallKey, PluginSetupRecord[]>
}

/** `default` means the file was missing or unreadable. */
export type RegistryReadResult<T> = { registry: T; source: 'file' | 'default' }
