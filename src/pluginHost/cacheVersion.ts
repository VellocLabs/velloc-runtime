/**
 * Picks the cache slot directory name for an installed plugin.
 * See docs F-14 "Cache-version slot".
 */
import type { PluginOrigin } from './registryFormats'

export type CacheVersionInput = {
  manifestVersion?: string
  catalogVersion?: string
  commitSha?: string
  source: PluginOrigin
}

function normaliseSubdir(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** 32-bit FNV-1a as 8 hex digits; only separates directories. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function pickCacheVersion(input: CacheVersionInput): string {
  if (input.manifestVersion) return input.manifestVersion
  if (input.catalogVersion) return input.catalogVersion
  if (input.commitSha) {
    const short = input.commitSha.slice(0, 12)
    if (input.source.source === 'git-subdir') {
      return `${short}-${fingerprint(normaliseSubdir(input.source.path))}`
    }
    return short
  }
  return 'unknown'
}
