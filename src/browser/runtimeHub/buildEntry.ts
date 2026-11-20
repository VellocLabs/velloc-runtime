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
  if (!key) return null
  let url: URL
  try {
    url = new URL(workerHref)
  } catch {
    return null
  }
  const m = /^\/runtime\/v([0-9]+)\//.exec(url.pathname)
  if (!m) return null
  const versionPath = `/runtime/v${m[1]}/`
  return `${url.origin}${versionPath}b/${key}/`
}
