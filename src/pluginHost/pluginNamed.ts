/**
 * Whether a plugin of a given name is installed: from a marketplace, or as a
 * directory plugin of the user or of a sidebar project. Records some features
 * file by plugin name (F-27 web profiles) stay while one remains.
 */
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { joinRuntimePath } from '../utils/runtimePaths'
import { sanitizeWorkspaceState, WORKSPACE_STATE_FILE } from '../utils/workspaceState'
import { loadInstalledPlugins } from './installedRegistry'
import { listLocalPlugins } from './localPluginList'

/** `<name>@<marketplace>` → `<name>`; a key without a marketplace is the name. */
export function pluginNameOfKey(key: string): string {
  return key.slice(0, Math.max(0, key.lastIndexOf('@'))) || key
}

/** The sidebar's project folders (`~/.velloc/workspace-state.json`): the
 *  host's own list, never paths a client names. Empty when there is none. */
export async function sidebarProjects(ctx: { homeDir: string; fs: RuntimeFs }): Promise<string[]> {
  try {
    const text = await ctx.fs.readFile(joinRuntimePath(ctx.homeDir, RUNTIME_DIR_NAME, WORKSPACE_STATE_FILE), { encoding: 'utf-8' })
    return sanitizeWorkspaceState(JSON.parse(text)).projects.map(project => project.path)
  } catch {
    return []
  }
}

export async function pluginNamed(ctx: { homeDir: string; fs: RuntimeFs }, name: string): Promise<boolean> {
  const { registry } = await loadInstalledPlugins({ homeDir: ctx.homeDir }, ctx.fs)
  if (Object.entries(registry.plugins).some(([key, entries]) => (entries?.length ?? 0) > 0 && pluginNameOfKey(key) === name)) {
    return true
  }
  const roots = await listLocalPlugins({ homeDir: ctx.homeDir, projects: await sidebarProjects(ctx), fs: ctx.fs })
  return roots.some(root => root.plugins.some(plugin => plugin.name === name))
}
