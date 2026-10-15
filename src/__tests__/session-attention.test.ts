// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  ATTENTION_DROP_GRACE_MS,
  attentionDelivery,
  clearAttentionForSession,
  createAttentionMarks,
  deliveryConsumesEvent,
  readsAsQuestion,
  reconcileAttention,
  reconcileAttentionQueue,
  type AttentionEvent,
  type AttentionMarks,
} from '../browser/webview/sessionAttention'
import {
  ATTENTION_SOURCE_ATTR,
  revealAttentionSource,
} from '../browser/webview/attentionSource'

const TITLES = new Map([
  ['s1', 'Auth refactor'],
  ['s2', 'Docs pass'],
  ['s3', 'Migration'],
])
const NO_QUESTIONS = new Map<string, string>()

function reconcile(
  queue: readonly AttentionEvent[],
  needs: string[],
  questions: Array<[string, string]> = [],
  now = 1000,
) {
  return reconcileAttentionQueue(queue, {
    needsInputSessionIds: new Set(needs),
    endedWithQuestion: new Map(questions),
    titles: TITLES,
    now,
  })
}

describe('reconcileAttentionQueue', () => {
  it('raises one event per halted session, carrying its title', () => {
    const { queue, added } = reconcile([], ['s1'])
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({
      sessionId: 's1',
      kind: 'needs_input',
      title: 'Auth refactor',
    })
    // `added` is what the shell delivers — a first appearance is always new.
    expect(added).toEqual(queue)
  })

  it('carries the session launcher type, so the bar shows the sidebar icon', () => {
    const { queue } = reconcileAttentionQueue([], {
      needsInputSessionIds: new Set(['s1']),
      endedWithQuestion: new Map([['s2', 'Bump the minor?']]),
      titles: TITLES,
      templateTypes: new Map([['s1', 'code']]),
      now: 1000,
    })
    expect(queue[0]).toMatchObject({ sessionId: 's1', templateType: 'code' })
    // Unknown → undefined, which the bar renders as the default launcher.
    expect(queue[1]?.templateType).toBeUndefined()
  })

  it('does not stack: the same session halted twice stays one row', () => {
    const first = reconcile([], ['s1'])
    const second = reconcile(first.queue, ['s1'])
    expect(second.queue).toHaveLength(1)
    // Nothing new to deliver — re-delivering would re-notify on every render.
    expect(second.added).toEqual([])
    // Referentially stable, so the bar does not re-render on every tick.
    expect(second.queue).toBe(first.queue)
  })

  it('drops an event once the session is no longer waiting', () => {
    // The ask was answered from inside the session: the input disappears and
    // so must the row, with no teardown path to forget.
    const first = reconcile([], ['s1', 's2'])
    const second = reconcile(first.queue, ['s2'])
    expect(second.queue.map(e => e.sessionId)).toEqual(['s2'])
    expect(second.added).toEqual([])
  })

  it('keeps queue order stable and appends new events at the end', () => {
    const first = reconcile([], ['s1'])
    const second = reconcile(first.queue, ['s1', 's2'], [], 2000)
    const third = reconcile(second.queue, ['s1', 's2', 's3'], [], 3000)
    expect(third.queue.map(e => e.sessionId)).toEqual(['s1', 's2', 's3'])
    // An event the user is reading must not jump position, so createdAt is
    // preserved rather than refreshed.
    expect(third.queue[0]?.createdAt).toBe(1000)
    expect(third.added.map(e => e.sessionId)).toEqual(['s3'])
  })

  it('follows a rename without re-raising the event', () => {
    const first = reconcile([], ['s1'])
    const renamed = reconcileAttentionQueue(first.queue, {
      needsInputSessionIds: new Set(['s1']),
      endedWithQuestion: NO_QUESTIONS,
      titles: new Map([['s1', 'Auth refactor (v2)']]),
      now: 5000,
    })
    expect(renamed.queue[0]?.title).toBe('Auth refactor (v2)')
    expect(renamed.queue[0]?.createdAt).toBe(1000)
    // A rename is not news — re-delivering would fire a second OS toast.
    expect(renamed.added).toEqual([])
  })

  it('raises an ended-with-question event with the question as its detail', () => {
    const { queue } = reconcile([], [], [['s2', 'Should I also bump the minor?']])
    expect(queue[0]).toMatchObject({
      sessionId: 's2',
      kind: 'ended_with_question',
      detail: 'Should I also bump the minor?',
    })
  })

  it('does not double-count a session that is both halted and questioning', () => {
    // The halt is the stronger signal and already sends the user to the same
    // place; two rows for one session would inflate the bar's count.
    const { queue } = reconcile([], ['s1'], [['s1', 'Which one?']])
    expect(queue).toHaveLength(1)
    expect(queue[0]?.kind).toBe('needs_input')
  })

  it('suppresses an acknowledged event instead of queueing it again', () => {
    // THE bug this set exists for: the queue is derived, so clearing it on
    // arrival does not end the event — the very next reconcile re-derives it
    // from the same still-true input and the bar comes back on the next
    // session switch, for ever.
    const first = reconcile([], ['s1'])
    const id = first.queue[0]!.id

    const second = reconcileAttentionQueue([], {
      needsInputSessionIds: new Set(['s1']),
      endedWithQuestion: NO_QUESTIONS,
      titles: TITLES,
      acknowledged: new Set([id]),
      now: 2000,
    })
    expect(second.queue).toEqual([])
    // Not news either: `added` is what gets revealed / toasted.
    expect(second.added).toEqual([])
    // Still reported as live, so the caller keeps the mark (and can retry a
    // reveal for the session the user is standing in).
    expect(second.suppressed.map(e => e.id)).toEqual([id])
  })

  it('takes an acknowledged event OUT of the queue it was already in', () => {
    // The shell acknowledges and clears in one action, but the two must not
    // have to happen in that order for the queue to be right.
    const first = reconcile([], ['s1', 's2'])
    const ackId = first.queue[0]!.id
    const second = reconcileAttentionQueue(first.queue, {
      needsInputSessionIds: new Set(['s1', 's2']),
      endedWithQuestion: NO_QUESTIONS,
      titles: TITLES,
      acknowledged: new Set([ackId]),
      now: 2000,
    })
    expect(second.queue.map(e => e.sessionId)).toEqual(['s2'])
    expect(second.suppressed.map(e => e.sessionId)).toEqual(['s1'])
  })

  it('acknowledges per event, not per session', () => {
    // A session can hold one row of each kind; answering the halt does not
    // mean the user has seen the question its previous turn ended on.
    const { queue } = reconcileAttentionQueue([], {
      needsInputSessionIds: new Set(['s1']),
      endedWithQuestion: new Map([['s2', 'Ready?']]),
      titles: TITLES,
      acknowledged: new Set(['s1:needs_input']),
      now: 1000,
    })
    expect(queue.map(e => e.sessionId)).toEqual(['s2'])
  })

  it('raises an acknowledged event again once the mark is dropped', () => {
    // The mark's lifetime is the event's: the caller prunes it when the id
    // stops being derivable, so the same session asking a SECOND time is news
    // again rather than silently swallowed.
    const suppressedRun = reconcileAttentionQueue([], {
      needsInputSessionIds: new Set(['s1']),
      endedWithQuestion: NO_QUESTIONS,
      titles: TITLES,
      acknowledged: new Set(['s1:needs_input']),
      now: 1000,
    })
    expect(suppressedRun.queue).toEqual([])

    // The ask goes away — nothing derivable, so the caller drops the mark.
    const quiet = reconcile([], [])
    expect(quiet.queue).toEqual([])
    expect(quiet.suppressed).toEqual([])

    // It asks again, with no mark left to suppress it.
    const again = reconcile([], ['s1'], [], 3000)
    expect(again.queue.map(e => e.sessionId)).toEqual(['s1'])
    expect(again.added.map(e => e.sessionId)).toEqual(['s1'])
  })

  it('drops an event for a session it cannot name', () => {
    // A row the user cannot recognise is worse than no row.
    const { queue } = reconcileAttentionQueue([], {
      needsInputSessionIds: new Set(['ghost']),
      endedWithQuestion: NO_QUESTIONS,
      titles: TITLES,
      now: 1,
    })
    expect(queue).toEqual([])
  })
})

