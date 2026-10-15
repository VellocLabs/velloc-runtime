/**
 * Session permission modes: ids (persisted in settings and session metadata:
 * default · acceptEdits · plan · bypassPermissions · dontAsk; `auto` / `bubble`
 * are type-only), presentation, picker and the Shift+Ctrl+M ring.
 * `bypassPermissionsModeDisabled` removes bypassPermissions from all of them
 * and from `mayEnterMode`.
 */

/** Mode ids a user can write in settings or pick in the UI. */
export const SETTINGS_MODE_IDS = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

export type SettingsModeId = (typeof SETTINGS_MODE_IDS)[number]

/** Every mode id the runtime knows about, including the not-yet-enterable ones. */
export type SessionMode = SettingsModeId | 'auto' | 'bubble'

/** Abstract pill tone; the composer maps it to a text colour class. */
export type ModeTone = 'muted' | 'success' | 'info' | 'danger' | 'caution'

type ModeFace = {
  /** English label for the picker menu (the UI localizes the picker modes). */
  label: string
  /** English label for the composer pill. */
  pill: string
  tone: ModeTone
}

const ASK_FACE: ModeFace = { label: 'Ask permissions', pill: 'Ask', tone: 'muted' }

const FACES: Readonly<Record<string, ModeFace>> = {
  default: ASK_FACE,
  acceptEdits: { label: 'Accept edits', pill: 'Accept', tone: 'success' },
  plan: { label: 'Plan mode', pill: 'Plan', tone: 'info' },
  bypassPermissions: { label: 'Bypass permissions', pill: 'Bypass', tone: 'danger' },
  dontAsk: { label: "Don't ask", pill: 'DontAsk', tone: 'danger' },
  auto: { label: 'Auto mode', pill: 'Auto', tone: 'caution' },
}

function faceOf(mode: SessionMode): ModeFace {
  return Object.hasOwn(FACES, mode) ? FACES[mode]! : ASK_FACE
}

export const modeLabel = (mode: SessionMode): string => faceOf(mode).label
export const modePillLabel = (mode: SessionMode): string => faceOf(mode).pill
export const modeTone = (mode: SessionMode): ModeTone => faceOf(mode).tone

/** Read an untrusted string as a mode id; anything unknown is `default`. */
export function coerceSessionMode(value: string): SessionMode {
  const known: readonly string[] = SETTINGS_MODE_IDS
  return known.includes(value) ? (value as SettingsModeId) : 'default'
}

/** The picker's modes, top to bottom, with the kill switch applied. */
export function pickerModes(bypassDisabled: boolean | undefined): SessionMode[] {
  const all: SessionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
  return bypassDisabled ? all.filter(m => m !== 'bypassPermissions') : all
}

/** Whether a switch to `mode` is allowed under the given permission context. */
export function mayEnterMode(
  mode: string,
  context: { bypassPermissionsModeDisabled?: boolean } | undefined,
): boolean {
  return !(mode === 'bypassPermissions' && context?.bypassPermissionsModeDisabled)
}

export type CycleOptions = {
  /** The host offers bypass on the shortcut ring at all. */
  bypassOffered?: boolean
  /** The settings kill switch is on. */
  bypassDisabled?: boolean
}

/**
 * The mode Shift+Ctrl+M moves to. The ring is the picker list, minus bypass
 * unless it is offered; from a mode not on the ring it goes back to `default`.
 */
export function nextModeInCycle(current: string, options: CycleOptions = {}): SessionMode {
  const ring = pickerModes(options.bypassDisabled).filter(
    m => m !== 'bypassPermissions' || options.bypassOffered,
  )
  const at = ring.indexOf(current as SessionMode)
  return at < 0 ? 'default' : ring[(at + 1) % ring.length]!
}
