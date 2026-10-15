/**
 * The base an `assets-manifest.json`'s relative chunk URLs resolve from: a
 * build-entry copy (`/v<N>/b/<key>/`) resolves at the version root; anything
 * else is returned unchanged (F-24). Must stay import-free and imported only
 * from backgroundCacheUpdate (a classic-script entry).
 */
export function manifestAssetBase(manifestUrl: string): string {
  let url: URL
  try {
    url = new URL(manifestUrl)
  } catch {
    return manifestUrl
  }
  // `/v<N>/b/<key>/<file>` → `/v<N>/<file>`. The version segment is matched at
  // the START of the path, the same rule `buildEntryUrl` uses to find it.
  const entry = /^(\/v[0-9]+\/)b\/[^/]+\/(.*)$/.exec(url.pathname)
  if (!entry) return manifestUrl
  return new URL(entry[1] + entry[2], url).href
}
