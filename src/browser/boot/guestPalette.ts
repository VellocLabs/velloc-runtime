/**
 * The guest's palette (`classic`, the default, or `chrome`) and the Chrome seed + variant, per client
 * in localStorage. The host only resolves (`appearance.resolveTheme`) and writes no pref. A throwing
 * or empty storage reads as `classic` with no seed.
 */

export type GuestPalette = 'classic' | 'chrome'

export const GUEST_PALETTE_STORAGE_KEY = 'velloc.appearance.palette'

/**
 * The seed colour + variant the chrome palette resolves from. Absent on the
 * seedless swatches ("Default", which is the classic palette, and "Chrome",
 * which clears the seed and uses Chrome's stock palette). `#rrggbb` — the
 * same form the host parses.
 */
export const GUEST_ACCENT_STORAGE_KEY = 'velloc.appearance.accent'

export type GuestAccent = {
  /** `#rrggbb`. ABSENT means "no user colour" — Chrome's stock palette. */
  seed?: string
  /** Chrome's `BrowserColorVariant`. Absent defaults to `tonalSpot` host-side. */
  variant?: string
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const paletteListeners = new Set<(palette: GuestPalette) => void>()
const accentListeners = new Set<(accent: GuestAccent) => void>()

export function readGuestPalette(storage: StorageLike | null = defaultStorage()): GuestPalette {
  try {
    return storage?.getItem(GUEST_PALETTE_STORAGE_KEY) === 'chrome' ? 'chrome' : 'classic'
  } catch {
    return 'classic'
  }
}

/** Narrow a raw accent record; rejects anything malformed. */
function parseGuestAccent(value: unknown): GuestAccent | null {
  if (value === null || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  const out: GuestAccent = {}
  if (rec.seed !== undefined) {
    if (typeof rec.seed !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(rec.seed)) return null
    out.seed = rec.seed.toLowerCase()
  }
  if (rec.variant !== undefined) {
    if (typeof rec.variant !== 'string' || rec.variant === '') return null
    out.variant = rec.variant
  }
  return out
}

/** The stored accent, or `{}` (no user colour) when unset or malformed. */
export function readGuestAccent(storage: StorageLike | null = defaultStorage()): GuestAccent {
  try {
    const raw = storage?.getItem(GUEST_ACCENT_STORAGE_KEY)
    if (!raw) return {}
    return parseGuestAccent(JSON.parse(raw)) ?? {}
  } catch {
    return {}
  }
}

/** Persist the palette choice and notify subscribers (the host-theme receiver repaints). */
export function writeGuestPalette(
  palette: GuestPalette,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(GUEST_PALETTE_STORAGE_KEY, palette)
  } catch {
    // Storage unavailable: the choice still applies for this page's lifetime.
  }
  for (const listener of paletteListeners) listener(palette)
}

/** Persist the accent and notify subscribers. Passing `{}` clears the seed. */
export function writeGuestAccent(
  accent: GuestAccent,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(GUEST_ACCENT_STORAGE_KEY, JSON.stringify(accent))
  } catch {
    // Storage unavailable.
  }
  for (const listener of accentListeners) listener(accent)
}

/**
 * A write from ANOTHER window of this origin reaches this one only as a
 * `storage` event (the listener sets are per realm), so without this a second
 * Velloc window keeps painting the palette it booted with. The key's change —
 * or a storage clear (`key === null`) — is re-read and handed to `onChange`.
 * Same rule as guestTextSize.ts / showReasoning.ts. Returns a disposer.
 */
function listenCrossWindow(key: string, onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return
    onChange()
  }
  const target = typeof window === 'undefined' ? null : window
  target?.addEventListener('storage', onStorage)
  return () => target?.removeEventListener('storage', onStorage)
}

export function subscribeGuestPalette(listener: (palette: GuestPalette) => void): () => void {
  paletteListeners.add(listener)
  const stopCrossWindow = listenCrossWindow(GUEST_PALETTE_STORAGE_KEY, () =>
    listener(readGuestPalette()),
  )
  return () => {
    paletteListeners.delete(listener)
    stopCrossWindow()
  }
}

export function subscribeGuestAccent(listener: (accent: GuestAccent) => void): () => void {
  accentListeners.add(listener)
  const stopCrossWindow = listenCrossWindow(GUEST_ACCENT_STORAGE_KEY, () =>
    listener(readGuestAccent()),
  )
  return () => {
    accentListeners.delete(listener)
    stopCrossWindow()
  }
}
