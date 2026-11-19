/**
 * The `theme` block of a marketplace listing (F-14): the looks a theme plugin
 * offers, each with a preview picture and, for a pack, the plugin's own
 * command that picks it.
 *
 * Security: the block is catalogue data, read as untrusted. A look survives
 * only with a plain id, a preview that can be nothing but a picture at a
 * pinned or own-origin https address, and a `use` that names one command
 * word and one short lowercase argument; `onEnable` is held to the same
 * shape. Whether that command is the
 * plugin's own is checked where it runs.
 */

import { codeSourceOf, sameCode, type PluginCodeSource } from './codeSource'
import { joinPluginRef } from './pluginRef'
import type { CatalogListing, ListingTheme, ThemeLook, ThemeLookUse } from './registryFormats'

/**
 * The installs that are `listing`'s plugin: `<name>@<marketplace>`, then every
 * install of that name whose code is the listing's repository and folder,
 * whichever marketplace it came from. Names only; none need be installed.
 *
 * Security: an install under another marketplace counts only by its recorded
 * code source, never by its name alone.
 */
export function listingInstalls(
  installed: Readonly<Record<string, readonly { codeSource?: PluginCodeSource }[]>>,
  listing: Pick<CatalogListing, 'name' | 'source'>,
  marketplace: string,
): string[] {
  const own = joinPluginRef(listing.name, marketplace)
  const code = typeof listing.source === 'object' ? codeSourceOf(listing.source) : null
  if (!code) return [own]
  const others = Object.entries(installed).flatMap(([ref, rows]) =>
    ref !== own && ref.startsWith(`${listing.name}@`) && rows.some(row => row.codeSource && sameCode(row.codeSource, code))
      ? [ref]
      : [],
  )
  return [own, ...others]
}

/** A look id as the catalogue keeps it, and as `theme.useLook` accepts it. */
export function isLookId(value: unknown): value is string {
  return typeof value === 'string' && LOOK_ID.test(value)
}

/** At most this many looks are kept per listing. */
export const THEME_LOOKS_MAX = 64

const LOOK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const COMMAND_WORD = /^[A-Za-z0-9_-]{1,64}$/
const LOOK_ARGS = /^[a-z0-9-]{0,64}$/
const PICTURE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(svg|webp|png|jpg|gif)$/
const PINNED_RAW_PREFIX = /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\//
const HTTPS_ORIGIN_DIR = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/([A-Za-z0-9._-]+\/)*$/
const LOOPBACK_ORIGIN_DIR = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/([A-Za-z0-9._-]+\/)*$/
const NAME_MAX = 80
const DESCRIPTION_MAX = 400
const APPEARANCES = ['light', 'dark', 'both'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A path of plain segments ending in a picture extension, none of them dots alone. */
function isPicturePath(path: string): boolean {
  return PICTURE_PATH.test(path) && !path.split('/').some(segment => segment === '.' || segment === '..')
}

/** `https://raw.githubusercontent.com/<owner>/<repo>/<40-hex commit>/<picture path>`. */
function isPinnedRawPicture(url: string): boolean {
  const prefix = PINNED_RAW_PREFIX.exec(url)
  return prefix !== null && isPicturePath(url.slice(prefix[0].length))
}

/** A preview as a listing may write it: a picture path relative to the
 *  marketplace's directory, or an https picture address (which one is
 *  allowed is `resolveLookPreview`'s to say). */
function isPreviewCandidate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  if (isPicturePath(value)) return true
  const origin = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\//.exec(value)
  return origin !== null && isPicturePath(value.slice(origin[0].length))
}

function lookUseOf(raw: unknown): ThemeLookUse | null {
  if (!isRecord(raw)) return null
  if (typeof raw.command !== 'string' || !COMMAND_WORD.test(raw.command)) return null
  if (raw.args === undefined) return { command: raw.command }
  if (typeof raw.args !== 'string' || !LOOK_ARGS.test(raw.args)) return null
  return { command: raw.command, args: raw.args }
}

function lookOf(raw: unknown): ThemeLook | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !LOOK_ID.test(raw.id)) return null
  if (!isPreviewCandidate(raw.preview)) return null
  const look: ThemeLook = { id: raw.id, preview: raw.preview }
  if (typeof raw.name === 'string' && raw.name !== '') look.name = raw.name.slice(0, NAME_MAX)
  if (typeof raw.description === 'string' && raw.description !== '') {
    look.description = raw.description.slice(0, DESCRIPTION_MAX)
  }
  const appearance = APPEARANCES.find(a => a === raw.appearance)
  if (appearance) look.appearance = appearance
  if (raw.use !== undefined) {
    const use = lookUseOf(raw.use)
    if (!use) return null
    look.use = use
  }
  return look
}

/**
 * The listing's `theme` as written, checked. Undefined only when the listing
 * has none: a listing that writes one stays a theme listing even when no look
 * of it survives, so it is never treated as an ordinary plugin.
 */
export function normalizeListingTheme(raw: unknown): ListingTheme | undefined {
  if (raw === undefined || raw === null) return undefined
  const theme: ListingTheme = { looks: [] }
  if (!isRecord(raw)) return theme
  if (raw.official === true) theme.official = true
  const onEnable = raw.onEnable === undefined ? null : lookUseOf(raw.onEnable)
  if (onEnable) theme.onEnable = onEnable
  if (!Array.isArray(raw.looks)) return theme
  const seen = new Set<string>()
  for (const rawLook of raw.looks) {
    if (theme.looks.length >= THEME_LOOKS_MAX) break
    const look = lookOf(rawLook)
    if (!look || seen.has(look.id)) continue
    seen.add(look.id)
    theme.looks.push(look)
  }
  return theme
}

/**
 * The absolute address a look's preview is fetched from, or null when it may
 * not be shown. `originDir` is the directory the marketplace is served from,
 * with its trailing slash.
 *
 * Security: only a commit-pinned raw file, or a file under the marketplace's
 * own directory, over https (plain http for a loopback marketplace alone).
 */
export function resolveLookPreview(preview: string, originDir: string | null): string | null {
  if (isPinnedRawPicture(preview)) return preview
  if (originDir === null) return null
  if (!HTTPS_ORIGIN_DIR.test(originDir) && !LOOPBACK_ORIGIN_DIR.test(originDir)) return null
  if (isPicturePath(preview)) return `${originDir}${preview}`
  return preview.startsWith(originDir) && isPicturePath(preview.slice(originDir.length)) ? preview : null
}

/** `theme` with every preview absolute; a look whose preview may not be shown is left out. */
export function resolveListingTheme(theme: ListingTheme, originDir: string | null): ListingTheme {
  const looks: ThemeLook[] = []
  for (const look of theme.looks) {
    const preview = resolveLookPreview(look.preview, originDir)
    if (preview !== null) looks.push({ ...look, preview })
  }
  return { ...theme, looks }
}
