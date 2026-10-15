/**
 * A catalog source document holding the figures the built-in rows leave to the
 * catalog, from the checked-in fixture. Used by the dev server's stand-in
 * snapshot and by tests.
 */
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import type { CatalogModelFigures } from '../config/nexusModelConfig/catalogFigures'

/** providerId -> model id -> figures. */
export type BuiltinCatalogFigures = Record<string, Record<string, CatalogModelFigures>>

/** The catalog key a built-in provider's figures are filed under (its first). */
export function builtinCatalogKey(providerId: string): string {
  const key = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === providerId)?.catalog?.keys[0]
  if (!key) throw new Error(`built-in provider ${providerId} has no catalog key`)
  return key
}

/** `without` names a catalog key to leave out. */
export function builtinFiguresDocument(
  figures: BuiltinCatalogFigures,
  without?: string,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {}
  for (const [providerId, models] of Object.entries(figures)) {
    const key = builtinCatalogKey(providerId)
    if (key === without) continue
    doc[key] = {
      id: key,
      name: key,
      models: Object.fromEntries(Object.entries(models).map(([id, f]) => [id, {
        id,
        name: id,
        tool_call: true,
        modalities: { input: f.supportsImageInput ? ['text', 'image'] : ['text'], output: ['text'] },
        limit: { context: f.contextWindow ?? 0, output: f.maxOutputTokens ?? 0 },
      }])),
    }
  }
  return doc
}
