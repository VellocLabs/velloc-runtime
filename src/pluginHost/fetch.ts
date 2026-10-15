/**
 * HTTPS-tarball fetch layer: GitHub codeload tarballs
 * (`https://codeload.github.com/<owner>/<repo>/tar.gz/<refspec>`, refspec a
 * branch ref, tag ref or 40-char sha) and direct `.tar.gz` / `.tgz` URLs, with
 * no git client. Any other URL is rejected at fetch time; `git://` and SSH are
 * out of scope.
 */

import type { PluginOrigin } from './registryFormats'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'

/** The bytes we fetched + the metadata the install op needs to record. */
export type FetchedTarball = {
  bytes: Uint8Array
  /** The exact URL we hit (logged + included in error messages). */
  url: string
  /** The pinned SHA we asked for, if any. */
  sha?: string
  /** Resolved refspec the URL was built from. */
  ref: string
}

/** Resolve a `PluginOrigin` to a fetchable HTTPS URL. Returns `null` for
 *  source kinds we can't fetch with HTTPS-only (`directory:`, `inline:`). */
export function resolveSourceFetchUrl(source: PluginOrigin): {
  url: string
  ref: string
  sha?: string
} | null {
  switch (source.source) {
    case 'github': {
      const ref = source.sha ?? source.ref ?? 'refs/heads/main'
      const refSegment = isFullRefSpec(ref) ? ref : `refs/heads/${ref}`
      const segment = source.sha ?? refSegment
      return {
        url: `https://codeload.github.com/${source.repo}/tar.gz/${segment}`,
        ref,
        sha: source.sha,
      }
    }
    case 'url': {
      const githubMatch = source.url.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
      )
      if (githubMatch) {
        const [, owner, repo] = githubMatch
        const ref = source.sha ?? source.ref ?? 'refs/heads/main'
        const refSegment = isFullRefSpec(ref) ? ref : `refs/heads/${ref}`
        const segment = source.sha ?? refSegment
        return {
          url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${segment}`,
          ref,
          sha: source.sha,
        }
      }
      // Direct HTTP(S) tarball URL (a `.tar.gz`/`.tgz` a self-hosted or test
      // server serves). The fetch layer (`network.httpGet`) accepts http + https
      // schemes, so this also backs the e2e fake-marketplace server. Anything
      // that isn't a github.com repo URL nor a direct tarball stays rejected.
      if (/^https?:\/\/.+\.(tar\.gz|tgz)(\?.*)?$/i.test(source.url)) {
        return {
          url: source.url,
          ref: source.sha ?? source.ref ?? 'direct',
          sha: source.sha,
        }
      }
      return null
    }
    case 'git-subdir': {
      // just `path`; nexus has no git, so the install op fetches the WHOLE repo
      // tarball here and re-roots at `path` afterwards (extract.ts#extractSubdir).
      // GitHub-only in v1 — accept `owner/repo` shorthand, https github.com, or
      // git@ SSH; anything else is not codeload-reachable.
      const repo = parseGitHubRepo(source.url)
      if (!repo) return null
      const ref = source.sha ?? source.ref ?? 'refs/heads/main'
      const refSegment = isFullRefSpec(ref) ? ref : `refs/heads/${ref}`
      const segment = source.sha ?? refSegment
      return {
        url: `https://codeload.github.com/${repo}/tar.gz/${segment}`,
        ref,
        sha: source.sha,
      }
    }
    case 'https': {
      // A plugin archive (`.tar.gz`) at an https URL; the fetch layer
      // (`httpsSource.ts`) enforces https again on the final URL.
      if (!/^https:\/\//i.test(source.url)) return null
      return { url: source.url, ref: 'https' }
    }
    case 'local':
      // A local `"./path"` plugin source is read from the cached marketplace
      // content dir by the install op, never fetched as a tarball.
      return null
    case 'directory':
    case 'inline':
      return null
  }
}

function isFullRefSpec(ref: string): boolean {
  return ref.startsWith('refs/')
}

/** Normalize a `git-subdir` source's `url` to GitHub `owner/repo`, or null when
 *  it isn't a GitHub repo nexus can reach via codeload. Accepts the three forms
 *  `https://github.com/owner/repo(.git)` URL, and a `git@github.com:owner/repo(.git)`
 *  SSH URL. */
function parseGitHubRepo(spec: string): string | null {
  const s = spec.trim()
  const https = s.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  )
  if (https) return `${https[1]}/${https[2]}`
  const ssh = s.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (ssh) return `${ssh[1]}/${ssh[2]}`
  // `owner/repo` shorthand: exactly one slash, no scheme / host / whitespace.
  const shorthand = s.match(/^([^/\s:@]+)\/([^/\s:@]+?)(?:\.git)?$/)
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`
  return null
}

/** Detect if `source` is reachable by the v1 HTTPS-only fetcher. */
export function isFetchableSource(source: PluginOrigin): boolean {
  return resolveSourceFetchUrl(source) !== null
}

/** Fetch a tarball from an arbitrary URL. Bare transport for tests. */
export async function fetchTarballBytes(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      credentials: 'omit',
    })
  } catch (e) {
    throw new Error(
      `[fetch] network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!response.ok) {
    throw new Error(
      `[fetch] HTTP ${response.status} ${response.statusText} fetching ${url}`,
    )
  }
  const buf = await response.arrayBuffer()
  return new Uint8Array(buf)
}

/** High-level helper: resolve a `PluginOrigin` to a URL, fetch it, return
 *  the bytes + metadata. */
export async function fetchSourceTarball(
  source: PluginOrigin,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<FetchedTarball> {
  const resolved = resolveSourceFetchUrl(source)
  if (!resolved) {
    throw new Error(
      `[fetch] source kind '${source.source}' is not HTTPS-fetchable`
      + ` in v1; only github sources and HTTPS github.com URLs are supported.`
      + ` For directory / inline / non-GitHub sources, use the manual install path`
      + ` (clone the plugin repo into ~/${RUNTIME_DIR_NAME}/plugins/<name>/).`,
    )
  }
  const bytes = await fetchTarballBytes(resolved.url, fetchImpl)
  return {
    bytes,
    url: resolved.url,
    ref: resolved.ref,
    sha: resolved.sha,
  }
}
