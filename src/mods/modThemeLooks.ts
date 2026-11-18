/**
 * Theme looks on the runtime protocol (F-25, F-35): `theme.useLook` applies a
 * look the built-in marketplace lists to one session, `theme.clear` takes the
 * session's theme away. Both are `full`. What stands afterwards is read from
 * the session's published theme, not from the reply.
 *
 * Security: a client names a session, a plugin and a look, never a command.
 * The runtime reads the look from its own cached catalogue, and runs the
 * command it names only when the module that registered that command was
 * loaded from that very listing's install. Another plugin's command, a
 * built-in and free text cannot be reached.
 */
import type { CommandRunSettlement } from '../engine/extensionSeam'
import type { CatalogListing } from '../pluginHost/registryFormats'
import { isLookId } from '../pluginHost/themeListing'
import type { ModCommandOrigin } from './modCommands'

export const THEME_CAPABILITY = 'theme'

/** Both run or unload a plugin's code on the host and repaint the desktop
 *  window, which a remote client must not do. */
export const THEME_ACTION_SCOPES = {
  useLook: 'full',
  clear: 'full',
} as const
export type ThemeAction = keyof typeof THEME_ACTION_SCOPES

export type ThemeUseLookPayload = { sessionId: string; plugin: string; lookId: string }
export type ThemeClearPayload = { sessionId: string }

/**
 * `command`: the plugin's own command answered (`text` is what it printed).
 * `reload`: the plugin was loaded again, so its own theme is the latest set.
 * Not applied: `unknownLook` — the catalogue lists no such look; `notLoaded`
 * — the session has no mod runtime, or the plugin is not loaded in it;
 * `notOwnCommand` — the plugin registered no such command; `unanswered` —
 * nothing answered it; `commandFailed` — it answered with a failure.
 */
export type ThemeUseLookResult =
  | { ok: true; via: 'command'; text?: string }
  | { ok: true; via: 'reload' }
  | { ok: false; reason: 'unknownLook' | 'notLoaded' | 'notOwnCommand' | 'unanswered' }
  | { ok: false; reason: 'commandFailed'; text?: string }

/** `cleared`: whether a theme stood. */
export type ThemeClearResult = { ok: true; cleared: boolean }

const SESSION_ID_MAX = 128
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key))
  )
}

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= SESSION_ID_MAX

export function isThemeUseLookPayload(value: unknown): value is ThemeUseLookPayload {
  return (
    hasOnlyKeys(value, ['sessionId', 'plugin', 'lookId']) &&
    isSessionId(value.sessionId) &&
    typeof value.plugin === 'string' &&
    PLUGIN_NAME.test(value.plugin) &&
    isLookId(value.lookId)
  )
}

export function isThemeClearPayload(value: unknown): value is ThemeClearPayload {
  return hasOnlyKeys(value, ['sessionId']) && isSessionId(value.sessionId)
}

/** What applying a look needs of a session's mod runtime. */
export type ThemeLookSlot = {
  /** Who serves `/name`: the plugin, and where its module was loaded from. */
  commandOwner?(name: string): { plugin: string; provenance?: string } | undefined
  commandRun?(
    input: { command: string; args: string },
    core: undefined,
    signal?: AbortSignal,
    context?: undefined,
    origin?: ModCommandOrigin,
  ): Promise<CommandRunSettlement>
  /** Whether a module loaded from `provenance` is running in the session. */
  hasLoaded?(provenance: string): boolean
  /** Reloads every module loaded from `provenance`; how many loaded again. */
  reloadPlugin?(provenance: string): Promise<number>
  /** Clears the session's theme; whether one stood. */
  clearTheme?(): boolean
}

export type ThemeLookTarget = {
  /** Key of the marketplace whose listings carry looks. */
  marketplace: string
  /** Its cached listings as this channel shows them; null when none is cached. */
  listings: readonly CatalogListing[] | null
  /** The session's mod runtime, when it has one. */
  slot: ThemeLookSlot | undefined
}

/** Applies the look `plugin` / `lookId` names to the session behind `target.slot`. Never rejects. */
export async function useThemeLook(
  target: ThemeLookTarget,
  ask: Pick<ThemeUseLookPayload, 'plugin' | 'lookId'>,
  signal?: AbortSignal,
): Promise<ThemeUseLookResult> {
  const listing = target.listings?.find(candidate => candidate.name === ask.plugin)
  const look = listing?.theme?.looks.find(candidate => candidate.id === ask.lookId)
  if (!look) return { ok: false, reason: 'unknownLook' }
  const { slot } = target
  const installed = `${ask.plugin}@${target.marketplace}`
  if (!slot) return { ok: false, reason: 'notLoaded' }
  if (!look.use) {
    const reloaded = (await slot.reloadPlugin?.(installed).catch(() => 0)) ?? 0
    return reloaded > 0 ? { ok: true, via: 'reload' } : { ok: false, reason: 'notLoaded' }
  }
  if (slot.hasLoaded && !slot.hasLoaded(installed)) return { ok: false, reason: 'notLoaded' }
  const owner = slot.commandOwner?.(look.use.command)
  if (!slot.commandRun || owner?.plugin !== ask.plugin || owner.provenance !== installed) {
    return { ok: false, reason: 'notOwnCommand' }
  }
  const settlement = await slot
    .commandRun({ command: look.use.command, args: look.use.args ?? '' }, undefined, signal, undefined, { kind: 'bridge' })
    .catch((): CommandRunSettlement => ({ settled: false }))
  if (!settlement.settled || settlement.unanswered) return { ok: false, reason: 'unanswered' }
  const { text, exitCode } = settlement.result
  const said = typeof text === 'string' && text !== '' ? { text } : {}
  if (typeof exitCode === 'number' && exitCode !== 0) return { ok: false, reason: 'commandFailed', ...said }
  return { ok: true, via: 'command', ...said }
}

/** Clears the theme of the session behind `slot`. */
export function clearSessionTheme(slot: ThemeLookSlot | undefined): ThemeClearResult {
  return { ok: true, cleared: slot?.clearTheme?.() ?? false }
}
