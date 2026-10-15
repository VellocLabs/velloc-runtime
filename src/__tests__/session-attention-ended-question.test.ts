/**
 * `detectEndedWithQuestion`, the "turn ended on a question" edge detector. The stop and the new preview arrive on
 * different feeds in either order, and `running: true`/`false` may fold into one render, so the shell hands the
 * next pass every session a summary reported running (`ranSince`).
 */
import { describe, expect, it } from 'vitest'

import {
  createEndedQuestionTracker,
  detectEndedWithQuestion,
} from '../browser/webview/sessionAttention'

const QUESTION = 'I can do it two ways. Which migration order do you want?'

/** Drive the detector pass by pass, as the shell's effect does. */
function driver(initialPreview: string) {
  const tracker = createEndedQuestionTracker()
  const previews = new Map<string, string>([['s1', initialPreview]])
  let running = new Set<string>()
  const pass = (ranSince: ReadonlySet<string> = new Set()) =>
    detectEndedWithQuestion(
      tracker,
      running,
      id => previews.get(id),
      id => previews.has(id),
      ranSince,
    )
  return {
    setPreview: (text: string) => {
      previews.set('s1', text)
      return pass()
    },
    start: () => {
      running = new Set(['s1'])
      return pass()
    },
    stop: () => {
      running = new Set()
      return pass()
    },
    /** Started AND stopped between two passes (both summaries in one render). */
    blink: () => {
      running = new Set()
      return pass(new Set(['s1']))
    },
    delete: () => {
      previews.delete('s1')
      return pass()
    },
  }
}

describe('detectEndedWithQuestion', () => {
  it('raises when the reply preview arrives AFTER the stop', () => {
    const d = driver('earlier reply.')
    d.setPreview('how should we migrate?') // the user's prompt, shown at send
    d.start()
    expect(d.stop().size).toBe(0) // still the prompt: wait
    expect(d.setPreview(QUESTION)).toEqual(new Map([['s1', QUESTION]]))
  })

  it('raises when the reply preview arrives BEFORE the stop (the bug)', () => {
    const d = driver('earlier reply.')
    d.setPreview('how should we migrate?')
    d.start()
    d.setPreview(QUESTION) // the list feed beat the summary feed
    expect(d.stop()).toEqual(new Map([['s1', QUESTION]]))
  })

  it('never takes the user’s own prompt for the reply', () => {
    const d = driver('')
    d.setPreview('how should we migrate?')
    d.start()
    // The turn ends with the preview still the prompt (no reply text yet):
    // the prompt is the START value, so it is not raised.
    expect(d.stop().size).toBe(0)
  })

  it('does not raise a reply that is not a question', () => {
    const d = driver('earlier reply.')
    d.start()
    d.setPreview('Done — migrated both tables.')
    expect(d.stop().size).toBe(0)
  })

  it('drops a pending stop when the session runs again or is deleted', () => {
    const a = driver('earlier reply.')
    a.start()
    a.stop()
    a.start()
    expect(a.setPreview(QUESTION).size).toBe(0)

    const b = driver('earlier reply.')
    b.start()
    b.stop()
    expect(b.delete().size).toBe(0)
  })

  it('raises nothing for a session that was idle from the start', () => {
    const d = driver(QUESTION)
    expect(d.setPreview(QUESTION).size).toBe(0)
  })

  it('raises when the start and the stop land between two passes', () => {
    const d = driver('')
    d.setPreview('how should we migrate?')
    // `running` never shows s1: the true and false summaries were batched.
    expect(d.blink().size).toBe(0) // still the prompt: wait
    expect(d.setPreview(QUESTION)).toEqual(new Map([['s1', QUESTION]]))
  })

  it('never takes the prompt for the reply when the turn blinked', () => {
    const d = driver('earlier reply.')
    d.setPreview('how should we migrate?')
    expect(d.blink().size).toBe(0)
    // Nothing else arrives: the prompt is still not raised on later passes.
    expect(d.setPreview('how should we migrate?').size).toBe(0)
  })

  it('a blink while already running is not a stop', () => {
    // Still running at this pass: the latch alone does not end the turn.
    const tracker = createEndedQuestionTracker()
    tracker.running = new Set(['s1'])
    const raised = detectEndedWithQuestion(
      tracker,
      new Set(['s1']),
      () => QUESTION,
      () => true,
      new Set(['s1']),
    )
    expect(raised.size).toBe(0)
    expect(tracker.pending.size).toBe(0)
  })
})
