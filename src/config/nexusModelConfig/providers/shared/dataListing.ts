import type { ProviderDocumentSource, ProviderModelInfo } from '../../providerDefinition'
import { listingRows } from './listing'

/**
 * The plain `{data: [{id, display_name?}]}` model listing: ids and names only;
 * limits, tiers and image input come from the curated catalog. Tool support is
 * assumed.
 */
export function dataModelListing(path: string): ProviderDocumentSource<ProviderModelInfo[]> {
  return {
    path,
    parse(document) {
      return listingRows(document).map(row => {
        const name = typeof row.display_name === 'string' && row.display_name ? row.display_name : undefined
        return { id: row.id as string, ...(name ? { name } : {}), supportsTools: true }
      })
    },
  }
}
