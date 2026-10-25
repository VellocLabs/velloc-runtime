import type { PluginInstalledUiEntry } from '../../bridge/protocol/plugins'
import type { InstalledSkillUiEntry } from '../../bridge/protocol/skills'
import type { NexusMcpServerConfig } from '../../../settings/settingsTypes'
import type { ModPluginSummary } from '../mods/modsStateView'
import type { SettingsSectionId } from '../settings/settingsNav'

/**
 * The Customize screen's installed column (F-35): what this machine has, in
 * four read-only groups. A row opens the Settings page that manages it.
 */

export const INSTALLED_GROUPS = ['plugins', 'mods', 'skills', 'mcp'] as const
export type InstalledGroup = (typeof INSTALLED_GROUPS)[number]

export type InstalledRow = {
  id: string
  name: string
  /** One line under the name: a description or where it came from. Data, not UI text. */
  detail?: string
}

export type InstalledInventory = {
  plugins: readonly PluginInstalledUiEntry[]
  mods: readonly ModPluginSummary[]
  skills: readonly InstalledSkillUiEntry[]
  mcp: Readonly<Record<string, NexusMcpServerConfig>>
}

export const EMPTY_INVENTORY: InstalledInventory = { plugins: [], mods: [], skills: [], mcp: {} }

/** Where a row's group is managed. */
export const GROUP_SETTINGS_SECTION: Record<InstalledGroup, SettingsSectionId> = {
  plugins: 'plugins',
  mods: 'plugins',
  skills: 'features',
  mcp: 'mcp',
}

const byName = (a: InstalledRow, b: InstalledRow) => a.name.localeCompare(b.name)

function mcpDetail(config: NexusMcpServerConfig): string | undefined {
  if (config.url) return config.url
  if (config.command) return [config.command, ...(config.args ?? [])].join(' ')
  return undefined
}

export function buildInstalledRows(
  inventory: InstalledInventory,
): Record<InstalledGroup, InstalledRow[]> {
  return {
    plugins: inventory.plugins
      .map(entry => ({
        id: `${entry.name}@${entry.marketplace}`,
        name: entry.name,
        detail: entry.description ?? entry.marketplace,
      }))
      .sort(byName),
    mods: inventory.mods
      .map(summary => ({
        id: summary.plugin,
        name: summary.plugin,
        detail: summary.description ?? summary.provenance,
      }))
      .sort(byName),
    skills: inventory.skills
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        detail: entry.description ?? entry.publisher,
      }))
      .sort(byName),
    mcp: Object.entries(inventory.mcp)
      .map(([id, config]) => ({ id, name: id, detail: mcpDetail(config) }))
      .sort(byName),
  }
}
