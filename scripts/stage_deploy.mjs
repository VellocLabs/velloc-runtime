// Contract: assembles the Cloudflare deploy directory `site/` (gitignored) for
// `npm run deploy:stage`. A deploy replaces the whole site, so what is not
// staged here is not served (G-3).
//   site/index.html             deploy/root-index.html (bare-origin landing page)
//   site/v<N>/                  the current interface version, built fresh from src/
//   site/v<K>/ (K < N)          retained versions, byte copies of the release pinned
//                               in deploy/retained-interfaces.json (STAGE_LEGACY_SITES);
//                               a configured version that is not supplied fails the stage
//   site/managed-binaries.json  fleet-wide security-pin data; the guest's only
//                               root-relative fetch
//   site/_headers               public/_headers + immutable-cache blocks for every
//                               served version's assets/ and b/
// verifyBundleBase() fails the stage when a bundle sits at a path it was not
// built for. There is one staging mode: compile the current version from src/.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { readBuildKeyFromIndexHtml } from './lib/buildKey.mjs'
import { isMainModule } from './lib/isMainModule.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const deployDir = path.join(repoRoot, 'deploy')
const siteDir = path.join(repoRoot, 'site')
const publicDir = path.join(repoRoot, 'public')
const retainedInterfacesPath = path.join(deployDir, 'retained-interfaces.json')

function fail(message) {
  console.error(`stage_deploy: ${message}`)
  process.exit(1)
}

// The guest-side constant is a GENERATED artifact (single source of truth:
// src/custom_browser/VERSION; regenerate with check_interface_version.py
// --sync); parse it the same way the custom_browser build gate does.
function readInterfaceVersion() {
  const tsPath = path.join(
    repoRoot, 'src', 'browser', 'bridge', 'protocol', 'interfaceVersion.gen.ts')
  const match = /^export const NEXUS_INTERFACE_VERSION = (\d+)$/m.exec(
    fs.readFileSync(tsPath, 'utf8'))
  if (!match) {
    fail(`could not parse NEXUS_INTERFACE_VERSION from ${tsPath}`)
  }
  return Number.parseInt(match[1], 10)
}

// A staged bundle must be built with VERSIONED_DEPLOY=1 at the version of the
// directory it sits in, or every asset request 404s into a blank panel;
// index.html's script/link URLs carry that base. Returns the failure message,
// or null. Exported for tests.
export function bundleBaseError(bundle) {
  const indexPath = path.join(bundle.dir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    return `${bundle.dir} has no index.html — not a built bundle`
  }
  const html = fs.readFileSync(indexPath, 'utf8')
  const expectedPrefix = `/${bundle.name}/assets/`
  if (!html.includes(expectedPrefix)) {
    const found = /\/(v\d+)\/assets\//.exec(html)
    return (
      `${indexPath} does not reference ${expectedPrefix} — the bundle was ` +
      (found
        ? `built for /${found[1]}/ but staged as /${bundle.name}/`
        : 'not built with VERSIONED_DEPLOY=1') +
      '. Rebuild with `npm run build:versioned` at the matching interface version.')
  }
  return null
}

function verifyBundleBase(bundle) {
  const error = bundleBaseError(bundle)
  if (error) fail(error)
}

/**
 * Read deploy/retained-interfaces.json: older interface versions that stay
 * served, each pinned to one published release tag, e.g.
 * `{ "retained": { "1": "runtime-v1-2026.10.07.1" } }`. A pinned tag keeps a
 * frozen version's bytes fixed. Refuses a key at or above the current version
 * and a tag that does not name its own version. Returns `{ entries }` sorted
 * ascending, or `{ error }`. Pure; exported for tests.
 */
