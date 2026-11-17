/**
 * A picture for a marketplace plugin that the directory does not describe
 * (F-35). marketplace.json and plugin.json carry no image field, so the
 * picture is the avatar of the GitHub account that publishes the plugin:
 * the owner of its repository, else of its homepage, else of its author's page.
 */
import type { CatalogListing, PluginOrigin } from '../pluginHost/registryFormats'

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

/** The repository URL a source installs from, when it names one. */
function sourceRepoUrl(origin: PluginOrigin | string | undefined): string | undefined {
  const source = origin
  if (!source || typeof source !== 'object') return undefined
  if (source.source === 'github') return `https://github.com/${source.repo}`
  if (source.source === 'url' || source.source === 'git-subdir') return source.url
  return undefined
}

/** The avatar URL for a listing's publisher on GitHub, or undefined when it names no GitHub account. */
export function listingIconUrl(listing: CatalogListing): string | undefined {
  const owner =
    githubOwnerOf(sourceRepoUrl(listing.source)) ?? githubOwnerOf(listing.homepage) ?? githubOwnerOf(listing.author?.url)
  return owner ? `https://github.com/${owner}.png?size=96` : undefined
}

/** The avatar URL of the GitHub account a marketplace is fetched from, or undefined when its source is not on GitHub. */
export function marketplaceIconUrl(source: PluginOrigin | undefined): string | undefined {
  const owner = githubOwnerOf(sourceRepoUrl(source))
  return owner ? `https://github.com/${owner}.png?size=64` : undefined
}

/** A GitHub repository name: letters, digits, `.`, `_` and `-`, at most 100, and not `.` or `..`. */
const GITHUB_REPO = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/

/** The `owner/repo` a source is fetched from on GitHub, if any. */
export function githubRepoOf(source: PluginOrigin | undefined): string | undefined {
  const url = sourceRepoUrl(source)
  const owner = githubOwnerOf(url)
  if (!url || !owner) return undefined
  const path = /^git@github\.com:(.+)$/i.exec(url.trim())?.[1] ?? safePath(url)
  const repo = path?.replace(/^\/+/, '').split('/')[1]?.replace(/\.git$/i, '')
  return repo && GITHUB_REPO.test(repo) ? `${owner}/${repo}` : undefined
}

function safePath(url: string): string | undefined {
  try {
    return new URL(url.trim()).pathname
  } catch {
    return undefined
  }
}
