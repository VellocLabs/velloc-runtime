import { COMMUNITY_MARKETPLACE_NAME, CURATED_CATALOG_KEY } from './defaultMarketplace'

/** Catalog names only the publisher's own GitHub organisation may register. */
export const RESERVED_MARKETPLACE_NAMES: ReadonlySet<string> = new Set([
  CURATED_CATALOG_KEY,
  COMMUNITY_MARKETPLACE_NAME,
])

const PUBLISHER_GITHUB_OWNER = 'anthropics'

const isReserved = (name: string): boolean =>
  RESERVED_MARKETPLACE_NAMES.has(name.toLowerCase())

const squash = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')

// The part every reserved name starts with once case and separators are gone.
const RESERVED_STEM = (() => {
  const forms = [...RESERVED_MARKETPLACE_NAMES].map(squash)
  let stem = forms[0] ?? ''
  for (const f of forms) while (!f.startsWith(stem)) stem = stem.slice(0, -1)
  return stem
})()

/** True for a non-reserved name that could pass for a reserved one. */
export function looksLikeReservedName(name: string): boolean {
  if (isReserved(name)) return false
  if (/[^\x20-\x7e]/.test(name)) return true
  return RESERVED_STEM.length > 0 && squash(name).includes(RESERVED_STEM)
}

/** Null when `name` may come from `source`; otherwise why it may not. */
export function reservedNameSourceProblem(
  name: string,
  source: { source: string; repo?: string; url?: string },
): string | null {
  if (!isReserved(name)) return null
  const owner = PUBLISHER_GITHUB_OWNER
  let fromOwner = false
  if (source.source === 'github') {
    fromOwner = (source.repo ?? '').toLowerCase().startsWith(`${owner}/`)
  } else if (source.source === 'git' && source.url) {
    const url = source.url.toLowerCase()
    fromOwner = url.includes(`github.com/${owner}/`) || url.includes(`github.com:${owner}/`)
  }
  return fromOwner
    ? null
    : `'${name}' is a reserved marketplace name; it can only be added from a GitHub repository owned by ${owner}.`
}

/** Null for an acceptable marketplace name; otherwise the first problem found. */
export function marketplaceNameProblem(name: string): string | null {
  if (!name) return 'A marketplace needs a name.'
  if (name.includes(' ')) return 'Use dashes instead of spaces in a marketplace name.'
  if (/[/\\]/.test(name) || name.includes('..') || name === '.') {
    return 'A marketplace name is a single folder name: no slashes and no dot segments.'
  }
  if (looksLikeReservedName(name)) {
    return `'${name}' is too close to a reserved marketplace name (impersonation is not allowed).`
  }
  const lower = name.toLowerCase()
  if (lower === 'inline' || lower === 'builtin') {
    return `'${lower}' is used internally and cannot name a marketplace.`
  }
  return null
}
