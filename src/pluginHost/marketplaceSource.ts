/**
 * What a person types to name a marketplace: `owner/repo` or a GitHub
 * address. Pure, so a form can check the text before sending it.
 */

export type MarketplaceSourceInput = { source: 'github'; repo: string } | { source: 'url'; url: string }

/**
 * Parses `owner/repo` (github) or `https://github.com/...` (url); `null` when
 * unparseable. Not validated until fetch.
 */
export function parseMarketplaceSource(raw: string): MarketplaceSourceInput | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return { source: 'github', repo: trimmed }
  }
  if (/^https:\/\/(?:www\.)?github\.com\//.test(trimmed)) {
    // The url source's URL is what the fetch layer translates; keep it canonical.
    const normalised = trimmed.replace(/\.git\/?$/, '').replace(/\/$/, '')
    return { source: 'url', url: `${normalised}.git` }
  }
  return null
}

/** `owner/repo`, lower-cased, of a GitHub source; `null` for any other host. */
export function githubRepoOf(source: MarketplaceSourceInput): string | null {
  if (source.source === 'github') return source.repo.replace(/\.git$/, '').toLowerCase()
  const match = source.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}