export function readRetainedInterfaces(configPath, currentVersion) {
  if (!fs.existsSync(configPath)) {
    return { error: `missing ${configPath} — the committed list of retained interface versions` }
  }
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    return { error: `${configPath} is not valid JSON: ${error.message}` }
  }
  const retained = doc?.retained ?? {}
  if (typeof retained !== 'object' || Array.isArray(retained) || retained === null) {
    return { error: `${configPath}: "retained" must be an object of version -> release tag` }
  }
  const entries = []
  for (const [key, release] of Object.entries(retained)) {
    if (!/^[1-9]\d*$/.test(key)) {
      return { error: `${configPath}: "${key}" is not an interface version (a positive integer)` }
    }
    const version = Number.parseInt(key, 10)
    if (version >= currentVersion) {
      return {
        error:
          `${configPath}: retained interface v${version} is not older than the ` +
          `current v${currentVersion}. The current version is always built fresh ` +
          'from src/; only versions below it can be retained.',
      }
    }
    if (typeof release !== 'string' || !release.startsWith(`runtime-v${version}-`)) {
      return {
        error:
          `${configPath}: v${version} must pin a published runtime-v${version}-* ` +
          `release tag, got ${JSON.stringify(release)}`,
      }
    }
    entries.push({ version, release })
  }
  entries.sort((a, b) => a.version - b.version)
  return { entries }
}

/**
 * Match the legacy sites Workflow A supplied (`STAGE_LEGACY_SITES=<K>=<dir>`,
 * path.delimiter-joined; each a release's unzipped `site/`) against the config.
 * Fails on a configured version with no site, an unretained or repeated version,
 * a site without v<K>/index.html, or a site that is also a retention baseline.
 * Returns `{ sites: [{ version, release, siteDir }] }` in config order, or
 * `{ error }`. Pure; exported for tests.
 */
export function resolveLegacySites(env, entries, baselineRoots = []) {
  const supplied = new Map()
  for (const segment of (env ?? '').split(path.delimiter).filter(Boolean)) {
    const match = /^([1-9]\d*)=(.+)$/.exec(segment)
    if (!match) {
      return { error: `STAGE_LEGACY_SITES segment "${segment}" is not <version>=<site dir>` }
    }
    const version = Number.parseInt(match[1], 10)
    if (supplied.has(version)) {
      return { error: `STAGE_LEGACY_SITES names v${version} twice` }
    }
    supplied.set(version, path.resolve(match[2]))
  }
  const configured = new Set(entries.map(e => e.version))
  for (const version of supplied.keys()) {
    if (!configured.has(version)) {
      return {
        error:
          `STAGE_LEGACY_SITES supplies v${version}, which deploy/retained-interfaces.json ` +
          'does not retain — add it there (with its pinned release) or stop fetching it',
      }
    }
  }
  const baselines = new Set(baselineRoots.map(root => path.resolve(root)))
  const sites = []
  for (const { version, release } of entries) {
    const siteDir = supplied.get(version)
    if (!siteDir) {
      return {
        error:
          `interface v${version} is retained (pinned to ${release}) but ` +
          'STAGE_LEGACY_SITES supplies no site for it. Without it this deploy ' +
          `drops /v${version}/ and every binary pinned to it 404s. Download the ` +
          `release and pass ${version}=<unzipped>/site.`,
      }
    }
    if (baselines.has(siteDir)) {
      return {
        error:
          `${siteDir} is passed both as the retained /v${version}/ tree and as a ` +
          'retention baseline of the current version — they are different inputs',
      }
    }
    if (!fs.existsSync(path.join(siteDir, `v${version}`, 'index.html'))) {
      return {
        error:
          `STAGE_LEGACY_SITES v${version}=${siteDir} has no v${version}/index.html — ` +
          `point it at the unzipped site/ of ${release}`,
      }
    }
    sites.push({ version, release, siteDir })
  }
  return { sites }
}

/**
 * Copy one retained version's tree verbatim, `<siteDir>/v<K>/` →
 * `<outSiteDir>/v<K>/`, including its build-info.json and b/<key>/ entries;
 * the release's root files and _headers are not taken. Returns
 * `{ version, release, candidateId, files }` or `{ error }` (target already
 * staged, or a bundle base that is not /v<K>/assets/). Exported for tests.
 */
