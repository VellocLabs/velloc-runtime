/**
 * The page's provider-neutral entry to a provider's display rules
 * (`ProviderDefinition.display`): what a model is called, and which part of
 * the provider's usage bears on it. A provider without rules shows the name
 * as listed and its usage whole. The page calls these and never branches on
 * a provider id; each provider's rules live in its own directory.
 */
import type { PlanUsageSnapshot } from '../../models/usage/planUsage'
import { getProviderDefinition } from './providers'

export type DisplayedModel = { free?: boolean }

export function displayModelLabel(providerId: string | undefined, name: string, model: DisplayedModel): string {
  return getProviderDefinition(providerId)?.display?.modelLabel?.(name, model) ?? name
}

export function usageForModel(
  providerId: string | undefined,
  usage: PlanUsageSnapshot,
  model: DisplayedModel,
): PlanUsageSnapshot {
  return getProviderDefinition(providerId)?.display?.usageFor?.(usage, model) ?? usage
}

/** The usage as a hover summary shows it (`ProviderModelDisplay.usageSummary`);
 *  a provider without the rule is summarised as is. */
export function usageSummary(providerId: string | undefined, usage: PlanUsageSnapshot): PlanUsageSnapshot {
  return getProviderDefinition(providerId)?.display?.usageSummary?.(usage) ?? usage
}
