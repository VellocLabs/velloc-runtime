import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Cache-Control contract for the deployed bundle (`public/_headers`, staged verbatim by scripts/stage_deploy.mjs).
 * The `/*` catch-all, which governs each `/v<N>/index.html`, uses `max-age=31536000` (boot from cache), never
 * `no-cache` / `must-revalidate` (would block boot), and `s-maxage=0` (the CDN always revalidates); the
 * content-hashed `/assets/*` stay `immutable`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const HEADERS = readFileSync(
  join(here, '..', '..', 'public', '_headers'),
  'utf8',
)

/**
 * Return the Cache-Control value for a given path rule in a Cloudflare
 * `_headers` file. Rules are `path\n  ! Cache-Control\n  Cache-Control: <v>`.
 */
function cacheControlFor(path: string): string {
  const lines = HEADERS.split('\n')
  const start = lines.findIndex((l) => l.trim() === path)
  expect(start, `no rule block for "${path}" in public/_headers`).toBeGreaterThanOrEqual(0)
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    // Stop at the next rule (a non-indented, non-comment, non-empty line).
    if (line.length > 0 && !/^\s/.test(line) && !line.startsWith('#')) break
    const m = /^\s*Cache-Control:\s*(.+)$/.exec(line)
    if (m) return m[1].trim()
  }
  throw new Error(`no Cache-Control directive under "${path}" in public/_headers`)
}

describe('public/_headers cache-control contract', () => {
  it('serves the catch-all (incl. index.html) with long max-age so a restart boots from cache instantly', () => {
    const cc = cacheControlFor('/*')
    // max-age=31536000: browser treats the copy as fresh for one year — every
    // boot serves from cache with zero network wait.
    expect(cc).toMatch(/(^|[,\s])max-age=31536000([,\s]|$)/)
    // s-maxage=0 forces Cloudflare to revalidate every request, so the
    // background fetch in index.html always gets the newest version.
    expect(cc).toMatch(/(^|[,\s])s-maxage=0([,\s]|$)/)
  })

  it('never forces a blocking revalidation on the catch-all (no boot hang on a bad network)', () => {
    const cc = cacheControlFor('/*')
    expect(cc).not.toMatch(/no-cache/)
    expect(cc).not.toMatch(/must-revalidate/)
    expect(cc).not.toMatch(/no-store/)
    // Chrome does not apply stale-while-revalidate to top-level document
    // navigations, so the old SWR approach was ineffective. The new strategy
    // uses long max-age + JS background fetch instead. SWR must not reappear.
    expect(cc).not.toMatch(/stale-while-revalidate/)
  })

  it('keeps content-hashed assets immutably cached (only changed chunks re-download)', () => {
    const cc = cacheControlFor('/assets/*')
    expect(cc).toMatch(/immutable/)
    expect(cc).toMatch(/max-age=\d{6,}/) // a year, not zero
  })

  it('stage_deploy generates an immutable block for the per-build entry path (/v<N>/b/*)', () => {
    // The live site/_headers is public/_headers verbatim plus blocks generated
    // by stage_deploy.mjs, so the per-build entry rule is not in the static
    // file above — it is emitted by the generator. Pin the generator emits it:
    // an entry URL names a build immutably, so it must cache forever
    // with no revalidation. Read the generator source rather than running a
    // stage, which would compile the bundle.
    const gen = readFileSync(
      join(here, '..', '..', 'scripts', 'stage_deploy.mjs'), 'utf8')
    const b = gen.indexOf('/${stagedName}/b/*')
    expect(b, 'stage_deploy.mjs must emit a /v<N>/b/* header block').toBeGreaterThanOrEqual(0)
    const block = gen.slice(b, b + 200)
    expect(block).toMatch(/Cache-Control: public, max-age=31536000, immutable/)
  })

  it('allows cross-origin reads on the catch-all — the channel probe depends on it', () => {
    // The About page's update-channel picker HEADs the OTHER channel's
    // /v<N>/ cross-origin (channelServesThisVersion). That probe fails
    // CLOSED, so without Access-Control-Allow-Origin the browser blocks the
    // response and a perfectly healthy channel renders as "Not available" —
    // the exact bug this rule fixed. /v<N>/index.html falls through to the
    // /* catch-all, so the header must live there.
    const lines = HEADERS.split('\n')
    const start = lines.findIndex((l) => l.trim() === '/*')
    expect(start).toBeGreaterThanOrEqual(0)
    let acao: string | null = null
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.length > 0 && !/^\s/.test(line) && !line.startsWith('#')) break
      const m = /^\s*Access-Control-Allow-Origin:\s*(.+)$/.exec(line)
      if (m) acao = m[1].trim()
    }
    expect(acao, 'the /* rule must send Access-Control-Allow-Origin').toBe('*')
  })

  it('refuses to be framed — the guest trusts postMessage senders by origin', () => {
    // The boot handshake (`nexus-init`), the theme feed (`nexus-theme`) and
    // the bridge bootstrap all ride postMessage. An origin gate rejects a
    // forged sender; frame-ancestors 'none' keeps a hostile page from getting
    // a window reference to post from in the first place. The desktop's
    // <webview> is its own top-level frame tree, so it is unaffected.
    const lines = HEADERS.split('\n')
    const start = lines.findIndex((l) => l.trim() === '/*')
    expect(start).toBeGreaterThanOrEqual(0)
    let csp: string | null = null
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.length > 0 && !/^\s/.test(line) && !line.startsWith('#')) break
      const m = /^\s*Content-Security-Policy:\s*(.+)$/.exec(line)
      if (m) csp = m[1].trim()
    }
    expect(csp, 'the /* rule must send Content-Security-Policy').not.toBeNull()
    expect(csp).toMatch(/(^|;\s*)frame-ancestors 'none'(\s*;|$)/)
  })

  it('bounds the frozen ROOT document cache — it has no background updater', () => {
    // `/` serves deploy/root-freeze/index.html (the pre-versioning build for
    // legacy binaries). That build predates the background cache updater, so
    // nothing ever revalidates its HTML: with the catch-all's year max-age a
    // legacy browser that loaded `/` once would be pinned to that copy for a
    // year — a later re-freeze (upgrade nudge, security notice) could never
    // reach it. The root document therefore needs its own BOUNDED rule.
    // /v<N>/index.html deliberately stays on the year catch-all (those
    // bundles carry the updater).
    for (const path of ['/', '/index.html']) {
      const cc = cacheControlFor(path)
      // Bounded: at most a day, never the year strategy.
      const maxAge = /(?:^|[,\s])max-age=(\d+)(?:[,\s]|$)/.exec(cc)
      expect(maxAge, `max-age missing for "${path}"`).not.toBeNull()
      expect(Number(maxAge![1])).toBeLessThanOrEqual(86_400)
      expect(Number(maxAge![1])).toBeGreaterThan(0)
      // Edge stays always-fresh so the bounded re-check sees a new freeze.
      expect(cc).toMatch(/(^|[,\s])s-maxage=0([,\s]|$)/)
      // Still must not block boot on a bad network.
      expect(cc).not.toMatch(/no-cache|must-revalidate|no-store/)
    }
  })
})

