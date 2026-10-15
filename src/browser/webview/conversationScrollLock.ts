import { COLLAPSIBLE_CARD_TRIGGER_SLOTS } from './collapsibleCardSlots'

export const CONVERSATION_BOTTOM_THRESHOLD_PX = 24

export type RefLike<T> = { current: T }

const VIEWPORT_SELECTOR = '.aui-thread-viewport'

// The card slots are shared with the search reveal (collapsibleCardSlots.ts);
// the two extra entries are scroll-lock-only: file entries are not cards
// the reveal opens, and the bare `collapsible-trigger` is scoped here to
// the background-results card while the reveal opens any of them.
const COLLAPSIBLE_TRIGGER_SELECTOR = [
  ...COLLAPSIBLE_CARD_TRIGGER_SLOTS.map(slot => `[data-slot="${slot}"]`),
  '[data-slot="file-entry-toggle"]',
  '[data-role="background-results-card"] [data-slot="collapsible-trigger"]',
].join(',')
const COLLAPSIBLE_EXCLUDED_ANCESTOR_SELECTOR = [
  '[data-slot="nexus-status-bar"]',
  '.aui-composer-root',
  '.aui-composer-mode-picker',
  '.aui-project-folder-chip-root',
  '.aui-project-branch-chip-root',
  '.aui-session-diff-chip-root',
].join(',')

export function findConversationViewport(root: ParentNode): HTMLElement | null {
  if (root instanceof HTMLElement && root.matches(VIEWPORT_SELECTOR)) {
    return root
  }
  const el = root.querySelector(VIEWPORT_SELECTOR)
  return el instanceof HTMLElement ? el : null
}

function isOpenCollapsibleTrigger(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (element.closest(COLLAPSIBLE_EXCLUDED_ANCESTOR_SELECTOR)) return false
  if ('disabled' in element && element.disabled === true) return false
  return (
    element.getAttribute('aria-expanded') === 'true' ||
    element.getAttribute('data-state') === 'open'
  )
}

function isDescendantOfAny(
  element: HTMLElement,
  candidates: readonly HTMLElement[],
): boolean {
  return candidates.some(candidate => candidate !== element && candidate.contains(element))
}

export function collapseConversationCollapsibles(root: ParentNode): number {
  const viewport = findConversationViewport(root) ?? root
  const openTriggers = Array.from(
    viewport.querySelectorAll(COLLAPSIBLE_TRIGGER_SELECTOR),
  ).filter(isOpenCollapsibleTrigger)

  const triggers = openTriggers.filter(
    trigger => !isDescendantOfAny(trigger, openTriggers),
  )

  let collapsed = 0
  for (const trigger of triggers) {
    if (trigger.isConnected && isOpenCollapsibleTrigger(trigger)) {
      trigger.click()
      collapsed++
    }
  }

  return collapsed
}

/**
 * The single owner of programmatic scrollTop writes on the conversation viewport, and of the guard that
 * keeps them from reading as user scrolls. Only a write that moved the viewport arms the guard, once per
 * coalesced event; `consumePending` swallows exactly one event, then disarms.
 */
export interface ConversationScrollWriter {
  /** Snap to the bottom; arms the guard if the position moved. */
  snapToBottom(viewport: HTMLElement): void
  /** Shift by `deltaPx` (virtualization height repair above the viewport);
   *  arms the guard if the position moved. */
  adjustBy(viewport: HTMLElement, deltaPx: number): void
  /** Is a programmatic scroll event still expected? */
  hasPending(): boolean
  /** Swallow one pending event. Returns whether one was armed. */
  consumePending(): boolean
  /** Disarm — a (re)installed scroll handler must start clean so a flag armed
   *  by a torn-down instance can't swallow the first real user scroll. */
  reset(): void
}

export function createConversationScrollWriter(): ConversationScrollWriter {
  let pending = false
  return {
    snapToBottom(viewport: HTMLElement): void {
      const before = viewport.scrollTop
      snapConversationViewportToBottom(viewport)
      if (viewport.scrollTop !== before) pending = true
    },
    adjustBy(viewport: HTMLElement, deltaPx: number): void {
      if (deltaPx === 0) return
      const before = viewport.scrollTop
      viewport.scrollTop = before + deltaPx
      if (viewport.scrollTop !== before) pending = true
    },
    hasPending(): boolean {
      return pending
    },
    consumePending(): boolean {
      const was = pending
      pending = false
      return was
    },
    reset(): void {
      pending = false
    },
  }
}

