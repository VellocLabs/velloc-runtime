/**
 * The dev server's stand-in snapshot (vite/devCatalogSnapshotPlugin.ts): a
 * tree with no generated snapshot still gives the built-in rows their
 * catalog figures, and loses to any real data.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { devCatalogSnapshotPlugin } from '../../../vite/devCatalogSnapshotPlugin'
import { snapshotCoverageProblems } from '../../catalog/builtinCatalogCoverage'
import { createSnapshotReader } from '../../catalog/catalogSnapshot'
import { builtinCatalogKey } from '../_helpers/builtinCatalogFigures'

const NEXUS_WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const FIXTURE_REL = path.join('src', '__tests__', 'catalog', 'fixtures', 'builtin-catalog-figures.json')

type Middleware = (req: { url?: string }, res: FakeRes, next: () => void) => void
type FakeRes = { setHeader(name: string, value: string): void; end(text: string): void }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A throwaway tree holding the fixture; the plugin's middleware on `base`. */
function serve(opts: { base?: string; generated?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dev-catalog-'))
  roots.push(root)
  mkdirSync(path.dirname(path.join(root, FIXTURE_REL)), { recursive: true })
  copyFileSync(path.join(NEXUS_WEB_ROOT, FIXTURE_REL), path.join(root, FIXTURE_REL))
  if (opts.generated) {
    mkdirSync(path.join(root, 'public', 'catalog', 'snapshot'), { recursive: true })
    writeFileSync(path.join(root, 'public', 'catalog', 'snapshot', 'index.json'), '{}')
  }
  const plugin = devCatalogSnapshotPlugin(root) as Plugin & {
    configResolved(c: Pick<ResolvedConfig, 'base'>): void
    configureServer(s: Pick<ViteDevServer, 'middlewares'>): void
  }
  let middleware: Middleware | undefined
  plugin.configResolved({ base: opts.base ?? '/' })
  plugin.configureServer({ middlewares: { use: (fn: Middleware) => { middleware = fn } } } as never)
  return (url: string): string | undefined => {
    let body: string | undefined
    middleware!({ url }, { setHeader: () => {}, end: text => { body = text } }, () => {})
    return body
  }
}

describe('dev server stand-in snapshot', () => {
  it('serves the built-in figures, stamped 0, covering every built-in row', async () => {
    const get = serve()
    const files: Record<string, string> = {}
    const reader = createSnapshotReader({
      fetchAsset: async asset => {
        const text = get(`/${asset}?v=1`)
        if (text !== undefined) files[asset.replace(/^catalog\/snapshot\//, '')] = text
        return text
      },
    })
    const index = await reader.readIndex()
    expect(index?.generatedAt, 'any cache or generated snapshot is newer').toBe(0)
    const openai = await reader.readProvider(builtinCatalogKey('openai'))
    expect(openai?.['gpt-5.4-mini']?.contextWindow).toBe(400_000)
    for (const key of Object.keys(index!.providers)) await reader.readProvider(key)
    await reader.readIdIndex()
    expect(snapshotCoverageProblems(files)).toEqual([])
  })

  it('follows the base path and leaves other paths alone', () => {
    const get = serve({ base: '/v9/' })
    expect(get('/v9/catalog/snapshot/index.json')).toBeDefined()
    expect(get('/catalog/snapshot/index.json')).toBeUndefined()
    expect(get('/v9/catalog/snapshot/providers/nope.json')).toBeUndefined()
  })

  it('steps aside for a generated snapshot', () => {
    expect(serve({ generated: true })('/catalog/snapshot/index.json')).toBeUndefined()
  })
})
