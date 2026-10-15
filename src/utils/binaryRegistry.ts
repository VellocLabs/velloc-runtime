/**
 * Security: managed-binary registry, guest side. `managed-binaries.json` picks
 * what the host downloads and its expected hash, so it is fetched SAME-ORIGIN
 * only (no new trust root) and published via `model.publishBinaryRegistry`,
 * overriding the compiled-in fallback. Each entry's SHA-256 gates the binary
 * bytes and is re-validated host-side. Malformed entries are dropped
 * individually, matching the C++ parser.
 */

export type ManagedBinaryPlatform = 'win32' | 'darwin' | 'linux'
export type ManagedBinaryArch = 'x64' | 'arm64'
export type ManagedBinaryFormat = 'zip' | 'tar.gz'

export type ManagedBinaryAssetWire = {
  platform: ManagedBinaryPlatform
  arch: ManagedBinaryArch
  /** Pinned https download URL (a single release asset). */
  url: string
  /** Lowercase/uppercase hex SHA-256 of the archive bytes (64 chars). */
  sha256: string
  format: ManagedBinaryFormat
  /** Path of the executable member inside the archive (forward slashes). */
  member: string
}

export type ManagedBinaryWire = {
  /** Shell tool id == on-disk basename, e.g. "rg". */
  id: string
  label?: string
  version?: string
  assets: ManagedBinaryAssetWire[]
}

export type ManagedBinaryRegistryWire = {
  binaries: ManagedBinaryWire[]
}

/** Same-origin path the registry is served at.
 *
 *  Deliberately ROOT-absolute, not BASE_URL-relative: the registry is
 *  fleet-wide security-pin data (it controls which binaries hosts run),
 *  independent of the bridge interface version. Versioned deploys serve
 *  this one file at the site root so a pin update reaches every retained
 *  `/v<N>/` build and the frozen root build at once, without touching
 *  their otherwise-immutable snapshots (see scripts/stage_deploy.mjs). */
export const MANAGED_BINARIES_PATH = '/managed-binaries.json'

/** Re-fetch at most this often (a boot-time fetch is the common case; the
 *  TTL only matters if something calls repeatedly within a session). */
const TTL_MS = 5 * 60 * 1000

const PLATFORMS = new Set<string>(['win32', 'darwin', 'linux'])
const ARCHES = new Set<string>(['x64', 'arm64'])
const FORMATS = new Set<string>(['zip', 'tar.gz'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Allow https anywhere, and plain http ONLY for loopback (local dev
 *  servers / mirrors). A loopback http host is the same machine, so
 *  it adds no remote attack surface, and the SHA-256 remains the gate. */
function isAllowedUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.startsWith('https://')) return true
  try {
    const u = new URL(value)
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' ||
        u.hostname === '127.0.0.1' ||
        u.hostname === '[::1]' ||
        u.hostname === '::1')
    )
  } catch {
    return false
  }
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
}

function validateAsset(
  raw: unknown,
  where: string,
  errors: string[],
): ManagedBinaryAssetWire | null {
  if (!isRecord(raw)) {
    errors.push(`${where}: expected an object`)
    return null
  }
  const { platform, arch, url, sha256, format, member } = raw
  if (typeof platform !== 'string' || !PLATFORMS.has(platform)) {
    errors.push(`${where}.platform: must be win32|darwin|linux`)
    return null
  }
  if (typeof arch !== 'string' || !ARCHES.has(arch)) {
    errors.push(`${where}.arch: must be x64|arm64`)
    return null
  }
  if (!isAllowedUrl(url)) {
    errors.push(`${where}.url: must be https (or http on loopback)`)
    return null
  }
  if (!isHex64(sha256)) {
    errors.push(`${where}.sha256: must be 64 hex chars`)
    return null
  }
  if (typeof format !== 'string' || !FORMATS.has(format)) {
    errors.push(`${where}.format: must be zip|tar.gz`)
    return null
  }
  if (typeof member !== 'string' || member.length === 0) {
    errors.push(`${where}.member: required non-empty string`)
    return null
  }
  return {
    platform: platform as ManagedBinaryPlatform,
    arch: arch as ManagedBinaryArch,
    url,
    sha256,
    format: format as ManagedBinaryFormat,
    member,
  }
}