describe('reconcileAttention — mark lifetime', () => {
  const ID = 's1:needs_input'

  function step(
    marks: AttentionMarks,
    queue: readonly AttentionEvent[],
    needs: string[],
    now: number,
  ) {
    return reconcileAttention(
      queue,
      {
        needsInputSessionIds: new Set(needs),
        endedWithQuestion: NO_QUESTIONS,
        titles: TITLES,
        now,
      },
      marks,
    )
  }

  it('keeps an acknowledgement across a remount blink of its input', () => {
    // THE bug: a halted session's thread-reported ask reads `false` while its
    // thread unmounts and again on remount until the card re-registers. That
    // blink used to prune the acknowledgement at once, so the next reconcile
    // re-delivered an ask the user had already visited — the bar came back.
    const marks = createAttentionMarks()
    const raised = step(marks, [], ['s1'], 1000)
    expect(raised.added.map(e => e.id)).toEqual([ID])
    // The user visits the session: the shell's arrival rule acknowledges it.
    marks.acknowledged.add(ID)
    const visited = step(marks, [], ['s1'], 1100)
    expect(visited.suppressed.map(e => e.id)).toEqual([ID])

    // Unmount, then the remount's first report — the ask is momentarily gone.
    expect(step(marks, visited.queue, [], 1200).queue).toEqual([])
    expect(step(marks, [], [], 1300).queue).toEqual([])

    // The card registers again: still the same, already-visited ask.
    const back = step(marks, [], ['s1'], 1400)
    expect(back.added).toEqual([])
    expect(back.queue).toEqual([])
    expect(back.suppressed.map(e => e.id)).toEqual([ID])
    expect(marks.acknowledged.has(ID)).toBe(true)
    expect(marks.absentSince.has(ID)).toBe(false)
  })

  it('forgets the mark once the absence outlasts the grace, so asking again is news', () => {
    const marks = createAttentionMarks()
    step(marks, [], ['s1'], 1000)
    marks.acknowledged.add(ID)
    marks.delivered.add(ID)
    step(marks, [], ['s1'], 1100)

    // Answered: the ask is gone. Absence is stamped, the marks still stand.
    step(marks, [], [], 2000)
    expect(marks.absentSince.get(ID)).toBe(2000)
    expect(marks.acknowledged.has(ID)).toBe(true)

    // No reconcile in between: the return itself is the first one to run, and
    // it must see the gap — a mark forgotten only AFTER the reconcile would
    // have suppressed this ask.
    const again = step(marks, [], ['s1'], 2000 + ATTENTION_DROP_GRACE_MS)
    expect(again.added.map(e => e.id)).toEqual([ID])
    expect(again.suppressed).toEqual([])
    expect(marks.acknowledged.has(ID)).toBe(false)
    expect(marks.delivered.has(ID)).toBe(false)
  })

  it('keeps a delivered mark across a blink, so an unacknowledged row returns without re-delivering', () => {
    // A `bar` / `notify` event is delivered but not acknowledged: the blink
    // takes its row out of the queue and puts it back, and the delivered mark
    // is what stops the shell toasting it a second time.
    const marks = createAttentionMarks()
    const raised = step(marks, [], ['s1'], 1000)
    marks.delivered.add(ID)
    const gone = step(marks, raised.queue, [], 1100)
    expect(gone.queue).toEqual([])

    const back = step(marks, gone.queue, ['s1'], 1200)
    expect(back.added.map(e => e.id)).toEqual([ID])
    expect(marks.delivered.has(ID)).toBe(true)
  })

  it('stamps absence only for marked ids', () => {
    const marks = createAttentionMarks()
    step(marks, [], ['s1', 's2'], 1000)
    marks.acknowledged.add(ID)
    step(marks, [], [], 1100)
    expect([...marks.absentSince.keys()]).toEqual([ID])
  })
})

