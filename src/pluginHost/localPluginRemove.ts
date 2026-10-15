/**
 * Uninstall a directory plugin.
 *
 * Security: it deletes a host folder, so the path must be a present, non-link
 * direct child of a `<RUNTIME_DIR_NAME>/plugins` directory, not a marketplace
 * pipeline directory; anything else is refused untouched. The name then leaves
 * that root's `enabled-plugins.json`.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  basenameRuntimePath,
  dirnameRuntimePath,
  isAbsoluteRuntimePath,
  normalizeRuntimePath,
} from '../utils/runtimePaths'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { forgetEnabledPlugin, patchEnabledPlugin } from './enabledStore'

/** The marketplace pipeline's state under the user plugins root — not plugins. */
export const PIPELINE_DIRS: ReadonlySet<string> = new Set([
  'cache',
  'known_marketplaces',
  'marketplaces',
])

/** Why `path` may not be removed, or null when it has the plugin-folder shape. */
export function localPluginPathProblem(path: string): string | null {
  if (typeof path !== 'string' || path === '' || !isAbsoluteRuntimePath(path)) {
    return 'not an absolute path'
  }
  if (path.split(/[\\/]+/).some(segment => segment === '..' || segment === '.')) {
    return 'the path has a relative segment'
  }
  const normalized = normalizeRuntimePath(path)
  const name = basenameRuntimePath(normalized)
  const parent = dirnameRuntimePath(normalized)
  const runtimeDir = dirnameRuntimePath(parent)
  const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  if (
    !sameName(basenameRuntimePath(parent), 'plugins') ||
    !sameName(basenameRuntimePath(runtimeDir), RUNTIME_DIR_NAME)
  ) {
    return `not a folder directly under ${RUNTIME_DIR_NAME}/plugins`
  }
  if (name === '' || PIPELINE_DIRS.has(name.toLowerCase())) {
    return `${name || 'the root'} is not a plugin folder`
  }
  return null
}

/**
 * Enable or disable a directory plugin by its folder: the folder's name in
 * (or out of) its root's `enabled-plugins.json` — the allowlist the loader's
 * walk matches (`allowlistNameOf`). The path is held to the same shape as
 * for removal; the folder itself is not touched.
 */
export async function setLocalPluginEnabled(
  path: string,
  enabled: boolean,
  fs: RuntimeFs,
): Promise<{ name: string }> {
  const problem = localPluginPathProblem(path)
  if (problem) throw new Error(`Cannot ${enabled ? 'enable' : 'disable'} ${path}: ${problem}`)
  const normalized = normalizeRuntimePath(path)
  const name = basenameRuntimePath(normalized)
  const base = dirnameRuntimePath(dirnameRuntimePath(dirnameRuntimePath(normalized)))
  await patchEnabledPlugin(base, name, enabled, fs)
  return { name }
}

export async function removeLocalPlugin(
  path: string,
  fs: RuntimeFs,
): Promise<{ name: string }> {
  const problem = localPluginPathProblem(path)
  if (problem) throw new Error(`Cannot uninstall ${path}: ${problem}`)
  const normalized = normalizeRuntimePath(path)
  const name = basenameRuntimePath(normalized)
  const parent = dirnameRuntimePath(normalized)
  // The parent's own listing says what the entry is without following it.
  const entry = (await fs.readdir(parent)).find(each => each.name === name)
  if (!entry) throw new Error(`Cannot uninstall ${path}: it does not exist`)
  if (entry.isSymbolicLink()) {
    throw new Error(`Cannot uninstall ${path}: it is a link — remove the link by hand`)
  }
  if (!entry.isDirectory()) throw new Error(`Cannot uninstall ${path}: not a folder`)
  await fs.rm(normalized, { recursive: true })
  // `<base>/.velloc/enabled-plugins.json` is the allowlist of this root: the
  // folder is gone, so neither list keeps its name.
  await forgetEnabledPlugin(dirnameRuntimePath(dirnameRuntimePath(parent)), name, fs)
  return { name }
}
