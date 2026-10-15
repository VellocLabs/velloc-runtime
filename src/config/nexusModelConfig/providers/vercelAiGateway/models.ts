import type { ProviderDocumentSource, ProviderModelInfo } from '../../providerDefinition'
import {
  isFreePricing,
  isRecord,
  listingRows,
  orderedTiers,
  perMillionPrice,
  positiveInt,
  stringList,
  withDefined,
} from '../shared/listing'

/**
 * `GET /models` (no key needed): only `type: 'language'` rows; tools = the `tool-use`
 * tag; `reasoning_options` (`effort` values; `toggle` = `none` allowed). Free: both
 * prices `"0"`.
 */
export const vercelModels: ProviderDocumentSource<ProviderModelInfo[]> = {
  path: '/models',
  public: true,
  parse(document) {
    return listingRows(document)
      .filter(row => row.type === undefined || row.type === 'language')
      .map(row => {
        const tags = stringList(row.tags)
        const modalities = isRecord(row.modalities) ? row.modalities : {}
        const inputs = stringList(modalities.input)
        const options = Array.isArray(row.reasoning_options)
          ? row.reasoning_options.filter(isRecord)
          : []
        const effort = options.find(o => o.type === 'effort')
        const toggle = options.some(o => o.type === 'toggle')
        let thinkingTiers: string[] | undefined
        if (effort) {
          thinkingTiers = orderedTiers(stringList(effort.values))
          if (toggle && !thinkingTiers.includes('none')) thinkingTiers = ['none', ...thinkingTiers]
        } else if (toggle) {
          thinkingTiers = ['none', 'medium']
        }
        if (thinkingTiers?.length === 0) thinkingTiers = undefined
        return withDefined<ProviderModelInfo>(
          { id: row.id as string, supportsTools: tags.includes('tool-use') },
          {
            name: typeof row.name === 'string' ? row.name : undefined,
            contextWindow: positiveInt(row.context_window),
            maxOutputTokens: positiveInt(row.max_tokens),
            supportsImageInput: inputs.length > 0 ? inputs.includes('image') : undefined,
            supportsPdfInput: inputs.length > 0 ? inputs.includes('pdf') : undefined,
            thinkingTiers,
            free: isFreePricing(row.pricing, 'input', 'output') ? true : undefined,
            price: perMillionPrice(row.pricing, 'input', 'output'),
          },
        )
      })
  },
}
