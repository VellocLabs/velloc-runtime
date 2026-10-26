// Reads and writes installed_plugins.json, cached per home directory.

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  registryFilePath,
  pluginsRoot,
  type PluginInstallPathContext,
} from './pluginDirs'
import {
  INSTALLED_REGISTRY_FORMAT_VERSION,
  type InstalledPluginsFile,
  type PluginInstallKey,
  type PluginSetupRecord,
  type InstallScope,
  type RegistryReadResult,
} from './registryFormats'

const registryFileMemo = new Map<string, InstalledPluginsFile>()

export function forgetRegistryFile(homeDir?: string): void {
  if (homeDir === undefined) {
    registryFileMemo.clear()
  } else {
    registryFileMemo.delete(homeDir)
  }
}

/** Turns a version-1 file (one record per plugin) into the per-scope list form. */
export function upgradeRegistryShape(
  v1Data: {
    version: 1
    plugins: Record<string, {
      version: string
      installedAt: string
      lastUpdated?: string
      installPath: string
      gitCommitSha?: string
    }>
  },
): InstalledPluginsFile {
  const v2Plugins: Record<string, PluginSetupRecord[]> = {}
  for (const [pluginId, plugin] of Object.entries(v1Data.plugins)) {
    v2Plugins[pluginId] = [
      {
        scope: 'user',
        installPath: plugin.installPath,
        version: plugin.version,
        installedAt: plugin.installedAt,
        lastUpdated: plugin.lastUpdated,
        gitCommitSha: plugin.gitCommitSha,
      },
    ]
  }
  return { version: INSTALLED_REGISTRY_FORMAT_VERSION, plugins: v2Plugins }
}

function defaultRegistry(): InstalledPluginsFile {
  return { version: INSTALLED_REGISTRY_FORMAT_VERSION, plugins: {} }
}

function isMissingFileError(e: unknown): boolean {
  if (!e) return false
  const message = e instanceof Error ? e.message : String(e)
  return /ENOENT|not found|no such file/i.test(message)
}

const VALID_SCOPES: ReadonlySet<InstallScope> = new Set([
  'managed', 'user', 'project', 'local',
])

function normalizeEntry(raw: unknown): PluginSetupRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<PluginSetupRecord> & {
    sha?: unknown
  }
  const scope: InstallScope = VALID_SCOPES.has(r.scope as InstallScope)
    ? (r.scope as InstallScope)
    : 'user'
  if (typeof r.installPath !== 'string' || !r.installPath) return null

  const toIso = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value).toISOString()
    }
    return undefined
  }

  const entry: PluginSetupRecord = {
    scope,
    installPath: r.installPath,
  }
  if (typeof r.projectPath === 'string' && r.projectPath) {
    entry.projectPath = r.projectPath
  }
  if (typeof r.version === 'string' && r.version) {
    entry.version = r.version
  }
  const installedAt = toIso(r.installedAt)
  if (installedAt) entry.installedAt = installedAt
  const lastUpdated = toIso(r.lastUpdated)
  if (lastUpdated) entry.lastUpdated = lastUpdated
  if (typeof r.gitCommitSha === 'string' && r.gitCommitSha) {
    entry.gitCommitSha = r.gitCommitSha
  } else if (typeof r.sha === 'string' && r.sha) {
    entry.gitCommitSha = r.sha
  }
  const origin = (raw as { origin?: unknown }).origin
  if (origin && typeof origin === 'object') {
    const o = origin as { source?: unknown; url?: unknown; sha256?: unknown }
    if (o.source === 'https' && typeof o.url === 'string' && o.url) {
      entry.origin = {
        source: 'https',
        url: o.url,
        ...(typeof o.sha256 === 'string' && o.sha256 ? { sha256: o.sha256 } : {}),
      }
    }
  }
  const code = (raw as { codeSource?: unknown }).codeSource
  if (code && typeof code === 'object') {
    const c = code as { repo?: unknown; path?: unknown; sha?: unknown }
    if (typeof c.repo === 'string' && c.repo && typeof c.path === 'string') {
      entry.codeSource = {
        repo: c.repo,
        path: c.path,
        ...(typeof c.sha === 'string' && c.sha ? { sha: c.sha } : {}),
      }
    }
  }
  return entry
}

function normalizeRegistry(raw: unknown): InstalledPluginsFile {
  const plugins: Record<string, PluginSetupRecord[]> = {}
  if (!raw || typeof raw !== 'object') return defaultRegistry()
  const rawObj = raw as Record<string, unknown>
  const rawPlugins = rawObj.plugins
  if (rawPlugins && typeof rawPlugins === 'object') {
    for (const [key, value] of Object.entries(rawPlugins as Record<string, unknown>)) {
      if (!key) continue
      const arrayCandidate = Array.isArray(value) ? value : [value]
      const entries: PluginSetupRecord[] = []
      for (const item of arrayCandidate) {
        const entry = normalizeEntry(item)
        if (entry) entries.push(entry)
      }
      if (entries.length > 0) plugins[key] = entries
    }
  }
  return { version: INSTALLED_REGISTRY_FORMAT_VERSION, plugins }
}

