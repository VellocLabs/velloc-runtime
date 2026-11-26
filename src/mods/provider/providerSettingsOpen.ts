/**
 * Contract: `$.provider.openSettings({ provider?, definition?, host? })` of a
 * router's settings app (F-27): which place on the Models settings page the
 * call lands on. Navigation alone: nothing here adds or changes a provider,
 * and the answer never says what the person has set up. Pure.
 *
 * The first of these that holds decides:
 * 1. `provider` is one of the router's peers it does not manage: that provider.
 * 2. `definition` is given: the editor it is added through when installed,
 *    else the add menu.
 * 3. `host` is given: the custom provider form.
 * 4. Nothing usable: the list.
 *
 * Security: a `host` outside the router's `recognizes.hosts` refuses the
 * call, whichever rule would have decided. A `provider` outside the router's
 * peers is treated as absent, so the call cannot probe for ids.
 */
import type { ModelsSettingsTarget } from '../../browser/runtimeProtocol/modContributions'
import type { Peer } from './nouns/providerPeersTypes'

const NAME_MAX = 256

export type OpenSettingsRequest = { provider?: string; definition?: string; host?: string }

export type OpenSettingsFacts = {
  /** The router's peers, as `$.provider.peers()` lists them. */
  peers: readonly Pick<Peer, 'id' | 'managed'>[]
  /** The router's `recognizes.hosts` as its manifest lists them; absent when it declares none. */
  recognizes: readonly string[] | undefined
  /** Whether a provider definition of this id is installed. */
  definitionInstalled: (definition: string) => boolean
}

const named = (name: string, message: string): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

/** Reads the call's argument; absent is `{}`. Throws a `TypeError` naming what is wrong. */
export function readOpenSettingsRequest(value: unknown): OpenSettingsRequest {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('$.provider.openSettings({ provider?, definition?, host? }): expected an object')
  }
  const out: OpenSettingsRequest = {}
  for (const key of ['provider', 'definition', 'host'] as const) {
    const each = (value as Record<string, unknown>)[key]
    if (each === undefined) continue
    if (typeof each !== 'string' || each === '' || each.length > NAME_MAX) {
      throw new TypeError(`$.provider.openSettings: ${key} must be a non-empty text`)
    }
    out[key] = each
  }
  return out
}

/** Where the call lands; throws `NotAllowedError` for a host the router does not recognize. */
export function settingsTargetFor(routerId: string, request: OpenSettingsRequest, facts: OpenSettingsFacts): ModelsSettingsTarget {
  if (request.host !== undefined && !(facts.recognizes ?? []).includes(request.host.toLowerCase())) {
    throw named('NotAllowedError', `$.provider.openSettings: host ${request.host} is not in ${routerId}'s recognizes.hosts`)
  }
  if (request.provider !== undefined && facts.peers.some(peer => peer.id === request.provider && peer.managed !== true)) {
    return { kind: 'provider', provider: request.provider }
  }
  if (request.definition !== undefined) {
    return facts.definitionInstalled(request.definition) ? { kind: 'definition', definition: request.definition } : { kind: 'addMenu' }
  }
  if (request.host !== undefined) return { kind: 'custom' }
  return { kind: 'home' }
}
