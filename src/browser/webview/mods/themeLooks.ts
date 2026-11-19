/**
 * Theme looks as both the theme directory (F-35) and the conversation's theme
 * menu (F-25) show them: the built-in marketplace's theme listings, the look
 * last applied from this window per session, and the ask that applies one.
 * A client names a session, a plugin and a look id; the runtime alone decides
 * what runs (`theme.useLook`).
 */
import * as React from 'react'

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
  // A look still waiting for a turn would switch a theme plugin back on.
  cancelWaitingLooks()
  const count = await turnOffAll(keep)
  if (count > 0 || keep === undefined) forgetAppliedLooks()
  return count
}

/** Why a look cannot be applied to `target`, or null when it can. A running turn does not block: the look waits for it. */
export function lookBlocked(target: { busy: boolean } | null | undefined): MessageKey | null {
  return target ? null : 'customize.themes.noSession'
}

/** The look waiting for a session's turn to end, per session id; one each, the latest pick. */
const waiting = new Map<string, { key: string; controller: AbortController }>()
const waitingWatchers = new Set<() => void>()
let waitingView: Readonly<Record<string, string>> = {}

function waitingChanged(): void {
  waitingView = Object.fromEntries([...waiting].map(([sessionId, entry]) => [sessionId, entry.key]))
  for (const watcher of [...waitingWatchers]) watcher()
}

/** The looks waiting for a turn to end, by session id; the same object until one changes. */
export const waitingLooks = (): Readonly<Record<string, string>> => waitingView

/** `waitingLooks`, kept current in a component. */
export function useWaitingLooks(): Readonly<Record<string, string>> {
  return React.useSyncExternalStore(onWaitingLooksChanged, waitingLooks, waitingLooks)
}

/** Hear a look start or stop waiting; returns the undo. */
export function onWaitingLooksChanged(watcher: () => void): () => void {
  waitingWatchers.add(watcher)
  return () => void waitingWatchers.delete(watcher)
}

/** Drops the look waiting in `sessionId`, or in every session; the runtime stops waiting too. */
export function cancelWaitingLooks(sessionId?: string): void {
  const ids = sessionId === undefined ? [...waiting.keys()] : [sessionId]
  let changed = false
  for (const id of ids) {
    const entry = waiting.get(id)
    if (!entry) continue
    waiting.delete(id)
    entry.controller.abort()
    changed = true
  }
  if (changed) waitingChanged()
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

/**
 * Asks the runtime to apply `plugin`'s look `lookId` in `sessionId`; a
 * success is remembered for the window. A newer ask for the session replaces
 * a look still waiting there. `waitForTurn`: the session runs a turn, so the
 * runtime applies the look once it ends — the look waits (`waitingLooks`),
 * and null is the answer when it was replaced or cancelled. No ask has a
 * deadline: the runtime waits for a turn the window may not have seen start.
 */
export async function askUseLook(
  runtimeConnection: () => Promise<RuntimeConnection>,
  sessionId: string,
  plugin: string,
  lookId: string,
  options: { waitForTurn?: boolean } = {},
): Promise<ThemeUseLookResult | null> {
  cancelWaitingLooks(sessionId)
  const key = lookKey(plugin, lookId)
  const controller = new AbortController()
  if (options.waitForTurn) {
    waiting.set(sessionId, { key, controller })
    waitingChanged()
  }
  try {
    const conn = await runtimeConnection()
    const result = (await conn.request(
      `${THEME_CAPABILITY}.useLook` as RouteKey,
      { sessionId, plugin, lookId },
      { timeoutMs: 0, signal: controller.signal },
    )) as ThemeUseLookResult
    if (controller.signal.aborted) return null
    if (result.ok) rememberAppliedLook(sessionId, key)
    return result
  } catch (error) {
    if (controller.signal.aborted) return null
    throw error
  } finally {
    if (waiting.get(sessionId)?.controller === controller) {
      waiting.delete(sessionId)
      waitingChanged()
    }
  }
}