async function readInstalledPlugins(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  throwOnCorrupt: boolean,
): Promise<RegistryReadResult<InstalledPluginsFile>> {
  const cached = registryFileMemo.get(ctx.homeDir)
  if (cached !== undefined) {
    return { registry: cached, source: 'file' }
  }

  const path = registryFilePath(ctx)
  let raw: string
  try {
    raw = await fs.readFile(path, { encoding: 'utf-8' })
  } catch (e) {
    if (isMissingFileError(e)) {
      return { registry: defaultRegistry(), source: 'default' }
    }
    const message = e instanceof Error ? e.message : String(e)
    if (throwOnCorrupt) {
      throw new Error(
        `installed_plugins.json is unreadable (${message}); refusing to overwrite it. Fix or delete the file manually.`,
      )
    }
    console.warn(
      `[installedPluginsManager] failed to read ${path}: ${message}; using defaults`,
    )
    return { registry: defaultRegistry(), source: 'default' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (throwOnCorrupt) {
      throw new Error(
        `installed_plugins.json contains malformed JSON (${message}); refusing to overwrite it. Fix or delete the file manually.`,
      )
    }
    console.warn(
      `[installedPluginsManager] malformed JSON in ${path}: ${message}; using defaults (file NOT overwritten — fix or delete manually)`,
    )
    return { registry: defaultRegistry(), source: 'default' }
  }

  const registry = normalizeRegistry(parsed)
  registryFileMemo.set(ctx.homeDir, registry)
  return { registry, source: 'file' }
}

/** Missing or unreadable files yield an empty registry with source `default`. */
export async function loadInstalledPlugins(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
): Promise<RegistryReadResult<InstalledPluginsFile>> {
  return readInstalledPlugins(ctx, fs, false)
}

async function loadInstalledPluginsForMutation(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
): Promise<RegistryReadResult<InstalledPluginsFile>> {
  return readInstalledPlugins(ctx, fs, true)
}

export async function saveInstalledPlugins(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  registry: InstalledPluginsFile,
): Promise<void> {
  const dirPath = pluginsRoot(ctx)
  try {
    await fs.mkdir(dirPath)
  } catch {
    // already there
  }
  const path = registryFilePath(ctx)
  const body = `${JSON.stringify(registry, null, 2)}\n`
  await fs.writeFile(path, body, { encoding: 'utf-8' })
  registryFileMemo.set(ctx.homeDir, registry)
}

/** Adds or replaces the record for this plugin and scope. */
export async function recordPluginSetup(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  pluginId: PluginInstallKey,
  entry: PluginSetupRecord,
): Promise<InstalledPluginsFile> {
  const { registry } = await loadInstalledPluginsForMutation(ctx, fs)
  const existing = registry.plugins[pluginId] ?? []
  const filtered = existing.filter(e => !(e.scope === entry.scope && e.projectPath === entry.projectPath))
  const next: InstalledPluginsFile = {
    version: INSTALLED_REGISTRY_FORMAT_VERSION,
    plugins: {
      ...registry.plugins,
      [pluginId]: [...filtered, entry],
    },
  }
  await saveInstalledPlugins(ctx, fs, next)
  return next
}

export const recordInstalledPlugin = recordPluginSetup

export async function dropPluginRecord(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  pluginId: PluginInstallKey,
): Promise<InstalledPluginsFile> {
  const { registry } = await loadInstalledPluginsForMutation(ctx, fs)
  if (!(pluginId in registry.plugins)) return registry
  const nextPlugins = { ...registry.plugins }
  delete nextPlugins[pluginId]
  const next: InstalledPluginsFile = {
    version: INSTALLED_REGISTRY_FORMAT_VERSION,
    plugins: nextPlugins,
  }
  await saveInstalledPlugins(ctx, fs, next)
  return next
}

export async function getInstalledPlugin(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  pluginId: PluginInstallKey,
): Promise<PluginSetupRecord | undefined> {
  const { registry } = await loadInstalledPlugins(ctx, fs)
  const entries = registry.plugins[pluginId]
  return entries?.[0]
}

export async function listInstalledPluginEntries(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  pluginId: PluginInstallKey,
): Promise<PluginSetupRecord[]> {
  const { registry } = await loadInstalledPlugins(ctx, fs)
  return [...(registry.plugins[pluginId] ?? [])]
}
