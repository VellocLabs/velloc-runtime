/**
 * The reads answered only to a mod the organization's managed settings install
 * (F-25): `$.session.identity()` and `$.prompt.media({ id })`. A managed
 * install sits in the `prepend` or `append` tier; any other caller is answered
 * `{ deny }`. The tier is the calling plugin's own, set by the host.
 */

import type { Origin } from './modTypes'

/** "How the session is signed in … `{ deny }` to any other." */
export type SessionIdentity =
  | {
      kind: string
      organizationId?: string
      organizationType?: string
      email?: string
      isVerified: boolean
    }
  | { deny: string }

/** `$.prompt.media(args)`: "which attached item of the prompt being
 *  submitted to read, and from where in it". */
export type PromptMediaArgs = { id: string; offset?: number }

/** Every answer Velloc gives `$.prompt.media` is a refusal: its
 *  `prompt.submit` lists no attachments to read. */
export type PromptMediaAnswer = { deny: string }

export const NOT_MANAGED_DENIAL = 'only a plugin installed by managed settings may read this'

/** Whether `origin` is a plugin managed settings install. */
export function isManagedOrigin(origin: Origin): boolean {
  return origin.tier === 'prepend' || origin.tier === 'append'
}

/** Core of `session.identity`. Velloc holds no account sign-in, so a managed
 *  caller learns `kind: 'none'` and nothing of an organization. */
export function sessionIdentityOf(origin: Origin): SessionIdentity {
  if (!isManagedOrigin(origin)) return { deny: NOT_MANAGED_DENIAL }
  return { kind: 'none', isVerified: false }
}

/** Whether a hook's answer is one `session.identity` takes. */
export function isSessionIdentity(value: unknown): value is SessionIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.deny === 'string') return v.deny !== ''
  return (
    typeof v.kind === 'string' &&
    typeof v.isVerified === 'boolean' &&
    (v.organizationId === undefined || typeof v.organizationId === 'string') &&
    (v.organizationType === undefined || typeof v.organizationType === 'string') &&
    (v.email === undefined || typeof v.email === 'string')
  )
}

/** The checked argument; each refusal names the field. */
export function promptMediaArgsOf(value: unknown): PromptMediaArgs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('$.prompt.media(args): args must be { id, offset? }')
  }
  const { id, offset } = value as Record<string, unknown>
  if (typeof id !== 'string' || id === '') throw new TypeError('$.prompt.media: id must be a non-empty string')
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)) {
    throw new TypeError('$.prompt.media: offset must be a non-negative integer')
  }
  return { id, ...(offset !== undefined ? { offset } : {}) }
}

/** `$.prompt.media`: "the engine's own read, no event". */
export function promptMediaOf(args: PromptMediaArgs, origin: Origin): PromptMediaAnswer {
  if (!isManagedOrigin(origin)) return { deny: NOT_MANAGED_DENIAL }
  return { deny: `no submission in flight carries ${args.id}` }
}
