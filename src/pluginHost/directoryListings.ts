/**
 * Plugins installed straight from the plugin directory (F-35): no
 * marketplace lists them, so the listing each was installed from is kept
 * here, under the catalog key `plugin-directory`, with the directory record
 * it came from. `~/.velloc/plugins/directory_plugins.json`.
 */
import { joinPath } from '../memory/memoryPaths'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { pluginsRoot, type PluginInstallPathContext } from './pluginDirs'
import type { CatalogListing } from './registryFormats'

/** The catalog key of directory installs: `<name>@plugin-directory`. Never a marketplace name. */
export const DIRECTORY_CATALOG_KEY = 'plugin-directory'

export const DIRECTORY_PLUGINS_FILE_NAME = 'directory_plugins.json'

/** One directory install: the listing it installs from, and how to find its record again. */
export type DirectoryPluginEntry = {
  listing: CatalogListing
  /** The record's `manifest_name`. */
  manifestName: string
  /** The origin of the directory's listing API the record came from. */
  apiOrigin: string
}

type DirectoryPluginsFile = { version: 1; plugins: Record<string, DirectoryPluginEntry> }

const filePath = (ctx: PluginInstallPathContext) => joinPath(pluginsRoot(ctx), DIRECTORY_PLUGINS_FILE_NAME)

function isEntry(value: unknown): value is DirectoryPluginEntry {
  const v = value as Partial<DirectoryPluginEntry> | null
  return !!v && typeof v === 'object'
    && typeof v.manifestName === 'string' && typeof v.apiOrigin === 'string'
    && !!v.listing && typeof v.listing === 'object' && typeof v.listing.name === 'string'
    && !!v.listing.source && (v.listing.source.source === 'github' || v.listing.source.source === 'git-subdir')
}

export async function loadDirectoryPlugins(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
): Promise<Record<string, DirectoryPluginEntry>> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(filePath(ctx), { encoding: 'utf-8' }))
  } catch {
    return {}
  }
  const plugins = (raw as { plugins?: unknown } | null)?.plugins
  const out: Record<string, DirectoryPluginEntry> = {}
  if (plugins && typeof plugins === 'object') {
    for (const [name, entry] of Object.entries(plugins)) if (isEntry(entry)) out[name] = entry
  }
  return out
}

/** Applies `change` to the stored entries and writes them back. */
export async function updateDirectoryPlugins(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  change: (plugins: Record<string, DirectoryPluginEntry>) => void,
): Promise<void> {
  const plugins = await loadDirectoryPlugins(ctx, fs)
  change(plugins)
  const file: DirectoryPluginsFile = { version: 1, plugins }
  try {
    await fs.mkdir(pluginsRoot(ctx))
  } catch {
    // already there
  }
  await fs.writeFile(filePath(ctx), `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf-8' })
}

/** The listing `name` was installed from the directory with; null when it was not. */
export async function readDirectoryListing(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  name: string,
): Promise<CatalogListing | null> {
  return (await loadDirectoryPlugins(ctx, fs))[name]?.listing ?? null
}
