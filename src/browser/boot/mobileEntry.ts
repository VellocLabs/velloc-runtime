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

/**
 * Store this device's choice. `false` when storage is missing or refuses the write, so the caller
 * does not navigate into a page that would decide from the device again.
 */
export function writeRemoteShellChoice(
  choice: RemoteShellChoice,
  storage: ChoiceStorage | null = defaultStorage(),
): boolean {
  try {
    if (!storage) return false
    storage.setItem(REMOTE_SHELL_CHOICE_KEY, choice)
    return true
  } catch {
    return false
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

/** The desktop entry, `index.html`, beside the phone entry. */
export const DESKTOP_ENTRY_FILE = 'index.html'

/** Who is offered the phone shell by hand: a touch-first device of any screen size. */
export function offersPhoneShell(win: Pick<Window, 'matchMedia' | 'screen'>): boolean {
  return readDeviceTraits(win).coarsePointer
}

/**
 * The entry's absolute URL, when the listener serves it: a same-origin GET whose body is
 * dropped. `null` when the URL cannot be built, the fetch fails, or the answer is not 2xx.
 */
async function servedEntryUrl(
  env: { baseUri: string; fetch: MobileEntryEnv['fetch'] },
  file: string,
): Promise<string | null> {
  try {
    const target = new URL(file, env.baseUri).href
    const response = await env.fetch(target, { method: 'GET', credentials: 'same-origin' })
    void response.body?.cancel().catch(() => {})
    return response.ok ? target : null
  } catch {
    return null
  }
}

export type ShellSwitchEnv = {
  win: { location: Pick<Location, 'replace'> }
  baseUri: string
  fetch: MobileEntryEnv['fetch']
  storage?: ChoiceStorage | null
}

/**
 * What a shell switch did: it navigated; the listener does not serve the other entry (a desktop on
 * an older build); or storage refused the choice, so nothing was navigated and the page stayed put.
 */
export type ShellSwitchOutcome = 'switched' | 'not-served' | 'storage-blocked'

/** Remember the desktop shell for this device and load `index.html`. */
export function switchToDesktopShell(
  env: Omit<ShellSwitchEnv, 'fetch'>,
): Exclude<ShellSwitchOutcome, 'not-served'> {
  const stored = writeRemoteShellChoice(
    'desktop',
    env.storage === undefined ? defaultStorage() : env.storage,
  )
  // Without the stored choice the desktop entry re-derives the phone shell and sends the page back.
  if (!stored) return 'storage-blocked'
  env.win.location.replace(new URL(DESKTOP_ENTRY_FILE, env.baseUri).href)
  return 'switched'
}

/**
 * Remember the phone shell for this device and load `mobile.html`, when the listener serves it.
 * `not-served` (a desktop on an older build) and `storage-blocked` both leave the page here.
 */
export async function switchToMobileShell(env: ShellSwitchEnv): Promise<ShellSwitchOutcome> {
  const target = await servedEntryUrl(env, MOBILE_ENTRY_FILE)
  if (!target) return 'not-served'
  if (!writeRemoteShellChoice('mobile', env.storage === undefined ? defaultStorage() : env.storage)) {
    return 'storage-blocked'
  }
  env.win.location.replace(target)
  return 'switched'
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
  const target = await servedEntryUrl(env, MOBILE_ENTRY_FILE)
  if (!target) return false
  env.win.location.replace(target)
  return true
}
