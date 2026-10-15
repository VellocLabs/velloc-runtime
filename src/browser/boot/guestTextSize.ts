/**
 * Text size: a five-step scale (`data-step` 1–5, default 2) that moves only the type tokens derived
 * from `<html data-text-size>`. Per client in localStorage; anything but "1"–"5" reads as the default.
 */

export type GuestTextSize = 1 | 2 | 3 | 4 | 5

export const GUEST_TEXT_SIZE_STORAGE_KEY = 'velloc.appearance.textSize'

/** The attribute `globals.css` keys the token steps on. */
export const GUEST_TEXT_SIZE_ATTR = 'data-text-size'

export const GUEST_TEXT_SIZES: readonly GuestTextSize[] = [1, 2, 3, 4, 5]

export const DEFAULT_GUEST_TEXT_SIZE: GuestTextSize = 2

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Narrow any raw value (storage, a select's string) to a step, else null. */
export function parseGuestTextSize(raw: unknown): GuestTextSize | null {
  const n = typeof raw === 'string' ? Number(raw) : raw
  return GUEST_TEXT_SIZES.find((s) => s === n) ?? null
}

const listeners = new Set<(size: GuestTextSize) => void>()

export function readGuestTextSize(storage: StorageLike | null = defaultStorage()): GuestTextSize {
  try {
    return parseGuestTextSize(storage?.getItem(GUEST_TEXT_SIZE_STORAGE_KEY)) ?? DEFAULT_GUEST_TEXT_SIZE
  } catch {
    return DEFAULT_GUEST_TEXT_SIZE
  }
}

/** Persist the choice and notify subscribers (the installed root re-stamps). */
export function writeGuestTextSize(
  size: GuestTextSize,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(GUEST_TEXT_SIZE_STORAGE_KEY, String(size))
  } catch {
    // Storage unavailable: the choice still applies for this page's lifetime.
  }
  for (const listener of listeners) listener(size)
}

export function subscribeGuestTextSize(listener: (size: GuestTextSize) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Stamp `<html data-text-size>` — idempotent. The default step is stamped
 *  too, so the attribute is always a truthful readout of the active scale. */
export function applyGuestTextSize(root: Element, size: GuestTextSize): void {
  root.setAttribute(GUEST_TEXT_SIZE_ATTR, String(size))
}

/**
 * Stamp `root` with the stored step now and on every later write, including another window's
 * (`storage` event, or a clear). Installed before the React shell. Returns a disposer.
 */
export function installGuestTextSize(
  root: Element,
  storage: StorageLike | null = defaultStorage(),
  eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null =
    typeof window === 'undefined' ? null : window,
): () => void {
  applyGuestTextSize(root, readGuestTextSize(storage))
  const unsubscribe = subscribeGuestTextSize((size) => applyGuestTextSize(root, size))
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== GUEST_TEXT_SIZE_STORAGE_KEY) return
    const size = readGuestTextSize(storage)
    for (const listener of listeners) listener(size)
  }
  eventTarget?.addEventListener('storage', onStorage)
  return () => {
    unsubscribe()
    eventTarget?.removeEventListener('storage', onStorage)
  }
}