export function snapConversationViewportToBottom(viewport: HTMLElement): void {
  // No scroll-anchor inflation here: the viewport footer (composer) is
  // sticky-in-flow at the END of the scroll content, so at max scroll it sits
  // exactly at its flow position and never overlays the last message. The
  // previous footer-height clearance on `.aui-scroll-anchor` therefore showed
  // up as a footer-sized blank gap between the last message and the composer
  // (and on short windows pushed an empty thread's welcome page above the
  // fold). The anchor's static CSS height (h-8) is all the clearance the last
  // message's hover action bar needs.
  viewport.scrollTop = viewport.scrollHeight
}

export function isConversationViewportAtBottom(
  viewport: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  thresholdPx = CONVERSATION_BOTTOM_THRESHOLD_PX,
): boolean {
  if (viewport.scrollHeight <= viewport.clientHeight) return true
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= thresholdPx
}

export function syncConversationLockFromViewport(
  lockRef: RefLike<boolean>,
  viewport: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  thresholdPx = CONVERSATION_BOTTOM_THRESHOLD_PX,
): boolean {
  const locked = isConversationViewportAtBottom(viewport, thresholdPx)
  lockRef.current = locked
  return locked
}

/**
 * Lock sync for scroll events during a user gesture. An upward scroll only releases the lock, except
 * one ending exactly at the bottom (a browser clamp after content shrank); downward or stationary scrolls
 * re-lock at the bottom and release elsewhere.
 */
export function syncConversationLockOnUserScroll(
  lockRef: RefLike<boolean>,
  viewport: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  previousScrollTop: number,
  thresholdPx = CONVERSATION_BOTTOM_THRESHOLD_PX,
): boolean {
  const distanceFromBottom =
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
  const scrolledUp = viewport.scrollTop < previousScrollTop
  if (scrolledUp && distanceFromBottom > 2) {
    lockRef.current = false
    return false
  }
  return syncConversationLockFromViewport(lockRef, viewport, thresholdPx)
}

/**
 * How the scroll handler treats one event; pure so the priority order (the guard wins) is testable.
 * `consumeProgrammatic`: our own snap, swallowed without touching the lock; `repinLocked`: locked, no
 * intent; `syncUser`: a gesture is active; `ignore`: unlocked, no intent.
 */
export type ConversationScrollEventAction =
  | 'consumeProgrammatic'
  | 'repinLocked'
  | 'syncUser'
  | 'ignore'

export function classifyConversationScrollEvent(params: {
  programmaticPending: boolean
  lockActive: boolean
  intentActive: boolean
}): ConversationScrollEventAction {
  if (params.programmaticPending) return 'consumeProgrammatic'
  if (params.lockActive && !params.intentActive) return 'repinLocked'
  if (params.intentActive) return 'syncUser'
  return 'ignore'
}

export function engageConversationLockToBottom(
  lockRef: RefLike<boolean>,
  viewport: HTMLElement | null,
): void {
  lockRef.current = true
  if (viewport) snapConversationViewportToBottom(viewport)
}

/**
 * Reaction to a change in pending AskUserQuestion cards: `reveal` (0 → >0) snaps to the bottom once,
 * then releases the lock; `resume` (>0 → 0) re-engages it; `none` leaves the scroll state alone.
 */
export type PendingQuestionTransitionAction = 'reveal' | 'resume' | 'none'

export function classifyPendingQuestionTransition(
  prevCount: number,
  nextCount: number,
): PendingQuestionTransitionAction {
  if (prevCount === 0 && nextCount > 0) return 'reveal'
  if (prevCount > 0 && nextCount === 0) return 'resume'
  return 'none'
}

export function engageConversationLockOnFirstForeground(params: {
  isForeground: boolean
  hasEnteredForegroundRef: RefLike<boolean>
  isForegroundRef: RefLike<boolean>
  lockRef: RefLike<boolean>
  viewport: HTMLElement | null
}): boolean {
  params.isForegroundRef.current = params.isForeground
  if (!params.isForeground) {
    return false
  }

  if (params.hasEnteredForegroundRef.current) {
    return false
  }

  params.hasEnteredForegroundRef.current = true
  engageConversationLockToBottom(params.lockRef, params.viewport)
  return true
}
