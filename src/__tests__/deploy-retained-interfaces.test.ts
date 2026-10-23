import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

// @ts-expect-error — plain .mjs build script, no type declarations
import { parseArgs } from '../../scripts/pack_artifact.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs build script, no type declarations
import { assembleSite, bundleBaseError, generatedHeaderBlocks, readRetainedInterfaces, resolveLegacySites, resolveRetentionBaselines, stageLegacyInterface } from '../../scripts/stage_deploy.mjs'
import { NEXUS_INTERFACE_VERSION } from '../browser/bridge/protocol/interfaceVersion.gen'

/**
 * Retained legacy interface versions (G-3): deploy/retained-interfaces.json names the /v<K>/ trees to carry, each
 * copied verbatim from one published release. Pinned: the bytes are untouched at their own base; a missing or
 * >= current version fails the stage; every served version gets its immutable cache block; the current version's
 * retention baseline and the legacy trees never mix.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'velloc-legacy-test-'))
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

let n = 0
const fresh = (label: string) => {
  n += 1
  const dir = join(tmp, `${label}-${n}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const write = (file: string, content: string | Buffer) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function listTree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(root, full).split('\\').join('/'))
    }
  }
  walk(root)
  return out.sort()
}

// A built bundle's index.html as stage_deploy sees it: the versioned asset
// base in its script URL and the nexus-build-time meta stageBuildEntry keys on.
const indexHtml = (version: number, buildTime = '2026-10-09T01:02:03.004Z') =>
  `<!doctype html><head><meta name="nexus-build-time" content="${buildTime}">` +
  `<script type="module" src="/v${version}/assets/index-ABCDEF12.js"></script></head>`

/** A release's unzipped site/ holding a frozen /v<version>/ tree. */
function legacyRelease(version: number, opts: { base?: number } = {}) {
  const site = join(fresh('legacy-release'), 'site')
  const v = join(site, `v${version}`)
  write(join(v, 'index.html'), indexHtml(opts.base ?? version, '2026-10-07T00:00:00.000Z'))
  write(join(v, 'assets', 'index-ABCDEF12.js'), `console.log("v${version}")`)
  write(join(v, 'assets', 'locales', 'en-11111111.json'), '{"hello":"Hello"}')
  // Binary bytes, so "verbatim" is checked on more than text.
  write(join(v, 'assets', 'logo-22222222.png'), Buffer.from([0, 255, 1, 254, 13, 10, 0]))
  write(join(v, 'assets-manifest.json'), '{"buildId":"old","assets":[]}')
  write(join(v, 'build-info.json'),
    JSON.stringify({ candidateId: `candidate-v${version}-abcdef0-42` }))
  write(join(v, 'b', '20261007T000000000Z', 'index.html'), indexHtml(version, '2026-10-07T00:00:00.000Z'))
  // Release-root files that belong to THAT build and must not leak into this one.
  write(join(site, 'index.html'), 'OLD LANDING PAGE')
  write(join(site, 'managed-binaries.json'), '{"old":true}')
  write(join(site, '_headers'), '/old-rule\n  X-Old: 1\n')
  return site
}