describe('reconcileAttention — a re-ask inside the grace is news', () => {
  const ID = 's1:needs_input'
  const QID = 's1:ended_with_question'

  function step(
    marks: AttentionMarks,
    queue: readonly AttentionEvent[],
    input: {
      needs?: Array<[string, string | undefined]>
      questions?: Array<[string, string]>
    },
    now: number,
  ) {
    const needsInputKeys = new Map<string, string>()
    for (const [sessionId, key] of input.needs ?? []) {
      if (key !== undefined) needsInputKeys.set(sessionId, key)
    }
    return reconcileAttention(
      queue,
      {
        needsInputSessionIds: new Set((input.needs ?? []).map(([id]) => id)),
        needsInputKeys,
        endedWithQuestion: new Map(input.questions ?? []),
        titles: TITLES,
        now,
      },
      marks,
    )
  }

  it('a halt on a NEW ask inside the grace does not inherit the acknowledgement', () => {
    // THE bug: the event id is per (session, kind), so a session that was
    // answered and asked again within ATTENTION_DROP_GRACE_MS came back under
    // the id the user had acknowledged — the mark survived, `absentSince` was
    // cleared, and the new ask was suppressed for as long as it stayed open.
    const marks = createAttentionMarks()
    step(marks, [], { needs: [['s1', 'tool-1']] }, 1000)
    marks.acknowledged.add(ID)
    marks.delivered.add(ID)
    step(marks, [], { needs: [['s1', 'tool-1']] }, 1100)

    // Answered, and asked again 300ms later — well inside the grace.
    step(marks, [], {}, 1200)
    const again = step(marks, [], { needs: [['s1', 'tool-2']] }, 1500)
    expect(again.added.map(e => e.id)).toEqual([ID])
    expect(again.suppressed).toEqual([])
    expect(marks.acknowledged.has(ID)).toBe(false)
    expect(marks.delivered.has(ID)).toBe(false)
  })

  it('a new ask replacing the old one with NO gap at all is news too', () => {
    const marks = createAttentionMarks()
    step(marks, [], { needs: [['s1', 'tool-1']] }, 1000)
    marks.acknowledged.add(ID)
    step(marks, [], { needs: [['s1', 'tool-1']] }, 1100)
    const swapped = step(marks, [], { needs: [['s1', 'tool-2']] }, 1200)
    expect(swapped.added.map(e => e.id)).toEqual([ID])
    expect(marks.acknowledged.has(ID)).toBe(false)
  })

  it('the SAME ask returning inside the grace (a remount blink) keeps its mark', () => {
    const marks = createAttentionMarks()
    step(marks, [], { needs: [['s1', 'tool-1']] }, 1000)
    marks.acknowledged.add(ID)
    const visited = step(marks, [], { needs: [['s1', 'tool-1']] }, 1100)
    step(marks, visited.queue, {}, 1200)
    const back = step(marks, [], { needs: [['s1', 'tool-1']] }, 1300)
    expect(back.added).toEqual([])
    expect(back.suppressed.map(e => e.id)).toEqual([ID])
    expect(marks.acknowledged.has(ID)).toBe(true)
  })

  it('an ask whose identity is unknown on one side keeps the mark — evicted sessions', () => {
    // A session evicted from the mount LRU is still reported halted by the
    // worker summary flag, but its snapshot — and so its ask key — is gone.
    // Losing the key is not a new ask; only a DIFFERENT key is.
    const marks = createAttentionMarks()
    step(marks, [], { needs: [['s1', 'tool-1']] }, 1000)
    marks.acknowledged.add(ID)
    step(marks, [], { needs: [['s1', 'tool-1']] }, 1100)
    const evicted = step(marks, [], { needs: [['s1', undefined]] }, 1200)
    expect(evicted.added).toEqual([])
    expect(marks.acknowledged.has(ID)).toBe(true)
    // Mounted again with the same ask: still acknowledged.
    const mounted = step(marks, [], { needs: [['s1', 'tool-1']] }, 1300)
    expect(mounted.added).toEqual([])
    expect(marks.acknowledged.has(ID)).toBe(true)
  })

  it('a DIFFERENT question inside the grace is news; the same one is not', () => {
    const marks = createAttentionMarks()
    step(marks, [], { questions: [['s1', 'Deploy now?']] }, 1000)
    marks.acknowledged.add(QID)
    const visited = step(marks, [], { questions: [['s1', 'Deploy now?']] }, 1100)
    expect(visited.suppressed.map(e => e.id)).toEqual([QID])

    // Blink: same question back → still acknowledged.
    step(marks, visited.queue, {}, 1200)
    const same = step(marks, [], { questions: [['s1', 'Deploy now?']] }, 1300)
    expect(same.added).toEqual([])
    expect(marks.acknowledged.has(QID)).toBe(true)

    // The next turn ends on another question 200ms later → a new event.
    step(marks, [], {}, 1400)
    const other = step(marks, [], { questions: [['s1', 'Roll back?']] }, 1600)
    expect(other.added.map(e => e.id)).toEqual([QID])
    expect(other.added[0]?.detail).toBe('Roll back?')
    expect(marks.acknowledged.has(QID)).toBe(false)
  })
})

