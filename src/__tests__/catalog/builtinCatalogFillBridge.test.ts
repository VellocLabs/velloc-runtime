// The catalog fetch (`BrowserHostBridge.getModelCatalog`) waits for the
// runtime's first catalog-figure read, within a bound: the rows it publishes
// carry the catalog's figures on the very first call, and a read that never
// settles holds the picker up no longer than the bound.
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport, BrowserLlmCatalog } from '../../browser/bridge/browserBridgeProtocol'
import { BrowserHostBridge } from '../../browser/bridge/BrowserHostBridge'
import {
  CATALOG_FIGURES_WAIT_MS,
  resetBuiltinCatalogFill,
  startBuiltinCatalogFill,
} from '../../catalog/builtinCatalogFill'
import type { CatalogProviderRecords } from '../../catalog/types'
import { resetCatalogFigures } from '../../config/nexusModelConfig/catalogFigures'
import { resetModelEntryCatalog } from '../../models/drivers/modelEntryCatalog'

afterEach(() => {
  resetBuiltinCatalogFill()
  resetCatalogFigures()
  resetModelEntryCatalog()
})

/** A host that lists DeepSeek's Flash with no figures, and answers nothing else. */
const transport = {
  async request(req: { id: string; route: { capability: string; action: string } }) {
    const action = `${req.route.capability}.${req.route.action}`
    if (action === 'model.catalog') {
      const result: BrowserLlmCatalog = {
        providers: [{
          id: 'deepseek',
          label: 'DeepSeek',
          iconSvg: '',
          enabled: true,
          models: [{ id: 'deepseek-flash', label: 'deepseek-flash', enabled: true, supportsStreaming: true }],
        }],
      }
      return { id: req.id, route: req.route, ok: true, result }
    }
    return { id: req.id, route: req.route, ok: false, error: { code: 'UNEXPECTED', message: action } }
  },
} as unknown as BrowserBridgeTransport

const RECORDS: CatalogProviderRecords = {
  'deepseek-flash': { name: 'x', contextWindow: 1_000_000, maxOutput: 393_216, inputModalities: ['text', 'image'], free: false },
}

function flashRow(catalog: BrowserLlmCatalog) {
  const provider = catalog.providers.find(p => p.id === 'deepseek')!
  return provider.models.find(m => (m.entry?.resolvedId ?? m.id) === 'deepseek-flash')!
}

describe('getModelCatalog and the first catalog-figure read', () => {
  it('waits for the read: the first call already carries the catalog figures', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    startBuiltinCatalogFill({
      catalog: {
        async provider(key) {
          await gate
          return key === 'deepseek' ? RECORDS : undefined
        },
        onUpdated: () => () => {},
      },
      publish: async () => {},
    })
    const pending = new BrowserHostBridge({ transport }).getModelCatalog()
    setTimeout(release, 20)
    const row = flashRow(await pending)
    expect(row.contextWindow).toBe(1_000_000)
    expect(row.maxOutputTokens).toBe(393_216)
  })

  it('a read that never settles holds the call up only for the bound', async () => {
    startBuiltinCatalogFill({
      catalog: { provider: () => new Promise(() => {}), onUpdated: () => () => {} },
      publish: async () => {},
    })
    const started = Date.now()
    const row = flashRow(await new BrowserHostBridge({ transport }).getModelCatalog())
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(CATALOG_FIGURES_WAIT_MS - 100)
    expect(waited).toBeLessThan(CATALOG_FIGURES_WAIT_MS + 3_000)
    // The row answers without the figures (each consumer's default applies).
    expect(row.contextWindow).toBeUndefined()
  }, 15_000)
})
