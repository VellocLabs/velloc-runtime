/**
 * How one session relates to another: the origin a child records, the lineage
 * computed from it, the family it spans, and the short names a family uses.
 * Pure functions over stored metadata. Four answers are kept apart: shown
 * under (`resolveLineage`), controlled by (`isDelegated`), copied from
 * (`forkedFromSessionId`, as stored), reported to (`reportTargetOf`). (F-36)
 */

/** Why a session was started from another one. `team` is a teammate (F-20). */
export type SessionOriginKind = 'side_session' | 'hand_off' | 'team'

/** Who asked for the work the child does. */
export type SessionInitiator = 'model' | 'user'

/** Stored on a child session when another session started it. */
export type SessionOrigin = {
  /** The session that started this one; the delegation link. */
  sessionId: string
  /** The proposal or direct start this session came from. */
  taskId: string
  kind: SessionOriginKind
  initiator: SessionInitiator
  /** Set when a person forked this session off the origin instead of the
   *  origin's model starting it. */
  userFork?: boolean
  /** Set when this session edits the same working tree as its origin. */
  sharedCheckout?: boolean
  /** This session's short name within its family. */
  name?: string
}

export type SessionLineageKind = SessionOriginKind | 'fork' | 'suggested_task'

/** The effective relation a session is shown and controlled under. */
export type SessionLineage = {
  /** The session this one is shown under. */
  sessionId: string
  kind: SessionLineageKind
  initiator: SessionInitiator
  /** For a fork: the message the copy was cut at. */
  atMessageUuid?: string
}

export type ChildReportEnding = 'finished' | 'failed' | 'stopped' | 'lost' | 'waiting_user'

/** A child's finished turn, held by the parent until its model reads it.
 *  `text` is the child's own words, shortened; it is data, never an
 *  instruction. */
export type ChildReport = {
  sessionId: string
  ending: ChildReportEnding
  text: string
  at: number
}

/** Why a session another session started never started. */
export type ChildStartFailure = {
  reason: string
  at: number
}

export function isChildStartFailure(value: unknown): value is ChildStartFailure {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.reason === 'string' && typeof v.at === 'number' && Number.isFinite(v.at)
}

/** The row state of a session another session is starting. */
export type ChildStartState =
  | { state: 'starting'; since: number }
  | { state: 'failed'; reason: string; at: number }

/** The metadata fields the relation is computed from. */
export type SessionLineageInput = {
  spawnedFrom?: SessionOrigin
  forkedFromSessionId?: string
  forkedAtMessageUuid?: string
  lineageDetached?: boolean
  /** A teammate's lead (F-20); read as a `team` origin. */
  spawnerSessionId?: string
  teammateName?: string
}

export const SESSION_ORIGIN_KINDS: readonly SessionOriginKind[] = ['side_session', 'hand_off', 'team']

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Whether `value` is a well-formed stored origin. */
export function isSessionOrigin(value: unknown): value is SessionOrigin {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    isNonEmptyString(v.sessionId) &&
    typeof v.taskId === 'string' &&
    (SESSION_ORIGIN_KINDS as readonly string[]).includes(v.kind as string) &&
    (v.initiator === 'model' || v.initiator === 'user') &&
    (v.userFork === undefined || typeof v.userFork === 'boolean') &&
    (v.sharedCheckout === undefined || typeof v.sharedCheckout === 'boolean') &&
    (v.name === undefined || typeof v.name === 'string')
  )
}

/** The origin a session records: its stored one, else its teammate link as a
 *  `team` origin, else none. */
export function originOf(meta: SessionLineageInput): SessionOrigin | undefined {
  if (meta.spawnedFrom && isSessionOrigin(meta.spawnedFrom)) return meta.spawnedFrom
  if (isNonEmptyString(meta.spawnerSessionId)) {
    return {
      sessionId: meta.spawnerSessionId,
      taskId: '',
      kind: 'team',
      initiator: 'model',
      ...(isNonEmptyString(meta.teammateName) ? { name: meta.teammateName } : {}),
    }
  }
  return undefined
}

