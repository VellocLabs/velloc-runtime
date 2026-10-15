/**
 * Deriving the topbar session tabs from the full session list: teammate sessions are absent from the
 * sidebar and reachable through the strip, which shows a lead's whole family.
 */
import { teammateSpawnTimeFromId } from '../../utils/sidechainStoragePaths'
import { RESERVED_MEMBER_KEYS } from '../../team/memberKey'
import type { SessionListItem } from './SessionRows'

/**
 * When a child was created, for newest-first order: the teammate id's spawn stamp first, since
 * `SessionListItem.createdAt` is an activity clock for sessions this webview did not create. 0 sorts last.
 */
function childCreatedAt(session: SessionListItem): number {
  return (
    teammateSpawnTimeFromId(session.sessionId) ?? session.createdAt ?? 0
  )
}

/**
 * The family the strip shows for `activeSessionId`: the root first, then its children in list order.
 * Fewer than two entries when there is nothing to switch between.
 */
export function deriveSessionTabs(
  allItems: readonly SessionListItem[],
  activeSessionId: string,
): SessionListItem[] {
  const active = allItems.find(s => s.sessionId === activeSessionId)
  if (!active) return []
  const rootId = active.spawnerSessionId ?? activeSessionId
  const root = allItems.find(s => s.sessionId === rootId)
  if (!root) return active.spawnerSessionId ? [active] : []
  const children = allItems
    .filter(s => s.spawnerSessionId === rootId)
    // NEWEST FIRST: a child is added immediately to the right of the lead, so
    // the rightmost tab is the OLDEST child. The list this reads is ordered by
    // activity (the sidebar's order), which reshuffles as teammates work --
    // tabs must not move under the pointer, so order by creation instead.
    // `childCreatedAt` is what makes that a CREATION order rather than a
    // second activity order; a child with no creation time anywhere sorts
    // last among themselves, by id, which is at least stable.
    .sort((a, b) => childCreatedAt(b) - childCreatedAt(a) ||
      a.sessionId.localeCompare(b.sessionId))
  return [root, ...children]
}

/**
 * The session the sidebar highlights for `activeSessionId`: a child resolves to its `spawnerSessionId`
 * (one hop, listed or not); any other id is returned unchanged.
 */
export function sidebarActiveSessionId(
  allItems: readonly SessionListItem[],
  activeSessionId: string,
): string {
  const active = allItems.find(s => s.sessionId === activeSessionId)
  return active?.spawnerSessionId ?? activeSessionId
}

/**
 * The session a teammate-jump request means, resolved within the active session's family (member names
 * are unique per team only). Null when the teammate is gone; the caller drops the click.
 */
export function resolveTeammateJumpTarget(
  allItems: readonly SessionListItem[],
  activeSessionId: string,
  request: { sessionId: string } | { teammateName: string },
): string | null {
  if ('sessionId' in request) {
    return allItems.some(s => s.sessionId === request.sessionId)
      ? request.sessionId
      : null
  }
  const family = deriveSessionTabs(allItems, activeSessionId)
  // A teammate's SendMessage to its lead addresses `team-lead` (or `lead`):
  // a reserved key, never a teammate's own name, and the coordinator resolves
  // it to the parent (`sessionIdForMemberOfLead`). Here it is the family's
  // root — which no tab carries as a `teammateName`, so without this the
  // ">>" on such a card matched nothing and the click was dropped.
  if (RESERVED_MEMBER_KEYS.has(request.teammateName)) {
    const root = family[0]
    // A child whose lead is not in the list yields only itself: no lead to
    // jump to, so the click is dropped like any other unresolvable name.
    return root && !root.spawnerSessionId ? root.sessionId : null
  }
  const match = family.find(s => s.teammateName === request.teammateName)
  return match?.sessionId ?? null
}

/**
 * Tab-label fitting: when titles do not all fit, drop them whole from the last tab leftwards. The active
 * tab keeps its title, truncating only when nothing else is left.
 */
export type TabWidthSample = {
  sessionId: string
  /** Width of the tab with NO title: the status slot plus padding. The
   *  slot is a fixed size whatever it shows (icon / busy ripple), so this
   *  does not move when a session starts or stops. */
  iconWidth: number
  /** Natural (untruncated) width of the title text on top of that. */
  labelWidth: number
}

