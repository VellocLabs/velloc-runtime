/**
 * Where a plugin's code lives: a repository and the folder in it. Two
 * installs with the same repository and folder are the same plugin, whatever
 * they are named or wherever they were listed (F-35).
 */
import type { PluginOrigin } from './registryFormats'

/** `repo`: `<host>/<owner>/<name>`, lower-cased; `path`: the folder, `''` for the root; `sha`: the commit, when pinned. */
export type PluginCodeSource = { repo: string; path: string; sha?: string }

/** `https://github.com/Owner/Repo.git/…` → `github.com/owner/repo`; null when it names no repository. */
export function normalizeRepoUrl(url: string | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim().toLowerCase().replace(/^git@github\.com:/, 'https://github.com/')
  const match = /^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/#?]+)/.exec(trimmed)
  if (!match) return null
  return `${match[1]}/${match[2]}/${match[3]!.replace(/\.git$/, '')}`
}

/** `./plugins/x/` → `plugins/x`; dot segments are refused (null). */
export function normalizeCodePath(path: string | undefined): string | null {
  const parts = (path ?? '').replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) return null
  return parts.join('/')
}

/**
 * The code a listing installs. A listing kept inside its marketplace
 * (`local`) lives in the marketplace's own repository, so that source is
 * needed for it; `sha` is the commit fetched, when known.
 */
export function codeSourceOf(
  source: PluginOrigin,
  marketplaceSource?: PluginOrigin,
  sha?: string,
): PluginCodeSource | null {
  let repo: string | null = null
  let path: string | null = ''
  switch (source.source) {
    case 'github':
      repo = normalizeRepoUrl(`https://github.com/${source.repo}`)
      break
    case 'url':
      repo = normalizeRepoUrl(source.url)
      break
    case 'git-subdir':
      repo = /^[\w.-]+\/[\w.-]+$/.test(source.url)
        ? normalizeRepoUrl(`https://github.com/${source.url}`)
        : normalizeRepoUrl(source.url)
      path = normalizeCodePath(source.path)
      break
    case 'local': {
      const outer = marketplaceSource ? codeSourceOf(marketplaceSource) : null
      repo = outer?.repo ?? null
      const inner = normalizeCodePath(source.path)
      path = outer && inner !== null ? [outer.path, inner].filter(Boolean).join('/') : null
      break
    }
    default:
      return null
  }
  if (!repo || path === null) return null
  const pinned = sha ?? ('sha' in source && typeof source.sha === 'string' ? source.sha : undefined)
  return { repo, path, ...(pinned ? { sha: pinned } : {}) }
}

/** Same repository and folder; the commit is not compared. */
export function sameCode(a: PluginCodeSource, b: PluginCodeSource): boolean {
  return a.repo === b.repo && a.path === b.path
}

/** Whether `installed` is at commit `sha` (either may be abbreviated). */
export function sameCommit(installed: string | undefined, sha: string | undefined): boolean {
  if (!installed || !sha) return false
  const a = installed.toLowerCase()
  const b = sha.toLowerCase()
  return a.startsWith(b) || b.startsWith(a)
}
