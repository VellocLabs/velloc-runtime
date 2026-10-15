/**
 * The release's `update.json` and the decision it drives (F-30).
 *
 * Contract: `{ version, url, min_version? }`. A client installs `version` when
 * its own version is below `min_version`, or below `version` when
 * `min_version` is absent. Versions are four dotted integers.
 */

export type UpdateManifest = {
  version: string
  url: string
  minVersion?: string
}

/** Endpoints per channel; each redirects to the matching release asset. */
export const UPDATE_MANIFEST_URLS = {
  stable: 'https://velloc.app/update/stable.json',
  beta: 'https://velloc.app/update/beta.json',
} as const

type Version = readonly [number, number, number, number]

export function parseVersion(text: string): Version | null {
  const parts = text.trim().split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map(part => (/^\d{1,5}$/.test(part) ? Number(part) : Number.NaN))
  if (numbers.some(n => !Number.isInteger(n) || n > 65535)) return null
  return numbers as unknown as Version
}

/** Negative, zero or positive as `a` sorts below, equal to or above `b`. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 4; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/** The manifest, or a sentence saying why it is refused. */
export function parseUpdateManifest(value: unknown): UpdateManifest | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'manifest is not an object' }
  const v = value as Record<string, unknown>
  if (typeof v.version !== 'string' || !parseVersion(v.version)) return { error: 'manifest version is invalid' }
  if (typeof v.url !== 'string' || !isHttpsUrl(v.url)) return { error: 'manifest url must be https' }
  const manifest: UpdateManifest = { version: v.version.trim(), url: v.url }
  if (v.min_version !== undefined) {
    const minText = typeof v.min_version === 'string' ? v.min_version : ''
    const min = parseVersion(minText)
    if (!min) return { error: 'manifest min_version is invalid' }
    // A threshold above the package would make every install fall short of it and repeat.
    if (compareVersions(min, parseVersion(manifest.version)!) > 0) {
      return { error: 'manifest min_version is above version' }
    }
    manifest.minVersion = minText.trim()
  }
  return manifest
}

/** True when a client at `current` must install the manifest's package. */
export function shouldInstall(current: string, manifest: UpdateManifest): boolean {
  const own = parseVersion(current)
  const threshold = parseVersion(manifest.minVersion ?? manifest.version)
  if (!own || !threshold) return false
  return compareVersions(own, threshold) < 0
}

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:'
  } catch {
    return false
  }
}
