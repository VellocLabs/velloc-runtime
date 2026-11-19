/**
 * Theme looks as both the theme directory (F-35) and the conversation's theme
 * menu (F-25) show them: the built-in marketplace's theme listings, the look
 * last applied from this window per session, and the ask that applies one.
 * A client names a session, a plugin and a look id; the runtime alone decides
 * what runs (`theme.useLook`).
 */
import type { ThemeUseLookResult } from '../../../mods/modThemeLooks'
import { THEME_CAPABILITY } from '../../../mods/modThemeLooks'
import { BUILTIN_MARKETPLACE_KEY } from '../../../pluginHost/builtinMarketplace'
import { joinPluginRef } from '../../../pluginHost/pluginRef'
import type { PluginAvailableUiEntry } from '../../bridge/protocol/plugins'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../../runtimeProtocol'
import type { MessageKey } from '../i18n/messages/en'
import type { NexusSettingsBridge } from '../nexusSettingsBridge'
import { pluginsListMarketplaceThemes } from '../settings/clients'

/** A theme plugin of the directory: a listing that carries looks. */
export type ThemePlugin = PluginAvailableUiEntry & { theme: NonNullable<PluginAvailableUiEntry['theme']> }

export const isThemePlugin = (entry: PluginAvailableUiEntry): entry is ThemePlugin =>
  Array.isArray(entry.theme?.looks) && entry.theme.looks.length > 0

/** The built-in marketplace's theme listings, from its local copy; rejects when it cannot be read. */
export async function readThemePlugins(
  bridge: NexusSettingsBridge,
): Promise<{ plugins: ThemePlugin[]; fetched: boolean }> {
  const result = await pluginsListMarketplaceThemes(bridge, BUILTIN_MARKETPLACE_KEY)
  return { plugins: (result.manifest?.plugins ?? []).filter(isThemePlugin), fetched: result.manifest != null }
}

/** A plugin's listing name as a heading: `theme-examples` reads "Theme examples". */
export function packTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words === '' ? name : words.charAt(0).toUpperCase() + words.slice(1)
}

/** `<plugin>/<look id>`. */
export const lookKey = (plugin: string, lookId: string) => `${plugin}/${lookId}`

/** The session's standing theme as its runtime publishes it: `null` when none stands, `undefined` while not read yet. */
export type ThemeStanding = { plugin: string } | null | undefined

/** A session's standing theme from its mod UI: unknown until the session has loaded and its mods have settled. */
export function themeStandingOf(modUi: {
  theme?: { plugin: string } | null
  isLoaded?: boolean
  modsSettled?: boolean
}): ThemeStanding {
  if (modUi.theme) return { plugin: modUi.theme.plugin }
  return modUi.isLoaded === true && modUi.modsSettled === true ? null : undefined
}

/**
 * The look to mark In use: the one `last` applied while its plugin's theme
 * still stands, a standing single theme's only look, and none when no theme
 * stands or another source set it.
 */
export function lookInUse(
  last: string | undefined,
  standing: ThemeStanding,
  plugins: readonly ThemePlugin[],
): string | null {
  if (standing === undefined) return last ?? null
  if (standing === null) return null
  const owner = plugins.find(
    p => standing.plugin === p.name || standing.plugin === joinPluginRef(p.name, BUILTIN_MARKETPLACE_KEY),
  )
  if (!owner) return null
  if (last?.startsWith(`${owner.name}/`)) return last
  return owner.theme.looks.length === 1 ? lookKey(owner.name, owner.theme.looks[0]!.id) : null
}

/** The look last applied from this window, per session id; outlives every screen and menu. */
const applied = new Map<string, string>()

export const appliedLooks = (): Record<string, string> => Object.fromEntries(applied)
export const rememberAppliedLook = (sessionId: string, key: string): void => void applied.set(sessionId, key)
/** Every theme plugin was switched off: no look is in use any more. */
export const forgetAppliedLooks = (): void => applied.clear()

/**
 * Switches every theme plugin off but `keep` through `turnOffAll`
 * (`themeMods.turnOffAll`); once any went off, no applied look is remembered.
 */
export async function turnOffThemePlugins(
  turnOffAll: (keep?: string) => Promise<number>,
  keep?: string,
): Promise<number> {
  const count = await turnOffAll(keep)
  if (count > 0 || keep === undefined) forgetAppliedLooks()
  return count
}

/** Why a look cannot be applied to `target` now, or null when it can. */
export function lookBlocked(target: { busy: boolean } | null | undefined): MessageKey | null {
  if (!target) return 'customize.themes.noSession'
  return target.busy ? 'customize.themes.busy' : null
}

export type ThemeFailure = Extract<ThemeUseLookResult, { ok: false }>['reason'] | 'request'

export const THEME_FAILURE_MESSAGE: Record<ThemeFailure, MessageKey> = {
  unknownLook: 'customize.themes.reason.unknownLook',
  notLoaded: 'customize.themes.reason.notLoaded',
  notOwnCommand: 'customize.themes.reason.notOwnCommand',
  unanswered: 'customize.themes.reason.unanswered',
  commandFailed: 'customize.themes.reason.commandFailed',
  request: 'customize.themes.reason.request',
}

/** Asks the runtime to apply `plugin`'s look `lookId` in `sessionId`; a success is remembered for the window. */
export async function askUseLook(
  runtimeConnection: () => Promise<RuntimeConnection>,
  sessionId: string,
  plugin: string,
  lookId: string,
): Promise<ThemeUseLookResult> {
  const conn = await runtimeConnection()
  const result = (await conn.request(`${THEME_CAPABILITY}.useLook` as RouteKey, {
    sessionId,
    plugin,
    lookId,
  })) as ThemeUseLookResult
  if (result.ok) rememberAppliedLook(sessionId, lookKey(plugin, lookId))
  return result
}
