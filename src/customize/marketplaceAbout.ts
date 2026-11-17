/**
 * A marketplace's "About" (F-35): the description of the GitHub repository
 * it is fetched from, read from GitHub's public repository API.
 */
import type { DirectoryOfferDeps } from './directoryOffer'
import { githubRepoOf } from './listingIcon'

export const GITHUB_API_ORIGIN = 'https://api.github.com'
/** Longer descriptions are cut; the page shows three lines at most. */
const ABOUT_MAX_CHARS = 1000

/**
 * The repository description of `marketplace`, or undefined when it is not
 * added here, is not on GitHub, or its repository has none. Throws when the
 * lookup fails.
 */
export async function describeMarketplaceAbout(
  marketplace: string,
  deps: Pick<DirectoryOfferDeps, 'fetchJson' | 'listMarketplaces'>,
): Promise<string | undefined> {
  const entry = (await deps.listMarketplaces()).find(m => m.name === marketplace)
  const repo = githubRepoOf(entry?.source)
  if (!repo) return undefined
  const body = (await deps.fetchJson(`${GITHUB_API_ORIGIN}/repos/${repo}`)) as { description?: unknown } | null
  const text = typeof body?.description === 'string' ? body.description.trim() : ''
  return text ? text.slice(0, ABOUT_MAX_CHARS) : undefined
}
