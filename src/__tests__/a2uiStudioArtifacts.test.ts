// @vitest-environment happy-dom
// The committed studio artifacts are generated from the studio catalog (F-1):
// the description the runtime checks an app's entry against, and the component
// reference an app session's prompt carries. Regenerate with
// A2UI_WRITE_ARTIFACTS=1.
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { A2uiGenerator, CatalogConfig, ExpressFormatFactory, InMemoryCatalogProvider } from '@a2ui/agent'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import { STUDIO_CATALOG_ID, studioUI } from '../browser/webview/a2ui/studio/studioCatalog'

const DIR = resolve(__dirname, '../toolkit/builtin/a2ui')
const CATALOG_PATH = resolve(DIR, 'express/studio-catalog.json')
const PROMPT_PATH = resolve(DIR, 'prompts/a2ui-express-studio.md')
const WRITE = process.env.A2UI_WRITE_ARTIFACTS === '1'

function generate() {
  const document = exportA2UICatalog(studioUI as never) as Record<string, unknown>
  const catalogText = `${JSON.stringify(document, null, 2)}\n`
  const config = new CatalogConfig(new InMemoryCatalogProvider(JSON.parse(catalogText)).load())
  const generator = new A2uiGenerator([config], undefined, new ExpressFormatFactory())
  const processor = generator.createProcessor({ '1.0': { supportedCatalogIds: [STUDIO_CATALOG_ID] } } as never)
  return { document, catalogText, promptText: `${processor.promptSnippet.trimEnd()}\n` }
}

function committed(path: string): string {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}

describe('studio catalog artifacts', () => {
  const { document, catalogText, promptText } = generate()
  if (WRITE) {
    writeFileSync(CATALOG_PATH, catalogText)
    writeFileSync(PROMPT_PATH, promptText)
  }

  it('the committed description matches the studio catalog', () => {
    expect(document.catalogId).toBe(STUDIO_CATALOG_ID)
    expect(committed(CATALOG_PATH), 'run with A2UI_WRITE_ARTIFACTS=1 to regenerate').toBe(catalogText)
  })

  it('the committed component reference matches the catalog', () => {
    expect(committed(PROMPT_PATH), 'run with A2UI_WRITE_ARTIFACTS=1 to regenerate').toBe(promptText)
  })

  it('lists standard and added components', () => {
    for (const name of ['Column', 'Button', 'Modal', 'Stat', 'DataTable']) {
      expect(promptText, name).toContain(`• ${name}(`)
    }
  })
})