export function stageLegacyInterface(site, outSiteDir) {
  const name = `v${site.version}`
  const target = path.join(outSiteDir, name)
  if (fs.existsSync(target)) {
    return { error: `${target} is already staged — /${name}/ cannot be served twice` }
  }
  fs.cpSync(path.join(site.siteDir, name), target, { recursive: true })
  const baseError = bundleBaseError({ name, dir: target })
  if (baseError) {
    return { error: `retained ${site.release}: ${baseError}` }
  }
  let candidateId = null
  const infoPath = path.join(target, 'build-info.json')
  if (fs.existsSync(infoPath)) {
    try {
      candidateId = JSON.parse(fs.readFileSync(infoPath, 'utf8')).candidateId ?? null
    } catch {
      candidateId = null
    }
  }
  return { version: site.version, release: site.release, candidateId, files: countFiles(target) }
}

/**
 * The generated part of site/_headers: one immutable block per SERVED
 * version, current and retained alike — a retained /v<K>/ still has hashed
 * assets and per-build entries that must cache forever, or every legacy boot
 * re-downloads its whole bundle. Literal paths — Workers-assets placeholder
 * support isn't relied on. /v<N>/index.html deliberately falls through to the
 * catch-all (see public/_headers). Pure; exported for tests.
 */
export function generatedHeaderBlocks(stagedNames) {
  return stagedNames.map(stagedName =>
    `# Generated by scripts/stage_deploy.mjs — content-hashed bundles of the\n` +
    `# /${stagedName}/ interface-version deploy.\n` +
    `/${stagedName}/assets/*\n` +
    `  ! Cache-Control\n` +
    `  Cache-Control: public, max-age=31536000, immutable\n` +
    `# Immutable per-build entries (stageBuildEntry): the bytes at a b/<key>/\n` +
    `# URL never change, so they cache forever with no revalidation.\n` +
    `/${stagedName}/b/*\n` +
    `  ! Cache-Control\n` +
    `  Cache-Control: public, max-age=31536000, immutable\n` +
    `# Model catalog snapshot: fixed URLs whose bytes change per deploy, so a\n` +
    `# day-long cache with edge revalidation, never immutable.\n` +
    `/${stagedName}/catalog/snapshot/*\n` +
    `  ! Cache-Control\n` +
    `  Cache-Control: public, max-age=86400, s-maxage=0\n`).join('\n')
}

// Fresh `npm run build:versioned` of this checkout — the staged content for
// the current version, and the only thing that ever ends up under /v<N>/.
function buildCurrentDist() {
  const build = spawnSync(
    process.execPath, [path.join(repoRoot, 'scripts', 'build_versioned.mjs')],
    { cwd: repoRoot, stdio: 'inherit' })
  if (build.status !== 0) {
    fail(`versioned build failed (exit ${build.status})`)
  }
  const distDir = path.join(repoRoot, 'dist')
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    fail(`no ${distDir}/index.html after the build`)
  }
  return distDir
}

/**
 * The retention baseline: assets an already-open session may still lazy-import
 * after this deploy. STAGE_RETENTION_BASELINE is a staged `site/` unpacked from
 * the release currently in production; unset means none (the first deploy of a
 * version). A set-but-missing dir is `{ error }`, never a silent zero, since it
 * would 404 open sessions' next import. Returns `{ dir }`, `{ dir: null }` or
 * `{ error }`. Exported for tests.
 */
export function resolveRetentionBaseline(baselineRoot, stagedName) {
  if (baselineRoot === undefined || baselineRoot === '') {
    return { dir: null }
  }
  const dir = path.join(baselineRoot, stagedName, 'assets')
  if (!fs.existsSync(dir)) {
    return {
      error:
        `STAGE_RETENTION_BASELINE=${baselineRoot} has no ${stagedName}/assets/ — ` +
        'point it at a staged site/ tree of the release currently in production',
    }
  }
  return { dir }
}

// STAGE_RETENTION_BASELINE may carry several path-separated baselines
// (production's release, then the previous beta candidate). Each resolves in
// order; the first set-but-missing one is `{ error }`. Returns `{ baselines }`
// in env order, the retention precedence (production's bytes win a collision).
// Exported for tests.
export function resolveRetentionBaselines(env, stagedName) {
  if (env === undefined || env === '') return { baselines: [] }
  const baselines = []
  for (const root of env.split(path.delimiter).filter(Boolean)) {
    const r = resolveRetentionBaseline(root, stagedName)
    if (r.error) return { error: r.error }
    if (r.dir) baselines.push(r)
  }
  return { baselines }
}

