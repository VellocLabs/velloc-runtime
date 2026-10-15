import type { ProviderDocumentSource, ProviderModelInfo } from '../../providerDefinition'
import { isRecord, listingRows, orderedTiers, positiveInt, withDefined } from '../shared/listing'

/** `capabilities.<name>.supported` — undefined when the listing omits it. */
function supported(capabilities: Record<string, unknown>, name: string): boolean | undefined {
  const entry = capabilities[name]
  return isRecord(entry) && typeof entry.supported === 'boolean' ? entry.supported : undefined
}

/**
 * Anthropic's `GET /v1/models`: window (`max_input_tokens`), output cap
 * (`max_tokens`; `null`/`0` = unknown), effort levels (the row's tiers; none =
 * no reasoning control) and image/pdf input. No default effort is listed.
 */
export const anthropicModels: ProviderDocumentSource<ProviderModelInfo[]> = {
  path: '/v1/models?limit=1000',
  parse(document) {
    return listingRows(document).map(row => {
      const capabilities = isRecord(row.capabilities) ? row.capabilities : {}
      const effort = isRecord(capabilities.effort) ? capabilities.effort : undefined
      let thinkingTiers: string[] | undefined
      if (effort && effort.supported === true) {
        const levels = Object.keys(effort).filter(level => supported(effort, level) === true)
        thinkingTiers = orderedTiers(levels)
        if (thinkingTiers.length === 0) thinkingTiers = undefined
      }
      const name = typeof row.display_name === 'string' && row.display_name ? row.display_name : undefined
      return withDefined<ProviderModelInfo>(
        { id: row.id as string, supportsTools: true },
        {
          name,
          contextWindow: positiveInt(row.max_input_tokens),
          maxOutputTokens: positiveInt(row.max_tokens),
          supportsImageInput: supported(capabilities, 'image_input'),
          supportsPdfInput: supported(capabilities, 'pdf_input'),
          thinkingTiers,
        },
      )
    })
  },
}
