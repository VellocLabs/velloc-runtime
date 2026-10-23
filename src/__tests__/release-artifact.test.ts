import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

// @ts-expect-error — plain .mjs build script, no types
import { writeZip, readZip, zipDirectory, extractZip } from '../../scripts/lib/zip.mjs'
// @ts-expect-error — plain .mjs build script, no types
import { candidateId, computeAssetChurn, parseArgs } from '../../scripts/pack_artifact.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs build script, no types
import { resolveRetentionBaseline, resolveRetentionBaselines, retainBaselineAssets, retainBaselineEntries, stageBuildEntry } from '../../scripts/stage_deploy.mjs'
// @ts-expect-error — plain .mjs build script, no types
import { buildKeyFromBuildTime as buildKeyMjs, readBuildKeyFromIndexHtml } from '../../scripts/lib/buildKey.mjs'
import { buildKeyFromBuildTime as buildKeyTs, BUILD_TIME_META_NAME } from '../branding/buildInfo'

/**
 * The build-once release artifact (G-3): the hand-rolled zip writer (deterministic, no stamped mtimes, so the
 * SHA-256 tracks the contents) and the workflow contract that production never rebuilds.
 */

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflows = join(repoRoot, '.github', 'workflows')

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'velloc-zip-test-'))
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const text = (s: string) => Buffer.from(s, 'utf8')

describe('zip writer', () => {
  it('round-trips entries through a real central directory', () => {
    const out = join(tmp, 'round.zip')
    writeZip([
      { name: 'site/index.html', data: text('<!doctype html>hello') },
      { name: 'wrangler.toml', data: text('name = "velloc-runtime"\n') },
    ], out)

    const back = readZip(out)
    expect(back.map((e: { name: string }) => e.name))
      .toEqual(['site/index.html', 'wrangler.toml'])
    expect(back[1].data.toString('utf8')).toBe('name = "velloc-runtime"\n')
  })

  it('is deterministic — identical content produces identical bytes', () => {
    // The release model treats the digest as the identity of the deploy. If
    // packing the same tree twice produced two hashes, every comparison in the
    // flow ("is production serving the artifact beta soaked?") would be noise.
    const entries = [
      { name: 'b.txt', data: text('second') },
      { name: 'a.txt', data: text('first') },
    ]
    const one = join(tmp, 'det-1.zip')
    const two = join(tmp, 'det-2.zip')
    writeZip(entries, one)
    writeZip([...entries].reverse(), two)
    expect(readFileSync(one).equals(readFileSync(two))).toBe(true)
  })

  it('stores incompressible data rather than growing it', () => {
    // Fonts and png assets are already compressed; deflating them costs bytes.
    const noise = Buffer.alloc(4096)
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) & 0xff
    const out = join(tmp, 'noise.zip')
    writeZip([{ name: 'n.bin', data: noise }], out)
    expect(statSync(out).size).toBeLessThan(noise.length + 512)
    expect(readZip(out)[0].data.equals(noise)).toBe(true)
  })

  it('packs and extracts a directory tree', () => {
    const src = join(tmp, 'tree')
    mkdirSync(join(src, 'v1', 'assets'), { recursive: true })
    writeFileSync(join(src, 'index.html'), 'root')
    writeFileSync(join(src, 'v1', 'index.html'), '/v1/assets/app.js')
    writeFileSync(join(src, 'v1', 'assets', 'app.js'), 'console.log(1)')

    const out = join(tmp, 'tree.zip')
    zipDirectory(src, out, 'site')
    const dest = join(tmp, 'extracted')
    extractZip(out, dest)

    expect(readFileSync(join(dest, 'site', 'v1', 'assets', 'app.js'), 'utf8'))
      .toBe('console.log(1)')
  })

  it('refuses an entry that escapes the destination', () => {
    const out = join(tmp, 'evil.zip')
    writeZip([{ name: '../escaped.txt', data: text('no') }], out)
    expect(() => extractZip(out, join(tmp, 'dest'))).toThrow(/escapes/)
  })
})

describe('candidateId', () => {
  it('carries interface version, source commit and run id', () => {
    expect(candidateId({
      interfaceVersion: 1,
      sourceCommit: 'be4f115abcdef',
      runId: '18429376123',
    })).toBe('candidate-v1-be4f115-18429376123')
  })

  it('marks a local pack so it can never be mistaken for a CI candidate', () => {
    expect(candidateId({ interfaceVersion: 2, sourceCommit: 'abcdef1234' }))
      .toBe('candidate-v2-abcdef1-local')
  })
})

