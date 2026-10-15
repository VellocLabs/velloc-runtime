/**
 * Persisted enable/disable choices for local plugins: `/plugins enable|disable`
 * writes the full set to `<cwd>/.velloc/enabled-plugins.json`, which, when
 * present, is the authoritative allowlist at startup.
 */

import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { dirnameRuntimePath } from '../utils/runtimePaths'
import {
  getEnabledPluginsConfigPath,
  getUserEnabledPluginsConfigPath,
} from './pluginPaths'

/** `disabledPlugins`: the folders the person switched OFF. A folder in
 *  neither list was never switched — a plugin dropped in by hand, which
 *  Settings flags as new. Never read by the loader: off is the default. */
type EnabledPluginsFile = { enabledPlugins: string[]; disabledPlugins?: string[] }

type EnabledPluginsDoc = { enabled: string[]; disabled: string[] }

const namesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []

/** Read + parse one `enabled-plugins.json`. Null when absent or corrupt. */
async function readEnabledPluginsDoc(
  path: string,
  fs: RuntimeFs,
): Promise<EnabledPluginsDoc | null> {
  let raw: string
  try {
    raw = await fs.readFile(path, { encoding: 'utf-8' })
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EnabledPluginsFile>
    if (parsed && Array.isArray(parsed.enabledPlugins)) {
      return { enabled: namesOf(parsed.enabledPlugins), disabled: namesOf(parsed.disabledPlugins) }
    }
  } catch (error) {
    console.warn(`[plugins] failed to parse ${path}:`, error)
  }
  return null
}

async function readEnabledPluginsFile(
  path: string,
  fs: RuntimeFs,
): Promise<string[] | null> {
  return (await readEnabledPluginsDoc(path, fs))?.enabled ?? null
}

/**
 * Read the persisted enabled-plugin names. Returns `null` when no file exists
 * (so callers fall back to options/env), or the parsed list otherwise.
 */
export async function loadEnabledPlugins(
  cwd: string,
  fs: RuntimeFs = processFs(),
): Promise<string[] | null> {
  return readEnabledPluginsFile(getEnabledPluginsConfigPath(cwd), fs)
}

/** Read the USER-scope (`~/.velloc/enabled-plugins.json`) allowlist. */
export async function loadUserEnabledPlugins(
  homeDir: string,
  fs: RuntimeFs = processFs(),
): Promise<string[] | null> {
  return readEnabledPluginsFile(getUserEnabledPluginsConfigPath(homeDir), fs)
}

/** The folders switched off in `<cwd>/.velloc/enabled-plugins.json`. */
export async function loadDisabledPlugins(cwd: string, fs: RuntimeFs = processFs()): Promise<string[]> {
  return (await readEnabledPluginsDoc(getEnabledPluginsConfigPath(cwd), fs))?.disabled ?? []
}

/** The folders switched off in `~/.velloc/enabled-plugins.json`. */
export async function loadUserDisabledPlugins(homeDir: string, fs: RuntimeFs = processFs()): Promise<string[]> {
  return (await readEnabledPluginsDoc(getUserEnabledPluginsConfigPath(homeDir), fs))?.disabled ?? []
}

/**
 * The effective legacy allowlist: the UNION of the user-scope and project-scope
 * files (each speaks for its own install scope). `null` only when neither file
 * exists.
 */
export async function loadEffectiveEnabledPlugins(params: {
  cwd: string
  homeDir?: string
  /** THIS runtime's fs; omitted → the realm-global slot (tests). */
  fs?: RuntimeFs
}): Promise<string[] | null> {
  const fs = params.fs ?? processFs()
  const [project, user] = await Promise.all([
    loadEnabledPlugins(params.cwd, fs),
    params.homeDir ? loadUserEnabledPlugins(params.homeDir, fs) : null,
  ])
  if (project === null && user === null) {
    return null
  }
  return [...new Set([...(user ?? []), ...(project ?? [])])]
}

