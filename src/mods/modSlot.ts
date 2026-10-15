/**
 * WHICH sessions get a mod runtime: one per top-level session and per TEAMMATE. A
 * sub-agent gets none (its calls go to the slot above it); a headless run gets none
 * unless settings.json `mods.headless` opts in. No `mods/` imports, so a session
 * without mods pays nothing.
 */

import type { ModModuleRef } from './ModRuntime'
import type { PluginUserConfigField } from '../pluginHost/pluginModel'
import { optionsLoadError, publicOptions, settleOptions } from './optionValues'
import { builtinModRefs } from './builtinMods'

/** The facts about a session this decision reads. */
export type ModSlotSession = {
  /** A fork / sub-agent build of the runtime. */
  isSubAgent?: boolean
  /** A routine, cron or remote-trigger run. */
  isHeadless?: boolean
  /** settings.json `mods.headless`: a headless run loads mods only when the
   *  user opted in. */
  headlessMods?: boolean
  /** The init payload's teammate flag. A teammate IS a slot; the fact is
   *  handed over so the decision is seen to have weighed it. */
  isTeammate?: boolean
  /** Set (non-empty) on a teammate's session; absent or empty otherwise. */
  teammateName?: string
}

/** Whether this session is a slot of its own — a session a person can open:
 *  a top-level session or a teammate. */
export function isModSlot(session: ModSlotSession): boolean {
  if (session.isSubAgent === true) return false
  if (session.isHeadless === true && session.headlessMods !== true) return false
  return true
}

/**
 * A plugin's id, the key of its `pluginConfigs` entry (`plugin.source`):
 * `<name>@<marketplace>` for an installed plugin, `<name>@inline` for a
 * directory plugin — also `plugin.register`'s `provenance`.
 */
export function pluginConfigId(plugin: { name: string; installIdentifier?: string }): string {
  return plugin.installIdentifier ?? `${plugin.name}@inline`
}

/**
 * The hooks modules to load for this session: every enabled plugin's, in
 * plugin order then the order its `hooks.json` lists them — or none, when the
 * session is not a slot.
 */
export function selectModModules(
  session: ModSlotSession,
  plugins: ReadonlyArray<{
    name: string
    path?: string
    hookModules?: readonly string[]
    manifest?: { version?: string; description?: string; userConfig?: Readonly<Record<string, PluginUserConfigField>> }
    /** `<name>@<marketplace>` for an installed plugin — `plugin.register`'s
     *  `provenance`; a directory-walk plugin reads `<name>@inline`. */
    installIdentifier?: string
  }>,
  /** Each plugin's stored `userConfig` values (settings.json
   *  `pluginConfigs`), by plugin id — `pluginConfigId`. */
  configs: Readonly<Record<string, { options?: Readonly<Record<string, unknown>> }>> = {},
  /** settings.json `enabledPlugins`: a built-in's `<name>@builtin` entry,
   *  when set, overrides its default (`isBuiltinModEnabled`). */
  enabledPlugins: Readonly<Record<string, boolean>> = {},
): ModModuleRef[] {
  if (!isModSlot(session)) return []
  const installed = plugins.flatMap(plugin => {
    const fields = plugin.manifest?.userConfig
    const pluginId = pluginConfigId(plugin)
    const resolved = settleOptions(fields, configs[pluginId]?.options)
    return (plugin.hookModules ?? []).map(path => ({
      plugin: plugin.name,
      path,
      // The plugin's directory — `$.plugin.root`.
      ...(plugin.path !== undefined ? { root: plugin.path } : {}),
      // `plugin.register`'s own-word fields.
      ...(plugin.manifest?.version !== undefined ? { version: plugin.manifest.version } : {}),
      ...(plugin.manifest?.description !== undefined ? { description: plugin.manifest.description } : {}),
      provenance: pluginId,
      // "The values of the manifest's `userConfig` fields, defaults filled
      // in"; values that do not fit the fields (a required one with no
      // value among them) fail the load, naming each.
      options: resolved.values,
      ...(resolved.problems.length > 0
        ? { optionsError: optionsLoadError(plugin.name, pluginId, resolved.problems) }
        : {}),
      ...(fields && Object.keys(fields).length > 0
        ? { config: { fields, values: publicOptions(fields, resolved.values) } }
        : {}),
    }))
  })
  // The enabled built-ins load in every slot, in the `builtin` tier
  // beneath the installed plugins; `ModDispatcher` seats by tier, so their
  // place in the list does not matter.
  return [...installed, ...builtinModRefs(enabledPlugins)]
}
