// Builds a release candidate and packs it as a self-contained deployable
// artifact: the single build of the build-once release flow (G-3). Beta soak,
// promote and rollback consume this output and never compile again.
//   runtime.zip    wrangler.toml (pinned config) + site/ (`deploy:stage` output)
//   manifest.json  provenance: candidate id, source commit, run id
//   SHA256SUMS     digests of runtime.zip and manifest.json (neither holds the other's)
// Flags: --out --source-ref --source-commit --run-id [--baseline <dir>]...
//   [--legacy <K>=<dir>]... [--expect-version <N>] [--note <text>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { isMainModule } from './lib/isMainModule.mjs'
import { zipDirectory, listFiles } from './lib/zip.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`pack_artifact: ${message}`)
  process.exit(1)
}

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) fail(`unexpected argument ${arg}`)
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      out[key] = true
    } else {
      // A repeated flag accumulates into an array (--baseline, --legacy); a flag
      // given once stays a scalar.
      if (key in out) {
        out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value]
      } else {
        out[key] = value
      }
      i += 1
    }
  }
  return out
}

// Normalise a possibly-repeated flag to a list. Scalar → [scalar], array →
// itself, missing/true → [].
function asList(value) {
  if (value === undefined || value === true) return []
  return Array.isArray(value) ? value : [value]
}

export function readInterfaceVersion(root = repoRoot) {
  const tsPath = path.join(
    root, 'src', 'browser', 'bridge', 'protocol', 'interfaceVersion.gen.ts')
  const match = /^export const NEXUS_INTERFACE_VERSION = (\d+)$/m.exec(
    fs.readFileSync(tsPath, 'utf8'))
  if (!match) fail(`could not parse NEXUS_INTERFACE_VERSION from ${tsPath}`)
  return Number.parseInt(match[1], 10)
}

/**
 * candidate-v<interface>-<short sha>-<run id>
 *
 * Three coordinates because each answers a question the others cannot: which
 * wire contract the bundle speaks, which source it was compiled from, and
 * which CI run produced it (the handle Workflow B takes as input, and the only
 * one that distinguishes two builds of the same commit).
 */
