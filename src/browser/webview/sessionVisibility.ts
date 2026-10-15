/**
 * Which sessions this channel shows: a type the channel's launcher catalog does not list is hidden, and
 * a teammate follows its lead. UI only: nothing is deleted or stopped. Untyped sessions are always shown,
 * and a local catalog never hides a type the bundled catalog lists.
 */
import {
  getLauncherMeta,
  isTypeListedInBundledCatalog,
} from '../../prompting/templateRegistry'

/** The fields the rule reads — satisfied by both `SessionListItem` and
 *  `LocalSessionEntry`. */
export type VisibilityEntry = {
  sessionId: string
  templateType?: string
  spawnerSessionId?: string
}

/** Whether the current channel's catalog — live or bundled — lists
 *  `templateType`. */
export function isSessionTypeOffered(templateType: string | undefined): boolean {
  return (
    templateType === undefined ||
    getLauncherMeta(templateType) !== undefined ||
    isTypeListedInBundledCatalog(templateType)
  )
}

/**
 * The ids this channel hides: sessions of an unlisted type, plus teammates of a hidden lead. A teammate
 * is judged by its lead, or by its own type when the lead is not in `entries`.
 */
export function hiddenSessionIds(
  entries: readonly VisibilityEntry[],
): ReadonlySet<string> {
  const byId = new Map(entries.map(entry => [entry.sessionId, entry] as const))
  const hidden = new Set<string>()
  for (const entry of entries) {
    const lead = entry.spawnerSessionId ? byId.get(entry.spawnerSessionId) : undefined
    const judged = lead ?? entry
    if (!isSessionTypeOffered(judged.templateType)) hidden.add(entry.sessionId)
  }
  return hidden
}

/** `ids` minus the hidden ones — the same set object when nothing is hidden,
 *  so memoised consumers see no change. */
export function withoutHidden(
  ids: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): ReadonlySet<string> {
  if (hidden.size === 0) return ids
  return new Set([...ids].filter(id => !hidden.has(id)))
}

/** `map` minus the hidden session ids among its keys — the same map object
 *  when nothing is hidden. */
export function withoutHiddenKeys<V>(
  map: ReadonlyMap<string, V>,
  hidden: ReadonlySet<string>,
): ReadonlyMap<string, V> {
  if (hidden.size === 0) return map
  return new Map([...map].filter(([id]) => !hidden.has(id)))
}

/**
 * The session to land on when the one on screen is hidden: the first entry
 * (callers pass the list in activity order) that is neither hidden nor a
 * teammate. `undefined` when there is none — the caller creates a session.
 */
export function pickVisibleSession<T extends VisibilityEntry>(
  entries: readonly T[],
  hidden: ReadonlySet<string>,
): T | undefined {
  return entries.find(
    entry => !entry.spawnerSessionId && !hidden.has(entry.sessionId),
  )
}