describe('computeAssetChurn', () => {
  // Filenames under assets/ are content hashes (Vite/Rollup `[hash]`), so a
  // url present in the current build but absent from the baseline already
  // means "new or changed" — the diff needs no extra hashing.
  const asset = (url: string, size: number) => ({ url, size, type: 'js' })

  // Every result carries the baseline identity too; these three keys are
  // asserted separately below, so the arithmetic cases stay readable.
  const churn = (current: unknown[], baseline: unknown[]) => {
    const {
      baselineRelease, baselineCommit, baselineCandidateId,
      contentCount, contentBytes, rewrittenCount, rewrittenBytes,
      newAssets, rewrittenAssets,
      ...counts
    } = computeAssetChurn(current, baseline)
    return counts
  }

  it('counts nothing changed when every url matches the baseline', () => {
    const current = [asset('assets/a.abc123.js', 100), asset('assets/b.def456.js', 200)]
    const baseline = [asset('assets/a.abc123.js', 100), asset('assets/b.def456.js', 200)]
    expect(churn(current, baseline)).toEqual({
      changedCount: 0, totalCount: 2, changedBytes: 0, totalBytes: 300,
    })
  })

  it('counts a url absent from the baseline as changed, by its current size', () => {
    // b's hash changed (content changed) and c is new — both are "not in
    // baseline", indistinguishable from each other and that is by design:
    // a changed file IS a new file under content hashing.
    const current = [
      asset('assets/a.abc123.js', 100),
      asset('assets/b.NEWHASH.js', 250),
      asset('assets/c.new.js', 50),
    ]
    const baseline = [
      asset('assets/a.abc123.js', 100),
      asset('assets/b.OLDHASH.js', 200),
    ]
    expect(churn(current, baseline)).toEqual({
      changedCount: 2, totalCount: 3, changedBytes: 300, totalBytes: 400,
    })
  })

  it('does not count a url the current build dropped', () => {
    // Removed-but-not-replaced assets are what retention (retainBaselineAssets
    // in stage_deploy.mjs) carries forward for open sessions — already
    // reported separately as retainedAssets, so churn must not double-count
    // them as "changed".
    const current = [asset('assets/a.abc123.js', 100)]
    const baseline = [asset('assets/a.abc123.js', 100), asset('assets/removed.js', 999)]
    expect(churn(current, baseline)).toEqual({
      changedCount: 0, totalCount: 1, changedBytes: 0, totalBytes: 100,
    })
  })

  it('reports the whole current build as changed against an empty baseline', () => {
    const current = [asset('assets/a.abc123.js', 100), asset('assets/b.def456.js', 200)]
    expect(churn(current, [])).toEqual({
      changedCount: 2, totalCount: 2, changedBytes: 300, totalBytes: 300,
    })
  })

  it('carries the baseline identity, so the figure can name what it measured against', () => {
    // Run 31392770174: a commit touching no bundled source reported 98/218
    // files (70.6%) because the baseline was the release production serves,
    // two commits back, with a module-splitting refactor in between. The
    // arithmetic was right; the report just never said what it compared to.
    const result = computeAssetChurn(
      [asset('assets/a.new.js', 100)],
      [asset('assets/a.old.js', 100)],
      {
        release: 'runtime-v1-2026.08.10.1',
        commit: '2f34d633e12a5b9b774b7c38417781be22cd7d84',
        candidateId: 'candidate-v1-2f34d63-31343916536',
      })
    expect(result.baselineRelease).toBe('runtime-v1-2026.08.10.1')
    expect(result.baselineCommit).toBe('2f34d633e12a5b9b774b7c38417781be22cd7d84')
    expect(result.baselineCandidateId).toBe('candidate-v1-2f34d63-31343916536')
  })

  it('leaves the new-code/re-emitted split null when given no reader', () => {
    // Classification needs both asset trees on disk. Without them the counts
    // must be null, not 0 — "not classified" and "nothing was new" are
    // different answers and the summary renders them differently.
    const result = computeAssetChurn([asset('assets/a.js', 10)], [])
    expect(result.contentCount).toBeNull()
    expect(result.rewrittenCount).toBeNull()
    expect(result.contentBytes).toBeNull()
    expect(result.rewrittenBytes).toBeNull()
    // The named lists follow the counts: null, never [], or a summary would
    // render an empty table as though nothing had been new.
    expect(result.newAssets).toBeNull()
    expect(result.rewrittenAssets).toBeNull()
  })

  it('separates genuinely new code from chunks re-emitted for reference updates', () => {
    // The b051c74…d660fab shape, in miniature: `app` really changed, and
    // `page` changed ONLY because the filename it imports moved. Counting
    // both as "changed" is true but reads as twice the change it is.
    // Filenames must carry a real `-<8+ char hash>.ext`: the classifier
    // neutralises only hashes it harvested from the two manifests, so a
    // fixture named `app.NEW.js` would exercise none of the normalisation.
    const current = [asset('assets/app-BBBBBBBB.js', 500), asset('assets/page-DDDDDDDD.js', 100)]
    const baseline = [asset('assets/app-AAAAAAAA.js', 400), asset('assets/page-CCCCCCCC.js', 100)]
    const files: Record<string, string> = {
      'assets/app-AAAAAAAA.js': 'export const shell = 1',
      'assets/app-BBBBBBBB.js': 'export const shell = 2',            // real edit
      'assets/page-CCCCCCCC.js': 'import "./app-AAAAAAAA.js"; run()',
      'assets/page-DDDDDDDD.js': 'import "./app-BBBBBBBB.js"; run()', // only the ref moved
    }
    const read = (url: string) => (files[url] ? Buffer.from(files[url]) : null)
    const result = computeAssetChurn(current, baseline, {}, { current: read, baseline: read })

    expect(result.changedCount).toBe(2)
    expect(result.contentCount).toBe(1)
    expect(result.contentBytes).toBe(500)
    expect(result.rewrittenCount).toBe(1)
    expect(result.rewrittenBytes).toBe(100)
  })

  it('names both sets, pairing each re-emitted asset with the twin it replaced', () => {
    // Counts say how big the churn was; only the names say what to do about
    // it. The `was` pairing is also what makes the report checkable by hand —
    // without it "89 re-emitted" has to be taken on trust.
    const current = [asset('assets/app-BBBBBBBB.js', 500), asset('assets/page-DDDDDDDD.js', 100)]
    const baseline = [asset('assets/app-AAAAAAAA.js', 400), asset('assets/page-CCCCCCCC.js', 100)]
    const files: Record<string, string> = {
      'assets/app-AAAAAAAA.js': 'export const shell = 1',
      'assets/app-BBBBBBBB.js': 'export const shell = 2',
      'assets/page-CCCCCCCC.js': 'import "./app-AAAAAAAA.js"; run()',
      'assets/page-DDDDDDDD.js': 'import "./app-BBBBBBBB.js"; run()',
    }
    const read = (url: string) => (files[url] ? Buffer.from(files[url]) : null)
    const result = computeAssetChurn(current, baseline, {}, { current: read, baseline: read })

    expect(result.newAssets).toEqual([
      { url: 'assets/app-BBBBBBBB.js', size: 500, cascadeCount: 1 },
    ])
    expect(result.rewrittenAssets).toEqual([
      { url: 'assets/page-DDDDDDDD.js', was: 'assets/page-CCCCCCCC.js', size: 100 },
    ])
  })

  it('counts the cascade transitively, not just direct importers', () => {
    // `page` imports `app`; `entry` imports `page` and never mentions `app`.
    // Editing `app` re-emitted both, so its blast radius is 2 — counting only
    // the chunks that name it would report 1 and understate every deep graph,
    // which is exactly the shape the real bundle has (27 direct importers
    // closing over 89).
    const current = [
      asset('assets/app-BBBBBBBB.js', 300),
      asset('assets/page-DDDDDDDD.js', 200),
      asset('assets/entry-FFFFFFFF.js', 100),
    ]
    const baseline = [
      asset('assets/app-AAAAAAAA.js', 300),
      asset('assets/page-CCCCCCCC.js', 200),
      asset('assets/entry-EEEEEEEE.js', 100),
    ]
    const files: Record<string, string> = {
      'assets/app-AAAAAAAA.js': 'export const shell = 1',
      'assets/app-BBBBBBBB.js': 'export const shell = 2',
      'assets/page-CCCCCCCC.js': 'import "./app-AAAAAAAA.js"',
      'assets/page-DDDDDDDD.js': 'import "./app-BBBBBBBB.js"',
      'assets/entry-EEEEEEEE.js': 'import "./page-CCCCCCCC.js"',
      'assets/entry-FFFFFFFF.js': 'import "./page-DDDDDDDD.js"',
    }
    const read = (url: string) => (files[url] ? Buffer.from(files[url]) : null)
    const result = computeAssetChurn(current, baseline, {}, { current: read, baseline: read })

    expect(result.contentCount).toBe(1)
    expect(result.newAssets?.[0]).toEqual({
      url: 'assets/app-BBBBBBBB.js', size: 300, cascadeCount: 2,
    })
  })

  it('ranks new code by cascade, so the chunk worth un-sharing is first', () => {
    // The ordering IS the finding: a 6 KiB chunk that re-emits the bundle
    // matters more than a large leaf that re-emits nothing, and a summary
    // that shows only the top rows must show the right ones.
    const current = [
      asset('assets/leaf-BBBBBBBB.js', 900),
      asset('assets/hub-DDDDDDDD.js', 10),
      asset('assets/page-FFFFFFFF.js', 50),
    ]
    // The baseline must list the hub too: hashes are harvested from the two
    // manifests, so a filename no manifest names is never neutralised and the
    // chunk importing it would look like new code.
    const baseline = [asset('assets/hub-CCCCCCCC.js', 10), asset('assets/page-EEEEEEEE.js', 50)]
    const files: Record<string, string> = {
      'assets/leaf-BBBBBBBB.js': 'export const leaf = 1',
      'assets/hub-CCCCCCCC.js': 'export const hub = 1',
      'assets/hub-DDDDDDDD.js': 'export const hub = 2',       // the real edit
      'assets/page-EEEEEEEE.js': 'import "./hub-CCCCCCCC.js"',
      'assets/page-FFFFFFFF.js': 'import "./hub-DDDDDDDD.js"', // only the ref moved
    }
    const read = (url: string) => (files[url] ? Buffer.from(files[url]) : null)
    const result = computeAssetChurn(current, baseline, {}, { current: read, baseline: read })

    // pack_artifact.mjs is untyped, so the entry shape is spelled out here.
    const ranked = (result.newAssets as Array<{ url: string; cascadeCount: number }>)
      .map(entry => [entry.url, entry.cascadeCount])
    expect(ranked).toEqual([
      ['assets/hub-DDDDDDDD.js', 1],
      ['assets/leaf-BBBBBBBB.js', 0],
    ])
  })

  it('does not let two rewritten chunks claim the same baseline twin', () => {
    // Both current chunks normalize to the same body. Only one baseline chunk
    // has it, so exactly one is a re-emit and the other is genuinely new --
    // otherwise duplicated boilerplate would silently absorb real additions.
    const current = [asset('assets/x-NEW22222.js', 10), asset('assets/y-NEW33333.js', 10)]
    const baseline = [asset('assets/x-OLD11111.js', 10)]
    const files: Record<string, string> = {
      'assets/x-OLD11111.js': 'import "./shared-OLD11111.js"',
      'assets/x-NEW22222.js': 'import "./shared-NEW22222.js"',
      'assets/y-NEW33333.js': 'import "./shared-NEW33333.js"',
    }
    const read = (url: string) => (files[url] ? Buffer.from(files[url]) : null)
    const result = computeAssetChurn(current, baseline, {}, { current: read, baseline: read })
    expect(result.rewrittenCount).toBe(1)
    expect(result.contentCount).toBe(1)
  })

  it('survives an asset the baseline tree does not actually hold', () => {
    // Retention means the baseline manifest and the baseline tree can
    // disagree. An unreadable file must degrade that one asset, not throw --
    // the pack must not fail over an informational report.
    const current = [asset('assets/a-NEW11111.js', 10)]
    const baseline = [asset('assets/a-OLD22222.js', 10), asset('assets/gone-OLD33333.js', 10)]
    const read = (url: string) =>
      (url === 'assets/gone-OLD33333.js' ? null : Buffer.from('same body'))
    expect(() => computeAssetChurn(current, baseline, {}, { current: read, baseline: read }))
      .not.toThrow()
    const result = computeAssetChurn(current, baseline, {}, { current: read, baseline: read })
    expect(result.rewrittenCount).toBe(1)
  })

  it('nulls the baseline identity rather than omitting it when unknown', () => {
    // A baseline release packed before build-info.json carried a sourceCommit
    // has counts but no identity. `null` says "looked, not there"; a missing
    // key would be indistinguishable from a renderer bug.
    const result = computeAssetChurn([asset('assets/a.js', 10)], [])
    expect(result).toHaveProperty('baselineRelease', null)
    expect(result).toHaveProperty('baselineCommit', null)
    expect(result).toHaveProperty('baselineCandidateId', null)
  })
})

