import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { createCatalogStore } from '../../catalog/catalogStore'
import { createSnapshotReader } from '../../catalog/catalogSnapshot'
import { createModelCatalog } from '../../catalog/modelCatalog'
import { buildSnapshotFiles, missingSnapshotProviders } from '../../catalog/snapshotGenerator'
import { SNAPSHOT_PROVIDER_KEYS } from '../../catalog/snapshotProviders'
import { isSafeProviderKey } from '../../catalog/catalogReader'
import type { CatalogIndex } from '../../catalog/types'
import sample from './fixtures/models-dev-sample.json'

const DOC = JSON.stringify(sample)
/** The fixture's own providers: kept whole, so the snapshot equals a refresh. */
const SAMPLE_KEYS = Object.keys(sample)
const NOW = 1_800_000_000_000

/** In-memory fs with the host's rename rule (never overwrites). */
function memFs() {
  const store = new Map<string, string>()
  const missing = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { name: 'NotFoundError' })
  const fs = {
    async readFile(p: string) {
      if (!store.has(p)) throw missing(p)
      return store.get(p)!
    },
    async writeFile(p: string, data: string) {
      store.set(p, String(data))
    },
    async stat(p: string) {
      if (!store.has(p)) throw missing(p)
      return { size: store.get(p)!.length } as never
    },
    async unlink(p: string) {
      if (!store.delete(p)) throw missing(p)
    },
    async mkdir() {},
    async rename(a: string, b: string) {
      store.set(b, store.get(a)!)
      store.delete(a)
    },
  } as unknown as RuntimeFs
  return { fs, store }
}

