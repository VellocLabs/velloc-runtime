// @vitest-environment happy-dom
// The committed Express artifacts are generated from the Velloc catalog (F-1):
// the catalog document the runtime checks blocks against, and the prompt the
// a2ui skill teaches. Regenerate with A2UI_WRITE_ARTIFACTS=1.
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { A2uiGenerator, CatalogConfig, ExpressFormatFactory } from '@a2ui/agent'
import { Catalog } from '@a2ui/web_core/catalog'
import { vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'

const DIR = resolve(__dirname, '../toolkit/builtin/a2ui')
const CATALOG_PATH = resolve(DIR, 'express/velloc-catalog.json')
const PROMPT_PATH = resolve(DIR, 'prompts/a2ui-express.md')
const WRITE = process.env.A2UI_WRITE_ARTIFACTS === '1'

function generate() {
  const document = (vellocCatalog as unknown as { toJson(): Record<string, unknown> }).toJson()
  const catalogText = `${JSON.stringify(document, null, 2)}\n`
  const loaded = (Catalog as unknown as { fromJson(json: unknown): never }).fromJson(document)
  const generator = new A2uiGenerator([new CatalogConfig(loaded)], undefined, new ExpressFormatFactory())
  const processor = generator.createProcessor({
    '1.0': { supportedCatalogIds: [vellocCatalog.id] },
  } as never)
  return { catalogText, promptText: `${processor.promptSnippet.trimEnd()}\n` }
}

function committed(path: string): string {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}

describe('A2UI Express artifacts', () => {
  const { catalogText, promptText } = generate()
  if (WRITE) {
    writeFileSync(CATALOG_PATH, catalogText)
    writeFileSync(PROMPT_PATH, promptText)
  }

  it('the committed catalog document matches the Velloc catalog', () => {
    expect(committed(CATALOG_PATH), 'run with A2UI_WRITE_ARTIFACTS=1 to regenerate').toBe(catalogText)
  })

  it('the committed Express prompt matches the catalog', () => {
    expect(committed(PROMPT_PATH), 'run with A2UI_WRITE_ARTIFACTS=1 to regenerate').toBe(promptText)
  })

  it('documents every chart component and its props', () => {
    for (const name of ['PieChart', 'LineChart', 'BarChart', 'Metric', 'DataTable']) {
      expect(promptText).toContain(`• ${name}(`)
    }
    expect(promptText).not.toMatch(/• PieChart\([^\n]*\n(\s+- [^\n]*\n)*\s+- title: Represents a string/)
  })
})