describe('Workflow A gates the deploy, not the build', () => {
  const doc = parse(readFileSync(join(workflows, 'build-beta.yml'), 'utf8'))
  const jobs = doc.jobs as Record<string, {
    needs?: string | string[], steps: Array<{ uses?: string, run?: string, with?: Record<string, unknown> }>
  }>
  const needsOf = (job: string) => [jobs[job].needs ?? []].flat()
  const body = (job: string) => JSON.stringify(jobs[job].steps)

  it('deploys only after typecheck, every test shard and pack succeed', () => {
    expect(needsOf('deploy').sort()).toEqual(['pack', 'test', 'typecheck'])
    for (const gate of ['typecheck', 'test', 'pack']) {
      expect(needsOf(gate)).toEqual(['source'])
    }
  })

  it('touches beta from the deploy job alone', () => {
    for (const job of Object.keys(jobs)) {
      if (job === 'deploy') continue
      expect(body(job), `${job} must not deploy`).not.toMatch(/wrangler@/)
    }
    expect(body('deploy')).toMatch(/wrangler@[\d.]+ deploy[\s\S]*--name velloc-runtime-beta/)
  })

  it('builds and tests the one commit `source` resolved', () => {
    for (const job of ['typecheck', 'test', 'pack']) {
      const checkout = jobs[job].steps.find(s => s.uses?.startsWith('actions/checkout@'))
      expect(checkout?.with?.ref, job).toBe('${{ needs.source.outputs.commit }}')
    }
  })

  it('shards the tests with one retry, and lets every shard report', () => {
    const test = doc.jobs.test
    const shards: number[] = test.strategy.matrix.shard
    expect(shards).toEqual(shards.map((_, i) => i + 1))
    expect(test.strategy['fail-fast']).toBe(false)
    expect(body('test')).toContain(`--shard=\${{ matrix.shard }}/${shards.length} --retry=1`)
  })

  it('uploads `candidate` once, from pack, and deploys what it downloads', () => {
    const uploads = Object.entries(jobs).flatMap(([job, j]) => j.steps
      .filter(s => s.uses?.startsWith('actions/upload-artifact@'))
      .map(s => [job, s.with?.name]))
    expect(uploads).toEqual([['pack', 'candidate']])
    const download = jobs.deploy.steps.find(s => s.uses?.startsWith('actions/download-artifact@'))
    expect(download?.with?.name).toBe('candidate')
  })
})