// Hashed assets the baseline carries but the fresh build no longer emits stay
// served, so open sessions' next lazy import doesn't 404 after a deploy.
// Walks to file level at any depth, so the old assets/locales/ catalogs a
// retained entry still names are kept. Returns the number of files retained.
export function retainBaselineAssets(baselineAssetsDir, stagedAssetsDir) {
  if (!baselineAssetsDir || !fs.existsSync(baselineAssetsDir)) return 0
  // The fresh build may emit no assets dir at all (or none at a subtree); the
  // copy targets below need the directory to exist before copyFileSync.
  fs.mkdirSync(stagedAssetsDir, { recursive: true })
  let retained = 0
  const walk = (base, staged) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const src = path.join(base, entry.name)
      const target = path.join(staged, entry.name)
      if (entry.isDirectory()) {
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          walk(src, target)
        } else if (!fs.existsSync(target)) {
          // Whole directory absent from the fresh build: copy it intact and
          // count the files inside.
          fs.cpSync(src, target, { recursive: true })
          retained += countFiles(target)
        }
        // target exists but is a file: a name the fresh build uses for a file
        // can never also be a baseline directory; skip rather than overwrite.
      } else if (!fs.existsSync(target)) {
        fs.copyFileSync(src, target)
        retained += 1
      }
    }
  }
  walk(baselineAssetsDir, stagedAssetsDir)
  return retained
}

function countFiles(dir) {
  let n = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1
  }
  return n
}

/**
 * Stage this build's immutable entry: byte copies of index.html and
 * assets-manifest.json under `v<N>/b/<buildKey>/`, buildKey derived from the
 * staged index.html's nexus-build-time meta. `/v<N>/index.html` changes bytes
 * on a same-version redeploy; this URL names one build forever. Chunks are not
 * copied: the manifest's paths resolve against the version root
 * (manifestAssetBase.ts). Returns { key, entryPath }. Exported for tests.
 */
export function stageBuildEntry(stagedDir) {
  const indexPath = path.join(stagedDir, 'index.html')
  const key = readBuildKeyFromIndexHtml(fs.readFileSync(indexPath, 'utf8'))
  if (!key) {
    fail('index.html carries no valid nexus-build-time meta — cannot stage a ' +
         'build entry. Rebuild with buildTimeMetaPlugin (npm run build:versioned).')
  }
  const stagedName = path.basename(stagedDir)
  const entryDir = path.join(stagedDir, 'b', key)
  fs.mkdirSync(entryDir, { recursive: true })
  for (const name of ['index.html', 'assets-manifest.json']) {
    const src = path.join(stagedDir, name)
    if (!fs.existsSync(src)) fail(`missing ${src} — cannot stage build entry`)
    fs.copyFileSync(src, path.join(entryDir, name))
  }
  return { key, entryPath: `/${stagedName}/b/${key}/` }
}

/**
 * Carry the baseline's immutable entries (`v<N>/b/*`) forward. A key already
 * present is re-checked, never overwritten: the same key with different bytes
 * (usually a non-reproducible rebuild of one commit) fails the build, since
 * keeping either copy would let an immutable URL or the page/entry pairing lie.
 * Returns the number of entries inherited (0 without a baseline). Exported for tests.
 */