/** Write the full enabled-plugin set (deduped) to `enabled-plugins.json`. */
export async function saveEnabledPlugins(
  cwd: string,
  names: string[],
  fs: RuntimeFs = processFs(),
): Promise<void> {
  const path = getEnabledPluginsConfigPath(cwd)
  const disabled = (await readEnabledPluginsDoc(path, fs))?.disabled ?? []
  await writeEnabledPluginsFile(path, names, fs, disabled.filter(name => !names.includes(name)))
}

async function writeEnabledPluginsFile(
  path: string,
  names: string[],
  fs: RuntimeFs,
  disabled: readonly string[] = [],
): Promise<void> {
  try {
    await fs.mkdir(dirnameRuntimePath(path))
  } catch {
    // Directory may already exist.
  }
  const content: EnabledPluginsFile = {
    enabledPlugins: [...new Set(names)],
    ...(disabled.length > 0 ? { disabledPlugins: [...new Set(disabled)] } : {}),
  }
  await fs.writeFile(path, JSON.stringify(content, null, 2), {
    encoding: 'utf-8',
  })
}

/**
 * Toggle one legacy plugin in `enabled-plugins.json` as a read-modify-write
 * patch, preserving entries for plugins not discovered this boot. Returns the
 * resulting persisted list (deduped).
 */
export async function patchEnabledPlugin(
  cwd: string,
  name: string,
  enabled: boolean,
  fs: RuntimeFs = processFs(),
): Promise<string[]> {
  return patchEnabledPluginFile(
    getEnabledPluginsConfigPath(cwd),
    name,
    enabled,
    fs,
  )
}

/**
 * Same patch, against the USER-scope file (`~/.velloc/enabled-plugins.json`).
 *
 * `/plugins enable <name>` routes here when the matched plugin was discovered
 * under the user root: a user-scope plugin toggled from one project folder has
 * to stay toggled in every other session, and writing the project file would
 * scope the choice to that one folder.
 */
export async function patchUserEnabledPlugin(
  homeDir: string,
  name: string,
  enabled: boolean,
  fs: RuntimeFs = processFs(),
): Promise<string[]> {
  return patchEnabledPluginFile(
    getUserEnabledPluginsConfigPath(homeDir),
    name,
    enabled,
    fs,
  )
}

/** Drop a folder from both lists of `<cwd>/.velloc/enabled-plugins.json`: its
 *  folder was removed, so it is neither on nor switched off. */
export async function forgetEnabledPlugin(
  cwd: string,
  name: string,
  fs: RuntimeFs = processFs(),
): Promise<void> {
  const path = getEnabledPluginsConfigPath(cwd)
  const doc = (await readEnabledPluginsDoc(path, fs)) ?? { enabled: [], disabled: [] }
  await writeEnabledPluginsFile(
    path,
    doc.enabled.filter(n => n !== name),
    fs,
    doc.disabled.filter(n => n !== name),
  )
}

async function patchEnabledPluginFile(
  path: string,
  name: string,
  enabled: boolean,
  fs: RuntimeFs,
): Promise<string[]> {
  // `readEnabledPluginsFile` returns null for BOTH a missing AND a corrupt
  // file. Treating either as `[]` is intentional here: a corrupt
  // enabled-plugins.json is ALREADY ignored at boot (the loader returns null →
  // fall back to options/env), so it carries no honored state to preserve —
  // patching over it heals the corruption rather than losing anything. (Unlike
  // the marketplace / installed registries, whose loaders DO honor the file and
  // therefore throw on corrupt rather than default — see marketplaceManager.ts.)
  const doc = (await readEnabledPluginsDoc(path, fs)) ?? { enabled: [], disabled: [] }
  const next = enabled
    ? [...doc.enabled, name]
    : doc.enabled.filter(n => n !== name)
  const deduped = [...new Set(next)]
  const disabled = enabled
    ? doc.disabled.filter(n => n !== name)
    : [...doc.disabled, name]
  await writeEnabledPluginsFile(path, deduped, fs, disabled)
  return deduped
}
