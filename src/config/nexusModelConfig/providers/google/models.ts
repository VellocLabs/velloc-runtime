import { NEXUS_MODEL_CONFIG } from '../../../nexusModelConfig'
import { findConfiguredModelIn } from '../../findConfiguredModel'
import type { ProviderDocumentSource, ProviderModelInfo } from '../../providerDefinition'
import { isRecord, positiveInt, stringList, withDefined } from '../shared/listing'

const MODEL_NAME_PREFIX = 'models/'

/**
 * `GET /models` of the Generative Language API, one page of up to 1000 rows.
 * A row is kept only when `supportedGenerationMethods` has `generateContent`
 * (embedding models are not). It is usable (`supportsTools`) only when the
 * built-in `google` catalog offers it: the listing also names image, speech
 * and open-weight models that take no tools. The id is
 * `name` without its `models/` lead. Context window: `inputTokenLimit`;
 * output cap: `outputTokenLimit`. Throws when there is no `models` array.
 */
export const geminiModels: ProviderDocumentSource<ProviderModelInfo[]> = {
  path: '/models?pageSize=1000',
  parse(document) {
    const rows = isRecord(document) ? document.models : undefined
    if (!Array.isArray(rows)) throw new Error('the model listing has no models array')
    const out: ProviderModelInfo[] = []
    for (const row of rows) {
      if (!isRecord(row) || typeof row.name !== 'string' || !row.name.startsWith(MODEL_NAME_PREFIX)) continue
      if (!stringList(row.supportedGenerationMethods).includes('generateContent')) continue
      const id = row.name.slice(MODEL_NAME_PREFIX.length)
      if (id === '') continue
      out.push(
        withDefined<ProviderModelInfo>(
          { id, supportsTools: findConfiguredModelIn(NEXUS_MODEL_CONFIG, 'google', id) !== undefined },
          {
            name: typeof row.displayName === 'string' && row.displayName.trim() !== '' ? row.displayName.trim() : undefined,
            contextWindow: positiveInt(row.inputTokenLimit),
            maxOutputTokens: positiveInt(row.outputTokenLimit),
          },
        ),
      )
    }
    return out
  },
}