describe('snapshot generator', () => {
  it('writes index.json, ids.json and one file per provider', () => {
    const files = buildSnapshotFiles(DOC, NOW, SAMPLE_KEYS)
    const index = JSON.parse(files['index.json']) as CatalogIndex
    expect(index.generatedAt).toBe(NOW)
    expect(index.fetchedAt).toBeUndefined()
    expect(index.etag).toBeUndefined()
    for (const key of Object.keys(index.providers)) {
      expect(files[`providers/${key}.json`], key).toBeTruthy()
    }
    expect(Object.keys(files).sort()).toEqual(
      ['ids.json', 'index.json', ...Object.keys(index.providers).map(k => `providers/${k}.json`)].sort(),
    )
    expect(index.modelCount).toBeGreaterThan(0)
  })

  it('equals what a runtime refresh of the same document stores', async () => {
    const files = buildSnapshotFiles(DOC, NOW, SAMPLE_KEYS)
    const mem = memFs()
    const store = createCatalogStore({ fs: mem.fs, dir: '/c' })
    const catalog = createModelCatalog({
      store,
      snapshot: createSnapshotReader({ fetchAsset: async () => undefined }),
      http: async () => ({ status: 200, body: DOC }),
      now: () => NOW,
    })
    await catalog.refresh()
    for (const [rel, text] of Object.entries(files)) {
      if (rel === 'index.json') continue
      expect(mem.store.get(`/c/${rel}`), rel).toBe(text)
    }
    const stored = JSON.parse(mem.store.get('/c/index.json')!) as CatalogIndex
    const snap = JSON.parse(files['index.json']) as CatalogIndex
    expect(snap.contentHash).toBe(stored.contentHash)
    expect(snap.providers).toEqual(stored.providers)
    expect(snap.modelCount).toBe(stored.modelCount)
  })

  it('is read back by the snapshot reader and answers lookups', async () => {
    const files = buildSnapshotFiles(DOC, NOW, SAMPLE_KEYS)
    const reads: string[] = []
    const catalog = createModelCatalog({
      store: createCatalogStore({ fs: memFs().fs, dir: '/empty' }),
      snapshot: createSnapshotReader({
        fetchAsset: async p => {
          reads.push(p)
          return files[p.replace(/^catalog\/snapshot\//, '')]
        },
      }),
      // Offline: the source is unreachable, the snapshot answers.
      http: async () => {
        throw new Error('offline')
      },
      now: () => NOW,
    })
    const providerKey = Object.keys(JSON.parse(files['index.json']).providers)[0]
    const records = await catalog.provider(providerKey)
    expect(records && Object.keys(records).length).toBeGreaterThan(0)
    expect((await catalog.status()).source).toBe('snapshot')
    expect(reads).toContain('catalog/snapshot/index.json')
  })

  it('keeps only the listed providers and marks the index partial', () => {
    const files = buildSnapshotFiles(DOC, NOW, ['opencode', 'deepseek'])
    const index = JSON.parse(files['index.json']) as CatalogIndex
    expect(Object.keys(index.providers).sort()).toEqual(['deepseek', 'opencode'])
    expect(index.partial).toBe(true)
    expect(Object.keys(files).filter(f => f.startsWith('providers/')).sort()).toEqual([
      'providers/deepseek.json',
      'providers/opencode.json',
    ])
    const ids = JSON.parse(files['ids.json']) as { ids: Record<string, string[]> }
    for (const keys of Object.values(ids.ids)) {
      for (const key of keys) expect(['opencode', 'deepseek']).toContain(key)
    }
    const kept = JSON.parse(files['providers/opencode.json']) as object
    expect(index.modelCount).toBe(
      Object.keys(kept).length + Object.keys(JSON.parse(files['providers/deepseek.json'])).length,
    )
  })

  it('is not partial when every provider of the document is kept', () => {
    const index = JSON.parse(buildSnapshotFiles(DOC, NOW, SAMPLE_KEYS)['index.json']) as CatalogIndex
    expect(index.partial).toBeUndefined()
  })

  it('refuses a document that has fewer than half of the listed providers', () => {
    expect(() =>
      buildSnapshotFiles(DOC, NOW, ['opencode', 'renamed-a', 'renamed-b', 'renamed-c']),
    ).toThrow(/only 1 of the 4 snapshot providers/)
    const files = buildSnapshotFiles(DOC, NOW, ['opencode', 'renamed-a'])
    expect(missingSnapshotProviders(files, ['opencode', 'renamed-a'])).toEqual(['renamed-a'])
  })

  it('lists safe, unique provider keys', () => {
    expect(new Set(SNAPSHOT_PROVIDER_KEYS).size).toBe(SNAPSHOT_PROVIDER_KEYS.length)
    for (const key of SNAPSHOT_PROVIDER_KEYS) expect(isSafeProviderKey(key), key).toBe(true)
  })

  it('keeps the gateway keys a provider mod reads from the catalog', () => {
    expect(SNAPSHOT_PROVIDER_KEYS).toContain('nebius')
  })

  it('refuses a document that is not usable, so a publish cannot ship an empty snapshot', () => {
    expect(() => buildSnapshotFiles('not json', NOW)).toThrow(/not valid JSON/)
    expect(() => buildSnapshotFiles('[]', NOW)).toThrow()
    expect(() => buildSnapshotFiles('{}', NOW)).toThrow(/no providers/)
  })
})

describe('gen_catalog_snapshot script', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const script = path.join(root, 'scripts', 'gen_catalog_snapshot.ts')

  function run(args: string[]) {
    return spawnSync(process.execPath, [tsx, script, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 })
  }

  it('writes the snapshot tree from a document and fails loudly, leaving nothing, on a bad one', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'catalog-snap-'))
    try {
      const good = path.join(tmp, 'good.json')
      const bad = path.join(tmp, 'bad.json')
      // Every listed provider (copies of one sample provider), plus one the
      // list does not name, which the script must leave out.
      const base = (sample as Record<string, { models: object }>).deepseek
      const wide = Object.fromEntries(
        [...SNAPSHOT_PROVIDER_KEYS, 'some-reseller'].map(k => [k, { ...base, id: k }]),
      )
      writeFileSync(good, JSON.stringify(wide))
      writeFileSync(bad, '{"x": 1}')
      const out = path.join(tmp, 'out', 'snapshot')
      // Copies of one provider do not hold the built-in rows' figures: the
      // layout is what is checked here (the coverage gate: below).
      const ok = run(['--file', good, '--out', out, '--skip-builtin-coverage'])
      expect(ok.status, ok.stderr).toBe(0)
      expect(existsSync(path.join(out, 'index.json'))).toBe(true)
      expect(existsSync(path.join(out, 'ids.json'))).toBe(true)
      const written = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8')) as CatalogIndex
      expect(written.version).toBe(1)
      expect(written.partial).toBe(true)
      expect(Object.keys(written.providers).sort()).toEqual([...SNAPSHOT_PROVIDER_KEYS].sort())
      expect(existsSync(path.join(out, 'providers', 'some-reseller.json'))).toBe(false)

      const out2 = path.join(tmp, 'out2', 'snapshot')
      const failed = run(['--file', bad, '--out', out2])
      expect(failed.status).toBe(1)
      expect(failed.stderr).toMatch(/catalog snapshot FAILED/)
      expect(existsSync(out2)).toBe(false)
      expect(existsSync(`${out2}.tmp`)).toBe(false)

      // The same document fails the publish without the flag: it does not
      // cover the figures the built-in rows leave to the catalog.
      const uncovered = run(['--file', good, '--out', out2])
      expect(uncovered.status).toBe(1)
      expect(uncovered.stderr).toMatch(/does not cover the built-in rows/)
      expect(uncovered.stderr).toMatch(/anthropic \/ claude-[\w-]+: the row leaves contextWindow to the catalog/)
      expect(existsSync(out2)).toBe(false)

      // The download failing is the same loud failure (nothing listens on port 1).
      const down = run(['--url', 'http://127.0.0.1:1/api.json', '--out', out2])
      expect(down.status).toBe(1)
      expect(existsSync(out2)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
