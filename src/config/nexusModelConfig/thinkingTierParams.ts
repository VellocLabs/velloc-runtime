import { getProviderDefinition } from './providers'

/**
 * The provider-specific body fragment for the chosen thinking tier, merged verbatim
 * into the request body. Each provider owns its mapping; a provider or tier without
 * one sends nothing.
 */
export function buildThinkingBodyExtension(
  providerId: string | undefined,
  tier: string | undefined,
  maxOutputTokens: number,
): Record<string, unknown> | undefined {
  if (!tier || !providerId) {
    return undefined
  }
  return getProviderDefinition(providerId)?.reasoning?.(tier, { maxOutputTokens })
}