/**
 * The relation a session is shown under, or null for a top-level session.
 * A detached session has none. A session its origin's model started, and
 * whose transcript was not copied from anywhere else, is under that origin.
 * Otherwise a copied transcript makes it a person's fork of the copy source,
 * and an origin alone makes it a task a person started from a proposal.
 */
export function resolveLineage(meta: SessionLineageInput): SessionLineage | null {
  if (meta.lineageDetached === true) return null
  const origin = originOf(meta)
  const forkedFrom = isNonEmptyString(meta.forkedFromSessionId) ? meta.forkedFromSessionId : undefined
  if (origin && !origin.userFork && (forkedFrom === undefined || forkedFrom === origin.sessionId)) {
    return { sessionId: origin.sessionId, kind: origin.kind, initiator: 'model' }
  }
  if (forkedFrom !== undefined) {
    return {
      sessionId: forkedFrom,
      kind: 'fork',
      initiator: 'user',
      ...(isNonEmptyString(meta.forkedAtMessageUuid) ? { atMessageUuid: meta.forkedAtMessageUuid } : {}),
    }
  }
  if (origin) return { sessionId: origin.sessionId, kind: 'suggested_task', initiator: 'user' }
  return null
}

/** The session this one is shown under, or null. */
export function effectiveParentId(meta: SessionLineageInput): string | null {
  return resolveLineage(meta)?.sessionId ?? null
}

/** Whether the origin's model controls this session: it started it, nobody
 *  forked it off since, and it was not detached. A user's fork is never
 *  delegated, whatever origin it inherited. */
export function isDelegated(meta: SessionLineageInput): boolean {
  const lineage = resolveLineage(meta)
  return lineage !== null && lineage.initiator === 'model'
}

/** Whether a session with an origin has been detached from it. A session
 *  that never had an origin is not "detached", it is top-level. */
export function isDetached(meta: SessionLineageInput): boolean {
  return meta.lineageDetached === true && originOf(meta) !== undefined
}

/** Guard on walking a chain of origins: deeper than this is a cycle or a
 *  corrupt store, and the walk stops where it is. */
export const FAMILY_DEPTH_LIMIT = 32

export type SessionLineageIndex = ReadonlyMap<string, SessionLineageInput>

/** The attached origin link of a session: its origin's id while it is not
 *  detached, whether or not that origin still exists. */
function attachedOriginId(meta: SessionLineageInput | undefined): string | undefined {
  if (!meta || meta.lineageDetached === true) return undefined
  return originOf(meta)?.sessionId
}

/**
 * The topmost session reachable from `sessionId` along attached origin links
 * that resolve to a known session. Stops at a missing origin, a cycle, or
 * `FAMILY_DEPTH_LIMIT` hops, and answers the last session it reached.
 */
export function familyRootOf(sessionId: string, index: SessionLineageIndex): string {
  const seen = new Set<string>([sessionId])
  let current = sessionId
  for (let depth = 0; depth < FAMILY_DEPTH_LIMIT; depth++) {
    const next = attachedOriginId(index.get(current))
    if (next === undefined || !index.has(next) || seen.has(next)) break
    seen.add(next)
    current = next
  }
  return current
}

/**
 * Every session in `sessionId`'s family: the root first, then its descendants
 * breadth-first along attached origin links. Includes `sessionId` itself and
 * archived members; the caller filters. Bounded by `FAMILY_DEPTH_LIMIT`.
 */
export function familyOf(sessionId: string, index: SessionLineageIndex): string[] {
  const root = familyRootOf(sessionId, index)
  const childrenOf = new Map<string, string[]>()
  for (const [id, meta] of index) {
    const parent = attachedOriginId(meta)
    if (parent === undefined || id === parent) continue
    const list = childrenOf.get(parent)
    if (list) list.push(id)
    else childrenOf.set(parent, [id])
  }
  const result: string[] = [root]
  const seen = new Set<string>([root])
  let frontier = [root]
  for (let depth = 0; depth < FAMILY_DEPTH_LIMIT && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        result.push(child)
        next.push(child)
      }
    }
    frontier = next
  }
  if (!seen.has(sessionId)) result.push(sessionId)
  return result
}

/**
 * The session a child's finished turn is reported to: the nearest attached
 * origin that `exists`, walking past origins that do not (an archived or
 * deleted ancestor still has a parent of its own). Null when the chain ends
 * without one, or the session is detached.
 */
