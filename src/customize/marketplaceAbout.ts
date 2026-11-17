/**
 * A marketplace's "About" (F-35): the description of the GitHub repository
 * it is fetched from, read from GitHub's public repository API.
 */
import type { DirectoryOfferDeps } from './directoryOffer'
import { githubRepoOf } from './listingIcon'

export const GITHUB_API_ORIGIN = 'https://api.github.com'
/** Longer descriptions are cut; the page shows three lines at most. */
const ABOUT_MAX_CHARS = 1000

/** The GitHub `owner/repo` of `marketplace`, or undefined when it is not added here or not on GitHub. */
export async function marketplaceRepo(
  marketplace: string,
  deps: Pick<DirectoryOfferDeps, 'listMarketplaces'>,
): Promise<string | undefined> {
  const entry = (await deps.listMarketplaces()).find(m => m.name === marketplace)
  return githubRepoOf(entry?.source)
}

/**
 * The description of the GitHub repository `repo` (`owner/repo`, as
 * `githubRepoOf` answers it), or undefined when it has none. Throws when the
 * lookup fails.
 */
export async function describeRepositoryAbout(
  repo: string,
  deps: Pick<DirectoryOfferDeps, 'fetchJson'>,
): Promise<string | undefined> {
  const body = (await deps.fetchJson(`${GITHUB_API_ORIGIN}/repos/${repo}`)) as { description?: unknown } | null
  const text = typeof body?.description === 'string' ? body.description.trim() : ''
  return text ? text.slice(0, ABOUT_MAX_CHARS) : undefined
}
