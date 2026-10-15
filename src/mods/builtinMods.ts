/**
 * The built-in tier (F-25): bundled hooks modules loaded in every slot beneath every
 * user plugin and above core, served under a `builtin:` path (never read from disk,
 * compiled at build time, never polled by the dev loop).
 */

import type { ModModuleRef } from './ModRuntime'

export type BuiltinModDefinition = {
  /** The plugin's name, as the chain and the state rows show it. */
  name: string
  /** The manifest's `version` the built-in states, for `plugin.register`. */
  version?: string
  /** The manifest's `description` — what Settings → Plugins & Mods says the
   *  built-in does. */
  description?: string
  /** The hooks module's text: `export function register(on, options) { … }`. */
  source: string
  /** Whether the built-in loads when the person has not said: settings.json
   *  `enabledPlugins["<name>@builtin"]`, when set, wins over it. Absent → on. */
  onByDefault?: boolean
}

/** The id settings.json `enabledPlugins` keys a built-in by — also its
 *  `provenance`: `<name>@builtin`. */
export function builtinModId(name: string): string {
  return `${name}@builtin`
}

/** Whether a built-in loads: the person's explicit `enabledPlugins` entry
 *  when there is one, its own default otherwise. */
export function isBuiltinModEnabled(
  definition: Pick<BuiltinModDefinition, 'name' | 'onByDefault'>,
  enabledPlugins: Readonly<Record<string, boolean>> = {},
): boolean {
  const explicit = enabledPlugins[builtinModId(definition.name)]
  return typeof explicit === 'boolean' ? explicit : definition.onByDefault !== false
}

export const BUILTIN_MOD_SCHEME = 'builtin:'

const registry = new Map<string, BuiltinModDefinition>()

/** Register a built-in mod. A second registration under one name replaces
 *  the first (a test's fixture); sessions started afterwards load the new text. */
export function registerBuiltinMod(definition: BuiltinModDefinition): void {
  if (typeof definition.name !== 'string' || definition.name === '') {
    throw new TypeError('registerBuiltinMod: name must be a non-empty string')
  }
  if (typeof definition.source !== 'string') {
    throw new TypeError(`registerBuiltinMod('${definition.name}'): source must be the module's text`)
  }
  registry.set(definition.name, { ...definition })
}

/** Forget a built-in (tests). */
export function unregisterBuiltinMod(name: string): void {
  registry.delete(name)
}

/** Every built-in, in registration order. */
export function listBuiltinMods(): BuiltinModDefinition[] {
  return [...registry.values()]
}

/** The module path a built-in is loaded under: `builtin:<name>/hooks/register.js`. */
export function builtinModPath(name: string): string {
  return `${BUILTIN_MOD_SCHEME}${name}/hooks/register.js`
}

/** Whether `path` names a built-in's module. */
export function isBuiltinModPath(path: string): boolean {
  return path.startsWith(BUILTIN_MOD_SCHEME)
}

/** The module text a `builtin:` path serves, or undefined for a path no
 *  built-in owns (one registered in another session's lifetime). */
export function readBuiltinMod(path: string): string | undefined {
  if (!isBuiltinModPath(path)) return undefined
  const name = path.slice(BUILTIN_MOD_SCHEME.length).replace(/\/hooks\/register\.js$/, '')
  return registry.get(name)?.source
}

/** The module refs a slot loads for the enabled built-ins, in the `builtin`
 *  tier — `enabledPlugins` is settings.json's map (`isBuiltinModEnabled`). */
export function builtinModRefs(enabledPlugins: Readonly<Record<string, boolean>> = {}): ModModuleRef[] {
  return listBuiltinMods().filter(definition => isBuiltinModEnabled(definition, enabledPlugins)).map(definition => ({
    plugin: definition.name,
    path: builtinModPath(definition.name),
    root: `${BUILTIN_MOD_SCHEME}${definition.name}`,
    tier: 'builtin',
    provenance: builtinModId(definition.name),
    ...(definition.version !== undefined ? { version: definition.version } : {}),
    ...(definition.description !== undefined ? { description: definition.description } : {}),
  }))
}