export function fitTabLabels(params: {
  samples: readonly TabWidthSample[]
  activeSessionId: string
  /** Space the strip may occupy, in px. `undefined` = not measured yet. */
  budget: number | undefined
  /** Gap between tabs plus the strip's own padding, in px. */
  chrome: number
}): Set<string> {
  const hidden = new Set<string>()
  const { samples, budget } = params
  if (budget === undefined || samples.length === 0) return hidden
  let total = params.chrome
  for (const sample of samples) total += sample.iconWidth + sample.labelWidth
  for (let i = samples.length - 1; i >= 0 && total > budget; i--) {
    const sample = samples[i]!
    if (sample.sessionId === params.activeSessionId) continue
    if (sample.labelWidth <= 0) continue
    hidden.add(sample.sessionId)
    total -= sample.labelWidth
  }
  return hidden
}

/**
 * Tab overflow: before titles drop, trailing tabs collapse into one overflow tab. The lead and the active
 * tab never collapse; closed teammates go first, rightmost first; fewer than {@link MIN_OVERFLOWED_TABS}
 * never collapse.
 */
export type TabOverflowSample = {
  sessionId: string
  /** The tab's FULL width, title included (`iconWidth + labelWidth`). */
  width: number
  /** The session has been shut down. Collapses before any live one. */
  shutdown: boolean
}

/** @see planTabOverflow */
export const MIN_OVERFLOWED_TABS = 2

export function planTabOverflow(params: {
  /** Strip order: the lead first, then its children newest-first. */
  samples: readonly TabOverflowSample[]
  activeSessionId: string
  /** Space the strip may occupy, in px. `undefined` = not measured yet. */
  budget: number | undefined
  /** The strip's own left + right padding, in px. */
  padding: number
  /** Gap between two adjacent rendered tabs, in px. */
  gap: number
  /** What the overflow tab itself costs once there is one, in px. */
  overflowWidth: number
}): Set<string> {
  const { samples, budget, padding, gap, overflowWidth } = params
  const none = new Set<string>()
  if (budget === undefined) return none

  const candidates = samples
    .map((sample, index) => ({ sample, index }))
    .filter(
      ({ sample, index }) =>
        index > 0 && sample.sessionId !== params.activeSessionId,
    )
    // Closed first; then the rightmost, which is the oldest.
    .sort(
      (a, b) =>
        Number(b.sample.shutdown) - Number(a.sample.shutdown) ||
        b.index - a.index,
    )
  if (candidates.length < MIN_OVERFLOWED_TABS) return none

  /** What the strip costs with `hidden` collapsed behind the overflow tab. */
  const widthWith = (hidden: ReadonlySet<string>): number => {
    let rendered = hidden.size > 0 ? 1 : 0
    let content = hidden.size > 0 ? overflowWidth : 0
    for (const sample of samples) {
      if (hidden.has(sample.sessionId)) continue
      rendered++
      content += sample.width
    }
    return padding + content + gap * Math.max(0, rendered - 1)
  }

  const uncollapsed = widthWith(none)
  if (uncollapsed <= budget) return none

  const hidden = new Set<string>()
  for (const { sample } of candidates) {
    hidden.add(sample.sessionId)
    if (hidden.size >= MIN_OVERFLOWED_TABS && widthWith(hidden) <= budget) break
  }
  if (hidden.size < MIN_OVERFLOWED_TABS) return none
  // Collapsing is only ever allowed to HELP. Two narrow icon-only tabs can
  // cost less than the chip that would stand for them, and trading width away
  // for a menu the user then has to open is the worst of both.
  return widthWith(hidden) < uncollapsed ? hidden : none
}

/**
 * The overflow menu's two groups, live teammates above closed ones, each newest first. `separated` is
 * false when either group is empty.
 */
export function groupOverflowMenu(
  tabs: readonly SessionListItem[],
  overflowIds: ReadonlySet<string>,
): { live: SessionListItem[]; closed: SessionListItem[]; separated: boolean } {
  const overflowed = tabs.filter(s => overflowIds.has(s.sessionId))
  const live = overflowed.filter(s => !s.shutdown)
  const closed = overflowed.filter(s => s.shutdown)
  return { live, closed, separated: live.length > 0 && closed.length > 0 }
}