export function retainBaselineEntries(baselineRoot, stagedName, stagedDir) {
  if (!baselineRoot) return 0
  const baselineEntries = path.join(baselineRoot, stagedName, 'b')
  if (!fs.existsSync(baselineEntries)) return 0
  let inherited = 0
  for (const key of fs.readdirSync(baselineEntries)) {
    const srcDir = path.join(baselineEntries, key)
    if (!fs.statSync(srcDir).isDirectory()) continue
    const targetDir = path.join(stagedDir, 'b', key)
    if (fs.existsSync(targetDir)) {
      const a = fs.readFileSync(path.join(srcDir, 'index.html'))
      const b = fs.readFileSync(path.join(targetDir, 'index.html'))
      if (!a.equals(b)) {
        fail(`build-key collision on "${key}": the baseline already serves ` +
             'an entry with this key but different index.html bytes. The key ' +
             "is the commit's build time, so this is almost always a REBUILD " +
             'of an already-deployed commit whose output is not byte-identical ' +
             '(a dependency or toolchain changed between the builds). Promote ' +
             'or redeploy the candidate already built from that commit instead ' +
             'of rebuilding it, or land a new commit (a new build time is a new ' +
             'key). Only if the baseline entry is from a DIFFERENT commit is it ' +
             'a true build-time collision — amend one of the two and rebuild.')
      }
      continue
    }
    fs.cpSync(srcDir, targetDir, { recursive: true })
    inherited += 1
  }
  return inherited
}

/**
 * Assemble site/ from an already-built current dist plus the inputs main()
 * resolved: the fresh /v<N>/, its retention, the retained /v<K>/ trees, the
 * root files, _headers and build-info.json. Separate from main() so tests run
 * a whole stage without vite. A legacy-tree problem throws. Returns
 * `{ stagedName, retained, retainedEntries, entry, legacy }`.
 */
export function assembleSite({
  siteDir, distDir, currentVersion, rootIndexPath, publicDir,
  baselines = [], legacySites = [], buildInfoExtra = {},
}) {
  const stagedName = `v${currentVersion}`
  const stagedDir = path.join(siteDir, stagedName)

  fs.rmSync(siteDir, { recursive: true, force: true })
  fs.mkdirSync(siteDir, { recursive: true })

  fs.cpSync(distDir, stagedDir, { recursive: true })
  // The fresh build must reference its own /v<N>/assets/ base.
  verifyBundleBase({ name: stagedName, dir: stagedDir })
  // Immutable per-build entry, staged from the fresh index.html BEFORE
  // retention touches anything (retention only ever ADDS files, so entry
  // bytes are the fresh build's own).
  const entry = stageBuildEntry(stagedDir)
  // Retain from EVERY baseline, in order (production first — on a same-path
  // collision the earlier baseline's bytes win, and production is earlier).
  // Each baseline contributes the assets/entries the fresh build lacks. Only
  // the CURRENT version's subtree of a baseline is read: a baseline release
  // that itself carried a retained /v<K>/ donates nothing to it — retained
  // trees come from their own pinned release below, never from a baseline.
  let retained = 0
  let retainedEntries = 0
  for (const b of baselines) {
    // b.dir is .../site/v<N>/assets; retainBaselineEntries wants the site ROOT
    // (it re-appends v<N>/b itself), so strip both segments.
    const baselineRoot = path.dirname(path.dirname(b.dir))
    retained += retainBaselineAssets(b.dir, path.join(stagedDir, 'assets'))
    retainedEntries += retainBaselineEntries(baselineRoot, stagedName, stagedDir)
  }
  if (baselines.length === 0) {
    console.warn(
      'stage_deploy: WARNING — no retention baseline (STAGE_RETENTION_BASELINE ' +
      'is unset); open sessions may 404 lazy imports after this deploy. That ' +
      `is expected only for the first /${stagedName}/ deploy.`)
  }

  // Retained legacy interface versions, verbatim from their pinned releases.
  const legacy = []
  for (const site of legacySites) {
    const result = stageLegacyInterface(site, siteDir)
    if (result.error) throw new Error(result.error)
    legacy.push(result)
    console.log(
      `stage_deploy: retained /v${result.version}/ verbatim from ${result.release} ` +
      `(${result.files} files, candidate ${result.candidateId ?? 'unknown'})`)
  }

  // Served marker for checking a live deploy's provenance
  // (curl https://.../v<N>/build-info.json). STAGE_BUILD_INFO merges the
  // candidate identity in; beta and production run the same artifact, so equal
  // candidateIds mean equal bytes. legacyInterfaces names the retained trees.
  fs.writeFileSync(path.join(stagedDir, 'build-info.json'), JSON.stringify({
    mode: 'build-current',
    interfaceVersion: currentVersion,
    builtAt: new Date().toISOString(),
    retainedAssets: retained,
    buildKey: entry.key,
    entryPath: entry.entryPath,
    retainedEntries,
    legacyInterfaces: legacy.map(l => ({
      interfaceVersion: l.version,
      release: l.release,
      candidateId: l.candidateId,
    })),
    ...buildInfoExtra,
  }, null, 2) + '\n')
  console.log(
    `stage_deploy: built /${stagedName}/ fresh from src ` +
    `(${retained} baseline asset files retained for open sessions, ` +
    `${retainedEntries} entries inherited)`)

  // Root-served files, always from the CURRENT checkout — never from a
  // retained release. The landing page is for humans typing the bare domain;
  // managed-binaries.json is the guest's one root-relative fetch
  // (src/utils/binaryRegistry.ts) and is fleet-wide security-pin data, so it
  // is deliberately version-independent.
  fs.copyFileSync(rootIndexPath, path.join(siteDir, 'index.html'))
  fs.copyFileSync(
    path.join(publicDir, 'managed-binaries.json'),
    path.join(siteDir, 'managed-binaries.json'))

  // _headers: current rules + one generated immutable block per SERVED
  // version (current first, then each retained one). /v<N>/index.html
  // deliberately falls through to the year-max-age, s-maxage=0 catch-all so
  // same-version web fixes propagate via the background updater.
  fs.writeFileSync(
    path.join(siteDir, '_headers'),
    `${fs.readFileSync(path.join(publicDir, '_headers'), 'utf8').trimEnd()}\n\n` +
    generatedHeaderBlocks([stagedName, ...legacy.map(l => `v${l.version}`)]))

  return { stagedName, retained, retainedEntries, entry, legacy }
}

