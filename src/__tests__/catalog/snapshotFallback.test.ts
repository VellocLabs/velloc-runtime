/**
 * Publish fallback (F-28): when the live model source is unusable at
 * publish time, the snapshot a deployed bundle serves is checked and carried
 * forward with a loud warning; the publish fails only when neither is usable.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSnapshotFiles,
  describeSnapshotAge,
  readServedSnapshot,
  type SnapshotFiles,
} from '../../catalog/snapshotGenerator'
import { SNAPSHOT_PROVIDER_KEYS } from '../../catalog/snapshotProviders'
import { builtinCatalogSourceDocument } from '../_helpers/builtinCatalogFigures'
import type { CatalogIndex } from '../../catalog/types'
import sample from './fixtures/models-dev-sample.json'

const DOC = JSON.stringify(sample)
// The sample holds only a few of the allow-listed providers, too few for the
// default list's guard; the reader tests keep exactly the sample's keys.
const SAMPLE_KEYS = Object.keys(sample)
// Every allow-listed provider (copies of one sample provider), plus one the
// list does not name: a document the default list filters down.
const WIDE_KEYS = [...SNAPSHOT_PROVIDER_KEYS, 'some-reseller']
const WIDE_DOC = JSON.stringify(Object.fromEntries(
  WIDE_KEYS.map(k => [k, { ...(sample as Record<string, object>).deepseek, id: k }]),
))
const DAY = 86_400_000

const served = (files: SnapshotFiles) => async (rel: string) => files[rel]
const indexOf = (files: SnapshotFiles) => JSON.parse(files['index.json']) as CatalogIndex

describe('readServedSnapshot', () => {
  it('reads back a generated snapshot byte for byte', async () => {
    const files = buildSnapshotFiles(DOC, 1_700_000_000_000, SAMPLE_KEYS)
    const snap = await readServedSnapshot(served(files))
    expect(snap.files).toEqual(files)
    expect(snap.index.generatedAt).toBe(1_700_000_000_000)
    expect(snap.index.partial).toBeUndefined()
  })

  it('reads back a filtered (partial) snapshot byte for byte, partial intact', async () => {
    const files = buildSnapshotFiles(WIDE_DOC, 1_700_000_000_000)
    expect(indexOf(files).partial).toBe(true)
    const snap = await readServedSnapshot(served(files))
    expect(snap.files).toEqual(files)
    expect(snap.index.partial).toBe(true)
    expect(Object.keys(snap.index.providers).sort()).toEqual([...SNAPSHOT_PROVIDER_KEYS].sort())
  })

  it('refuses a snapshot with no index', async () => {
    const files = buildSnapshotFiles(DOC, 1, SAMPLE_KEYS)
    delete files['index.json']
    await expect(readServedSnapshot(served(files))).rejects.toThrow(/index\.json/)
  })

  it('refuses a snapshot whose ids.json is missing', async () => {
    const files = buildSnapshotFiles(DOC, 1, SAMPLE_KEYS)
    delete files['ids.json']
    await expect(readServedSnapshot(served(files))).rejects.toThrow(/ids\.json/)
  })

  it('refuses a snapshot missing a provider file the index names', async () => {
    const files = buildSnapshotFiles(DOC, 1, SAMPLE_KEYS)
    const key = Object.keys((JSON.parse(files['index.json']) as CatalogIndex).providers)[0]
    delete files[`providers/${key}.json`]
    await expect(readServedSnapshot(served(files))).rejects.toThrow(/missing or unreadable/)
  })

  it('refuses a provider file from another deploy (hash mismatch)', async () => {
    const files = buildSnapshotFiles(DOC, 1, SAMPLE_KEYS)
    const key = Object.keys((JSON.parse(files['index.json']) as CatalogIndex).providers)[0]
    const records = JSON.parse(files[`providers/${key}.json`]) as Record<string, unknown>
    const first = Object.keys(records)[0]
    delete records[first]
    files[`providers/${key}.json`] = JSON.stringify(records)
    await expect(readServedSnapshot(served(files))).rejects.toThrow(/index hash/)
  })

  it('refuses an index whose model count or content hash is off', async () => {
    const files = buildSnapshotFiles(DOC, 1, SAMPLE_KEYS)
    const index = JSON.parse(files['index.json']) as CatalogIndex
    await expect(
      readServedSnapshot(served({ ...files, 'index.json': JSON.stringify({ ...index, modelCount: 1 }) })),
    ).rejects.toThrow(/model count/)
    await expect(
      readServedSnapshot(served({ ...files, 'index.json': JSON.stringify({ ...index, contentHash: 'x' }) })),
    ).rejects.toThrow(/content hash/)
  })

  it('refuses a provider file that does not parse as records', async () => {
    const files = buildSnapshotFiles(DOC, 1, SAMPLE_KEYS)
    const key = Object.keys((JSON.parse(files['index.json']) as CatalogIndex).providers)[0]
    files[`providers/${key}.json`] = '{"m": 1}'
    await expect(readServedSnapshot(served(files))).rejects.toThrow(/missing or unreadable/)
  })
})

describe('describeSnapshotAge', () => {
  it('names hours, then days', () => {
    expect(describeSnapshotAge(0, 10 * 60_000)).toBe('under an hour')
    expect(describeSnapshotAge(0, 3_600_000)).toBe('1 hour')
    expect(describeSnapshotAge(0, 30 * 3_600_000)).toBe('30 hours')
    expect(describeSnapshotAge(0, 3 * DAY)).toBe('3 days')
  })
})

describe('gen_catalog_snapshot fallback', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const script = path.join(root, 'scripts', 'gen_catalog_snapshot.ts')

  function run(args: string[]) {
    return spawnSync(process.execPath, [tsx, script, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 })
  }

  // Copies of one provider do not hold the built-in rows' figures: the
  // fallback's file handling is what that test checks (the coverage gate: below).
  const runLayout = (args: string[]) => run([...args, '--skip-builtin-coverage'])

  /** A served interface root (`<base>/catalog/snapshot/...`) on disk. */
  function serve(base: string, files: SnapshotFiles) {
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(base, 'catalog', 'snapshot', rel)
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, text)
    }
  }

  function readTree(dir: string): SnapshotFiles {
    const out: SnapshotFiles = {}
    const walk = (d: string, pre: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name), `${pre}${e.name}/`)
        else out[`${pre}${e.name}`] = readFileSync(path.join(d, e.name), 'utf8')
      }
    }
    walk(dir, '')
    return out
  }

  it('live ok, live fails, both fail, reused snapshot invalid', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'catalog-fallback-'))
    try {
      const good = path.join(tmp, 'good.json')
      const bad = path.join(tmp, 'bad.json')
      writeFileSync(good, WIDE_DOC)
      writeFileSync(bad, '{"x": 1}')
      // Served snapshots of both shapes: one a deploy from before the
      // allow-list wrote (every provider, no `partial`), one a filtered
      // deploy wrote (`partial`). Either is carried forward as-is.
      const older = buildSnapshotFiles(WIDE_DOC, Date.now() - 5 * DAY, WIDE_KEYS)
      const newer = buildSnapshotFiles(WIDE_DOC, Date.now() - 3 * DAY)
      expect(indexOf(older).partial).toBeUndefined()
      expect(indexOf(newer).partial).toBe(true)
      const beta = path.join(tmp, 'beta', 'v5')
      const prod = path.join(tmp, 'prod', 'v5')
      serve(beta, newer)
      serve(prod, older)
      const missing = path.join(tmp, 'nothing', 'v5')

      // Live ok: the live document wins, no warning, fallback never read.
      const out1 = path.join(tmp, 'o1', 'snapshot')
      const live = runLayout(['--file', good, '--out', out1, '--fallback-base', beta])
      expect(live.status, live.stderr).toBe(0)
      expect(live.stdout).not.toMatch(/::warning/)
      const liveIndex = JSON.parse(readFileSync(path.join(out1, 'index.json'), 'utf8')) as CatalogIndex
      expect(liveIndex.generatedAt).toBeGreaterThan(Date.now() - DAY)
      expect(liveIndex.partial).toBe(true)

      // Live fails: the fresher usable served snapshot is written verbatim,
      // with an Actions annotation and a log line naming its age.
      const out2 = path.join(tmp, 'o2', 'snapshot')
      const reused = runLayout(['--file', bad, '--out', out2, '--fallback-base', missing, '--fallback-base', prod, '--fallback-base', beta])
      expect(reused.status, reused.stderr).toBe(0)
      expect(readTree(out2)).toEqual(newer)
      expect(indexOf(readTree(out2)).partial).toBe(true)
      expect(reused.stdout).toMatch(/^::warning title=Model catalog snapshot reused::.*3 days old/m)
      expect(reused.stdout).toMatch(/^catalog snapshot WARNING: .*no providers.*3 days old/m)
      expect(existsSync(`${out2}.tmp`)).toBe(false)

      // Both fail: exit 1, nothing written (an existing output is kept).
      const out3 = path.join(tmp, 'o3', 'snapshot')
      const none = runLayout(['--file', bad, '--out', out3, '--fallback-base', missing])
      expect(none.status).toBe(1)
      expect(none.stderr).toMatch(/catalog snapshot FAILED: live source: .*no usable served snapshot/)
      expect(existsSync(out3)).toBe(false)
      expect(existsSync(`${out3}.tmp`)).toBe(false)
      const keep = runLayout(['--file', bad, '--out', out1, '--fallback-base', missing])
      expect(keep.status).toBe(1)
      expect(JSON.parse(readFileSync(path.join(out1, 'index.json'), 'utf8'))).toEqual(liveIndex)

      // A served snapshot that does not validate counts as unusable.
      const broken = path.join(tmp, 'broken', 'v5')
      const index = JSON.parse(newer['index.json']) as CatalogIndex
      serve(broken, { ...newer, 'index.json': JSON.stringify({ ...index, modelCount: index.modelCount + 1 }) })
      const out4 = path.join(tmp, 'o4', 'snapshot')
      const invalid = runLayout(['--file', bad, '--out', out4, '--fallback-base', broken])
      expect(invalid.status).toBe(1)
      expect(invalid.stderr).toMatch(/model count/)
      expect(existsSync(out4)).toBe(false)

      // An invalid base beside a valid one: the valid one is used.
      const out5 = path.join(tmp, 'o5', 'snapshot')
      const mixed = runLayout(['--file', bad, '--out', out5, '--fallback-base', broken, '--fallback-base', prod])
      expect(mixed.status, mixed.stderr).toBe(0)
      // A pre-filter served snapshot is not filtered on reuse.
      expect(readTree(out5)).toEqual(older)
      expect(Object.keys(indexOf(older).providers)).toContain('some-reseller')
      expect(mixed.stdout).toMatch(/5 days old/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)

  it('the coverage gate checks the snapshot written, live or reused', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'catalog-fallback-gate-'))
    try {
      const bad = path.join(tmp, 'bad.json')
      const uncoveredDoc = path.join(tmp, 'uncovered.json')
      writeFileSync(bad, '{"x": 1}')
      writeFileSync(uncoveredDoc, JSON.stringify(builtinCatalogSourceDocument('minimax')))
      const covered = buildSnapshotFiles(JSON.stringify(builtinCatalogSourceDocument()), Date.now() - 2 * DAY)
      const uncovered = buildSnapshotFiles(JSON.stringify(builtinCatalogSourceDocument('minimax')), Date.now() - 2 * DAY)
      const good = path.join(tmp, 'good', 'v5')
      const lacking = path.join(tmp, 'lacking', 'v5')
      serve(good, covered)
      serve(lacking, uncovered)

      // A reused snapshot that covers the built-in rows is written as-is.
      const out1 = path.join(tmp, 'o1', 'snapshot')
      const reused = run(['--file', bad, '--out', out1, '--fallback-base', good])
      expect(reused.status, reused.stderr).toBe(0)
      expect(readTree(out1)).toEqual(covered)

      // A reused snapshot that does not cover them fails the publish, naming
      // the rows, and nothing is written.
      const out2 = path.join(tmp, 'o2', 'snapshot')
      const short = run(['--file', bad, '--out', out2, '--fallback-base', lacking])
      expect(short.status).toBe(1)
      expect(short.stderr).toMatch(/does not cover the built-in rows/)
      expect(short.stderr).toMatch(/minimax \/ /)
      expect(existsSync(out2)).toBe(false)
      expect(existsSync(`${out2}.tmp`)).toBe(false)

      // A live document that does not cover them fails the publish too: the
      // gap is in the source and needs a person, so the served snapshot is
      // not used to hide it.
      const out3 = path.join(tmp, 'o3', 'snapshot')
      const live = run(['--file', uncoveredDoc, '--out', out3, '--fallback-base', good])
      expect(live.status).toBe(1)
      expect(live.stderr).toMatch(/does not cover the built-in rows/)
      expect(live.stdout).not.toMatch(/::warning/)
      expect(existsSync(out3)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})
