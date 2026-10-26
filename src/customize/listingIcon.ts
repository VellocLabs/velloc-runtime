/**
 * A picture for a marketplace plugin that the directory does not describe
 * (F-35). marketplace.json and plugin.json carry no image field, so the
 * picture is the avatar of the GitHub account that publishes the plugin:
 * the owner of its repository, else of its homepage, else of its author's page.
 */
import type { CatalogListing } from '../pluginHost/registryFormats'

/** A GitHub account name: letters, digits and single inner hyphens, at most 39. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** The account that owns a github.com URL (https, http, ssh or `git@` form), if any. */
export function githubOwnerOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  const scp = /^git@github\.com:([^/]+)\//i.exec(url.trim())
  let owner: string | undefined
  if (scp) {
    owner = scp[1]
  } else {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return undefined
    }
    if (!/^(https?|ssh|git\+https|git\+ssh):$/.test(parsed.protocol)) return undefined
    if (parsed.hostname.toLowerCase() !== 'github.com' && parsed.hostname.toLowerCase() !== 'www.github.com') return undefined
    owner = parsed.pathname.split('/')[1]
  }
  return owner && GITHUB_OWNER.test(owner) ? owner : undefined
}

/** The repository URL a listing installs from, when its source names one. */
function sourceRepoUrl(listing: CatalogListing): string | undefined {
  const source = listing.source as CatalogListing['source'] | string | undefined
  if (!source || typeof source !== 'object') return undefined
  if (source.source === 'github') return `https://github.com/${source.repo}`
  if (source.source === 'url' || source.source === 'git-subdir') return source.url
  return undefined
}

/** The avatar URL for a listing's publisher on GitHub, or undefined when it names no GitHub account. */
export function listingIconUrl(listing: CatalogListing): string | undefined {
  const owner =
    githubOwnerOf(sourceRepoUrl(listing)) ?? githubOwnerOf(listing.homepage) ?? githubOwnerOf(listing.author?.url)
  return owner ? `https://github.com/${owner}.png?size=96` : undefined
}
