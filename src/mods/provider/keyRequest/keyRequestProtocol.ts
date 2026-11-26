/**
 * Contract: a key the platform asks the person for on behalf of a router's
 * settings app (F-27 RP-22), on the runtime protocol. The request is
 * PUBLISHED STATE on `providers/keyRequests`; the person's answer is an
 * ACTION. Security: the state never holds a key, the answer is handed to the
 * platform's own store step and is not echoed, and both are scope `manager`.
 */
import type { LocalizedText } from '../../../config/localizedText'
import { PROVIDER_LOGIN_WALL_MS } from '../login/loginProtocol'

export const PROVIDER_KEY_REQUEST_CAPABILITY = 'providerKeyRequest'
export const PROVIDER_KEY_REQUEST_TOPIC = 'providers/keyRequests'

/** Longest key the page may send. */
export const MAX_KEY_REQUEST_CHARS = 16 * 1024
export const MAX_KEY_REQUEST_ID_CHARS = 128
/** Ended requests kept for the page to show before the oldest is dropped. */
export const MAX_ENDED_KEY_REQUESTS = 8
/** How long a request waits for the person before it is withdrawn: a sign-in's wall. */
export const KEY_REQUEST_WAIT_MS = PROVIDER_LOGIN_WALL_MS

/** Why a request ended without a new instance; shown until dismissed. */
export type ProviderKeyRequestProblem =
  /** The key is the one of `name`, another instance of the same provider. */
  | { kind: 'duplicate'; name: string }
  /** The key could not be stored. */
  | { kind: 'failed' }

export type ProviderKeyRequest = {
  requestId: string
  /** The router whose settings app asked. */
  routerId: string
  /** That router's name, when it is registered. */
  routerLabel?: LocalizedText
  /** The plugin whose module sends the requests made with the key. */
  plugin: string
  /** The provider the key is for. */
  definitionId: string
  /** That provider's name. */
  label: LocalizedText
  /** The provider's own wording for its key field, when it has one. */
  prompt?: LocalizedText
  /** An answer was taken and is being stored. */
  busy?: true
  ended?: ProviderKeyRequestProblem
}

/** Snapshot and every `state` delta: the whole table. */
export type ProviderKeyRequestState = {
  /** Increases with every publication; a reader keeps the highest it has seen. */
  seq: number
  requests: Record<string, ProviderKeyRequest>
}

export const EMPTY_KEY_REQUEST_STATE: ProviderKeyRequestState = Object.freeze({ seq: 0, requests: {} })

export type ProviderKeyRequestAnswerPayload = { requestId: string; key: string }
/** `accepted: false`: the request is gone, ended, or already being stored. */
export type ProviderKeyRequestAnswerResult = { accepted: boolean }
export type ProviderKeyRequestCancelPayload = { requestId: string }

export function isKeyRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_REQUEST_ID_CHARS
}

/** The key as it is stored: surrounding white space is never part of one. */
export function readRequestedKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_KEY_REQUEST_CHARS) return undefined
  const key = value.trim()
  return key.length > 0 ? key : undefined
}
