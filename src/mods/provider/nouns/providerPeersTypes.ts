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

export type PeerModelState = {
  status: PeerStatus
  /** When the cooldown or the exhausted window ends, epoch ms. */
  until?: number
  reason?: ProviderConnectivityIssue['kind']
}

/**
 * Contract: what the platform recorded about an instance from the verdicts
 * of its requests. Kept across restarts; a record past its `until` is gone
 * when read. A verdict scoped to a key, an account or the provider is
 * recorded on the instance; one scoped to a model, under `models`. `billing`
 * is a 30-minute cooldown; `credentials` is `disabled` until the instance's
 * config changes. Any change to the instance's config clears both.
 */
export type ProviderState = PeerModelState & {
  /** By model id: what holds for that model alone. */
  models?: Record<string, PeerModelState>
}

export type PeerModel = {
  id: string
  name?: string
  /** The person picked it on the provider's page. */
  picked: boolean
  free?: boolean
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
  /** The provider definition the instance belongs to. Equal to `id` while a
   *  definition has one instance. */
  definition: string
  label: string
  /** The name the person gave this instance. */
  name?: string
  /** A router is never a peer. */
  kind: 'provider'
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
 * `providers.clearPeerState`: forget what was recorded about an instance, or
 * about one of its models when `model` is given.
 */
export type ClearPeerStatePayload = { provider: string; model?: string }
export type ClearPeerStateResult = { ok: true }
