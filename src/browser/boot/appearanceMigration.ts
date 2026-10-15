/**
 * One-shot migration of a desktop panel's theme from the host's Chromium profile prefs into its own
 * localStorage; afterwards the host pref is never read. Idempotent via a sentinel key. A remote
 * client never migrates.
 */

import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import { BridgeRequestError, getAppearance } from '../webview/nexusBridgeActions'
import {
  GUEST_COLOR_SCHEME_STORAGE_KEY,
  parseGuestColorScheme,
  writeGuestColorScheme,
} from './guestColorScheme'
import {
  GUEST_ACCENT_STORAGE_KEY,
  GUEST_PALETTE_STORAGE_KEY,
  writeGuestAccent,
  writeGuestPalette,
} from './guestPalette'
import { matchThemeSwatch, THEME_SWATCHES } from '../webview/settings/appearanceOptions'

export const APPEARANCE_MIGRATION_SENTINEL_KEY = 'velloc.appearance.migratedFromHostPrefs.v1'

/** Bridge refusals that no retry changes: the route is absent or out of scope. */
const PERMANENT_CODES: ReadonlySet<string> = new Set(['unknown_route', 'forbidden_scope', 'NOT_IMPLEMENTED'])

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function alreadyMigrated(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(APPEARANCE_MIGRATION_SENTINEL_KEY) === '1'
  } catch {
    return false
  }
}

function markMigrated(storage: StorageLike | null): void {
  try {
    storage?.setItem(APPEARANCE_MIGRATION_SENTINEL_KEY, '1')
  } catch {
    // Storage unavailable — the migration simply re-runs next boot, which is
    // safe (it is only a write of the same values it wrote last time).
  }
}

/**
 * Run the migration if it has not run yet (fire-and-forget; a failure leaves the sentinel unset).
 * Returns true when it migrated something. Called once, before `installPerClientTheme`'s first resolve.
 */
export async function migrateAppearanceFromHostPrefs(
  transport: BrowserBridgeTransport,
  storage: StorageLike | null = defaultStorage(),
): Promise<boolean> {
  if (alreadyMigrated(storage)) return false

  let snapshot
  try {
    snapshot = await getAppearance(transport)
  } catch (error) {
    // The route will NEVER answer this client (older binary, or a remote
    // scoped out of it): nothing to migrate FROM, so mark done. Anything else
    // — a transport that dropped, a host not up yet — is transient, and
    // marking done there would skip the migration forever on one bad boot:
    // leave the sentinel unset and the next boot retries.
    if (error instanceof BridgeRequestError && PERMANENT_CODES.has(error.code)) {
      markMigrated(storage)
    }
    return false
  }

  // A client that ALREADY holds a local choice has nothing to migrate INTO:
  // either it was migrated before (the sentinel would say so, but a user can
  // clear keys by hand), or it picked something on a build that predates this
  // migration. Either way the local choice wins — clobbering it with a stale
  // host value would be a regression.
  const hasLocalScheme = ((): boolean => {
    try {
      return storage?.getItem(GUEST_COLOR_SCHEME_STORAGE_KEY) != null
    } catch {
      return false
    }
  })()
  const hasLocalPalette = ((): boolean => {
    try {
      return storage?.getItem(GUEST_PALETTE_STORAGE_KEY) != null
    } catch {
      return false
    }
  })()

  let migrated = false

  // Scheme: copy the host's mode verbatim when present and parseable.
  if (!hasLocalScheme) {
    const scheme = parseGuestColorScheme(snapshot.scheme)
    if (scheme !== null) {
      writeGuestColorScheme(scheme, storage)
      migrated = true
    }
  }

  // Colour: match the host's seed against the known swatches. A recognised
  // seed migrates as that swatch (chrome palette + seed + variant); an
  // unrecognised one (the user picked a colour Chrome's own picker offered
  // that we do not) migrates as palette=chrome with NO seed — Chrome's stock
  // palette — which is the closest honest rendering we can offer.
  if (!hasLocalPalette) {
    const hostColor = typeof snapshot.color === 'string' && snapshot.color !== '' ? snapshot.color : undefined
    if (hostColor !== undefined) {
      const swatchId = matchThemeSwatch(hostColor, 'chrome')
      const swatch = swatchId ? THEME_SWATCHES.find((s) => s.id === swatchId) : undefined
      writeGuestPalette('chrome', storage)
      if (swatch?.seed !== undefined || swatch?.variant !== undefined) {
        writeGuestAccent(
          {
            ...(swatch.seed !== undefined ? { seed: swatch.seed } : {}),
            ...(swatch.variant !== undefined ? { variant: swatch.variant } : {}),
          },
          storage,
        )
      } else {
        writeGuestAccent({}, storage)
      }
      migrated = true
    }
    // No user colour on the host → nothing to migrate, WHATEVER `variant`
    // says. The host emits `variant` for every profile (a fresh one answers
    // "system"), and Chrome itself ignores a variant that has no user colour,
    // so reading it as "the user chose the Chrome palette" moved every default
    // profile off Default on its first boot — inline host colours painted
    // where the classic palette paints none.
  }

  markMigrated(storage)
  return migrated
}
