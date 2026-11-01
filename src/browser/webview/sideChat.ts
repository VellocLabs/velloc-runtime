import type { SessionListItem } from './SessionRows'

/**
 * Side chats (F-36): forks a person opens beside a conversation. A side chat
 * is listed in its parent's side panel, never in the sidebar or the tab
 * strip, until it is detached or its parent is gone. Pure helpers over the
 * session list.
 */

/** The fields the relation is read from. */
export type SideChatRelation = {
  sessionId: string
  sideChat?: boolean
  detached?: boolean
  parentSessionId?: string
}

/** A side chat still under its parent (whether or not the parent is listed). */
export function isSideChatUnderParent(item: SideChatRelation): boolean {
  return item.sideChat === true && item.detached !== true && typeof item.parentSessionId === 'string'
}

/** The side chats shown under `parentId`, newest first. */
export function sideChatsOf(
  items: readonly SessionListItem[],
  parentId: string | null | undefined,
): SessionListItem[] {
  if (!parentId) return []
  return items
    .filter(item => isSideChatUnderParent(item) && item.parentSessionId === parentId)
    .sort((a, b) => (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt))
}

/**
 * The rows the sidebar and the tab strip list: a side chat stays in its
 * parent's panel while the parent is in the list; one whose parent is gone
 * (deleted, or not loaded) is a session of its own and lists like any other,
 * so deleting a parent never deletes or hides what was said beside it.
 */
export function withoutListedSideChats<T extends SideChatRelation>(items: readonly T[]): T[] {
  const ids = new Set(items.map(item => item.sessionId))
  return items.filter(
    item => !(isSideChatUnderParent(item) && ids.has(item.parentSessionId as string)),
  )
}

/**
 * Parents whose side chats wait for the person: the parent's row carries the
 * mark while the panel is closed.
 */
export function parentsNeedingAnswer(
  items: readonly SideChatRelation[],
  needsAnswer: ReadonlySet<string>,
): ReadonlySet<string> {
  const parents = new Set<string>()
  for (const item of items) {
    if (isSideChatUnderParent(item) && needsAnswer.has(item.sessionId)) {
      parents.add(item.parentSessionId as string)
    }
  }
  return parents
}

/**
 * The side chat the panel shows for a parent: the remembered choice while it
 * is still listed there, else the newest, else none.
 */
export function pickSideChat(
  sideChats: readonly { sessionId: string }[],
  remembered: string | null | undefined,
): string | null {
  if (remembered && sideChats.some(item => item.sessionId === remembered)) return remembered
  return sideChats[0]?.sessionId ?? null
}

/**
 * How a session's conversation is mounted: in the chat slot, or in the Side
 * chats pane. A pane thread is its own foreground session (the composer's
 * session gate, the folder chip and the bottom lock all read the foreground
 * id, which must be the side chat's, not the viewed session's) and carries
 * light controls: no model or effort picker, no settings, no folder controls.
 */
export function threadMount(
  sessionId: string,
  inPane: boolean,
  activeSessionId: string | null | undefined,
): { foregroundSessionId: string | undefined; lightControls: boolean } {
  return {
    foregroundSessionId: inPane ? sessionId : activeSessionId ?? undefined,
    lightControls: inPane,
  }
}

/** `mounted` plus the side chat the panel shows, so its client exists. */
export function mountedWithSideChat(mounted: readonly string[], shown: string | null): string[] {
  if (!shown || mounted.includes(shown)) return [...mounted]
  return [...mounted, shown]
}