/**
 * Error responses are never cacheable: the gateway worker enforces it because `_headers` rules cannot condition
 * on status, and a 404 under the catch-all's year-long max-age would never be repaired.
 */
describe('deploy 404s are never cacheable (gateway worker)', () => {
  const repoRoot = join(here, '..', '..')
  const wrangler = readFileSync(join(repoRoot, 'wrangler.toml'), 'utf8')

  it('wrangler.toml wires the gateway worker in front of the assets', () => {
    expect(wrangler).toMatch(/^main = "worker\/asset_gateway\.mjs"$/m)
    expect(wrangler).toMatch(/^binding = "ASSETS"$/m)
    // Unset on purpose: matching assets must keep being served natively by
    // Cloudflare (zero worker latency/cost), with the worker invoked only
    // for requests no asset matched. Enabling it would put the worker on
    // every request — a routing change this contract does not want.
    expect(wrangler).not.toMatch(/^\s*run_worker_first/m)
  })

  it('the release artifact ships the worker next to wrangler.toml', () => {
    const pack = readFileSync(
      join(repoRoot, 'scripts', 'pack_artifact.mjs'),
      'utf8',
    )
    // promote runs `wrangler deploy --config <unzipped>/wrangler.toml`;
    // `main` resolves relative to the config, so a pack without worker/ is a
    // candidate that cannot deploy.
    expect(pack).toMatch(/packRoot, 'worker'/)
  })

  it('rewrites error responses to no-store and passes successes through untouched', async () => {
    const { default: gateway } = await import(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore -- plain .mjs worker module, no type declarations
      '../../worker/asset_gateway.mjs'
    )
    const respond = (status: number) =>
      new Response(status === 204 ? null : 'body', {
        status,
        headers: {
          'Cache-Control': 'public, max-age=31536000, s-maxage=0',
          'Access-Control-Allow-Origin': '*',
        },
      })
    const envFor = (status: number) => ({
      ASSETS: { fetch: async () => respond(status) },
    })
    const request = new Request('https://app.velloc.app/v9/index.html')

    const notFound = await gateway.fetch(request, envFor(404))
    expect(notFound.status).toBe(404)
    expect(notFound.headers.get('Cache-Control')).toBe('no-store')
    // The channel picker's cross-origin probe must be able to READ the 404
    // (a CORS-blocked response is indistinguishable from "not deployed").
    expect(notFound.headers.get('Access-Control-Allow-Origin')).toBe('*')

    const serverError = await gateway.fetch(request, envFor(500))
    expect(serverError.headers.get('Cache-Control')).toBe('no-store')

    // Success and redirect responses pass through with headers UNTOUCHED —
    // `_headers` stays the single source of truth for everything that
    // exists, even if worker routing ever changes to run-first.
    const ok = await gateway.fetch(request, envFor(200))
    expect(ok.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, s-maxage=0',
    )
    const redirect = await gateway.fetch(request, envFor(307))
    expect(redirect.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, s-maxage=0',
    )
  })
})