describe('readRetainedInterfaces — the committed config', () => {
  const config = (doc: unknown) => {
    const file = join(fresh('config'), 'retained-interfaces.json')
    write(file, typeof doc === 'string' ? doc : JSON.stringify(doc))
    return file
  }

  it('the committed deploy/retained-interfaces.json is valid at the current interface version', () => {
    // A stale entry (>= current) would fail every Workflow A run; pin it here
    // so the bump change and this file cannot drift past review.
    const result = readRetainedInterfaces(
      join(repoRoot, 'deploy', 'retained-interfaces.json'), NEXUS_INTERFACE_VERSION)
    expect(result.error).toBeUndefined()
    for (const entry of result.entries) {
      expect(entry.version).toBeLessThan(NEXUS_INTERFACE_VERSION)
      expect(entry.release.startsWith(`runtime-v${entry.version}-`)).toBe(true)
    }
  })

  it('an empty map retains nothing', () => {
    expect(readRetainedInterfaces(config({ retained: {} }), 2)).toEqual({ entries: [] })
    expect(readRetainedInterfaces(config({}), 2)).toEqual({ entries: [] })
  })

  it('returns the entries sorted by version', () => {
    const result = readRetainedInterfaces(config({
      retained: { 3: 'runtime-v3-2027.01.01.1', 1: 'runtime-v1-2026.10.07.1' },
    }), 4)
    expect(result).toEqual({
      entries: [
        { version: 1, release: 'runtime-v1-2026.10.07.1' },
        { version: 3, release: 'runtime-v3-2027.01.01.1' },
      ],
    })
  })

  it('refuses an entry equal to the current version — that path is built fresh', () => {
    const result = readRetainedInterfaces(
      config({ retained: { 1: 'runtime-v1-2026.10.07.1' } }), 1)
    expect(result.entries).toBeUndefined()
    expect(result.error).toMatch(/v1 is not older than the current v1/)
  })

  it('refuses an entry above the current version', () => {
    expect(readRetainedInterfaces(
      config({ retained: { 3: 'runtime-v3-2027.01.01.1' } }), 2).error)
      .toMatch(/v3 is not older than the current v2/)
  })

  it('refuses a tag that does not name its own version', () => {
    // A v2 release pinned under "1" holds no (or the wrong) v1/ tree.
    expect(readRetainedInterfaces(
      config({ retained: { 1: 'runtime-v2-2026.11.01.1' } }), 3).error)
      .toMatch(/must pin a published runtime-v1-\* release tag/)
    expect(readRetainedInterfaces(config({ retained: { 1: 42 } }), 3).error)
      .toMatch(/runtime-v1-/)
  })

  it('refuses a key that is not a version, a missing file and broken JSON', () => {
    expect(readRetainedInterfaces(config({ retained: { v1: 'runtime-v1-x' } }), 2).error)
      .toMatch(/not an interface version/)
    expect(readRetainedInterfaces(join(tmp, 'nope.json'), 2).error).toMatch(/missing/)
    expect(readRetainedInterfaces(config('{not json'), 2).error).toMatch(/not valid JSON/)
  })
})

