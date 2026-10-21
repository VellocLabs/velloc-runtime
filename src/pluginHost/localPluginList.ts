/**
 * The directory plugins on disk, root by root (user root, then each sidebar
 * project's), for Settings → Plugins & Mods, read with each root's
 * `enabled-plugins.json` so a disabled plugin keeps its row. Same walk and
 * enabled rule as the loader.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { joinRuntimePath, normalizeRuntimePath } from '../utils/runtimePaths'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import {
  loadDisabledPlugins,
  loadEnabledPlugins,
  loadUserDisabledPlugins,
  loadUserEnabledPlugins,
} from './enabledStore'
import { PIPELINE_DIRS } from './localPluginRemove'
import { describeInstalledPlugin } from './loadPlugins'
import { PLUGIN_DESCRIPTION_KEY, readPluginLocaleText } from './pluginLocaleText'
import { getPluginManifestPath, getProjectPluginsRoot } from './pluginPaths'

export type LocalPluginUiEntry = {
  /** The folder's name — what `enabled-plugins.json` lists. */
  folder: string
  /** The folder, absolute: what `plugins/setLocalEnabled` and
   *  `plugins/removeLocal` take, and a mod row's `root`. */
  path: string
  /** The manifest's name (the folder's when it names none). */
  name: string
  version?: string
  description?: string
  isMod: boolean
  enabled: boolean
  /** Off and never switched on or off: a folder copied in by hand that the
   *  person has not decided about yet. */
  isNew: boolean
}

export type LocalPluginRoot = {
  /** Absent: the user root. Otherwise the project folder it belongs to. */
  project?: string
  plugins: LocalPluginUiEntry[]
}

const sameFolder = (a: string, b: string) =>
  normalizeRuntimePath(a).toLowerCase() === normalizeRuntimePath(b).toLowerCase()

async function manifestIdentity(
  fs: RuntimeFs,
  pluginPath: string,
): Promise<{ name?: string; version?: string }> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(getPluginManifestPath(pluginPath), { encoding: 'utf-8' }),
    ) as { name?: unknown; version?: unknown }
    return {
      ...(typeof parsed.name === 'string' && parsed.name.trim() !== '' ? { name: parsed.name } : {}),
      ...(typeof parsed.version === 'string' && parsed.version !== '' ? { version: parsed.version } : {}),
    }
  } catch {
    return {}
  }
}

async function listRoot(
  fs: RuntimeFs,
  root: string,
  enabled: ReadonlySet<string>,
  switchedOff: ReadonlySet<string>,
  locale: string | undefined,
): Promise<LocalPluginUiEntry[]> {
  let entries
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const plugins: LocalPluginUiEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || PIPELINE_DIRS.has(entry.name.toLowerCase())) continue
    const path = joinRuntimePath(root, entry.name)
    const [identity, facts, translated] = await Promise.all([
      manifestIdentity(fs, path),
      describeInstalledPlugin(fs, path),
      readPluginLocaleText(fs, path, locale, PLUGIN_DESCRIPTION_KEY),
    ])
    const description = translated ?? facts.description
    plugins.push({
      folder: entry.name,
      path,
      name: identity.name ?? entry.name,
      ...(identity.version !== undefined ? { version: identity.version } : {}),
      ...(description !== undefined ? { description } : {}),
      isMod: facts.hasModules,
      enabled: enabled.has(entry.name),
      isNew: !enabled.has(entry.name) && !switchedOff.has(entry.name),
    })
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name))
}

/** The user root, then each project's root in the order given — a project
 *  that IS the home folder is the user root already, and is skipped. With
 *  `locale`, a plugin's description is its `locales/` file's
 *  `plugin.description` for that language when it has one
 *  (`pluginLocaleText.ts`), the manifest's English otherwise. */
export async function listLocalPlugins(params: {
  homeDir: string
  projects: readonly string[]
  fs: RuntimeFs
  locale?: string
}): Promise<LocalPluginRoot[]> {
  const { fs, homeDir } = params
  const userList = new Set((await loadUserEnabledPlugins(homeDir, fs)) ?? [])
  const userOff = await loadUserDisabledPlugins(homeDir, fs)
  const roots: LocalPluginRoot[] = [
    { plugins: await listRoot(fs, joinRuntimePath(homeDir, RUNTIME_DIR_NAME, 'plugins'), userList, new Set(userOff), params.locale) },
  ]
  const seen: string[] = [homeDir]
  for (const project of params.projects) {
    if (seen.some(each => sameFolder(each, project))) continue
    seen.push(project)
    const projectList = (await loadEnabledPlugins(project, fs)) ?? []
    const projectOff = await loadDisabledPlugins(project, fs)
    const plugins = await listRoot(
      fs,
      getProjectPluginsRoot(project),
      new Set([...userList, ...projectList]),
      new Set([...userOff, ...projectOff]),
      params.locale,
    )
    roots.push({ project, plugins })
  }
  return roots
}

/** An enabled directory plugin that replaces a marketplace plugin of its name. */
export type LocalPluginShadow = {
  /** The local plugin's folder, absolute. */
  path: string
  /** Absent: the user root, so every session. Otherwise only that project's. */
  project?: string
}

/** The enabled directory plugins named `name`, root by root: the loader loads
 *  one of them instead of the marketplace copy (a disabled one replaces nothing). */
export function localCopiesShadowing(roots: readonly LocalPluginRoot[], name: string): LocalPluginShadow[] {
  const out: LocalPluginShadow[] = []
  for (const root of roots) {
    const copy = root.plugins.find(plugin => plugin.enabled && plugin.name === name)
    if (copy) out.push({ path: copy.path, ...(root.project !== undefined ? { project: root.project } : {}) })
  }
  return out
}