describe('attentionDelivery', () => {
  const event = { sessionId: 's1' }

  it('reveals in place when the user is on that session in a focused window', () => {
    expect(
      attentionDelivery(event, { activeSessionId: 's1', windowFocused: true }),
    ).toBe('focus')
  })

  it('uses the bar when the window is active but the user is elsewhere', () => {
    expect(
      attentionDelivery(event, { activeSessionId: 's2', windowFocused: true }),
    ).toBe('bar')
  })

  it('uses the OS notification whenever the window is not the active surface', () => {
    expect(
      attentionDelivery(event, { activeSessionId: 's2', windowFocused: false }),
    ).toBe('notify')
    // Even for the SELECTED session: which session is selected says nothing
    // about whether a user who is not looking at the window has seen it.
    expect(
      attentionDelivery(event, { activeSessionId: 's1', windowFocused: false }),
    ).toBe('notify')
  })

  it('CONSUMES a focus delivery, and only a focus delivery', () => {
    // The queue's subject is a session the user is NOT at. An event raised at
    // the session they ARE at was already put in front of them in place, so it
    // is spent: leaving it raisable meant the bar waited until they switched
    // away and then announced the session they had just been sitting in.
    expect(deliveryConsumesEvent('focus')).toBe(true)
    // A bar row is spent by VISITING its session, not by being shown; and a
    // notify event is deliberately kept for the user's return, since the toast
    // fired at a window nobody was looking at.
    expect(deliveryConsumesEvent('bar')).toBe(false)
    expect(deliveryConsumesEvent('notify')).toBe(false)
  })

  it('uses the bar when no session is selected at all', () => {
    expect(
      attentionDelivery(event, { activeSessionId: null, windowFocused: true }),
    ).toBe('bar')
  })
})

