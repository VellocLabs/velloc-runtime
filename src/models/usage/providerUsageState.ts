/**
 * Provider usage on the runtime protocol: the runtime fetches and PUBLISHES it on
 * one global topic; a client never fetches it, and asks for a refresh with
 * `providerUsage.refresh` (scope `control`).
 */
import type { PlanUsageSnapshot } from './planUsage'

/** Snapshot + `state` deltas, each the whole `ProviderUsageState`. Readable
 *  at `observe`: it carries no secret, only figures. */
export const PROVIDER_USAGE_TOPIC = 'providers/usage'

export const PROVIDER_USAGE_CAPABILITY = 'providerUsage'

export type ProviderUsageEntry = {
  /** The last figures read; kept across a failed refresh. */
  usage?: PlanUsageSnapshot
  /** Epoch ms of the last attempt (successful or not). */
  checkedAt: number
  /** The last attempt's failure, when it failed. */
  error?: string
}

export type ProviderUsageState = Record<string, ProviderUsageEntry>

export type ProviderUsageRefreshPayload = {
  providerId: string
  /** Skip the minimum interval (the settings page's explicit check). */
  force?: boolean
}
