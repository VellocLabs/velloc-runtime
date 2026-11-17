import { extractGitHubTarball } from '../../pluginHost/extract'

const RAW_FILE_URL = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(refs\/(?:heads|tags)\/[^/]+|[0-9a-fA-F]{7,40})\/(.+)$/

/**
 * A fetch fake that answers the raw file host from repo tarballs: a raw URL
 * is looked up in the tarball `serveRepo` returns for the same repo and ref
 * (404 when the file is not in it); every other URL goes to `serveRepo`.
 */
export function rawHostFromTarballs(
  serveRepo: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const match = RAW_FILE_URL.exec(String(input))
    if (!match) return serveRepo(input, init)
    const [, owner, repo, ref, path] = match
    const archive = await serveRepo(`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`, init)
    if (!archive.ok) return archive
    const files = await extractGitHubTarball(new Uint8Array(await archive.arrayBuffer()))
    const wanted = path!.split('/').map(decodeURIComponent).join('/')
    const file = files.find(f => f.path === wanted)
    return file ? new Response(new Uint8Array(file.content), { status: 200 }) : new Response('404: Not Found', { status: 404 })
  }) as typeof fetch
}
