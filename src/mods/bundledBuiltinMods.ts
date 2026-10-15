/**
 * The product's built-in mods (F-25), compiled at build time and registered once.
 * None ship today. Imported lazily by the session boot.
 */

import { BUILTIN_MODS } from 'virtual:builtin-mods'
import { registerBuiltinMod } from './builtinMods'

/**
 * Each built-in's default when settings.json `enabledPlugins` does not name
 * it (`<name>@builtin`); one absent here defaults on. Kept out of the
 * plugins' own manifests.
 */
export const BUILTIN_MOD_DEFAULT_ENABLED: Readonly<Record<string, boolean>> = {}

let registered = false

/** Register every bundled built-in; a second call does nothing. */
export function registerBundledBuiltinMods(): void {
  if (registered) return
  registered = true
  for (const definition of BUILTIN_MODS) {
    const onByDefault = BUILTIN_MOD_DEFAULT_ENABLED[definition.name]
    registerBuiltinMod(onByDefault === undefined ? definition : { ...definition, onByDefault })
  }
}
