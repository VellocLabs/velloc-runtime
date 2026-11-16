import { useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { TranslateFn } from './i18n/translate'
import type { LocalSessionEntry } from './useSessionManager'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import type { SessionListItem } from './Sidebar'
import { withoutHidden, withoutHiddenKeys } from './sessionVisibility'
import { attentionDelivery, clearAttentionForSession, deliveryConsumesEvent, createEndedQuestionTracker, detectEndedWithQuestion, reconcileAttention, type AttentionEvent } from './sessionAttention'
import { showHostNotification } from './nexusBridgeActions'
import { sessionDisplayTitle } from './SessionRows'
import { createShellPublishAttentionQueue, createShellRevealAttentionInSession, createShellHandleAttentionSelect } from './shellSelectionActions'

export type SessionAttentionInput = {
  sessions: readonly LocalSessionEntry[]
  runningSeenSinceDetectRef: MutableRefObject<Set<string>>
  runningSessionIds: ReadonlySet<string>
  allSessionItems: SessionListItem[]
  t: TranslateFn
  needsAnswerSessionIds: ReadonlySet<string>
  hiddenIds: ReadonlySet<string>
  needsInputAskKeys: ReadonlyMap<string, string>
  activeSessionId: string
  hostBridgeTransport: BrowserBridgeTransport
  focusSession: (sessionId: string) => void
}

// The shell's half of session attention: the queue, window focus, OS notification and switch; the rules live in `sessionAttention.ts`.
export function useSessionAttention({
  sessions,
  runningSeenSinceDetectRef,
  runningSessionIds,
  allSessionItems,
  t,
  needsAnswerSessionIds,
  hiddenIds,
  needsInputAskKeys,
  activeSessionId,
  hostBridgeTransport,
  focusSession,
}: SessionAttentionInput) {
  // --- Session attention: "a session wants you, and you are not looking" ---
  // The queue lives here because this is where all three inputs already meet:
  // `needsAnswerSessionIds` (halted sessions, teammates included), the running
  // set, and the session rows carrying the last message. `sessionAttention.ts`
  // owns the rules; everything below is the shell's half - focus, the OS
  // notification, the switch.
  const [attentionQueue, setAttentionQueue] = useState<AttentionEvent[]>([])
  // The queue is ALSO held in a ref, and the ref is the one both writers read.
  // The reconcile below has to send an OS notification for each newly raised
  // event, and a side effect must never sit inside a `setState` updater: React
  // double-invokes updaters in StrictMode, which would fire every toast twice.
  // So the effects compute against the ref, run their side effects once, and
  // publish the result to state for rendering.
  const attentionQueueRef = useRef<AttentionEvent[]>(attentionQueue)
  const publishAttentionQueue = useMemo(
    () => createShellPublishAttentionQueue(attentionQueueRef, setAttentionQueue),
    [],
  )

  // Event ids already DELIVERED, pruned to those still desired. A `focus` reveal is marked
  // only once it found the control, so a not-yet-mounted card is retried.
  const deliveredAttentionRef = useRef<Set<string>>(new Set())

  // Event ids the user has ACKNOWLEDGED by going to the session (one raised where the user
  // already was is not); an acknowledged event never comes back. Pruned like the delivered marks.
  const acknowledgedAttentionRef = useRef<Set<string>>(new Set())

  // When each marked id was first seen missing from the derived set. Both
  // mark sets above end with their event, but "missing" is not "ended": a
  // remount of a halted session's thread makes its thread-reported ask blink
  // out and back, and forgetting the acknowledgement on that blink re-raised
  // an ask the user had already visited. `reconcileAttention` forgets a mark
  // only once its absence outlasts `ATTENTION_DROP_GRACE_MS`.
  const attentionAbsentSinceRef = useRef<Map<string, number>>(new Map())

  // The ask each live / marked id was last seen producing — what a returning
  // id is measured against, so a re-ask within the grace is not mistaken for
  // the blink the grace exists for.
  const attentionAskKeysRef = useRef<Map<string, string>>(new Map())

  // Scope the reveal to the session's OWN section: every mounted thread is in
  // the DOM at once (hidden ones are `display: none`), so an unscoped query
  // would happily focus a sibling session's pending control. Returns whether a
  // control was found. Synchronous on purpose: these run from effects, after
  // the commit that put the control in the DOM, and a deferral through
  // `requestAnimationFrame` never fires while the page is occluded — which is
  // exactly the state a window the user is not looking at is in.
  const revealAttentionInSession = useMemo(
    () => createShellRevealAttentionInSession(),
    [],
  )

  // Is the Velloc window the user's ACTIVE surface? Both halves matter: a
  // window can be visible but not focused (a second monitor the user is not
  // typing into). The initial read is synchronous so the first event delivered
  // after boot is not classified against a guessed value.
  const [windowFocused, setWindowFocused] = useState(
    () =>
      typeof document === 'undefined' ||
      (document.visibilityState !== 'hidden' && document.hasFocus()),
  )
  useEffect(() => {
    const sync = () => {
      setWindowFocused(
        document.visibilityState !== 'hidden' && document.hasFocus(),
      )
    }
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  // Sessions whose last turn ENDED on a question without halting: latched on the running →
  // stopped edge until visited or run again. `detectEndedWithQuestion` orders the two feeds.
  const endedQuestionTrackerRef = useRef(createEndedQuestionTracker())
  const [endedWithQuestion, setEndedWithQuestion] = useState<
    ReadonlyMap<string, string>
  >(() => new Map())
  useEffect(() => {
    // One index for every lookup below, instead of a linear scan per session.
    const rowById = new Map(
      sessions.map(item => [item.sessionId, item] as const),
    )
    // Mutates the tracker ref only — never inside the `setEndedWithQuestion`
    // updater, which StrictMode double-invokes.
    const ranSince = runningSeenSinceDetectRef.current
    runningSeenSinceDetectRef.current = new Set()
    const raised = detectEndedWithQuestion(
      endedQuestionTrackerRef.current,
      runningSessionIds,
      sessionId => rowById.get(sessionId)?.previewText,
      sessionId => rowById.has(sessionId),
      ranSince,
    )

    setEndedWithQuestion(current => {
      let next: Map<string, string> | null = null
      for (const [sessionId, preview] of raised) {
        if (current.get(sessionId) === preview) continue
        next = next ?? new Map(current)
        next.set(sessionId, preview)
      }
      // A session that started running again has superseded its own question.
      for (const sessionId of current.keys()) {
        if (!runningSessionIds.has(sessionId)) continue
        next = next ?? new Map(current)
        next.delete(sessionId)
      }
      return next ?? current
    })
  }, [runningSessionIds, sessions])

  // What a row needs to be recognised: the title, and the launcher type for
  // the same icon the sidebar row shows.
  const attentionSessions = useMemo(() => {
    const titles = new Map<string, string>()
    const templateTypes = new Map<string, string | undefined>()
    for (const item of allSessionItems) {
      titles.set(item.sessionId, sessionDisplayTitle(item, t))
      templateTypes.set(item.sessionId, item.templateType)
    }
    return { titles, templateTypes }
  }, [allSessionItems, t])

  // Reconcile, then deliver whatever is NEW. Delivery is decided per event by
  // `attentionDelivery`, and only `bar` actually needs the queue - a `focus`
  // event is consumed on the spot, and a `notify` event stays queued precisely
  // because the user is not there to consume it.
  useEffect(() => {
    // A session this channel hides never asks for attention: the bar would
    // offer a switch to a row the sidebar does not have, and the OS
    // notification would name one the user cannot find.
    // An event still derivable keeps its marks; one that has gone away — for
    // longer than a remount's blink — loses them, so the same session asking
    // again is delivered again. `reconcileAttention` owns that lifetime and
    // updates the three refs in place.
    const { queue, added, suppressed } = reconcileAttention(
      attentionQueueRef.current,
      {
        needsInputSessionIds: withoutHidden(needsAnswerSessionIds, hiddenIds),
        // Keyed by session and only ever read for a halted one, so the hidden
        // filter above already scopes it.
        needsInputKeys: needsInputAskKeys,
        endedWithQuestion: withoutHiddenKeys(endedWithQuestion, hiddenIds),
        titles: attentionSessions.titles,
        templateTypes: attentionSessions.templateTypes,
        now: Date.now(),
      },
      {
        acknowledged: acknowledgedAttentionRef.current,
        delivered: deliveredAttentionRef.current,
        absentSince: attentionAbsentSinceRef.current,
        askKeys: attentionAskKeysRef.current,
      },
    )

    // An acknowledged event is never delivered again — but the user may be
    // standing in the very session whose control the arrival could not find
    // (a session evicted from the mount LRU mounts on arrival and renders its
    // card a moment later). Retry that one reveal here, on the same terms as
    // the `focus` route below: it is the reveal that is outstanding, not the
    // notification.
    for (const event of suppressed) {
      if (!windowFocused || event.sessionId !== activeSessionId) continue
      if (deliveredAttentionRef.current.has(event.id)) continue
      if (revealAttentionInSession(event.sessionId)) {
        deliveredAttentionRef.current.add(event.id)
      }
    }

    let result = queue
    for (const event of added) {
      const delivery = attentionDelivery(event, {
        activeSessionId,
        windowFocused,
      })
      const alreadyDelivered = deliveredAttentionRef.current.has(event.id)
      // A route that DELIVERS the event where the user already is also spends
      // it (`deliveryConsumesEvent`). Marked before the branches below so the
      // rule is one line in one place rather than a property of whichever
      // branch happens to run.
      if (deliveryConsumesEvent(delivery)) {
        acknowledgedAttentionRef.current.add(event.id)
      }
      if (delivery === 'focus') {
        // The user is already here, so this never enters the queue — which
        // is why the clearing runs on EVERY pass while the ask is live, but
        // the reveal only on the first that finds the control. The
        // acknowledgement above is what makes the clearing STICK: without it
        // the derived queue re-raised the same event on the next pass and,
        // once the user had moved to another session, announced it there.
        const sessionId = event.sessionId
        result = clearAttentionForSession(result, sessionId)
        if (alreadyDelivered) continue
        if (revealAttentionInSession(sessionId)) {
          deliveredAttentionRef.current.add(event.id)
        }
        continue
      }
      deliveredAttentionRef.current.add(event.id)
      if (delivery === 'notify' && !alreadyDelivered) {
        // Reuse of the existing host surface: `ui.showNotification` is the
        // OS toast the turn-end nudge already uses, and the host suppresses
        // it whenever the window is active - so this cannot double up with
        // the bar even if our own focus read were stale.
        void showHostNotification(hostBridgeTransport, {
          title: t('attention.notificationTitle', { title: event.title }),
          message:
            event.kind === 'needs_input'
              ? t('attention.notificationNeedsInput')
              : (event.detail ?? t('attention.notificationQuestion')),
          notificationType: `session_attention_${event.kind}`,
        })
      }
    }
    publishAttentionQueue(result)
  }, [
    needsAnswerSessionIds,
    needsInputAskKeys,
    endedWithQuestion,
    hiddenIds,
    attentionSessions,
    activeSessionId,
    windowFocused,
    hostBridgeTransport,
    t,
    publishAttentionQueue,
    revealAttentionInSession,
  ])

  // THE clearing rule, and the only one: arriving at a session drops its
  // events. Keyed on (active session, window focus) rather than on the click,
  // so every route in - the bar, the OS notification, the sidebar, a teammate
  // jump, a plain tab switch - clears identically, and none of them has to
  // remember to. The focus half matters: a notification click raises the
  // window and selects the session in either order, and only the second of
  // those two events means the user has actually seen it.
  useEffect(() => {
    if (!activeSessionId || !windowFocused) return
    const before = attentionQueueRef.current
    const next = clearAttentionForSession(before, activeSessionId)
    publishAttentionQueue(next)
    // Arriving at a waiting session reveals its control, whatever the route, and marks its
    // events delivered; if the control is not mounted yet, the marks are dropped so the
    // reconcile retries.
    if (next !== before) {
      const revealed = revealAttentionInSession(activeSessionId)
      for (const event of before) {
        if (event.sessionId !== activeSessionId) continue
        // The visit IS the acknowledgement, whether or not a control was
        // found: the user went where they were sent. Re-raising it the
        // moment they move on is the "it never goes away" defect, and the
        // case where nothing was found is precisely the one that must not
        // be advertised a second time.
        acknowledgedAttentionRef.current.add(event.id)
        if (revealed) deliveredAttentionRef.current.add(event.id)
        else deliveredAttentionRef.current.delete(event.id)
      }
    }
    setEndedWithQuestion(current => {
      if (!current.has(activeSessionId)) return current
      const next = new Map(current)
      next.delete(activeSessionId)
      return next
    })
  }, [
    activeSessionId,
    windowFocused,
    publishAttentionQueue,
    revealAttentionInSession,
  ])

  const handleAttentionSelect = useMemo(
    () => createShellHandleAttentionSelect(activeSessionId, revealAttentionInSession, attentionQueueRef, acknowledgedAttentionRef, publishAttentionQueue, focusSession),
    [
      activeSessionId,
      focusSession,
      publishAttentionQueue,
      revealAttentionInSession,
    ],
  )

  return { attentionQueue, windowFocused, handleAttentionSelect, attentionSessions }
}