describe('promote input ergonomics', () => {
  // Both promote inputs are optional and resolved by the workflow: the run id
  // defaults to the newest successful build, the tag is generated from the
  // candidate's own manifest. A required free-text field here was an 11-digit
  // number retyped by hand and a version number a human could get wrong in a
  // way nothing downstream would catch.
  const doc = parse(readFileSync(join(workflows, 'promote-production.yml'), 'utf8'))
  const inputs = doc.on.workflow_dispatch.inputs

  it('asks the operator to type nothing', () => {
    for (const name of Object.keys(inputs)) {
      expect(inputs[name].required, `${name} must be optional`).toBe(false)
    }
  })

  it('resolves the candidate and the tag instead of trusting input', () => {
    const body = readFileSync(join(workflows, 'promote-production.yml'), 'utf8')
    // Newest successful build-beta run, not "whatever was pasted".
    expect(body).toMatch(/gh run list[\s\S]{0,200}--workflow build-beta\.yml/)
    expect(body).toMatch(/--status success/)
    // The tag's version segment comes from the manifest, never from input.
    expect(body).toMatch(/runtime-v\$V-\$DATE\.\$N/)
  })

  it('gates only the irreversible half, after publishing what it will ship', () => {
    // The whole reason promote is two jobs: an environment's protection rules
    // fire BEFORE a job's first step, so a single job would show the approver
    // a button and nothing else. `resolve` must stay ungated and must write a
    // summary; `deploy` must be the one carrying the environment.
    expect(doc.jobs.resolve.environment).toBeUndefined()
    expect(doc.jobs.deploy.environment).toBe('production')
    expect(doc.jobs.deploy.needs).toContain('resolve')

    const resolveSteps = JSON.stringify(doc.jobs.resolve.steps)
    expect(resolveSteps).toContain('GITHUB_STEP_SUMMARY')
    // Nothing irreversible may sit in the ungated job. Scoped to the commands
    // that actually write: `resolve` legitimately names wrangler.toml (it
    // checks the archive carries one) and runs `gh release view` to find a
    // free tag — reading is the entire point of that job.
    expect(resolveSteps).not.toMatch(/wrangler@|gh release create|gh release edit/)
  })

  it('refuses to promote bytes beta is not serving', () => {
    // Deployment protection rules are unavailable on this repo's plan, so
    // there is no approval step in which a human compares the candidate id
    // against beta. The workflow does it instead — and it must FAIL, not warn,
    // when the candidate was auto-resolved, because in that path nobody chose
    // the thing being shipped.
    const step = doc.jobs.resolve.steps.find(
      (s: { id?: string }) => s.id === 'beta')
    expect(step, 'resolve must cross-check beta').toBeDefined()
    expect(step.run).toContain('BETA_ORIGIN')
    expect(step.run).toContain('candidateId')
    // Auto-resolved mismatch is fatal.
    expect(step.run).toMatch(/::error::beta serves/)
    // A deliberately pinned run id downgrades it to a warning — the operator
    // said which candidate they meant, so this is information, not a veto.
    expect(step.run).toMatch(/::warning::beta serves/)
    // Unreachable beta must not silently pass in the auto path either.
    expect(step.run).toMatch(/::error::could not read/)
  })

  it('promotes only a completed, successful Workflow A run, pinned or not', () => {
    // A failed-gate run still holds a `candidate` (pack uploads it before the
    // gates finish), so the run's own state is what keeps it off production.
    const step = doc.jobs.resolve.steps.find(
      (s: { id?: string }) => s.id === 'run')
    expect(step, 'resolve must resolve the run').toBeDefined()
    const check = step.run.slice(step.run.lastIndexOf('fi\n'))
    expect(check).toMatch(/gh api "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$RUN_ID"/)
    expect(check).toContain('"\\(.path) \\(.status) \\(.conclusion)"')
    expect(check).toContain('".github/workflows/build-beta.yml completed success") : ;;')
    expect(check).toMatch(/\*\) echo "::error::run \$RUN_ID is not a successful[^\n]*\n\s*exit 1/)
    // The check runs on both paths: after the pinned/resolved branch closes,
    // before the run id is published to the deploy job.
    expect(check.indexOf('gh api')).toBeLessThan(check.indexOf('run_id=$RUN_ID'))
  })

  it('names the soak origin in exactly one place', () => {
    // The cross-check compares against whatever BETA_ORIGIN says. If a second
    // literal drifted from it, the check would verify a different origin than
    // the one it tells the operator to look at.
    expect(doc.env.BETA_ORIGIN).toBe('https://beta.velloc.app')
    const step = doc.jobs.resolve.steps.find(
      (s: { id?: string }) => s.id === 'beta')
    expect(step.run).not.toContain('https://beta.velloc.app')
  })

  it('touches every Release through one and the same identity', () => {
    // One token identity across the whole flow: `gh release view` decides a tag is free, so a check under a different
    // identity could hand back a tag that collides at `gh release create`.
    const steps = [...doc.jobs.resolve.steps, ...doc.jobs.deploy.steps]
      .filter((s: { run?: string }) => /gh release (create|edit|view)/.test(s.run ?? ''))
    // create, edit and view each appear at least once — otherwise this test
    // passes vacuously the day someone renames the commands.
    expect(steps.length).toBeGreaterThanOrEqual(3)
    const tokens = new Set(
      steps.map((s: { env?: Record<string, string> }) => s.env?.GH_TOKEN))
    expect(tokens.size, `one identity for all Release calls, saw ${[...tokens].join(', ')}`)
      .toBe(1)
    expect([...tokens][0]).toBeTruthy()
  })

  it('proves that identity can create a release before anything is deployed', () => {
    // The capability probe, not the token choice, is what catches this class
    // of failure — and it has to run in `resolve`, the job that changes
    // nothing, so a refusal is a clean failure rather than a 403 landing
    // between the deploy and the release. A DRAFT creates no tag and is
    // invisible in the releases list, so the probe leaves nothing behind.
    const step = doc.jobs.resolve.steps.find(
      (s: { name?: string }) => /^Preflight/.test(s.name ?? ''))
    expect(step, 'resolve must preflight release creation').toBeDefined()
    expect(step.run).toMatch(/releases" --method POST/)
    expect(step.run).toMatch(/-F draft=true/)
    expect(step.run).toMatch(/--method DELETE/)
    // Same identity as the steps that will really create the release.
    const create = doc.jobs.deploy.steps.find(
      (s: { run?: string }) => /gh release create/.test(s.run ?? ''))
    expect(step.env?.GH_TOKEN).toBe(create.env?.GH_TOKEN)
  })

  it('never passes a raw commit SHA as the release target', () => {
    // POST /releases with a 40-char SHA as target_commitish is rejected by
    // this repository — 404 for a user token, 403 "not accessible" for a PAT
    // or GITHUB_TOKEN. The same call with `main`, or with no target, is 201.
    // Five promotes failed on this and were misread as a permissions problem,
    // so the shape is pinned rather than left to be rediscovered.
    const body = readFileSync(join(workflows, 'promote-production.yml'), 'utf8')
    const code = body.split('\n').map(l => l.replace(/#.*$/, '')).join('\n')
    expect(code).not.toMatch(/--target/)
  })

  it('re-verifies the digest on the machine that deploys it', () => {
    // resolve and deploy run on different runners, so deploy re-downloads.
    // Carrying the digest across and comparing is what makes that re-download
    // a check rather than a second chance to get different bytes.
    const deploySteps = JSON.stringify(doc.jobs.deploy.steps)
    expect(deploySteps).toContain('sha256sum -c SHA256SUMS')
    expect(deploySteps).toMatch(/digest changed between resolve/)
  })
})

describe('retention baseline follows production, not the release list', () => {
  // A rollback deliberately leaves "newest release" and "what production
  // serves" apart — Workflow C restores an older release and does not move
  // GitHub's `latest` marker. Taking the newest release as the retention
  // baseline would then carry the wrong asset set forward, and the window in
  // which that is wrong is precisely the window in which a build is most
  // likely: just after a rollback, shipping the fix. Found by rehearsing
  // rollback rather than by reading the code.
  const body = readFileSync(join(workflows, 'build-beta.yml'), 'utf8')

  it('asks production what it serves', () => {
    expect(body).toMatch(/build-info\.json/)
    expect(body).toMatch(/candidateId/)
  })

  it('matches a release by candidateId, not by tag order', () => {
    // Tag order is a naming convention; the manifest is the only thing that
    // ties a release to the bytes it actually deployed.
    expect(body).toMatch(/manifest\.json/)
    expect(body).toMatch(/\$ID.*=.*\$LIVE|"\$ID" = "\$LIVE"/)
  })

  it('still builds when production cannot be read or does not match', () => {
    // The first build of an interface version has no release at all, and an
    // unreachable origin must not block a build — but both must say so.
    expect(body).toMatch(/::warning::could not read/)
    expect(body).toMatch(/::warning::production serves/)
    expect(body).toMatch(/Falling back to the newest release/)
  })
})

describe('asset churn report', () => {
  // The changed-file/changed-byte report riding alongside asset retention —
  // same baseline, same "null must stay distinguishable from zero" lesson
  // (see 'retention baseline follows production' above, run 31331435560).
  const betaBody = readFileSync(join(workflows, 'build-beta.yml'), 'utf8')
  const promoteBody = readFileSync(join(workflows, 'promote-production.yml'), 'utf8')

  it('beta summary reads assetChurn out of the packed manifest', () => {
    expect(betaBody).toMatch(/assetChurn\.changedCount/)
    expect(betaBody).toMatch(/assetChurn\.totalCount/)
    expect(betaBody).toMatch(/assetChurn\.changedBytes/)
    expect(betaBody).toMatch(/assetChurn\.totalBytes/)
    expect(betaBody).toMatch(/Changed assets/)
  })

  it('names the baseline in both summaries rather than implying "previous commit"', () => {
    // Run 31392770174 reported 98/218 (70.6%) for a commit that changed no
    // bundled source: the baseline was two commits back and a refactor sat
    // between. The number was right, the label was not — so the row must
    // carry the baseline release AND commit, and must NOT claim to be
    // measuring against the previous release.
    for (const [name, body] of [['beta', betaBody], ['promote', promoteBody]] as const) {
      expect(body, `${name}: must read the baseline commit`)
        .toMatch(/assetChurn\.baselineCommit|churn_base_commit/)
      expect(body, `${name}: must render the baseline beside the figure`)
        .toMatch(/— vs/)
      expect(body, `${name}: must not claim "vs previous release"`)
        .not.toMatch(/vs previous release/)
    }
  })

  it('beta summary distinguishes "no baseline" from "baseline predates this field"', () => {
    // Both are CHURN_TOTAL being empty, but for different reasons — collapsing
    // them to one "n/a" would read as "first deploy" when a same-version
    // rebuild against an old baseline is actually why the number is missing.
    expect(betaBody).toMatch(/no retention baseline \(first deploy of this version\)/)
    expect(betaBody).toMatch(/predates the asset-churn report/)
  })

  it('both summaries report the new-code / re-emitted split, not just the total', () => {
    // The total alone cannot distinguish a three-file UI edit from a
    // dependency bump: on b051c74…d660fab, 89 of 90 changed assets were
    // byte-identical code whose imports had moved.
    for (const [name, body] of [['beta', betaBody], ['promote', promoteBody]] as const) {
      expect(body, `${name}: must read the classification`)
        .toMatch(/assetChurn\.contentCount|churn_content/)
      expect(body, `${name}: must read the re-emitted count`)
        .toMatch(/assetChurn\.rewrittenCount|churn_rewritten/)
      expect(body, `${name}: must render the split`).toMatch(/re-emitted for reference updates/)
      // Rendered only when classification happened — an unclassified build
      // must not print an empty "of which" row.
      expect(body, `${name}: split row must be conditional`)
        .toMatch(/if \[ -n "\$CHURN_SPLIT" \]/)
    }
  })

  it('both summaries table the new chunks by name, ranked by cascade', () => {
    // "90 assets changed" tells nobody which chunk to un-share. The names and
    // the cascade column are what make a recurring offender visible across
    // builds — on b051c74…d660fab that is one row, MultiSessionShell → 89.
    for (const [name, body] of [['beta', betaBody], ['promote', promoteBody]] as const) {
      expect(body, `${name}: must read the named list`).toMatch(/newAssets/)
      expect(body, `${name}: must render the cascade column`)
        .toMatch(/cascadeCount/)
      expect(body, `${name}: must head the table`)
        .toMatch(/\| New code \| Size \| Re-emitted downstream \|/)
      // Same rule as the "of which" row: an unclassified build renders no
      // table at all rather than an empty one.
      expect(body, `${name}: table must be conditional`)
        .toMatch(/if \[ -n "\$CHURN_TABLE" \]/)
      // A capped list that does not say it is capped reads as complete.
      expect(body, `${name}: must count what it hid`).toMatch(/more in .manifest\.json/)
    }
  })

  it('promote summary carries the same churn fields through manifest.json, not a recompute', () => {
    // Promote never rebuilds and never re-derives the diff — it only reads
    // what pack_artifact.mjs already computed and beta already showed.
    expect(promoteBody).toMatch(/assetChurn\.changedCount/)
    expect(promoteBody).toMatch(/assetChurn\.totalCount/)
    expect(promoteBody).toMatch(/Changed assets/)
  })
})

describe('beta summary hands off to promote', () => {
  const betaBody = readFileSync(join(workflows, 'build-beta.yml'), 'utf8')

  it('links the promote workflow and offers a command that pins THIS candidate', () => {
    // Two different needs. The link is for "promote what I just soaked", which
    // is the default path and needs no inputs. The `gh` command is for "promote
    // this one specifically" — the case the link cannot serve, because GitHub
    // has no way to prefill workflow_dispatch inputs from a URL.
    expect(betaBody).toMatch(/actions\/workflows\/promote-production\.yml/)
    expect(betaBody).toMatch(/gh workflow run promote-production\.yml/)
    expect(betaBody).toMatch(/candidate_run_id=\$GITHUB_RUN_ID/)
  })

  it('says why the link cannot carry the run id, so nobody re-adds a query string', () => {
    // Without the reason recorded, `?candidate_run_id=…` looks like an
    // obvious improvement — it would be silently ignored by GitHub, and the
    // operator would believe they had pinned a candidate when they had not.
    expect(betaBody).toMatch(/no\s*\n?\s*#?\s*way to prefill|cannot prefill|has no/)
    expect(betaBody).toMatch(/discussions\/28505/)
  })
})

describe('retention baseline', () => {
  // The baseline is the assets an already-open panel may still lazy-import
  // after a deploy replaces the bundle it booted from. Under build-once it
  // comes from the artifact in production; there is deliberately no git-side
  // fallback left, so all three outcomes have to be distinguishable.
  it('resolves to no baseline when unset — the first deploy of a version', () => {
    expect(resolveRetentionBaseline(undefined, 'v1')).toEqual({ dir: null })
    expect(resolveRetentionBaseline('', 'v1')).toEqual({ dir: null })
  })

  it('errors when the baseline is configured but absent, rather than retaining zero', () => {
    // This combination means the workflow believed a previous release existed
    // and failed to fetch it. Shipping anyway 404s every open session's next
    // lazy import, so it must abort rather than silently retain nothing.
    const missing = join(tmp, 'no-such-baseline')
    const result = resolveRetentionBaseline(missing, 'v1')
    expect(result.dir).toBeUndefined()
    expect(result.error).toMatch(/has no v1\/assets\//)
  })

  it('resolves to the version-scoped assets dir of a staged baseline tree', () => {
    // The shape Workflow A produces: `unzip runtime.zip` then point at site/.
    const root = join(tmp, 'baseline', 'site')
    mkdirSync(join(root, 'v1', 'assets'), { recursive: true })
    expect(resolveRetentionBaseline(root, 'v1'))
      .toEqual({ dir: join(root, 'v1', 'assets') })
  })

  it('scopes by interface version, so a bump correctly starts with none', () => {
    const root = join(tmp, 'baseline', 'site')
    mkdirSync(join(root, 'v1', 'assets'), { recursive: true })
    // A v1 baseline must not be offered to a v2 build: the hashes it carries
    // belong to a different wire contract's bundle.
    expect(resolveRetentionBaseline(root, 'v2').error).toMatch(/has no v2\/assets\//)
  })
})

describe('resolveRetentionBaselines — several baselines (WP-1b)', () => {
  // pack_artifact joins repeated --baseline flags with path.delimiter into
  // STAGE_RETENTION_BASELINE; stage_deploy splits them back here.
  const staged = (name: string) => {
    const root = join(tmp, 'multi-baseline', name, 'site')
    mkdirSync(join(root, 'v1', 'assets'), { recursive: true })
    return root
  }

  it('is empty when unset', () => {
    expect(resolveRetentionBaselines(undefined, 'v1')).toEqual({ baselines: [] })
    expect(resolveRetentionBaselines('', 'v1')).toEqual({ baselines: [] })
  })

  it('splits on the platform path delimiter, skipping empty segments', () => {
    // Windows paths carry a drive-letter colon, so the delimiter must be
    // path.delimiter (';' there), never a hard-coded ':'.
    const prod = staged('prod')
    const beta = staged('beta')
    const result = resolveRetentionBaselines(
      [prod, '', beta, ''].join(delimiter), 'v1')
    expect(result.error).toBeUndefined()
    expect(result.baselines).toEqual([
      { dir: join(prod, 'v1', 'assets') },
      { dir: join(beta, 'v1', 'assets') },
    ])
  })

  it('keeps the env order — production first — because order is precedence', () => {
    // stage_deploy retains baseline by baseline; the first to supply a path
    // wins it. pack_artifact passes production first, so a reorder here
    // would let a beta-only candidate's bytes shadow production's.
    const prod = staged('prod-order')
    const beta = staged('beta-order')
    expect(resolveRetentionBaselines([beta, prod].join(delimiter), 'v1').baselines)
      .toEqual([{ dir: join(beta, 'v1', 'assets') }, { dir: join(prod, 'v1', 'assets') }])
    expect(resolveRetentionBaselines([prod, beta].join(delimiter), 'v1').baselines)
      .toEqual([{ dir: join(prod, 'v1', 'assets') }, { dir: join(beta, 'v1', 'assets') }])
  })

  it('aborts when a SECOND baseline is set but missing, not just the first', () => {
    // A present first baseline must not mask a failed fetch of the second.
    const prod = staged('prod-missing')
    const missing = join(tmp, 'multi-baseline', 'never-fetched', 'site')
    const result = resolveRetentionBaselines([prod, missing].join(delimiter), 'v1')
    expect(result.baselines).toBeUndefined()
    expect(result.error).toContain(missing)
    expect(result.error).toMatch(/has no v1\/assets\//)
  })
})

describe('main carries no build output', () => {
  // The build-once flow. `deploy/v<N>/` was ~50 MB of minified
  // output committed to git, and it existed only because production
  // re-staged from the repo. Production now deploys a packed artifact, so a
  // re-committed snapshot would be dead weight whose merge conflicts are
  // unresolvable — and a second source of truth for what is live.
  it('deploy/ holds only the landing page, no v<N>/ bundle', () => {
    const entries = readdirSync(join(repoRoot, 'deploy'))
    expect(entries.filter(name => /^v\d+$/.test(name))).toEqual([])
    expect(entries).toContain('root-index.html')
  })

  it('has no snapshot or promote-verify scripts left to recreate one', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(Object.keys(pkg.scripts)).not.toContain('snapshot:update')
    expect(Object.keys(pkg.scripts)).not.toContain('promote:verify')
    const scripts = readdirSync(join(repoRoot, 'scripts'))
    expect(scripts).not.toContain('update_snapshot.mjs')
    expect(scripts).not.toContain('verify_promote.mjs')
  })

  it('stage_deploy has a single mode — no snapshot-only path', () => {
    // STAGE_BUILD_CURRENT=0 was how the production project asked for the
    // committed bytes instead of a build. With the snapshot gone that env var
    // could only mean "stage nothing", so it must not be readable any more.
    const body = readFileSync(join(repoRoot, 'scripts', 'stage_deploy.mjs'), 'utf8')
    expect(body).not.toMatch(/process\.env\.STAGE_BUILD_CURRENT/)
  })
})

describe('release workflow contract', () => {
  const read = (name: string) => readFileSync(join(workflows, name), 'utf8')

  it('builds in exactly one workflow', () => {
    // The single build point. If a second workflow ever compiles, "the bytes
    // that soaked are the bytes that ship" stops being true and nothing else
    // in the flow would notice.
    const builds = readdirSync(workflows)
      .filter(name => /\.ya?ml$/.test(name))
      .filter(name => name !== 'ci.yml')
      .filter(name => /npm run build|vite build|pack_artifact/.test(read(name)))
    expect(builds).toEqual(['build-beta.yml'])
  })

  for (const name of ['promote-production.yml', 'rollback-production.yml']) {
    it(`${name} neither checks out source nor installs dependencies`, () => {
      const body = read(name)
      // Line-scoped so prose in the header comments cannot trip it; the
      // workflow's own runtime guard scans the whole file with fragments.
      const offenders = body.split('\n').filter(line => {
        const code = line.replace(/#.*$/, '')
        return /uses:\s*actions\/(checkout|setup-node)/.test(code)
          || /npm (ci|install)\b/.test(code)
          || /(npm run build|vite build)/.test(code)
      })
      expect(offenders).toEqual([])
    })
  }

  it('serialises everything that writes production', () => {
    for (const name of ['promote-production.yml', 'rollback-production.yml']) {
      expect(read(name)).toMatch(/group:\s*production-deploy/)
    }
  })

  it('declares permissions in every workflow, never inheriting them', () => {
    // The repository default must be read/write, because a workflow's
    // `permissions:` block cannot exceed it — with the restricted default,
    // promote's `contents: write` was a 403 when it tried to create the
    // Release (run 31333467818). That default then applies to any workflow
    // that stays silent, so silence is how a build job quietly acquires a
    // token that can push tags and publish releases.
    for (const name of readdirSync(workflows).filter(n => /\.ya?ml$/.test(n))) {
      expect(read(name), `${name} must declare permissions`)
        .toMatch(/^permissions:/m)
    }
  })

  it('grants actions: read to every workflow that downloads a run artifact', () => {
    // The repository is private, so `gh run download` needs `actions: read`;
    // `contents: read` alone is a 403. build-beta.yml's beta-baseline step
    // (WP-1b) had only `contents: read`, discarded gh's stderr and reported
    // every failure as "expired" — so no beta deploy ever retained the
    // previous beta candidate. Each one dropped the entry and the hashed
    // assets a still-running desktop booted from, and a remote client pairing
    // with that desktop 404'd its locale catalog and rendered raw keys.
    let seen = 0
    for (const name of readdirSync(workflows).filter(n => /\.ya?ml$/.test(n))) {
      const body = read(name)
      const downloads = body.split('\n')
        .map(line => line.replace(/#.*$/, ''))
        .some(line => /gh run download\b/.test(line))
      if (!downloads) continue
      seen += 1
      const doc = parse(body) as { permissions?: Record<string, string> }
      expect(doc.permissions?.actions, `${name} runs \`gh run download\``)
        .toMatch(/^(read|write)$/)
    }
    expect(seen).toBeGreaterThan(0)
  })

  it('never discards the error of the beta-baseline download', () => {
    // A swallowed stderr is how the 403 above passed for "expired" on every
    // deploy. The warning must carry what gh actually said.
    const betaStep = read('build-beta.yml')
      .split(/\n\s*- name: /)
      .find(step => step.startsWith('Fetch beta retention baseline'))
    expect(betaStep).toBeDefined()
    const downloadLines = betaStep!.split('\n')
      .filter(line => /gh run download\b/.test(line.replace(/#.*$/, '')))
    expect(downloadLines.length).toBeGreaterThan(0)
    // The command's continuation lines up to the `then` of its `if`.
    const command = betaStep!.slice(betaStep!.indexOf('gh run download'))
      .split(/;\s*then/)[0]
    expect(command).not.toMatch(/2>\s*\/dev\/null/)
    expect(betaStep).not.toMatch(/is gone\s*"?\s*\\?\s*"?\s*\(expired\)/)
  })

  const betaBaselineStep = () => {
    const step = read('build-beta.yml')
      .split(/\n\s*- name: /)
      .find(s => s.startsWith('Fetch beta retention baseline'))
    expect(step).toBeDefined()
    return step!
  }

  it('reads the beta run id from a candidate id whose sha git lengthened', () => {
    // Resolve identity mints the id with `git rev-parse --short=7`, which is
    // a MINIMUM — git prints 8+ digits when 7 are ambiguous. An exact {7}
    // made such an id read as "no candidate": warn, exit 0, and the previous
    // beta candidate's entry and assets were dropped from the next deploy.
    // The sed -E pattern is also a valid JS pattern, so run it directly.
    const m = /BRUN=.*sed -nE 's\/(.+?)\/\\1\/p'/.exec(betaBaselineStep())
    expect(m, 'BRUN sed expression').not.toBeNull()
    const re = new RegExp(m![1])
    const runId = (id: string) => re.exec(id)?.[1] ?? ''
    expect(runId('candidate-v1-be4f115-18429376123')).toBe('18429376123')
    expect(runId('candidate-v1-be4f1150-18429376123')).toBe('18429376123')
    expect(runId(`candidate-v12-${'a'.repeat(40)}-7`)).toBe('7')
    expect(runId('candidate-v1-be4f11-18429376123')).toBe('')
    expect(runId('candidate-v1-be4f115-local')).toBe('')
  })

  it('degrades, not fails, when the beta candidate artifact will not unpack', () => {
    // The step runs under `set -e`, so any unzip outside an `if` condition
    // turns a corrupt or runtime.zip-less artifact into a failed build —
    // when it only means one baseline fewer. A partial extraction must also
    // go, or the pack step's `[ -d beta-baseline/site ]` passes half a tree.
    const code = betaBaselineStep().split('\n').map(l => l.replace(/#.*$/, ''))
    const unzips = code.filter(l => /\bunzip\b/.test(l))
    expect(unzips.length).toBeGreaterThan(0)
    for (const line of unzips) expect(line).toMatch(/^\s*if\b/)
    expect(code.join('\n')).toMatch(/rm -rf beta-baseline\b/)
    expect(code.join('\n')).toMatch(/::warning::could not unpack the beta candidate/)
  })

  it('uses only action majors whose runtime is Node 24', () => {
    // GitHub deprecated the Node 20 action runtime and currently force-runs
    // those actions on Node 24; when that forcing is withdrawn, a v4 action
    // stops working — and the workflow it lands in is the one that builds and
    // ships the runtime. The floor per action is the FIRST major that actually
    // runs on Node 24, which is not always the first that mentions it:
    // upload-artifact v5 shipped "preliminary support" while still defaulting
    // to Node 20, so v6 is its real floor.
    const floor: Record<string, number> = {
      'actions/checkout': 5,
      'actions/setup-node': 5,
      'actions/upload-artifact': 6,
      'actions/download-artifact': 7,
    }
    let seen = 0
    for (const name of readdirSync(workflows).filter(n => /\.ya?ml$/.test(n))) {
      for (const line of read(name).split('\n')) {
        const m = /^\s*-?\s*uses:\s*([\w.-]+\/[\w.-]+)@v(\d+)/.exec(
          line.replace(/#.*$/, ''))
        if (!m) continue
        seen += 1
        const [, action, major] = m
        // An unlisted action fails rather than passing unchecked — adding one
        // means deciding which of its majors is Node 24, which is the whole
        // point of this test.
        expect(floor[action], `${name}: unreviewed action ${action}`)
          .toBeDefined()
        expect(Number(major), `${name}: ${action}@v${major} predates Node 24`)
          .toBeGreaterThanOrEqual(floor[action])
      }
    }
    // A regex that silently matched nothing would make this test green for the
    // wrong reason — including on the day someone reformats a `uses:` line.
    expect(seen).toBeGreaterThan(0)
  })

  it('pins one wrangler version everywhere it deploys', () => {
    const pins = new Set<string>()
    for (const name of ['build-beta.yml', 'promote-production.yml', 'rollback-production.yml']) {
      for (const match of read(name).matchAll(/wrangler@([\d.]+)/g)) {
        pins.add(match[1])
      }
    }
    // A floating version would mean the deploy tool differs between the beta
    // upload and the production upload of the same artifact.
    expect([...pins]).toHaveLength(1)
  })

  it('deploys beta under the beta worker name and production under the config default', () => {
    // Production takes its worker name from the wrangler.toml sealed inside
    // the artifact, so the promoted config is the one that was soaked. Beta
    // overrides on the command line for exactly that reason.
    // Scoped to the wrangler invocation: `gh run download --name candidate`
    // is a different flag on a different tool.
    const wranglerCall = (name: string) =>
      read(name)
        .split('\n')
        .map(line => line.replace(/#.*$/, ''))
        .join('\n')
        .split(/wrangler@[\d.]+/)
        .slice(1)
        .join('\n')
    expect(wranglerCall('build-beta.yml')).toMatch(/--name velloc-runtime-beta/)
    expect(wranglerCall('promote-production.yml')).not.toMatch(/--name/)
    expect(wranglerCall('rollback-production.yml')).not.toMatch(/--name/)
  })
})

/**
 * Immutable build entry (F-24): `/v<N>/b/<buildKey>/` holds byte-identical index.html + assets-manifest.json so a
 * remote client can name a build by URL. Pins the key derivation, byte identity, inheritance and the recursive
 * retainBaselineAssets; the collision guard (process.exit) is asserted via a child process.
 */
describe('build key derivation (TS and stage-side twins agree)', () => {
  // The page reads its own nexus-build-time meta and derives a key with the TS
  // function; stage_deploy.mjs reads the same meta and derives the key with the
  // .mjs function. If they ever disagree, the entry the page points at is not
  // the one that was staged. Pin them equal over a shared input set.
  const inputs = [
    '2026-09-17T10:30:00.000Z',
    '2026-09-08T03:38:46.000Z',
    '2026-01-01T00:00:00.000Z',
    '',
    'garbage',
    '2026-09-17T10:30:00Z',
  ]

  it('produces byte-identical keys across the TS and .mjs implementations', () => {
    for (const iso of inputs) {
      expect(buildKeyMjs(iso), `mjs(${JSON.stringify(iso)})`).toBe(buildKeyTs(iso))
    }
  })

  it('reads the key out of a staged index.html meta tag', () => {
    const html = `<!doctype html><head><meta name="${BUILD_TIME_META_NAME}" content="2026-09-08T03:38:46.000Z"></head>`
    expect(readBuildKeyFromIndexHtml(html)).toBe('20260908T033846000Z')
  })

  it('the meta-name literal the .mjs greps for matches BUILD_TIME_META_NAME', () => {
    // The .mjs cannot import the TS constant (plain Node during staging), so it
    // greps the literal. If the constant is ever renamed, the grep silently
    // stops matching and every stage fails with "no valid meta" — this pins the
    // literal so the rename is caught here, not in CI.
    const html = `<meta name="${BUILD_TIME_META_NAME}" content="2026-01-01T00:00:00.000Z">`
    expect(readBuildKeyFromIndexHtml(html)).toBe('20260101T000000000Z')
  })
})

// A build key is a fixed-shape transform of a millisecond ISO timestamp; these
// two helpers convert between them so fixtures stay readable.
const keyFromIso = (iso: string) => iso.replace(/[-:.]/g, '')
const isoFromKey = (key: string) =>
  `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T` +
  `${key.slice(9, 11)}:${key.slice(11, 13)}:${key.slice(13, 15)}.${key.slice(15, 18)}Z`

describe('stageBuildEntry', () => {
  const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

  // Stage a minimal v<N>/ tree whose index.html carries the given key's meta.
  const stageTree = (key: string) => {
    const dir = join(tmp, `stage-${key}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'),
      `<!doctype html><meta name="${BUILD_TIME_META_NAME}" content="${isoFromKey(key)}">`)
    writeFileSync(join(dir, 'assets-manifest.json'), '{"buildId":"x","assets":[]}\n')
    return dir
  }

  it('stages byte-identical index.html and manifest under b/<key>/', () => {
    const key = keyFromIso('2026-09-08T03:38:46.000Z')
    const dir = stageTree(key)
    const result = stageBuildEntry(dir)
    expect(result.key).toBe(key)
    // entryPath is built from the staged dir's basename — the dir staged above.
    expect(result.entryPath).toBe(`/${dir.split(/[\\/]/).pop()}/b/${key}/`)
    for (const name of ['index.html', 'assets-manifest.json']) {
      const a = readFileSync(join(dir, name))
      const b = readFileSync(join(dir, 'b', key, name))
      expect(sha256(b), name).toBe(sha256(a))
    }
  })
})

describe('retainBaselineEntries', () => {
  // Write an entry under `<root>/v<N>/b/<key>/`.
  const writeEntry = (versionedRoot: string, key: string, body: string) => {
    const dir = join(versionedRoot, 'b', key)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), body)
    writeFileSync(join(dir, 'assets-manifest.json'), '{}')
  }

  it('inherits baseline entries the fresh build does not have', () => {
    const baselineRoot = join(tmp, 'rb-base')          // .../site
    const baselineV = join(baselineRoot, 'v1')
    const stagedV = join(tmp, 'rb-staged', 'v1')
    mkdirSync(baselineV, { recursive: true })
    mkdirSync(stagedV, { recursive: true })
    writeEntry(baselineV, 'K1', 'baseline-one')        // baseline has K1
    writeEntry(stagedV, 'K2', 'fresh-two')             // fresh build has K2

    const inherited = retainBaselineEntries(baselineRoot, 'v1', stagedV)
    expect(inherited).toBe(1)
    expect(readFileSync(join(stagedV, 'b', 'K1', 'index.html'), 'utf8')).toBe('baseline-one')
    expect(readFileSync(join(stagedV, 'b', 'K2', 'index.html'), 'utf8')).toBe('fresh-two')
  })

  it('returns 0 with no baseline and with a baseline that has no entries', () => {
    const stagedV = join(tmp, 'rb-empty', 'v1')
    mkdirSync(stagedV, { recursive: true })
    expect(retainBaselineEntries(null, 'v1', stagedV)).toBe(0)
    const baselineRoot = join(tmp, 'rb-emptybase')
    mkdirSync(join(baselineRoot, 'v1'), { recursive: true })
    expect(retainBaselineEntries(baselineRoot, 'v1', stagedV)).toBe(0)
  })

  it('treats a re-staged key with identical bytes as already present (no double count)', () => {
    // A rebuild of the SAME commit re-stages the SAME key. The baseline already
    // carries it with identical bytes — it must be skipped, not inherited anew.
    const baselineRoot = join(tmp, 'rb-same-base')
    const baselineV = join(baselineRoot, 'v1')
    const stagedV = join(tmp, 'rb-same-staged', 'v1')
    mkdirSync(baselineV, { recursive: true })
    mkdirSync(stagedV, { recursive: true })
    writeEntry(baselineV, 'K1', 'same-bytes')
    writeEntry(stagedV, 'K1', 'same-bytes')
    expect(retainBaselineEntries(baselineRoot, 'v1', stagedV)).toBe(0)
  })

  it('fails a same-key/different-bytes entry and names the rebuild as the likely cause', () => {
    // The key is the commit's build time, so the usual way to reach this is
    // rebuilding an already-deployed commit with non-reproducible output —
    // not two commits colliding. The old message only named the collision
    // and told the operator to amend a commit that was never the problem.
    const baselineRoot = join(tmp, 'rb-diff-base')
    const baselineV = join(baselineRoot, 'v1')
    const stagedV = join(tmp, 'rb-diff-staged', 'v1')
    mkdirSync(baselineV, { recursive: true })
    mkdirSync(stagedV, { recursive: true })
    writeEntry(baselineV, 'K1', 'deployed-bytes')
    writeEntry(stagedV, 'K1', 'rebuilt-bytes')
    const errors: string[] = []
    const err = vi.spyOn(console, 'error').mockImplementation((m: string) => { errors.push(m) })
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    try {
      expect(() => retainBaselineEntries(baselineRoot, 'v1', stagedV)).toThrow('exit 1')
    } finally {
      exit.mockRestore()
      err.mockRestore()
    }
    const message = errors.join('\n')
    expect(message).toMatch(/build-key collision on "K1"/)
    expect(message).toMatch(/REBUILD of an already-deployed commit/)
    expect(message).toMatch(/redeploy the candidate already built from that commit/)
    // The fresh entry is left as staged — never overwritten by the baseline.
    expect(readFileSync(join(stagedV, 'b', 'K1', 'index.html'), 'utf8')).toBe('rebuilt-bytes')
  })
})

describe('retainBaselineAssets — recursive to file level (locale hole)', () => {
  // Regression pin for the pre-recursion bug: it iterated TOP-level entries and
  // skipped any directory the fresh build also emitted, so assets/locales/ was
  // skipped whole and old locale catalogs were never retained. The recursive
  // walk must carry old locale files forward alongside the new ones.
  it('retains old locale catalogs under a directory the fresh build also emits', () => {
    const base = join(tmp, 'loc-baseline', 'assets')
    const staged = join(tmp, 'loc-staged', 'assets')
    mkdirSync(join(base, 'locales'), { recursive: true })
    mkdirSync(join(staged, 'locales'), { recursive: true })
    writeFileSync(join(base, 'locales', 'zh-OLD.json'), '{"old":true}')
    writeFileSync(join(base, 'locales', 'en-OLD.json'), '{"old":true}')
    writeFileSync(join(staged, 'locales', 'zh-NEW.json'), '{"new":true}')
    // A top-level file the fresh build dropped.
    writeFileSync(join(base, 'chunk-OLD.js'), 'old')

    const retained = retainBaselineAssets(base, staged)
    expect(retained).toBe(3) // zh-OLD + en-OLD + chunk-OLD
    expect(readFileSync(join(staged, 'locales', 'zh-OLD.json'), 'utf8')).toBe('{"old":true}')
    expect(readFileSync(join(staged, 'locales', 'en-OLD.json'), 'utf8')).toBe('{"old":true}')
    expect(readFileSync(join(staged, 'locales', 'zh-NEW.json'), 'utf8')).toBe('{"new":true}')
    expect(readFileSync(join(staged, 'chunk-OLD.js'), 'utf8')).toBe('old')
  })

  it('still carries a whole directory the fresh build never emitted', () => {
    // Top-level behaviour must not regress: a baseline-only directory is copied
    // intact, and its files are counted.
    const base = join(tmp, 'dir-baseline', 'assets')
    const staged = join(tmp, 'dir-staged', 'assets')
    mkdirSync(join(base, 'gone'), { recursive: true })
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(base, 'gone', 'a.js'), 'a')
    writeFileSync(join(base, 'gone', 'b.js'), 'b')
    expect(retainBaselineAssets(base, staged)).toBe(2)
    expect(readFileSync(join(staged, 'gone', 'a.js'), 'utf8')).toBe('a')
  })
})

/**
 * WP-1b — beta's retention baseline is a UNION of the production release and
 * the previous beta candidate, so an entry/asset that only ever shipped on
 * beta survives the next beta deploy. parseArgs must accumulate a repeated
 * --baseline into a list (it used to overwrite, latter-wins), and the stage
 * side must retain the union across baselines.
 */
describe('parseArgs accumulates repeated flags (WP-1b)', () => {
  it('collects a repeated flag into an array, preserving order', () => {
    expect(parseArgs(['--baseline', 'a', '--baseline', 'b']).baseline)
      .toEqual(['a', 'b'])
  })

  it('keeps a flag given once a scalar, so single-value readers are unchanged', () => {
    const out = parseArgs(['--baseline', 'only', '--out', 'dest'])
    expect(out.baseline).toBe('only')
    expect(out.out).toBe('dest')
  })

  it('still treats a valueless flag as true', () => {
    expect(parseArgs(['--verbose', '--baseline', 'x']))
      .toEqual({ verbose: true, baseline: 'x' })
  })
})

describe('retention union across multiple baselines (WP-1b)', () => {
  const asset = (root: string, rel: string, body: string) => {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  const entry = (versionedRoot: string, key: string, body: string) => {
    asset(versionedRoot, join('b', key, 'index.html'), body)
    asset(versionedRoot, join('b', key, 'assets-manifest.json'), '{}')
  }

  it('retains assets and entries that are unique to EITHER baseline', () => {
    // Baseline A (production) has asset a + entry KA; baseline B (a beta-only
    // candidate) has asset b + entry KB. The fresh build has neither. The union
    // must carry all four forward — that is the whole point of WP-1b.
    const baseA = join(tmp, 'union-a')
    const baseB = join(tmp, 'union-b')
    const stagedV = join(tmp, 'union-staged', 'v1')
    mkdirSync(stagedV, { recursive: true })
    asset(baseA, join('v1', 'assets', 'a.js'), 'a')
    entry(join(baseA, 'v1'), 'KA', 'entry-a')
    asset(baseB, join('v1', 'assets', 'b.js'), 'b')
    entry(join(baseB, 'v1'), 'KB', 'entry-b')

    // Mirror stage_deploy's per-baseline loop: assets then entries, each root.
    let retained = 0
    let retainedEntries = 0
    for (const root of [baseA, baseB]) {
      retained += retainBaselineAssets(join(root, 'v1', 'assets'), join(stagedV, 'assets'))
      retainedEntries += retainBaselineEntries(root, 'v1', stagedV)
    }

    expect(retained).toBe(2) // a.js + b.js
    expect(retainedEntries).toBe(2) // KA + KB
    expect(readFileSync(join(stagedV, 'assets', 'a.js'), 'utf8')).toBe('a')
    expect(readFileSync(join(stagedV, 'assets', 'b.js'), 'utf8')).toBe('b')
    expect(readFileSync(join(stagedV, 'b', 'KA', 'index.html'), 'utf8')).toBe('entry-a')
    expect(readFileSync(join(stagedV, 'b', 'KB', 'index.html'), 'utf8')).toBe('entry-b')
  })
})
