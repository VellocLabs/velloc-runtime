/**
 * Theme looks on the runtime protocol (F-25, F-35): `theme.useLook` applies a
 * look the built-in marketplace lists to one session, `theme.onEnable` runs
 * the listing's `onEnable` command in a session after the plugin is turned
 * on, `theme.clear` takes the session's theme away. All are `full`. What
 * stands afterwards is read from the session's published theme, not from the
 * reply.
 *
 * Security: a client names a session, a plugin and a look, never a command.
 * The runtime reads the look or `onEnable` from its own cached catalogue, and
 * runs the command it names only when the module that registered that command
 * was loaded from an install of that very listing's plugin: its own, or the
 * same repository and folder installed from another marketplace. Another
 * plugin's command, a built-in and free text cannot be reached.
 */
import type { CommandRunSettlement } from '../engine/extensionSeam'
import type { CatalogListing, ThemeLookUse } from '../pluginHost/registryFormats'
import { isLookId } from '../pluginHost/themeListing'
import type { ModCommandOrigin } from './modCommands'

export const THEME_CAPABILITY = 'theme'

/** Both run or unload a plugin's code on the host and repaint the desktop
 *  window, which a remote client must not do. */
export const THEME_ACTION_SCOPES = {
  useLook: 'full',
  onEnable: 'full',
  clear: 'full',
} as const
export type ThemeAction = keyof typeof THEME_ACTION_SCOPES

export type ThemeUseLookPayload = { sessionId: string; plugin: string; lookId: string }
export type ThemeClearPayload = { sessionId: string }
export type ThemeOnEnablePayload = { sessionId: string; plugin: string }

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

/** What running a command the catalogue names for the plugin came to. */
type OwnCommandResult =
  | { ok: true; via: 'command'; text?: string }
  | { ok: false; reason: 'notLoaded' | 'notOwnCommand' | 'unanswered' }
  | { ok: false; reason: 'commandFailed'; text?: string }

/**
 * As `ThemeUseLookResult`'s command answers; `self`: the plugin's own theme
 * already stands once it has started, so nothing ran; `none`: the catalogue
 * names no `onEnable` for that plugin, so nothing ran.
 */
export type ThemeOnEnableResult = OwnCommandResult | { ok: true; via: 'self' } | { ok: false; reason: 'none' }

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

export function isThemeOnEnablePayload(value: unknown): value is ThemeOnEnablePayload {
  return (
    hasOnlyKeys(value, ['sessionId', 'plugin']) &&
    isSessionId(value.sessionId) &&
    typeof value.plugin === 'string' &&
    PLUGIN_NAME.test(value.plugin)
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
  /** The plugin whose theme stands now. */
  themeOwner?(): string | undefined
  /** Settles once the plugins now loading have started. */
  settled?(): Promise<void>
}

export type ThemeLookTarget = {
  /** Key of the marketplace whose listings carry looks. */
  marketplace: string
  /** Its cached listings as this channel shows them; null when none is cached. */
  listings: readonly CatalogListing[] | null
  /** The installs that are a listing's plugin, own install first. Default: `<name>@<marketplace>` alone. */
  installsOf?: (listing: CatalogListing) => readonly string[]
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
  const installs = target.installsOf?.(listing!) ?? [`${ask.plugin}@${target.marketplace}`]
  if (!slot) return { ok: false, reason: 'notLoaded' }
  const run = look.use ?? listing!.theme!.onEnable
  // A look without its own command: the plugin's `onEnable`, else loading the plugin again.
  if (run) return runOwnCommand(slot, ask.plugin, installs, run, signal)
  for (const install of installs) {
    const reloaded = (await slot.reloadPlugin?.(install).catch(() => 0)) ?? 0
    if (reloaded > 0) return { ok: true, via: 'reload' }
  }
  return { ok: false, reason: 'notLoaded' }
}

/**
 * `useThemeLook`, asked again while the plugin is still loading in the
 * session (just switched on, its module not yet up): while the answer is
 * `notLoaded` or `notOwnCommand`, every `timing.pause`, `timing.attempts`
 * times at most. `target.slot` is read on each try. Never rejects.
 */
export async function useThemeLookOnceLoaded(
  target: ThemeLookTarget,
  ask: Pick<ThemeUseLookPayload, 'plugin' | 'lookId'>,
  timing: ThemeOnEnableTiming = {},
  signal?: AbortSignal,
): Promise<ThemeUseLookResult> {
  const pause = timing.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 500)))
  const attempts = Math.max(1, timing.attempts ?? 12)
  // Named apart: spreading `target` would read its `slot` once more.
  const { marketplace, listings, installsOf } = target
  let result: ThemeUseLookResult = { ok: false, reason: 'notLoaded' }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await pause()
    if (signal?.aborted) break
    const slot = target.slot
    // The plugins now loading have started before a command of theirs is looked for.
    await slot?.settled?.().catch(() => undefined)
    if (signal?.aborted) break
    result = await useThemeLook({ marketplace, listings, ...(installsOf ? { installsOf } : {}), slot }, ask, signal)
    if (result.ok || (result.reason !== 'notLoaded' && result.reason !== 'notOwnCommand')) return result
  }
  return result
}

