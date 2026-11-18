/**
 * Security: theme mods (F-25) are the plugins that have set a theme, and how
 * far a backdrop reaches; both live in settings.json `mods`.
 * Clients read topic `mods/themes` (`observe`) and ask through
 * `themeMods.read` (`observe`), `themeMods.setBackdropScope` and
 * `themeMods.setSingle` (`control`). The runtime alone writes the list; a
 * client changes only the scope, to one of two words, and the one-at-a-time flag.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'

/** One plugin that has set a theme. */
export type ThemeModEntry = {
  /** The plugin's name, as a theme's `plugin` names it. */
  plugin: string
  /** `<name>@<marketplace>`, `<name>@builtin` or `<name>@inline`. */
  id: string
  /** A directory plugin's folder. */
  root?: string
}

/** `window`: the backdrop fills the whole window. `conversation`: it stays in
 *  the conversation, and the rest of the window shows the theme's colours. */
export type ThemeBackdropScope = 'conversation' | 'window'
export const DEFAULT_THEME_BACKDROP_SCOPE: ThemeBackdropScope = 'window'

export const THEME_MODS_LIMIT = 64
const TEXT_LIMIT = 300
const ROOT_LIMIT = 1024

export const THEME_MODS_CAPABILITY = 'themeMods'
export const THEME_MODS_TOPIC = 'mods/themes'
/** The `type` of the snapshot and of every delta. */
export const THEME_MODS_EVENT = 'state'

export const THEME_MODS_ACTION_SCOPES = {
  read: 'observe',
  setBackdropScope: 'control',
  setSingle: 'control',
} as const satisfies Record<string, ScopeMode>
export type ThemeModsAction = keyof typeof THEME_MODS_ACTION_SCOPES

/** `single`: enabling one theme mod disables the others. */
export type ThemeModsState = { mods: ThemeModEntry[]; backdropScope: ThemeBackdropScope; single: boolean }
export type ThemeModsScopePayload = { scope: ThemeBackdropScope }
export type ThemeModsSinglePayload = { on: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit

export function isThemeBackdropScope(value: unknown): value is ThemeBackdropScope {
  return value === 'conversation' || value === 'window'
}

export function isThemeModsReadPayload(value: unknown): boolean {
  return value === undefined || value === null || (isRecord(value) && Object.keys(value).length === 0)
}

export function isThemeModsScopePayload(value: unknown): value is ThemeModsScopePayload {
  return isRecord(value) && Object.keys(value).every(key => key === 'scope') && isThemeBackdropScope(value.scope)
}

export function isThemeModsSinglePayload(value: unknown): value is ThemeModsSinglePayload {
  return isRecord(value) && Object.keys(value).every(key => key === 'on') && typeof value.on === 'boolean'
}

/** The well-formed entries of `raw`, one per plugin, at most the limit. */
export function readThemeMods(raw: unknown): ThemeModEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ThemeModEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= THEME_MODS_LIMIT) break
    if (!isRecord(item) || !isText(item.plugin, TEXT_LIMIT) || !isText(item.id, TEXT_LIMIT)) continue
    if (seen.has(item.plugin)) continue
    seen.add(item.plugin)
    out.push({ plugin: item.plugin, id: item.id, ...(isText(item.root, ROOT_LIMIT) ? { root: item.root } : {}) })
  }
  return out
}

/** A payload from the topic as the state a page reads, or null. */
export function readThemeModsState(value: unknown): ThemeModsState | null {
  if (!isRecord(value) || !Array.isArray(value.mods)) return null
  return {
    mods: readThemeMods(value.mods),
    backdropScope: isThemeBackdropScope(value.backdropScope) ? value.backdropScope : DEFAULT_THEME_BACKDROP_SCOPE,
    single: value.single === true,
  }
}

/**
 * `list` with `entry` in it: the same array when the plugin is already there
 * with this id and root, the entry replaced when either changed, appended
 * otherwise. A full list drops its oldest entry.
 */
export function withThemeMod(list: readonly ThemeModEntry[], entry: ThemeModEntry): readonly ThemeModEntry[] {
  const at = list.findIndex(each => each.plugin === entry.plugin)
  if (at === -1) return [...list, entry].slice(-THEME_MODS_LIMIT)
  const found = list[at]!
  if (found.id === entry.id && found.root === entry.root) return list
  return list.map((each, index) => (index === at ? entry : each))
}