function validateBinary(
  raw: unknown,
  index: number,
  errors: string[],
): ManagedBinaryWire | null {
  if (!isRecord(raw)) {
    errors.push(`binaries[${index}]: expected an object`)
    return null
  }
  const id = raw.id
  if (typeof id !== 'string' || id.length === 0) {
    errors.push(`binaries[${index}].id: required non-empty string`)
    return null
  }
  if (!Array.isArray(raw.assets)) {
    errors.push(`binaries[${index}].assets: required array`)
    return null
  }
  const assets: ManagedBinaryAssetWire[] = []
  raw.assets.forEach((a, i) => {
    const asset = validateAsset(a, `binaries[${index}].assets[${i}]`, errors)
    if (asset) assets.push(asset)
  })
  if (assets.length === 0) {
    // A binary with no valid asset is useless; drop it.
    return null
  }
  return {
    id,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    assets,
  }
}

/**
 * Validate a parsed `managed-binaries.json`. Returns the registry with only
 * the valid binaries/assets, or `null` when nothing usable was found, plus
 * the list of per-entry problems (for logging).
 */
export function validateManagedBinaryRegistry(raw: unknown): {
  registry: ManagedBinaryRegistryWire | null
  errors: string[]
} {
  const errors: string[] = []
  if (!isRecord(raw) || !Array.isArray(raw.binaries)) {
    return { registry: null, errors: ['root: expected { binaries: [...] }'] }
  }
  const binaries: ManagedBinaryWire[] = []
  raw.binaries.forEach((b, i) => {
    const binary = validateBinary(b, i, errors)
    if (binary) binaries.push(binary)
  })
  return { registry: binaries.length > 0 ? { binaries } : null, errors }
}

/** The origin this guest was served from, or null when unknown (tests). */
function currentOrigin(): string | null {
  const loc = (globalThis as { location?: { origin?: string } }).location
  const origin = loc?.origin
  return typeof origin === 'string' && /^https?:\/\//.test(origin)
    ? origin
    : null
}

/** Build the same-origin registry URL. Returns null when no origin. */
export function resolveManagedBinariesUrl(origin?: string): string | null {
  const o = origin ?? currentOrigin()
  if (!o) return null
  // Relative path against the guest origin → same-origin by construction.
  return new URL(MANAGED_BINARIES_PATH, o).toString()
}

type CacheEntry = { registry: ManagedBinaryRegistryWire | null; fetchedAt: number }
let cache: CacheEntry | null = null

/** Test-only: drop the module-level cache between cases. */
export function __resetBinaryRegistryCacheForTests(): void {
  cache = null
}

export type FetchManagedBinaryRegistryOptions = {
  fetchImpl?: typeof fetch
  origin?: string
  now?: () => number
}

/**
 * Fetch + validate the same-origin `managed-binaries.json`. Returns the
 * validated registry, or `null` when there is no origin, the fetch fails,
 * or the file has no usable entries. Cached for `TTL_MS`. Never throws —
 * the host's compiled-in registry is the fallback, so a failure here just
 * means "no online override".
 */
export async function fetchManagedBinaryRegistry(
  opts: FetchManagedBinaryRegistryOptions = {},
): Promise<ManagedBinaryRegistryWire | null> {
  const now = opts.now ?? (() => Date.now())
  if (cache && now() - cache.fetchedAt < TTL_MS) {
    return cache.registry
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const url = resolveManagedBinariesUrl(opts.origin)
  if (!fetchImpl || !url) {
    return null
  }
  let registry: ManagedBinaryRegistryWire | null = null
  try {
    const res = await fetchImpl(url, { cache: 'no-cache', credentials: 'omit' })
    if (res.ok) {
      const json = (await res.json()) as unknown
      const validated = validateManagedBinaryRegistry(json)
      if (validated.registry === null && validated.errors.length > 0) {
        console.warn('[binaryRegistry] no usable entries:', validated.errors)
      }
      registry = validated.registry
    }
  } catch (e) {
    console.warn(
      '[binaryRegistry] fetch failed:',
      e instanceof Error ? e.message : e,
    )
  }
  cache = { registry, fetchedAt: now() }
  return registry
}
