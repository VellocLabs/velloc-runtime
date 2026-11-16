/**
 * Which shell a remote page boots (F-24): the phone entry `mobile.html` on a touch device with a
 * small screen, the desktop shell otherwise. A choice stored on this device overrides the guess.
 * Decided once per page load; turning the phone does not swap shells.
 */

/** This device's stored shell choice; absent = decide from the device. */
export const REMOTE_SHELL_CHOICE_KEY = 'nexus.remoteShell'

/** The phone entry, a sibling of `index.html` in the same build entry. */
export const MOBILE_ENTRY_FILE = 'mobile.html'

/** A touch screen whose short side is below this many CSS px gets the phone shell. */
export const MOBILE_SHELL_MAX_SCREEN_PX = 640

export type RemoteShellChoice = 'desktop' | 'mobile'

type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): ChoiceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The stored choice, or `null` when there is none, it is unknown, or storage is unavailable. */
export function readRemoteShellChoice(
  storage: ChoiceStorage | null = defaultStorage(),
): RemoteShellChoice | null {
  try {
    const value = storage?.getItem(REMOTE_SHELL_CHOICE_KEY)
    return value === 'desktop' || value === 'mobile' ? value : null
  } catch {
    return null
  }
}

/** Store this device's choice. Best-effort: unavailable storage leaves the guess in charge. */
export function writeRemoteShellChoice(
  choice: RemoteShellChoice,
  storage: ChoiceStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(REMOTE_SHELL_CHOICE_KEY, choice)
  } catch {
    // Unavailable storage: the next load decides from the device again.
  }
}

/** What the decision reads of the device. */
export type DeviceTraits = {
  coarsePointer: boolean
  /** `min(screen.width, screen.height)` in CSS px, so orientation does not change it. */
  screenShortSide: number
}

/** Read the device's traits. A window without `matchMedia` or `screen` reads as a desktop. */
export function readDeviceTraits(win: Pick<Window, 'matchMedia' | 'screen'>): DeviceTraits {
  let coarsePointer = false
  try {
    coarsePointer = win.matchMedia('(pointer: coarse)').matches
  } catch {
    coarsePointer = false
  }
  const width = win.screen?.width ?? Number.POSITIVE_INFINITY
  const height = win.screen?.height ?? Number.POSITIVE_INFINITY
  return { coarsePointer, screenShortSide: Math.min(width, height) }
}

/** Whether this device should get the phone shell: a stored choice wins, else the traits decide. */
export function wantsMobileShell(traits: DeviceTraits, choice: RemoteShellChoice | null): boolean {
  if (choice !== null) return choice === 'mobile'
  return traits.coarsePointer && traits.screenShortSide < MOBILE_SHELL_MAX_SCREEN_PX
}

export type MobileEntryEnv = {
  win: Pick<Window, 'matchMedia' | 'screen'> & { location: Pick<Location, 'pathname' | 'replace'> }
  baseUri: string
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'body'>>
  storage?: ChoiceStorage | null
}

/**
 * On the remote path, before any shell loads: navigate to the phone entry when this device wants
 * it and the listener serves it. Resolves `true` once the navigation is started (the caller stops
 * booting), `false` to boot the desktop shell here. A listener that does not serve the file (a
 * desktop on an older build) answers non-2xx, and the page stays on the desktop shell.
 */
export async function openMobileEntryIfWanted(env: MobileEntryEnv): Promise<boolean> {
  const choice = readRemoteShellChoice(env.storage === undefined ? defaultStorage() : env.storage)
  if (!wantsMobileShell(readDeviceTraits(env.win), choice)) return false
  if (env.win.location.pathname.endsWith(`/${MOBILE_ENTRY_FILE}`)) return false
  let target: string
  try {
    target = new URL(MOBILE_ENTRY_FILE, env.baseUri).href
  } catch {
    return false
  }
  try {
    const response = await env.fetch(target, { method: 'GET', credentials: 'same-origin' })
    void response.body?.cancel().catch(() => {})
    if (!response.ok) return false
  } catch {
    return false
  }
  env.win.location.replace(target)
  return true
}
