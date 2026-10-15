// Writes the checked-in fixture of the catalog figures (context window, output
// cap, image input) that built-in rows leave to the catalog, read by
// builtin-catalog-figures.test.ts.
//   --snapshot <dir>  a snapshot tree, e.g. the output of `npm run catalog:snapshot`
//   --out <file>      default src/__tests__/catalog/fixtures/builtin-catalog-figures.json
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogUnits, unitFigures } from '../src/catalog/builtinCatalogCoverage'
import type { CatalogProviderRecords } from '../src/catalog/types'
import type { CatalogModelFigures } from '../src/config/nexusModelConfig/catalogFigures'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIELDS = ['contextWindow', 'maxOutputTokens', 'supportsImageInput'] as const

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const dir = arg('--snapshot')
  if (!dir) throw new Error('--snapshot <dir> is required')
  const out = path.resolve(
    arg('--out') ?? path.join(repoRoot, 'src', '__tests__', 'catalog', 'fixtures', 'builtin-catalog-figures.json'),
  )
  const records = new Map<string, CatalogProviderRecords | undefined>()
  for (const unit of catalogUnits()) {
    for (const key of unit.keys) {
      if (records.has(key)) continue
      try {
        records.set(key, JSON.parse(await readFile(path.join(dir, 'providers', `${key}.json`), 'utf8')))
      } catch {
        records.set(key, undefined)
      }
    }
  }
  const fixture: Record<string, Record<string, CatalogModelFigures>> = {}
  for (const unit of catalogUnits()) {
    if (FIELDS.every(field => unit.row[field] !== undefined)) continue
    for (const [id, figures] of unitFigures(unit, key => records.get(key))) {
      const kept: CatalogModelFigures = {}
      for (const field of FIELDS) {
        if (figures[field] !== undefined) (kept as Record<string, unknown>)[field] = figures[field]
      }
      ;(fixture[unit.providerId] ??= {})[id] = kept
    }
  }
  const sorted = Object.fromEntries(
    Object.keys(fixture)
      .sort()
      .map(p => [p, Object.fromEntries(Object.keys(fixture[p]).sort().map(id => [id, fixture[p][id]]))]),
  )
  await writeFile(out, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
  console.log(`builtin catalog figures: ${Object.values(sorted).reduce((n, m) => n + Object.keys(m).length, 0)} models -> ${out}`)
}

main().catch(e => {
  console.error(`builtin catalog figures FAILED: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