/** Runs `run` in the session when the module that registered it is one of `installs`. */
async function runOwnCommand(
  slot: ThemeLookSlot,
  plugin: string,
  installs: readonly string[],
  run: ThemeLookUse,
  signal?: AbortSignal,
): Promise<OwnCommandResult> {
  if (slot.hasLoaded && !installs.some(install => slot.hasLoaded!(install))) return { ok: false, reason: 'notLoaded' }
  const owner = slot.commandOwner?.(run.command)
  if (
    !slot.commandRun ||
    owner?.plugin !== plugin ||
    owner.provenance === undefined ||
    !installs.includes(owner.provenance)
  ) {
    return { ok: false, reason: 'notOwnCommand' }
  }
  const settlement = await slot
    .commandRun({ command: run.command, args: run.args ?? '' }, undefined, signal, undefined, { kind: 'bridge' })
    .catch((): CommandRunSettlement => ({ settled: false }))
  if (!settlement.settled || settlement.unanswered) return { ok: false, reason: 'unanswered' }
  const { text, exitCode } = settlement.result
  const said = typeof text === 'string' && text !== '' ? { text } : {}
  if (typeof exitCode === 'number' && exitCode !== 0) return { ok: false, reason: 'commandFailed', ...said }
  return { ok: true, via: 'command', ...said }
}

export type ThemeOnEnableTiming = {
  /** How many times to ask while the plugin is still loading. Default 12. */
  attempts?: number
  /** Default: half a second. */
  pause?: () => Promise<void>
}

/**
 * Runs the `onEnable` command the catalogue names for `plugin` in the session
 * behind `target.slot`, asking again while the plugin is still loading there
 * (just turned on, its module not yet up). Once loaded, it waits for the
 * plugin to start; when the plugin's own theme then stands, nothing runs, so
 * a command that moves to another look never moves off the one showing.
 * Never rejects.
 */
export async function runThemeOnEnable(
  target: ThemeLookTarget,
  plugin: string,
  timing: ThemeOnEnableTiming = {},
  signal?: AbortSignal,
): Promise<ThemeOnEnableResult> {
  const listing = target.listings?.find(candidate => candidate.name === plugin)
  const run = listing?.theme?.onEnable
  if (!listing || !run) return { ok: false, reason: 'none' }
  const installs = target.installsOf?.(listing) ?? [`${plugin}@${target.marketplace}`]
  const pause = timing.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 500)))
  const attempts = Math.max(1, timing.attempts ?? 12)
  let result: OwnCommandResult = { ok: false, reason: 'notLoaded' }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await pause()
    if (signal?.aborted) break
    const slot = target.slot
    const started = slot !== undefined && (!slot.hasLoaded || installs.some(install => slot.hasLoaded!(install)))
    if (started) {
      await slot.settled?.().catch(() => undefined)
      if (signal?.aborted) break
      if (slot.themeOwner?.() === plugin) return { ok: true, via: 'self' }
    }
    if (slot) result = await runOwnCommand(slot, plugin, installs, run, signal)
    if (result.ok) return result
    // Once the plugin has started, a command it did not register will not appear.
    const loading = result.reason === 'notLoaded' || (result.reason === 'notOwnCommand' && !started)
    if (!loading) return result
  }
  return result
}

/** Clears the theme of the session behind `slot`. */
export function clearSessionTheme(slot: ThemeLookSlot | undefined): ThemeClearResult {
  return { ok: true, cleared: slot?.clearTheme?.() ?? false }
}
