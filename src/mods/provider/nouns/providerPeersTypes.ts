/**
 * Contract: the providers a person has set up, as a router provider's module
 * sees them (F-27), one entry per provider INSTANCE. `id` is opaque: nothing
 * reads a vendor, a plugin or an account out of its text. Which vendor an
 * instance belongs to is `definition`; what to show is `label` and `name`.
 *
 * Security: a peer carries no secret, no base URL and no account name.
 */
import type { PlanUsageSnapshot } from '../../../models/usage/planUsage'
import type { ProviderConnectivityIssue } from '../../../utils/providerConnectivity'

export type PeerStatus = 'ok' | 'cooling' | 'exhausted' | 'disabled'

export type PeerUntilFrom = 'provider' | 'platform'

export type PeerModelState = {
  status: PeerStatus
  /** When the cooldown or the exhausted window ends, epoch ms. */
  until?: number
  /**
   * Who set `until`: `provider` when the provider itself stated the wait or
   * the reset time, `platform` when the platform chose the wait because the
   * provider stated none. Absent with no `until`, and on a record kept from
   * before this field.
   */
  untilFrom?: PeerUntilFrom
  reason?: ProviderConnectivityIssue['kind']
}

/**
 * Contract: what the platform recorded about an instance's models from the
 * verdicts of their requests. Kept across restarts; a record past its
 * `until` is gone when read. Every verdict is recorded under the model the
 * request named, whatever its scope: the instance itself has no state, and a
 * model with no entry is `ok`. `billing` is a 30-minute cooldown;
 * `credentials` is `disabled` until the instance's config changes. Any
 * change to the instance's config clears both, for all its models.
 */
export type ProviderState = {
  /** By model id: what holds for that model alone. */
  models: Record<string, PeerModelState>
}

export type PeerModel = {
  id: string
  name?: string
  /** The person picked it on the provider's page. */
  picked: boolean
  free?: boolean
  /** The catalog's price, US dollars per million tokens (F-28). */
  cost?: { input: number; output: number; cacheRead?: number }
  contextWindow?: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsImageInput?: boolean
  supportsPdfInput?: boolean
  thinkingTiers?: string[]
  deprecated?: boolean
}

export type Peer = {
  /** The instance id: what a router's answer names. */
  id: string
  /** The provider definition the instance belongs to. Equal to `id` for a
   *  definition's first instance. */
  definition: string
  /** The definition's key in its plugin's manifest; a mod's provider only. */
  definitionKey?: string
  /** When the instance was made, epoch ms; absent on a first instance. */
  createdAt?: number
  label: string
  /** The name the person gave this instance. */
  name?: string
  /** A router is never a peer. */
  kind: 'provider'
  /** The router reading this table manages the provider. */
  managed?: true
  source: 'builtin' | 'custom' | 'mod'
  /** The provider is set up. */
  connected: boolean
  defaultModel?: string
  models: PeerModel[]
  state: ProviderState
  /** The last plan usage read, if any. */
  usage?: PlanUsageSnapshot
}

/** The peers a router sees: those inside its `routesTo`. */
export type PeersTableFor = (routerId: string) => Peer[]

/**
 * `providers.clearPeerState`: forget what was recorded about one model of an
 * instance, or about all its models when no `model` is given.
 */
export type ClearPeerStatePayload = { provider: string; model?: string }
export type ClearPeerStateResult = { ok: true }
