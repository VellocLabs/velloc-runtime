// The runtime's Express compiler (F-1): built from the generated catalog
// document, so it needs no renderer and no DOM. Loaded lazily.

import type { A2uiExpressCompiler } from './a2uiExpressCompiler'
import catalogDocument from './velloc-catalog.json'

let pending: Promise<A2uiExpressCompiler> | null = null

export function getRuntimeA2uiCompiler(): Promise<A2uiExpressCompiler> {
  pending ??= (async () => {
    const [{ Catalog }, { createA2uiExpressCompiler }] = await Promise.all([
      import('@a2ui/web_core/catalog'),
      import('./a2uiExpressCompiler'),
    ])
    const catalog = (Catalog as unknown as { fromJson(json: unknown): unknown }).fromJson(catalogDocument)
    return createA2uiExpressCompiler(catalog as Parameters<typeof createA2uiExpressCompiler>[0])
  })()
  pending.catch(() => { pending = null })
  return pending
}