describe('resolveLegacySites — supplied trees against the config', () => {
  const entries = [{ version: 1, release: 'runtime-v1-2026.10.07.1' }]

  it('matches each configured version to its site', () => {
    const site = legacyRelease(1)
    expect(resolveLegacySites(`1=${site}`, entries)).toEqual({
      sites: [{ version: 1, release: 'runtime-v1-2026.10.07.1', siteDir: resolve(site) }],
    })
  })

  it('nothing configured and nothing supplied is fine', () => {
    expect(resolveLegacySites(undefined, [])).toEqual({ sites: [] })
    expect(resolveLegacySites('', [])).toEqual({ sites: [] })
  })

  it('fails when a configured version was not supplied — never a silent drop', () => {
    const result = resolveLegacySites(undefined, entries)
    expect(result.sites).toBeUndefined()
    expect(result.error).toMatch(/v1 is retained \(pinned to runtime-v1-2026\.10\.07\.1\)/)
    expect(result.error).toMatch(/drops \/v1\//)
  })

  it('fails when the supplied dir is missing or holds no v<K>/index.html', () => {
    expect(resolveLegacySites(`1=${join(tmp, 'never-downloaded')}`, entries).error)
      .toMatch(/has no v1\/index\.html/)
    // A release tree for a different version is not a v1 tree.
    const v2site = legacyRelease(2)
    expect(resolveLegacySites(`1=${v2site}`, entries).error)
      .toMatch(/has no v1\/index\.html/)
  })

  it('fails on a version the config does not retain, on duplicates and on malformed segments', () => {
    const site = legacyRelease(1)
    expect(resolveLegacySites(`1=${site}${delimiter}2=${site}`, entries).error)
      .toMatch(/supplies v2, which deploy\/retained-interfaces\.json does not retain/)
    expect(resolveLegacySites(`1=${site}${delimiter}1=${site}`, entries).error)
      .toMatch(/names v1 twice/)
    expect(resolveLegacySites(site, entries).error).toMatch(/is not <version>=<site dir>/)
  })

  it('refuses a dir passed both as a legacy tree and as a current-version baseline', () => {
    const site = legacyRelease(1)
    expect(resolveLegacySites(`1=${site}`, entries, [site]).error)
      .toMatch(/both as the retained \/v1\/ tree and as a retention baseline/)
  })
})

describe('stageLegacyInterface — verbatim copy at its own base', () => {
  it('copies site/v<K>/ byte for byte and nothing else from the release', () => {
    const site = legacyRelease(1)
    const out = fresh('out-site')
    const result = stageLegacyInterface(
      { version: 1, release: 'runtime-v1-2026.10.07.1', siteDir: site }, out)
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({
      version: 1,
      release: 'runtime-v1-2026.10.07.1',
      candidateId: 'candidate-v1-abcdef0-42',
    })
    const source = listTree(join(site, 'v1'))
    expect(listTree(join(out, 'v1'))).toEqual(source)
    expect(result.files).toBe(source.length)
    for (const file of source) {
      expect(readFileSync(join(out, 'v1', file)).equals(readFileSync(join(site, 'v1', file))),
        `${file} must be byte-identical`).toBe(true)
    }
    // Root files of the old release stay behind.
    expect(readdirSync(out)).toEqual(['v1'])
  })

  it('fails when the legacy index.html is built for a different base', () => {
    // A v2 bundle staged as /v1/ would 404 every asset for every v1 binary.
    const site = legacyRelease(1, { base: 2 })
    const result = stageLegacyInterface(
      { version: 1, release: 'runtime-v1-x', siteDir: site }, fresh('out-site'))
    expect(result.error).toMatch(/does not reference \/v1\/assets\/ — the bundle was built for \/v2\/ but staged as \/v1\//)
    expect(result.error).toMatch(/^retained runtime-v1-x:/)
  })

  it('refuses to overwrite an already-staged version', () => {
    const site = legacyRelease(1)
    const out = fresh('out-site')
    mkdirSync(join(out, 'v1'))
    expect(stageLegacyInterface({ version: 1, release: 'r', siteDir: site }, out).error)
      .toMatch(/already staged/)
  })

  it('bundleBaseError accepts a bundle at its own base', () => {
    const site = legacyRelease(1)
    expect(bundleBaseError({ name: 'v1', dir: join(site, 'v1') })).toBeNull()
    expect(bundleBaseError({ name: 'v3', dir: join(site, 'v1') })).toMatch(/built for \/v1\//)
  })
})

describe('generatedHeaderBlocks — one immutable block per served version', () => {
  const immutable = /^\s+Cache-Control: public, max-age=31536000, immutable$/

  function rulesFor(headers: string, path: string): string[] {
    const lines = headers.split('\n')
    const start = lines.findIndex(line => line === path)
    expect(start, `${path} must have a header block`).toBeGreaterThanOrEqual(0)
    const body: string[] = []
    for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]); i += 1) body.push(lines[i])
    return body
  }

  it('covers assets/ and b/ of the current and of every retained version', () => {
    const headers = generatedHeaderBlocks(['v2', 'v1'])
    for (const name of ['v2', 'v1']) {
      for (const path of [`/${name}/assets/*`, `/${name}/b/*`]) {
        const rules = rulesFor(headers, path)
        expect(rules).toContain('  ! Cache-Control')
        expect(rules.some(rule => immutable.test(rule)), `${path} immutable`).toBe(true)
      }
    }
  })

  it('emits only the current version when nothing is retained', () => {
    const headers = generatedHeaderBlocks(['v1'])
    expect(headers).toMatch(/^\/v1\/assets\/\*$/m)
    expect(headers).not.toMatch(/^\/v2\//m)
  })
})

describe('assembleSite — a whole local stage with a fake legacy release', () => {
  // Everything main() does after the vite build, against fixture trees: the
  // fresh /v2/ from dist, a production baseline for /v2/, a frozen /v1/ from
  // its pinned release, root files, _headers, build-info.json. No deploy.
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function fixture() {
    const root = fresh('stage')
    const dist = join(root, 'dist')
    write(join(dist, 'index.html'), indexHtml(2))
    write(join(dist, 'assets', 'index-ABCDEF12.js'), 'console.log("v2")')
    write(join(dist, 'assets-manifest.json'), '{"buildId":"new","assets":[]}')
    const publicDir = join(root, 'public')
    write(join(publicDir, '_headers'), '/*\n  X-Base: 1\n')
    write(join(publicDir, 'managed-binaries.json'), '{"current":true}')
    const rootIndexPath = join(root, 'deploy', 'root-index.html')
    write(rootIndexPath, 'CURRENT LANDING PAGE')
    // Production's release AFTER the bump: carries /v2/ (the baseline) AND a
    // retained /v1/ — whose files must NOT donate to anything.
    const baselineSite = join(root, 'baseline', 'site')
    write(join(baselineSite, 'v2', 'assets', 'old-OLDOLD11.js'), 'old v2 chunk')
    write(join(baselineSite, 'v1', 'assets', 'baseline-v1-ZZZZZZZZ.js'), 'not the pinned v1')
    write(join(baselineSite, 'v1', 'index.html'), indexHtml(1))
    return {
      siteDir: join(root, 'site'), dist, publicDir, rootIndexPath, baselineSite,
      legacySite: legacyRelease(1),
    }
  }

  function stage(f: ReturnType<typeof fixture>, withLegacy: boolean) {
    const resolved = resolveRetentionBaselines(f.baselineSite, 'v2')
    expect(resolved.error).toBeUndefined()
    const legacy = resolveLegacySites(
      withLegacy ? `1=${f.legacySite}` : '',
      withLegacy ? [{ version: 1, release: 'runtime-v1-2026.10.07.1' }] : [],
      resolved.baselines.map((b: { dir: string }) => dirname(dirname(b.dir))))
    expect(legacy.error).toBeUndefined()
    return assembleSite({
      siteDir: f.siteDir,
      distDir: f.dist,
      currentVersion: 2,
      rootIndexPath: f.rootIndexPath,
      publicDir: f.publicDir,
      baselines: resolved.baselines,
      legacySites: legacy.sites,
      buildInfoExtra: { candidateId: 'candidate-v2-1234567-99' },
    })
  }

  it('serves the fresh /v2/ and the pinned /v1/ verbatim, with root files from the current build', () => {
    const f = fixture()
    const result = stage(f, true)

    // /v1/ is exactly the pinned release's tree — not the baseline's v1/.
    expect(listTree(join(f.siteDir, 'v1'))).toEqual(listTree(join(f.legacySite, 'v1')))
    for (const file of listTree(join(f.legacySite, 'v1'))) {
      expect(readFileSync(join(f.siteDir, 'v1', file))
        .equals(readFileSync(join(f.legacySite, 'v1', file)))).toBe(true)
    }
    expect(existsSync(join(f.siteDir, 'v1', 'assets', 'baseline-v1-ZZZZZZZZ.js'))).toBe(false)

    // Root files come from this checkout, never from the retained release.
    expect(readFileSync(join(f.siteDir, 'index.html'), 'utf8')).toBe('CURRENT LANDING PAGE')
    expect(readFileSync(join(f.siteDir, 'managed-binaries.json'), 'utf8')).toBe('{"current":true}')
    const headers = readFileSync(join(f.siteDir, '_headers'), 'utf8')
    expect(headers.startsWith('/*\n  X-Base: 1\n')).toBe(true)
    expect(headers).not.toMatch(/X-Old/)
    for (const path of ['/v2/assets/*', '/v2/b/*', '/v1/assets/*', '/v1/b/*']) {
      expect(headers.split('\n')).toContain(path)
    }
    expect(readdirSync(f.siteDir).sort())
      .toEqual(['_headers', 'index.html', 'managed-binaries.json', 'v1', 'v2'])

    // build-info.json of the CURRENT version records what rode along.
    const info = JSON.parse(readFileSync(join(f.siteDir, 'v2', 'build-info.json'), 'utf8'))
    expect(info.legacyInterfaces).toEqual([{
      interfaceVersion: 1,
      release: 'runtime-v1-2026.10.07.1',
      candidateId: 'candidate-v1-abcdef0-42',
    }])
    expect(info.candidateId).toBe('candidate-v2-1234567-99')
    // ...while /v1/build-info.json still names the candidate that built /v1/.
    expect(JSON.parse(readFileSync(join(f.siteDir, 'v1', 'build-info.json'), 'utf8')).candidateId)
      .toBe('candidate-v1-abcdef0-42')
    expect(result.legacy.map((l: { version: number }) => l.version)).toEqual([1])
  })

  it('leaves the current version\'s retention baseline exactly as without legacy', () => {
    const withLegacy = fixture()
    const without = fixture()
    const a = stage(withLegacy, true)
    const b = stage(without, false)
    expect(a.retained).toBe(1)
    expect(a.retained).toBe(b.retained)
    expect(a.retainedEntries).toBe(b.retainedEntries)
    // The baseline's v2 chunk was retained into /v2/; its v1 files went nowhere.
    expect(listTree(join(withLegacy.siteDir, 'v2'))).toEqual(listTree(join(without.siteDir, 'v2'))
      .filter(file => file !== 'build-info.json').concat('build-info.json').sort())
    expect(existsSync(join(withLegacy.siteDir, 'v2', 'assets', 'old-OLDOLD11.js'))).toBe(true)
    expect(listTree(join(withLegacy.siteDir, 'v2')).some(file => file.includes('baseline-v1'))).toBe(false)
    // Without retention configured, /v1/ is simply not served.
    expect(existsSync(join(without.siteDir, 'v1'))).toBe(false)
    expect(JSON.parse(readFileSync(join(without.siteDir, 'v2', 'build-info.json'), 'utf8'))
      .legacyInterfaces).toEqual([])
  })

  it('throws (fails the stage) on a wrong-base legacy tree', () => {
    const f = fixture()
    expect(() => assembleSite({
      siteDir: f.siteDir,
      distDir: f.dist,
      currentVersion: 2,
      rootIndexPath: f.rootIndexPath,
      publicDir: f.publicDir,
      legacySites: [{ version: 1, release: 'runtime-v1-x', siteDir: legacyRelease(1, { base: 2 }) }],
    })).toThrow(/does not reference \/v1\/assets\//)
  })
})

describe('the release workflows carry retained versions without rebuilding', () => {
  const workflows = join(repoRoot, '.github', 'workflows')
  const beta = parse(readFileSync(join(workflows, 'build-beta.yml'), 'utf8'))
  const steps = beta.jobs.pack.steps as Array<{ name?: string, id?: string, run?: string, 'continue-on-error'?: unknown }>

  it('Workflow A fetches every pinned release before packing, and a failed fetch fails the build', () => {
    const legacyIndex = steps.findIndex(step => step.id === 'legacy')
    const packIndex = steps.findIndex(step => step.name === 'Build and pack candidate')
    expect(legacyIndex).toBeGreaterThanOrEqual(0)
    expect(legacyIndex).toBeLessThan(packIndex)
    const legacy = steps[legacyIndex]
    expect(legacy['continue-on-error']).toBeUndefined()
    expect(legacy.run).toMatch(/set -euo pipefail/)
    expect(legacy.run).toMatch(/deploy\/retained-interfaces\.json/)
    // Download, verify, unpack — none of them guarded into a warning.
    expect(legacy.run).toMatch(/gh release download "\$TAG"/)
    expect(legacy.run).toMatch(/sha256sum -c SHA256SUMS/)
    expect(legacy.run).not.toMatch(/gh release download "\$TAG"[^\n]*\|\|/)
    expect(legacy.run).not.toMatch(/::warning::/)
    expect(steps[packIndex].run).toMatch(/--legacy "\$L"/)
  })

  it('pack_artifact accepts --legacy repeatedly', () => {
    expect(parseArgs(['--out', 'a', '--legacy', '1=x/site', '--legacy', '3=y/site']).legacy)
      .toEqual(['1=x/site', '3=y/site'])
  })

  it('promote and rollback deploy the unzipped artifact as a whole, so retained trees ride along', () => {
    for (const file of ['promote-production.yml', 'rollback-production.yml']) {
      const body = readFileSync(join(workflows, file), 'utf8')
      expect(body).toMatch(/wrangler@[\d.]+ deploy --config candidate\/wrangler\.toml/)
      expect(body).toMatch(/unzip -q artifact\/runtime\.zip -d candidate/)
    }
  })
})