export function candidateId({ interfaceVersion, sourceCommit, runId }) {
  const short = (sourceCommit || 'unknown').slice(0, 7)
  return `candidate-v${interfaceVersion}-${short}-${runId || 'local'}`
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// A retained baseline carries assets its own manifest lists but the tree may
// not hold (or vice versa) — a missing file means "cannot classify this one",
// never a failed build.
function tryRead(file) {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/**
 * How much of this build differs from the baseline release, by content-hashed
 * filename: a current url absent from the baseline is new or changed content
 * (the mirror of `retainBaselineAssets` in stage_deploy.mjs). Totals are the
 * current build's. The baseline is what retention resolved, usually not the
 * previous commit, so its identity travels with the numbers.
 */
export function computeAssetChurn(
  currentAssets, baselineAssets, baseline = {}, reader = null,
) {
  const baselineUrls = new Set(baselineAssets.map(asset => asset.url))
  const changed = currentAssets.filter(asset => !baselineUrls.has(asset.url))
  const churn = {
    changedCount: changed.length,
    totalCount: currentAssets.length,
    changedBytes: changed.reduce((sum, asset) => sum + asset.size, 0),
    totalBytes: currentAssets.reduce((sum, asset) => sum + asset.size, 0),
    // Of the changed set: code that is actually new, versus chunks re-emitted
    // only because a filename they reference moved. Null when unclassified.
    contentCount: null,
    contentBytes: null,
    rewrittenCount: null,
    rewrittenBytes: null,
    // The same two sets, NAMED — `newAssets` carries each new chunk with the
    // number of changed assets that transitively import it (its cascade), so
    // a chunk that keeps re-emitting the bundle is identifiable by name
    // instead of by re-running the analysis. Null, like the counts above,
    // when classification did not run.
    newAssets: null,
    rewrittenAssets: null,
    // What the numbers above are measured AGAINST. Null rather than absent
    // when a baseline predates the field that carries it, so a renderer can
    // tell "no such information" from "not looked up".
    baselineRelease: baseline.release ?? null,
    baselineCommit: baseline.commit ?? null,
    baselineCandidateId: baseline.candidateId ?? null,
  }
  if (reader) {
    Object.assign(
      churn, classifyChurn(changed, currentAssets, baselineAssets, reader))
  }
  return churn
}

/**
 * Split the changed set into new code and assets re-emitted only because an
 * import's hashed filename moved (byte-identical once every hashed asset
 * filename, taken from the two manifests, is neutralised). Both sets come back
 * named: `newAssets` sorted by cascade, each re-emitted asset with the
 * baseline twin it matched (`was`).
 */
function classifyChurn(changed, currentAssets, baselineAssets, reader) {
  const hashes = new Set()
  for (const asset of [...changed, ...baselineAssets]) {
    const match = /-([A-Za-z0-9_-]{8,})\.[a-z0-9]+$/.exec(asset.url)
    if (match) hashes.add(match[1])
  }
  // Longest-first so no hash can be a prefix of another mid-replacement.
  const pattern = hashes.size
    ? new RegExp([...hashes].sort((a, b) => b.length - a.length)
      .map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null
  // The reference edges only matter for the current build, and reading each
  // body twice would double the cost of the whole classification, so the one
  // read yields both the fingerprint and the filenames the body mentions.
  const byBasename = new Map(
    currentAssets.map(asset => [asset.url.split('/').pop(), asset.url]))
  const inspect = (url, load) => {
    const raw = load(url)
    if (raw === null || raw === undefined) return { print: null, refs: [] }
    const text = /\.(js|css|html|json|map|svg)$/.test(url) && pattern
      ? raw.toString('utf8')
      : null
    if (text === null) {
      return {
        print: crypto.createHash('sha256').update(Buffer.from(raw)).digest('hex'),
        refs: [],
      }
    }
    const refs = []
    for (const token of text.match(REFERENCE) ?? []) {
      const target = byBasename.get(token)
      if (target && target !== url) refs.push(target)
    }
    return {
      print: crypto.createHash('sha256')
        .update(Buffer.from(text.replace(pattern, '#'), 'utf8')).digest('hex'),
      refs,
    }
  }

  // print -> the baseline urls carrying it, consumed in order: two current
  // chunks must not both claim one prior, and naming the twin means saying
  // WHICH one was claimed rather than just that some was.
  const priors = new Map()
  for (const asset of baselineAssets) {
    const { print } = inspect(asset.url, reader.baseline)
    if (print) {
      if (!priors.has(print)) priors.set(print, [])
      priors.get(print).push(asset.url)
    }
  }

  const newAssets = [], rewrittenAssets = [], references = new Map()
  for (const asset of changed) {
    const { print, refs } = inspect(asset.url, reader.current)
    references.set(asset.url, refs)
    const twins = print ? priors.get(print) : null
    if (twins && twins.length) {
      rewrittenAssets.push({ url: asset.url, was: twins.shift(), size: asset.size })
    } else {
      newAssets.push({ url: asset.url, size: asset.size, cascadeCount: 0 })
    }
  }
  const cascades = cascadeCounts(references, newAssets.map(entry => entry.url))
  for (const entry of newAssets) entry.cascadeCount = cascades.get(entry.url) ?? 0

  return {
    contentCount: newAssets.length,
    contentBytes: newAssets.reduce((sum, entry) => sum + entry.size, 0),
    rewrittenCount: rewrittenAssets.length,
    rewrittenBytes: rewrittenAssets.reduce((sum, entry) => sum + entry.size, 0),
    // Biggest cascade first — the ordering IS the finding.
    newAssets: newAssets.sort(
      (a, b) => b.cascadeCount - a.cascadeCount || b.size - a.size),
    rewrittenAssets: rewrittenAssets.sort((a, b) => b.size - a.size),
  }
}

// How many names a summary shows before deferring to manifest.json, which
// always carries the full lists. Whatever is hidden is counted out loud — a
// silently truncated list reads as a complete one.
const CHURN_NAMES_SHOWN = 10

// A hashed asset filename as it appears inside another chunk's body. Matched
// against the current manifest's basenames, so a token that merely looks like
// one but names no asset is discarded.
const REFERENCE = /[A-Za-z0-9_.$-]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+/g

/**
 * How many changed assets sit downstream of each root: the transitive closure
 * over the reversed import graph. Only changed assets are walked, since
 * anything importing a changed chunk changed too. An asset under two roots
 * counts for both.
 */
function cascadeCounts(references, roots) {
  const importers = new Map()
  for (const [url, targets] of references) {
    for (const target of targets) {
      if (!importers.has(target)) importers.set(target, new Set())
      importers.get(target).add(url)
    }
  }
  const counts = new Map()
  for (const root of roots) {
    const seen = new Set([root])
    const queue = [root]
    while (queue.length) {
      for (const importer of importers.get(queue.pop()) ?? []) {
        if (seen.has(importer)) continue
        seen.add(importer)
        queue.push(importer)
      }
    }
    counts.set(root, seen.size - 1)
  }
  return counts
}

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot, encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

// No `shell: true` — on Windows that would be the only way to find `npm`, but
// it also concatenates arguments unescaped (Node DEP0190). Resolve the .cmd
// shim by name instead.
function toolVersion(command, args) {
  const bin = process.platform === 'win32' ? `${command}.cmd` : command
  const result = spawnSync(bin, args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim().split('\n').pop().trim() : 'unknown'
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.out) fail('--out <dir> is required')

  const interfaceVersion = readInterfaceVersion()
  // `runtime_version` is a Workflow A input purely as an ASSERTION. The real
  // source of truth is the generated constant in the checked-out source — a
  // free-text input that could disagree with it would be a way to mislabel an
  // artifact, not a way to configure one.
  if (args['expect-version']) {
    const expected = Number.parseInt(String(args['expect-version']).replace(/^v/, ''), 10)
    if (expected !== interfaceVersion) {
      fail(`--expect-version v${expected} but this source declares ` +
           `NEXUS_INTERFACE_VERSION=${interfaceVersion}. Either the ref is not ` +
           'the one you meant, or the input is stale.')
    }
  }

  const sourceCommit = args['source-commit'] || gitHead()
  const runId = args['run-id'] ? String(args['run-id']) : ''
  const id = args['candidate-id'] || candidateId({ interfaceVersion, sourceCommit, runId })
  const stagedName = `v${interfaceVersion}`

  const outDir = path.resolve(args.out)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  // --baseline is repeatable: a beta build retains from both the production
  // baseline and the previous beta candidate. The first is production's: churn
  // is measured against it, and it is retained first so its bytes win a
  // same-path collision.
  const baselines = asList(args.baseline).map(b => path.resolve(b))
  const primaryBaseline = baselines[0] ?? null
  // --legacy <K>=<site dir> is repeatable: one per retained interface version
  // in deploy/retained-interfaces.json, each the unzipped site/ of that
  // version's pinned release. stage_deploy checks the set against the config
  // (a configured version with no --legacy fails the stage) and copies only
  // site/v<K>/ out of each.
  const legacySites = asList(args.legacy).map(entry => {
    const match = /^([1-9]\d*)=(.+)$/.exec(String(entry))
    if (!match) fail(`--legacy ${entry} is not <version>=<site dir>`)
    return `${match[1]}=${path.resolve(match[2])}`
  })

  // Build + stage. stage_deploy.mjs has exactly one mode — compile the
  // current version from src/ — so there is no way for this to ship whatever
  // git happened to hold instead of the candidate it was asked for.
  const buildInfo = {
    mode: 'candidate',
    candidateId: id,
    sourceCommit,
    sourceRef: args['source-ref'] || '',
    workflowRunId: runId,
  }
  const stage = spawnSync(
    process.execPath, [path.join(repoRoot, 'scripts', 'stage_deploy.mjs')], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        STAGE_BUILD_INFO: JSON.stringify(buildInfo),
        // Multiple baselines are passed path-separated; stage_deploy resolves
        // each in order and retains the union (see retainBaseline* there).
        ...(baselines.length
          ? { STAGE_RETENTION_BASELINE: baselines.join(path.delimiter) }
          : {}),
        // Always set (possibly empty) so a stray STAGE_LEGACY_SITES in the
        // caller's environment cannot smuggle a tree past the flags.
        STAGE_LEGACY_SITES: legacySites.join(path.delimiter),
      },
    })
  if (stage.status !== 0) fail(`deploy:stage failed (exit ${stage.status})`)

  const siteDir = path.join(repoRoot, 'site')
  const stagedDir = path.join(siteDir, stagedName)
  if (!fs.existsSync(path.join(stagedDir, 'index.html'))) {
    fail(`staging produced no ${stagedName}/index.html`)
  }

  const assetManifestPath = path.join(stagedDir, 'assets-manifest.json')
  const assetManifest = fs.existsSync(assetManifestPath)
    ? JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'))
    : { buildId: null, assets: [] }
  const staged = JSON.parse(
    fs.readFileSync(path.join(stagedDir, 'build-info.json'), 'utf8'))

  // Same baseline root retention resolved, read again here: churn is
  // informational, so a missing or older baseline degrades to null instead of
  // failing the build.
  const baselineManifestPath = primaryBaseline
    ? path.join(primaryBaseline, stagedName, 'assets-manifest.json')
    : null
  const baselineManifest = baselineManifestPath && fs.existsSync(baselineManifestPath)
    ? JSON.parse(fs.readFileSync(baselineManifestPath, 'utf8'))
    : null
  // The baseline's build-info.json names the commit it was built from; CI
  // checks out at fetch-depth 1, so git history cannot.
  const baselineInfoPath = primaryBaseline
    ? path.join(primaryBaseline, stagedName, 'build-info.json')
    : null
  const baselineInfo = baselineInfoPath && fs.existsSync(baselineInfoPath)
    ? JSON.parse(fs.readFileSync(baselineInfoPath, 'utf8'))
    : {}
  // Reading both asset trees is what separates "new code" from "re-emitted
  // because a reference moved". Both are already on disk — the baseline was
  // unzipped for retention — so this costs a few hundred file reads and no
  // network. Wrapped: a classification failure must never fail a pack, since
  // the whole report is informational (the counts simply stay null).
  const assetReader = primaryBaseline
    ? {
      current: url => tryRead(path.join(stagedDir, url)),
      baseline: url => tryRead(path.join(primaryBaseline, stagedName, url)),
    }
    : null
  let assetChurn = null
  if (baselineManifest) {
    const identity = {
      release: args['baseline-release'] || null,
      commit: baselineInfo.sourceCommit || null,
      candidateId: baselineInfo.candidateId || null,
    }
    try {
      assetChurn = computeAssetChurn(
        assetManifest.assets, baselineManifest.assets, identity, assetReader)
    } catch (error) {
      console.warn(`pack_artifact: churn classification skipped — ${error.message}`)
      assetChurn = computeAssetChurn(
        assetManifest.assets, baselineManifest.assets, identity)
    }
  }

  // Assemble the deployable tree in a temp dir so the zip's member paths are
  // exactly `wrangler.toml` and `site/...` regardless of where we ran from.
  const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'velloc-candidate-'))
  try {
    fs.cpSync(siteDir, path.join(packRoot, 'site'), { recursive: true })
    fs.copyFileSync(
      path.join(repoRoot, 'wrangler.toml'), path.join(packRoot, 'wrangler.toml'))
    // The gateway worker (wrangler.toml `main`) must sit next to the config
    // in the artifact, or promote's `wrangler deploy --config <unzipped>/
    // wrangler.toml` fails to resolve it — a candidate that cannot deploy.
    fs.cpSync(
      path.join(repoRoot, 'worker'), path.join(packRoot, 'worker'),
      { recursive: true })

    const zipPath = path.join(outDir, 'runtime.zip')
    const { entryCount, bytes } = zipDirectory(packRoot, zipPath)

    const manifest = {
      candidateId: id,
      interfaceVersion,
      versionPath: `/${stagedName}/`,
      sourceCommit,
      sourceRef: args['source-ref'] || '',
      repository: process.env.GITHUB_REPOSITORY || '',
      workflowRunId: runId,
      workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT || '',
      builtAtUtc: staged.builtAt,
      buildId: assetManifest.buildId,
      assetCount: assetManifest.assets.length,
      retainedAssets: staged.retainedAssets ?? 0,
      // Read from the staged build-info.json, never recomputed: the entry is
      // whatever stageBuildEntry actually staged, and re-deriving the key here
      // could disagree with the bytes on disk (stage_deploy read the meta; a
      // second resolveBuildTime() would be a second wall clock without git).
      buildKey: staged.buildKey ?? null,
      entryPath: staged.entryPath ?? null,
      retainedEntries: staged.retainedEntries ?? 0,
      retentionBaseline: args['baseline-release'] || null,
      // Retained older interface versions this artifact also serves, each
      // with the release it was copied from — read from the staged
      // build-info.json, i.e. what was actually staged.
      legacyInterfaces: staged.legacyInterfaces ?? [],
      // null means "unknown" (no baseline, or a baseline built before this
      // field existed) — deliberately distinct from a zero-change build, the
      // same distinction retainedAssets already has to make.
      assetChurn,
      zipEntryCount: entryCount,
      zipBytes: bytes,
      note: args.note && args.note !== true ? String(args.note) : '',
      tooling: {
        node: process.version,
        npm: toolVersion('npm', ['--version']),
      },
      workers: { production: 'velloc-runtime', beta: 'velloc-runtime-beta' },
    }
    const manifestPath = path.join(outDir, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    // `sha256sum -c SHA256SUMS` format, so promote/rollback verify with the
    // stock coreutils tool and need no code from this repo.
    fs.writeFileSync(
      path.join(outDir, 'SHA256SUMS'),
      ['runtime.zip', 'manifest.json']
        .map(name => `${sha256(path.join(outDir, name))}  ${name}\n`)
        .join(''))

    console.log(`pack_artifact: ${id}`)
    console.log(`  files      ${listFiles(packRoot).length}`)
    console.log(`  runtime.zip ${(bytes / 1024 / 1024).toFixed(1)} MiB ` +
                `(${entryCount} entries)`)
    console.log(`  sha256     ${sha256(zipPath)}`)
    if (assetChurn) {
      const pct = assetChurn.totalBytes > 0
        ? ((assetChurn.changedBytes / assetChurn.totalBytes) * 100).toFixed(1)
        : '0.0'
      const against = assetChurn.baselineCommit
        ? `${assetChurn.baselineRelease || 'baseline'} @ ${assetChurn.baselineCommit.slice(0, 7)}`
        : assetChurn.baselineRelease || 'baseline'
      console.log(
        `  churn      ${assetChurn.changedCount}/${assetChurn.totalCount} files, ` +
        `${pct}% (${(assetChurn.changedBytes / 1024).toFixed(1)} KiB / ` +
        `${(assetChurn.totalBytes / 1024 / 1024).toFixed(1)} MiB) vs ${against}`)
      if (assetChurn.contentCount !== null) {
        console.log(
          `             of which ${assetChurn.contentCount} new code ` +
          `(${(assetChurn.contentBytes / 1024).toFixed(1)} KiB), ` +
          `${assetChurn.rewrittenCount} re-emitted for reference updates ` +
          `(${(assetChurn.rewrittenBytes / 1024).toFixed(1)} KiB)`)
        // Named, biggest cascade first: the top line is the chunk to un-share.
        for (const entry of assetChurn.newAssets.slice(0, CHURN_NAMES_SHOWN)) {
          console.log(
            `             ${entry.url} ` +
            `(${(entry.size / 1024).toFixed(1)} KiB) ` +
            `→ ${entry.cascadeCount} re-emitted downstream`)
        }
        const hidden = assetChurn.newAssets.length - CHURN_NAMES_SHOWN
        if (hidden > 0) console.log(`             …and ${hidden} more (manifest.json)`)
      }
    }
    console.log(`  out        ${outDir}`)
  } finally {
    fs.rmSync(packRoot, { recursive: true, force: true })
  }
}

// Importable for tests; only runs the build when invoked as a script.
if (isMainModule(import.meta.url)) {
  main()
}