function main() {
  const currentVersion = readInterfaceVersion()
  const stagedName = `v${currentVersion}`

  // Lives under deploy/, NOT public/: vite copies public/ verbatim into the
  // bundle, so a landing page there would also ship as /v<N>/root-index.html.
  const rootIndexPath = path.join(deployDir, 'root-index.html')
  if (!fs.existsSync(rootIndexPath)) {
    fail(`missing ${rootIndexPath} — the static landing page served at the ` +
         'site root')
  }

  // Everything that can refuse the stage is resolved BEFORE the (minutes-long)
  // build, so a misconfigured retention fails fast.
  const resolved = resolveRetentionBaselines(
    process.env.STAGE_RETENTION_BASELINE, stagedName)
  if (resolved.error) fail(resolved.error)
  const { baselines } = resolved

  const config = readRetainedInterfaces(retainedInterfacesPath, currentVersion)
  if (config.error) fail(config.error)
  const legacy = resolveLegacySites(
    process.env.STAGE_LEGACY_SITES, config.entries,
    baselines.map(b => path.dirname(path.dirname(b.dir))))
  if (legacy.error) fail(legacy.error)
  if (config.entries.length === 0) {
    console.log(
      'stage_deploy: deploy/retained-interfaces.json retains no older ' +
      `interface version — this deploy serves /${stagedName}/ only`)
  }

  let buildInfoExtra = {}
  if (process.env.STAGE_BUILD_INFO) {
    try {
      buildInfoExtra = JSON.parse(process.env.STAGE_BUILD_INFO)
    } catch (error) {
      fail(`STAGE_BUILD_INFO is not valid JSON: ${error.message}`)
    }
  }

  const distDir = buildCurrentDist()
  let result
  try {
    result = assembleSite({
      siteDir, distDir, currentVersion, rootIndexPath, publicDir,
      baselines, legacySites: legacy.sites, buildInfoExtra,
    })
  } catch (error) {
    fail(error.message)
  }

  const retainedNames = result.legacy.map(l => `/v${l.version}/`)
  console.log(
    `stage_deploy: staged ${siteDir} — landing page + /${stagedName}/ ` +
    '(built fresh from src)' +
    (retainedNames.length ? ` + retained ${retainedNames.join(', ')}` : ''))
}

// Importable for tests; only stages when invoked as a script.
if (isMainModule(import.meta.url)) {
  main()
}
