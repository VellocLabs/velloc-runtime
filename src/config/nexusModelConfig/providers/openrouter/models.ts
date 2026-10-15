import type { ProviderDocumentSource, ProviderModelInfo } from '../../providerDefinition'
import {
  isFreePricing,
  isRecord,
  listingRows,
  orderedTiers,
  perMillionPrice,
  positiveInt,
  stringList,
  tierFromEffort,
  withDefined,
} from '../shared/listing'

/**
 * A row's `name` leads with its vendor (`"Anthropic: Claude Sonnet 5.5"`);
 * the picker already groups rows under the provider, and the vendor half is
 * what made the label too long to read. A name with no `Vendor: ` lead is
 * kept whole.
 */
export function modelName(name: string): string {
  const at = name.indexOf(': ')
  const rest = at > 0 ? name.slice(at + 2).trim() : ''
  return rest || name
}

/**
 * `GET /models` (no key needed). Tools: `supported_parameters` has `tools`.
 * Reasoning: `reasoning.supported_efforts` (`mandatory` = no `none`). Output cap:
 * `top_provider.max_completion_tokens`. Free: both prices `"0"`. A `:batch` row is
 * dropped (`chat/completions` answers it with a 404).
 */
export const openrouterModels: ProviderDocumentSource<ProviderModelInfo[]> = {
  path: '/models',
  public: true,
  parse(document) {
    return listingRows(document).filter(row => !isBatchOnlyId(row.id as string)).map(row => {
      const params = stringList(row.supported_parameters)
      const architecture = isRecord(row.architecture) ? row.architecture : {}
      const inputs = stringList(architecture.input_modalities)
      const topProvider = isRecord(row.top_provider) ? row.top_provider : {}
      const reasoning = isRecord(row.reasoning) ? row.reasoning : undefined
      let thinkingTiers: string[] | undefined
      if (params.includes('reasoning')) {
        const stated = stringList(reasoning?.supported_efforts)
        thinkingTiers = orderedTiers(stated.length > 0 ? stated : ['low', 'medium', 'high'])
        if (reasoning?.mandatory === true) thinkingTiers = thinkingTiers.filter(t => t !== 'none')
        if (thinkingTiers.length === 0) thinkingTiers = undefined
      }
      return withDefined<ProviderModelInfo>(
        { id: row.id as string, supportsTools: params.includes('tools') },
        {
          name: typeof row.name === 'string' ? modelName(row.name) : undefined,
          contextWindow: positiveInt(row.context_length),
          maxOutputTokens: positiveInt(topProvider.max_completion_tokens),
          supportsImageInput: inputs.length > 0 ? inputs.includes('image') : undefined,
          supportsPdfInput: inputs.length > 0 ? inputs.includes('file') : undefined,
          thinkingTiers,
          defaultThinkingTier: thinkingTiers ? tierFromEffort(reasoning?.default_effort) : undefined,
          free: isFreePricing(row.pricing, 'prompt', 'completion') ? true : undefined,
          price: perMillionPrice(row.pricing, 'prompt', 'completion'),
        },
      )
    })
  },
}

/** A Batch-API-only variant (`openai/gpt-6-luna-pro:batch`). */
export function isBatchOnlyId(id: string): boolean {
  return id.endsWith(':batch')
}