export function reportTargetOf(
  sessionId: string,
  index: SessionLineageIndex,
  exists: (id: string) => boolean,
): string | null {
  const seen = new Set<string>([sessionId])
  let current = sessionId
  for (let depth = 0; depth < FAMILY_DEPTH_LIMIT; depth++) {
    const next = attachedOriginId(index.get(current))
    if (next === undefined || seen.has(next)) return null
    if (exists(next)) return next
    seen.add(next)
    current = next
  }
  return null
}

/** Names with a fixed meaning when a family member is addressed. */
export const RESERVED_FAMILY_NAMES: ReadonlySet<string> = new Set(['parent', 'top', 'self'])

/** Longest short name, in characters. */
export const FAMILY_NAME_MAX_CHARS = 24

export const FAMILY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const FAMILY_NAME_FALLBACK = 'session'

/** A short name's slug: lowercase, every run of other characters one `-`,
 *  no leading or trailing `-`, capped. Empty when nothing is left. */
export function familyNameSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FAMILY_NAME_MAX_CHARS)
    .replace(/-+$/g, '')
}

/** The name a session asks for, before uniqueness: the explicit name, else
 *  its title, else a fixed word. */
export function familyNameBase(preferred: string | undefined, title: string | undefined): string {
  for (const candidate of [preferred, title]) {
    if (candidate === undefined) continue
    const slug = familyNameSlug(candidate)
    if (slug) return slug
  }
  return FAMILY_NAME_FALLBACK
}

/**
 * A name for `base` that is not in `taken` and not reserved: the base, then
 * `base-2` through `base-99`, then the base with a random suffix, each
 * candidate checked. The base is shortened so a suffixed name stays within
 * `FAMILY_NAME_MAX_CHARS`. `random` yields the suffix; the default is four
 * lowercase alphanumerics.
 */
export function allocateFamilyName(
  base: string,
  taken: ReadonlySet<string>,
  random: () => string = randomNameSuffix,
): string {
  const slug = familyNameSlug(base) || FAMILY_NAME_FALLBACK
  const isFree = (name: string) => !taken.has(name) && !RESERVED_FAMILY_NAMES.has(name)
  if (isFree(slug)) return slug
  const withSuffix = (suffix: string) => {
    const room = FAMILY_NAME_MAX_CHARS - suffix.length - 1
    const head = slug.slice(0, room).replace(/-+$/g, '') || FAMILY_NAME_FALLBACK.slice(0, room)
    return `${head}-${suffix}`
  }
  for (let n = 2; n <= 99; n++) {
    const candidate = withSuffix(String(n))
    if (isFree(candidate)) return candidate
  }
  for (;;) {
    const candidate = withSuffix(random())
    if (isFree(candidate)) return candidate
  }
}

const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomNameSuffix(): string {
  let out = ''
  for (let i = 0; i < 4; i++) {
    out += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)]
  }
  return out
}

/** The list-entry relation fields a session is known by once summarized. */
export type SessionRelationFields = {
  parentSessionId?: string
  lineageKind?: SessionLineageKind
  familyName?: string
  detached?: boolean
}

/**
 * A lineage input rebuilt from a session's list-entry fields, for walking a
 * family over summaries alone: a model-started relation reads as an origin, a
 * person's fork as a copy source, a suggested task as a user-started origin.
 * A detached entry keeps the flag and nothing else.
 */
export function lineageInputFromRelationFields(fields: SessionRelationFields): SessionLineageInput {
  if (fields.detached) return { lineageDetached: true }
  const parent = fields.parentSessionId
  if (!parent || !fields.lineageKind) return {}
  const name = fields.familyName ? { name: fields.familyName } : {}
  switch (fields.lineageKind) {
    case 'fork':
      return { forkedFromSessionId: parent }
    case 'suggested_task':
      return { spawnedFrom: { sessionId: parent, taskId: '', kind: 'side_session', initiator: 'user', userFork: true, ...name } }
    default:
      return { spawnedFrom: { sessionId: parent, taskId: '', kind: fields.lineageKind, initiator: 'model', ...name } }
  }
}
