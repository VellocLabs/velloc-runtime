/**
 * Whether a plugin of a given name is installed: from a marketplace, or as a
 * directory plugin of the user or of a sidebar project. Records some features
 * file by plugin name (F-27 web profiles) stay while one remains.
 */
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { joinRuntimePath } from '../utils/runtimePaths'
import { sanitizeWorkspaceState } from '../utils/workspaceState'
import { loadInstalledPlugins } from './installedRegistry'
import { listLocalPlugins } from './localPluginList'

/** The sidebar's project list, as `workspaceCapability` writes it. */
const WORKSPACE_STATE_FILE = 'workspace-state.json'

async function sidebarProjects(homeDir: string, fs: RuntimeFs): Promise<string[]> {
  try {
    const text = await fs.readFile(joinRuntimePath(homeDir, RUNTIME_DIR_NAME, WORKSPACE_STATE_FILE), { encoding: 'utf-8' })
    return sanitizeWorkspaceState(JSON.parse(text)).projects.map(project => project.path)
  } catch {
    return []
  }
}

export async function pluginNamed(ctx: { homeDir: string; fs: RuntimeFs }, name: string): Promise<boolean> {
  const { registry } = await loadInstalledPlugins({ homeDir: ctx.homeDir }, ctx.fs)
  const installed = Object.entries(registry.plugins).some(([id, entries]) => {
    const at = id.lastIndexOf('@')
    return (entries?.length ?? 0) > 0 && (at > 0 ? id.slice(0, at) : id) === name
  })
  if (installed) return true
  const roots = await listLocalPlugins({ homeDir: ctx.homeDir, projects: await sidebarProjects(ctx.homeDir, ctx.fs), fs: ctx.fs })
  return roots.some(root => root.plugins.some(plugin => plugin.name === name))
}
