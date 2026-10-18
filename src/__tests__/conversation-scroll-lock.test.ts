// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import {
  classifyConversationScrollEvent,
  classifyPendingQuestionTransition,
  collapseConversationCollapsibles,
  createConversationScrollWriter,
  engageConversationLockOnFirstForeground,
  engageConversationLockToBottom,
  isConversationViewportAtBottom,
  snapConversationViewportToBottom,
  syncConversationLockFromViewport,
  syncConversationLockOnUserScroll,
  type RefLike,
} from '../browser/webview/conversationScrollLock'

function ref<T>(current: T): RefLike<T> {
  return { current }
}

function makeViewport({
  scrollHeight = 1000,
  clientHeight = 200,
  scrollTop = 0,
}: {
  scrollHeight?: number
  clientHeight?: number
  scrollTop?: number
} = {}): HTMLElement {
  const viewport = document.createElement('div')
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  })
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: value => {
      scrollTop = value
    },
  })
  return viewport
}

describe('conversation scroll lock', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('first foreground entry initializes lock, later foreground entries keep existing state', () => {
    const entered = ref(false)
    const foreground = ref(false)
    const locked = ref(false)
    const viewport = makeViewport({ scrollHeight: 1200, clientHeight: 300 })

    const first = engageConversationLockOnFirstForeground({
      isForeground: true,
      hasEnteredForegroundRef: entered,
      isForegroundRef: foreground,
      lockRef: locked,
      viewport,
    })

    expect(first).toBe(true)
    expect(entered.current).toBe(true)
    expect(foreground.current).toBe(true)
    expect(locked.current).toBe(true)
    expect(viewport.scrollTop).toBe(1200)

    viewport.scrollTop = 321
    locked.current = false

    const switchBack = engageConversationLockOnFirstForeground({
      isForeground: true,
      hasEnteredForegroundRef: entered,
      isForegroundRef: foreground,
      lockRef: locked,
      viewport,
    })

    expect(switchBack).toBe(false)
    expect(viewport.scrollTop).toBe(321)
    expect(locked.current).toBe(false)
  })

  it('send/manual-bottom enable the lock, and manual scroll away disables it', () => {
    const locked = ref(false)
    const viewport = makeViewport({
      scrollHeight: 1000,
      clientHeight: 250,
      scrollTop: 100,
    })

    engageConversationLockToBottom(locked, viewport)
    expect(locked.current).toBe(true)
    expect(viewport.scrollTop).toBe(1000)

    viewport.scrollTop = 500
    expect(syncConversationLockFromViewport(locked, viewport)).toBe(false)
    expect(locked.current).toBe(false)

    viewport.scrollTop = 750
    expect(syncConversationLockFromViewport(locked, viewport)).toBe(true)
    expect(locked.current).toBe(true)
  })

  it('snap-to-bottom never inflates the scroll anchor (a footer-sized anchor is a footer-sized gap)', () => {
    // The viewport footer is sticky-in-flow at the END of the content, so at
    // max scroll it sits at its flow position and never overlays the last
    // message. Inflating the anchor by the footer height therefore rendered
    // as a large blank gap between the last message and the composer — and on
    // short windows pushed an empty thread's welcome page above the fold.
    const viewport = makeViewport({ scrollHeight: 900, clientHeight: 400 })
    const anchor = document.createElement('div')
    anchor.className = 'aui-scroll-anchor'
    viewport.append(anchor)
    const footer = document.createElement('div')
    footer.className = 'aui-thread-viewport-footer'
    Object.defineProperty(footer, 'offsetHeight', {
      configurable: true,
      get: () => 180,
    })
    viewport.append(footer)

    snapConversationViewportToBottom(viewport)

    expect(viewport.scrollTop).toBe(900)
    expect(anchor.style.height).toBe('')
    expect(anchor.style.minHeight).toBe('')
    expect(isConversationViewportAtBottom(viewport)).toBe(true)
  })

  it('upward user scroll releases the lock even while still inside the bottom threshold', () => {
    // Smooth wheel scrolling delivers a small scroll-up's first frames while
    // still within the 24px threshold; a position-only sync re-locked there
    // and the next locked snap ate the user's scroll-up.
    const locked = ref(true)
    const viewport = makeViewport({
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 790, // 10px above the bottom — inside the threshold
    })

    expect(syncConversationLockOnUserScroll(locked, viewport, 800)).toBe(false)
    expect(locked.current).toBe(false)
  })

  it('downward user scroll re-locks at the bottom and releases elsewhere', () => {
    const locked = ref(false)
    const viewport = makeViewport({
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 790,
    })

    expect(syncConversationLockOnUserScroll(locked, viewport, 700)).toBe(true)
    expect(locked.current).toBe(true)

    viewport.scrollTop = 500
    expect(syncConversationLockOnUserScroll(locked, viewport, 400)).toBe(false)
    expect(locked.current).toBe(false)
  })

  it('classifies a snap-produced scroll as consumeProgrammatic even while locked, unlocked, or mid-intent', () => {
    // The guard must win over the lock/intent branches: a snap moves scrollTop
    // to the bottom and queues a scroll event; if the user has just wheeled up
    // (lock released, intent active) an unguarded handler would read that snap
    // event as "scrolled to bottom" and re-lock. Priority order is the fix.
    for (const lockActive of [true, false]) {
      for (const intentActive of [true, false]) {
        expect(
          classifyConversationScrollEvent({
            programmaticPending: true,
            lockActive,
            intentActive,
          }),
        ).toBe('consumeProgrammatic')
      }
    }
  })

  it('classifies a non-programmatic scroll by lock/intent', () => {
    expect(
      classifyConversationScrollEvent({
        programmaticPending: false,
        lockActive: true,
        intentActive: false,
      }),
    ).toBe('repinLocked')
    // Active user intent takes precedence over a still-set lock (the user is
    // scrolling; syncOnUserScroll decides release/re-lock from direction).
    expect(
      classifyConversationScrollEvent({
        programmaticPending: false,
        lockActive: true,
        intentActive: true,
      }),
    ).toBe('syncUser')
    expect(
      classifyConversationScrollEvent({
        programmaticPending: false,
        lockActive: false,
        intentActive: true,
      }),
    ).toBe('syncUser')
    expect(
      classifyConversationScrollEvent({
        programmaticPending: false,
        lockActive: false,
        intentActive: false,
      }),
    ).toBe('ignore')
  })

  it('an upward clamp that still ends exactly at the bottom keeps the lock', () => {
    // Collapsing a tool card while pinned shrinks scrollHeight; the browser
    // clamps scrollTop DOWN but the viewport is still at the true bottom —
    // that is not a user scroll-up and must not release the lock.
    const locked = ref(true)
    const viewport = makeViewport({
      scrollHeight: 700,
      clientHeight: 200,
      scrollTop: 500,
    })

    expect(syncConversationLockOnUserScroll(locked, viewport, 800)).toBe(true)
    expect(locked.current).toBe(true)
  })

  it('collapse-all closes every open top-level conversation collapsible in one pass', () => {
    const viewport = document.createElement('div')
    viewport.className = 'aui-thread-viewport'
    const first = document.createElement('button')
    first.dataset.slot = 'tool-fallback-trigger'
    first.setAttribute('aria-expanded', 'true')
    first.onclick = () => first.setAttribute('aria-expanded', 'false')
    const second = document.createElement('button')
    second.dataset.slot = 'reasoning-trigger'
    second.setAttribute('aria-expanded', 'true')
    second.onclick = () => second.setAttribute('aria-expanded', 'false')
    viewport.append(first, second)
    document.body.append(viewport)

    expect(collapseConversationCollapsibles(document)).toBe(2)
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('false')
  })

  it('collapse-all ignores the composer-bottom chip controls (folder, branch, session diff)', () => {
    // The composer-bottom row's chip controls are excluded from collapse-all
    // (composer UI, not transcript collapsibles).
    const viewport = document.createElement('div')
    viewport.className = 'aui-thread-viewport'
    for (const cls of [
      'aui-project-folder-chip-root',
      'aui-project-branch-chip-root',
    ]) {
      const root = document.createElement('div')
      root.className = cls
      const trigger = document.createElement('button')
      trigger.setAttribute('aria-expanded', 'true')
      trigger.onclick = () => trigger.setAttribute('aria-expanded', 'false')
      root.append(trigger)
      viewport.append(root)
    }
    document.body.append(viewport)

    expect(collapseConversationCollapsibles(document)).toBe(0)
    for (const trigger of viewport.querySelectorAll('button')) {
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
    }
  })

  it('collapse-all does not collapse the diff panel\'s turn triggers (panel-internal, not transcript)', () => {
    const viewport = document.createElement('div')
    viewport.className = 'aui-thread-viewport'
    const turnTrigger = document.createElement('button')
    turnTrigger.dataset.slot = 'turn-diff-turn-trigger'
    turnTrigger.setAttribute('aria-expanded', 'true')
    turnTrigger.onclick = () => turnTrigger.setAttribute('aria-expanded', 'false')
    viewport.append(turnTrigger)
    document.body.append(viewport)

    expect(collapseConversationCollapsibles(document)).toBe(0)
    expect(turnTrigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('collapse-all ignores composer controls', () => {
    const viewport = document.createElement('div')
    viewport.className = 'aui-thread-viewport'
    const composer = document.createElement('div')
    composer.className = 'aui-composer-root'
    const composerButton = document.createElement('button')
    composerButton.dataset.slot = 'reasoning-trigger'
    composerButton.setAttribute('aria-expanded', 'true')
    composerButton.onclick = () => composerButton.setAttribute('aria-expanded', 'false')
    composer.append(composerButton)
    viewport.append(composer)
    document.body.append(viewport)

    expect(collapseConversationCollapsibles(document)).toBe(0)
    expect(composerButton.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('classifyPendingQuestionTransition (AskUserQuestion reveal scroll)', () => {
  // Regression for the "can't scroll away from an AskUserQuestion" defect: the
  // conversation must snap to the bottom ONCE when a question appears (reveal),
  // then RELEASE the lock so the user regains scroll freedom; and re-engage the
  // lock when the question is answered (resume). The transition must be edge-
  // triggered on the 0↔positive boundary, NOT level-triggered on every render.
  it('reveals (one-time snap + lock release) on a 0 → positive transition', () => {
    expect(classifyPendingQuestionTransition(0, 1)).toBe('reveal')
    expect(classifyPendingQuestionTransition(0, 3)).toBe('reveal')
  })

  it('resumes (re-engage lock) on a positive → 0 transition (answered)', () => {
    expect(classifyPendingQuestionTransition(1, 0)).toBe('resume')
    expect(classifyPendingQuestionTransition(2, 0)).toBe('resume')
  })

  it('is a no-op while the count is unchanged or stays within the positive range', () => {
    // Unchanged — must not re-snap on every render (the level-triggered bug).
    expect(classifyPendingQuestionTransition(0, 0)).toBe('none')
    expect(classifyPendingQuestionTransition(1, 1)).toBe('none')
    // A second question arriving while one is already pending must not re-run
    // the reveal (that would yank the viewport back down again).
    expect(classifyPendingQuestionTransition(1, 2)).toBe('none')
    expect(classifyPendingQuestionTransition(2, 1)).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// ConversationScrollWriter — the single owner of programmatic scrollTop writes
// ---------------------------------------------------------------------------

/** A viewport whose scrollTop CLAMPS like a real element's — the writer's
 *  "a write that moved nothing must not arm" rule is exactly about clamping. */
function makeClampingViewport({
  scrollHeight = 1000,
  clientHeight = 200,
  scrollTop = 0,
}: {
  scrollHeight?: number
  clientHeight?: number
  scrollTop?: number
} = {}): HTMLElement {
  const max = Math.max(0, scrollHeight - clientHeight)
  const viewport = document.createElement('div')
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  })
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: value => {
      scrollTop = Math.min(max, Math.max(0, value))
    },
  })
  return viewport
}

describe('createConversationScrollWriter', () => {
  it('arms on a snap that moves the viewport, and consumes exactly once', () => {
    const writer = createConversationScrollWriter()
    const viewport = makeClampingViewport()
    expect(writer.hasPending()).toBe(false)

    writer.snapToBottom(viewport)
    // `scrollTop = scrollHeight` clamps to the max scroll position — that IS
    // how the snap reaches the bottom on a real element.
    expect(viewport.scrollTop).toBe(800)
    expect(writer.hasPending()).toBe(true)

    expect(writer.consumePending()).toBe(true)
    expect(writer.hasPending()).toBe(false)
    // A second consume finds nothing — one armed write, one swallowed event.
    expect(writer.consumePending()).toBe(false)
  })

  it('does NOT arm when a snap moves nothing (already at the bottom)', () => {
    // No movement → the browser fires no scroll event → an armed guard would
    // swallow the user's NEXT real scroll instead.
    const writer = createConversationScrollWriter()
    const viewport = makeClampingViewport({ scrollTop: 800 })
    writer.snapToBottom(viewport) // already at max scroll (1000-200)
    expect(writer.hasPending()).toBe(false)
  })

  it('arms on a height-repair adjustment that moves the viewport', () => {
    const writer = createConversationScrollWriter()
    const viewport = makeClampingViewport({ scrollTop: 400 })
    writer.adjustBy(viewport, 120)
    expect(viewport.scrollTop).toBe(520)
    expect(writer.hasPending()).toBe(true)
  })

  it('does not arm on a zero delta or a fully-clamped adjustment', () => {
    const writer = createConversationScrollWriter()
    const viewport = makeClampingViewport({ scrollTop: 0 })
    writer.adjustBy(viewport, 0)
    expect(writer.hasPending()).toBe(false)
    // At the top, a negative repair clamps to 0 — nothing moved.
    writer.adjustBy(viewport, -50)
    expect(writer.hasPending()).toBe(false)
  })

  it('several writes before the coalesced event still arm ONCE', () => {
    // The browser coalesces scroll events; a boolean (not a counter) matches
    // that — two writes, one event, one consume, and the guard is clean.
    const writer = createConversationScrollWriter()
    const viewport = makeClampingViewport()
    writer.snapToBottom(viewport)
    writer.adjustBy(viewport, -30)
    expect(writer.consumePending()).toBe(true)
    expect(writer.hasPending()).toBe(false)
  })

  it('reset disarms a stale guard from a torn-down instance', () => {
    const writer = createConversationScrollWriter()
    const viewport = makeClampingViewport()
    writer.snapToBottom(viewport)
    writer.reset()
    expect(writer.hasPending()).toBe(false)
    expect(writer.consumePending()).toBe(false)
  })
})
