import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { SNAPSHOT_ASSET_ROOT } from '../src/catalog/catalogSnapshot'
import {
  builtinFiguresDocument,
  type BuiltinCatalogFigures,
} from '../src/catalog/builtinFiguresDocument'
import { buildSnapshotFiles, type SnapshotFiles } from '../src/catalog/snapshotGenerator'

/**
 * Dev server only: a stand-in bundle snapshot (F-28) when the tree has none
 * generated, so dev servers and e2e resolve built-in rows' catalog figures. It
 * holds the checked-in figure fixture for the built-in providers' keys, stamped
 * `generatedAt: 0` so any cache or generated snapshot wins. A generated
 * snapshot in `public/catalog/snapshot/` is served instead, untouched.
 */
export function devCatalogSnapshotPlugin(root: string): Plugin {
  const fixturePath = path.join(root, 'src', '__tests__', 'catalog', 'fixtures', 'builtin-catalog-figures.json')
  const generatedIndex = path.join(root, 'public', SNAPSHOT_ASSET_ROOT, 'index.json')
  let files: SnapshotFiles | undefined
  let base = '/'

  const standIn = (): SnapshotFiles => {
    if (!files) {
      const figures = JSON.parse(readFileSync(fixturePath, 'utf8')) as BuiltinCatalogFigures
      const doc = builtinFiguresDocument(figures)
      files = buildSnapshotFiles(JSON.stringify(doc), 0, Object.keys(doc))
    }
    return files
  }

  return {
    name: 'dev-catalog-snapshot',
    apply: 'serve',
    configResolved(config) {
      base = config.base.endsWith('/') ? config.base : `${config.base}/`
    },
    configureServer(server) {
      const prefix = `${base}${SNAPSHOT_ASSET_ROOT}/`
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url?.startsWith(prefix) || existsSync(generatedIndex)) return next()
        const text = standIn()[decodeURIComponent(url.slice(prefix.length))]
        if (text === undefined) return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(text)
      })
    },
  }
}