describe('clearAttentionForSession', () => {
  it('drops every event for the visited session, whatever its kind', () => {
    const { queue } = reconcile([], ['s1', 's2'], [['s3', 'Ready?']])
    const cleared = clearAttentionForSession(queue, 's1')
    expect(cleared.map(e => e.sessionId)).toEqual(['s2', 's3'])
  })

  it('returns the same array when the session has nothing queued', () => {
    const { queue } = reconcile([], ['s1'])
    expect(clearAttentionForSession(queue, 'other')).toBe(queue)
  })
})

describe('readsAsQuestion', () => {
  it('accepts a turn that ENDS on a question mark', () => {
    expect(readsAsQuestion('Should I use the v2 endpoint?')).toBe(true)
    expect(readsAsQuestion('Ready to merge?\n\n')).toBe(true)
    // Trailing markdown / quoting the model tends to append.
    expect(readsAsQuestion('**Shall I continue?**')).toBe(true)
    expect(readsAsQuestion('"Do you want the long form?"')).toBe(true)
    // CJK full-width question mark.
    expect(readsAsQuestion('要继续吗？')).toBe(true)
  })

  it('rejects a turn that merely mentions a question', () => {
    // The queue's value is that every row is worth acting on, so a report
    // ABOUT a question must not raise one.
    expect(readsAsQuestion('I checked whether the flag is set — it is.')).toBe(
      false,
    )
    expect(readsAsQuestion('Answered the question? no, resolved it.')).toBe(
      false,
    )
    expect(readsAsQuestion('Done.')).toBe(false)
    expect(readsAsQuestion('')).toBe(false)
    expect(readsAsQuestion(undefined)).toBe(false)
    expect(readsAsQuestion(null)).toBe(false)
  })
})

describe('revealAttentionSource', () => {
  function fixture(html: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return host
  }

  it('focuses the first actionable control of the LAST pending source', () => {
    // A transcript can hold the remains of earlier asks; the live one is the
    // most recent.
    const host = fixture(`
      <div ${ATTENTION_SOURCE_ATTR}="old"><button id="old-btn">old</button></div>
      <div ${ATTENTION_SOURCE_ATTR}="live"><button id="live-btn">live</button></div>
    `)
    expect(revealAttentionSource(host)).toBe(true)
    expect(document.activeElement?.id).toBe('live-btn')
    host.remove()
  })

  it('skips a disabled control and reports a source with nothing focusable', () => {
    const host = fixture(
      `<div ${ATTENTION_SOURCE_ATTR}="live"><button disabled>busy</button></div>`,
    )
    // Still `true`: a control WAS found and scrolled to, which is what the
    // caller acts on — focusing is best-effort.
    expect(revealAttentionSource(host)).toBe(true)
    host.remove()
  })

  it('reports nothing when the session holds no pending control', () => {
    const host = fixture('<div><button>unrelated</button></div>')
    expect(revealAttentionSource(host)).toBe(false)
    expect(revealAttentionSource(null)).toBe(false)
    expect(revealAttentionSource(undefined)).toBe(false)
    host.remove()
  })
})
