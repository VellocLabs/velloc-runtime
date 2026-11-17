import { parseMarketplaceSource } from '../../../pluginHost/marketplaceSource'

const MARKETPLACE_ADD = /^\/(?:plugin\s+(?:marketplace|market)|marketplace)\s+add\s+(\S+)$/

/**
 * The repository a composer line `/plugin marketplace add <source>` (also
 * `/plugin market add`, `/marketplace add`) names, when the Add a marketplace
 * dialog can take it; null for any other text, so it is sent as typed.
 */
export function marketplaceAddSourceOf(text: string): string | null {
  const match = MARKETPLACE_ADD.exec(text.trim())
  if (!match) return null
  const source = match[1]!
  return parseMarketplaceSource(source) ? source : null
}
