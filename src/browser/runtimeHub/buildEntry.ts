/**
 * The runtime's immutable build-entry URL (`/runtime/v<N>/b/<buildKey>/`), so a remote client can detect a
 * version skew. Derived from the worker's own href and the build stamp the starting page sent.
 */

import { buildKeyFromBuildTime } from '../../branding/buildInfo'

/**
 * Build-entry URL from the worker href and the boot build's ISO stamp; null for a dev server, an
 * invalid stamp, or a href whose path does not start with `/runtime/v<N>/`. Pure.
 */
export function buildEntryUrl(workerHref: string, buildIso: string | null): string | null {
  const key = buildIso ? buildKeyFromBuildTime(buildIso) : ''
  return key ? buildEntryUrlForKey(workerHref, key) : null
}

/**
 * Build-entry URL on `href`'s origin and version root for a build key; null for a malformed key or
 * a href whose path does not start with `/runtime/v<N>/`. Security: only a key of the build-key
 * shape reaches the path, so the result never leaves that origin's version root. Pure.
 */
export function buildEntryUrlForKey(href: string, key: string): string | null {
  if (!/^[0-9]{8}T[0-9]{9}Z$/.test(key)) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const m = /^\/runtime\/v([0-9]+)\//.exec(url.pathname)
  if (!m) return null
  return `${url.origin}/runtime/v${m[1]}/b/${key}/`
}
