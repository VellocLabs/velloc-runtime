import { describe, expect, it, vi, afterEach } from 'vitest'
import { AgentTurnController } from '../browser/worker/AgentTurnController'
import type { AgentSessionPhase } from '../browser/worker/AgentTurnState'

/**
 * The SessionPhase state machine on AgentTurnController: input is allowed only when `kind === 'idle'`, and a
 * provider-connectivity retry stays `running` (sub `retry`), so the composer stays disabled through the backoff.
 */

function makeController(): AgentTurnController {
  return new AgentTurnController({
    onStateChanged: () => {},
    onTurnReady: () => {},
    onPendingMessageChanged: () => {},
    onPendingMessageCleared: () => {},
  })
}

function phaseOf(c: AgentTurnController): AgentSessionPhase {
  return c.getPhase()
}

afterEach(() => vi.restoreAllMocks())

describe('SessionPhase state machine', () => {
  it('starts idle and enters running/streaming on markStreamStart', () => {
    const c = makeController()
    expect(phaseOf(c)).toEqual({ kind: 'idle' })

    c.markStreamStart()
    expect(phaseOf(c)).toEqual({
      kind: 'running',
      sub: { type: 'streaming' },
    })
  })

  it('markStreamStart is idempotent while already running', () => {
    const c = makeController()
    c.markStreamStart()
    c.markToolStart('Read', 'local')
    // A second markStreamStart must not clobber the tools sub-state.
    c.markStreamStart()
    expect(phaseOf(c)).toEqual({
      kind: 'running',
      sub: { type: 'tools', tools: [{ name: 'Read', kind: 'local' }] },
    })
  })

  it('transitions streaming → tools → streaming as a tool runs and ends', () => {
    const c = makeController()
    c.markStreamStart()

    c.markToolStart('Read', 'local')
    expect(phaseOf(c)).toEqual({
      kind: 'running',
      sub: { type: 'tools', tools: [{ name: 'Read', kind: 'local' }] },
    })

    c.markToolEnd()
    // Stream still active → back to streaming (model generates next).
    expect(phaseOf(c)).toEqual({
      kind: 'running',
      sub: { type: 'streaming' },
    })
  })

  it('returns to idle on markStreamEnd after tools drain', () => {
    const c = makeController()
    c.markStreamStart()
    c.markToolEnd() // no-op (no tools), stays streaming
    c.markStreamEnd()
    expect(phaseOf(c)).toEqual({ kind: 'idle' })
  })

  it('keeps running/tools when the stream ends mid-tool, then idles on last tool end', () => {
    const c = makeController()
    c.markStreamStart()
    c.markToolStart('Sleep', 'local')

    // Stream ends (generator finally) while the tool is still draining.
    c.markStreamEnd()
    expect(phaseOf(c)).toEqual({
      kind: 'running',
      sub: { type: 'tools', tools: [{ name: 'Sleep', kind: 'local' }] },
    })

    // Last tool ends → stream already ended → idle (not streaming).
    c.markToolEnd()
    expect(phaseOf(c)).toEqual({ kind: 'idle' })
  })

  it('stays running/tools until the LAST concurrent tool ends', () => {
    const c = makeController()
    c.markStreamStart()
    c.markToolStart('Grep', 'local')
    c.markToolStart('Read', 'local')

    c.markToolEnd()
    // One tool left → still running/tools.
    expect(phaseOf(c).kind).toBe('running')
    expect((phaseOf(c) as { sub: { type: string } }).sub.type).toBe('tools')

    c.markToolEnd()
    // Last tool → streaming (stream still active).
    expect(phaseOf(c)).toEqual({
      kind: 'running',
      sub: { type: 'streaming' },
    })
  })

  it('enters running/retry on beginRetry and back to streaming on resumeFromRetry', () => {
    const c = makeController()
    c.markStreamStart()

    c.beginRetry({ retryInMs: 10_000, attempt: 1, maxRetries: 10, errorKind: 'timeout' })
    const phase = phaseOf(c)
    expect(phase.kind).toBe('running')
    const sub = (phase as { sub: { type: string; attempt: number } }).sub
    expect(sub.type).toBe('retry')
    expect(sub.attempt).toBe(1)

    // The Worker calls resumeFromRetry on the first stream event
    // of the recovered attempt — the controller itself flips back to
    // streaming (markStreamStart no-ops while running, so nothing else can).
    c.resumeFromRetry()
    expect(phaseOf(c)).toEqual({
      kind: 'running',
      sub: { type: 'streaming' },
    })
  })

  it('carries the error classification key + provider detail on the retry phase', () => {
    const c = makeController()
    c.markStreamStart()
    c.beginRetry({
      retryInMs: 10_000,
      attempt: 3,
      maxRetries: 10,
      errorKind: 'server_error',
      errorTitleKey: 'providerIssue.serviceUnavailable.title',
      errorDetail: 'HTTP 503: upstream connect timeout',
    })
    // Without these the indicator can only show the 'server_error' slug. The
    // KEY travels, not resolved text — this controller runs in the worker,
    // which has no locale.
    const sub = (phaseOf(c) as {
      sub: { errorTitleKey?: string; errorDetail?: string }
    }).sub
    expect(sub.errorTitleKey).toBe('providerIssue.serviceUnavailable.title')
    expect(sub.errorDetail).toBe('HTTP 503: upstream connect timeout')
    c.endRetry()
  })

  it('resumeFromRetry is a no-op outside the retry phase', () => {
    const c = makeController()
    c.markStreamStart()
    c.markToolStart('Read', 'local')
    c.resumeFromRetry()
    expect((phaseOf(c) as { sub: { type: string } }).sub.type).toBe('tools')
  })

  it('retry ticks continue past the deadline while the phase stays retry', () => {
    vi.useFakeTimers()
    try {
      let stateChanges = 0
      const c = new AgentTurnController({
        onStateChanged: () => { stateChanges++ },
        onTurnReady: () => {},
        onPendingMessageChanged: () => {},
        onPendingMessageCleared: () => {},
      })
      c.beginRetry({ retryInMs: 2_500, attempt: 1, maxRetries: 5, errorKind: 'overloaded' })
      const afterBegin = stateChanges // 1 (beginRetry emit)

      // The ticker used to self-clear at the deadline,
      // which froze the indicator at "starting retry N/M" for the whole
      // in-flight attempt. It now ticks for as long as the phase is retry —
      // the publisher turns the post-deadline ticks into a climbing
      // `inFlightSeconds` — so 10s must yield all 10 ticks, not 3.
      vi.advanceTimersByTime(10_000)
      expect(stateChanges).toBe(afterBegin + 10)

      // Countdown expiry is NOT turn end — the phase must still read retry
      // (the composer stays gated until the turn actually settles).
      expect((c.getPhase() as { sub: { type: string } }).sub.type).toBe('retry')

      // endRetry (called from every terminal turn path) stops the ticker.
      c.endRetry()
      vi.advanceTimersByTime(5_000)
      expect(stateChanges).toBe(afterBegin + 10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('endRetry does not clobber a non-retry phase', () => {
    const c = makeController()
    c.markStreamStart()
    c.markToolStart('Read', 'local')
    // No retry started; ending must not touch the tools phase.
    c.endRetry()
    expect(phaseOf(c).kind).toBe('running')
    expect((phaseOf(c) as { sub: { type: string } }).sub.type).toBe('tools')
  })

  it('exposes phase via getPhase for the composer gate', () => {
    const c = makeController()
    c.markStreamStart()
    c.beginRetry({ retryInMs: 10_000, attempt: 2, maxRetries: 10, errorKind: 'timeout' })

    const phase = c.getPhase()
    expect(phase.kind).toBe('running')
    expect((phase as { sub: { type: string } }).sub.type).toBe('retry')
    // Clean up the countdown timer so it doesn't leak past the test.
    c.endRetry()
  })
})

describe('Turn dispatch busy window', () => {
  it('is busy from dequeue — before any stream event — so Stop works during startup', () => {
    let dispatched = 0
    const c = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: () => { dispatched++ }, // hold the turn: no execution yet
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
    })
    void c.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'hi' } },
      'user',
    )
    expect(dispatched).toBe(1)
    // The dequeue→first-stream window (waitForInit, catalog grace) counts
    // as busy: the composer gate holds, task delivery won't flush, and…
    expect(c.isBusy()).toBe(true)
    // …Stop is effective (beginStopping requires isBusy).
    expect(c.beginStopping()).toBe(true)
  })

  it('a user submit during the startup window rides pendingUserMessage, not a second dispatch', () => {
    let dispatched = 0
    const c = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: () => { dispatched++ },
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
    })
    void c.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'first' } },
      'user',
    )
    c.submitUserMessage({ type: 'worker.submitMessage', payload: { prompt: 'second' } })
    expect(dispatched).toBe(1)
    expect(c.getPendingMessage()).toBe('second')
  })
})

describe('Turn completion settlement', () => {
  it('reset resolves the active and queued submitAndWait completions as aborted', async () => {
    const c = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: () => {}, // hold: active turn never settles on its own
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
    })
    const active = c.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'a' } },
      'user',
    )
    const queued = c.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'b' } },
      'task_delivery',
    )
    c.reset('worker_reinitialized')
    await expect(active).resolves.toEqual({
      status: 'aborted',
      reason: 'worker_reinitialized',
    })
    await expect(queued).resolves.toEqual({
      status: 'aborted',
      reason: 'worker_reinitialized',
    })
  })

  it('submitAndWait after dispose resolves aborted immediately (no dangling drive)', async () => {
    const c = makeController()
    c.dispose()
    await expect(
      c.submitAndWait(
        { type: 'worker.submitMessage', payload: { prompt: 'late' } },
        'mailbox',
      ),
    ).resolves.toEqual({ status: 'aborted', reason: 'worker_disposed' })
  })

  it('clearForInterrupt drops queued EXTERNAL turns (Stop must not revive the session)', async () => {
    let dispatched = 0
    const c = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: () => { dispatched++ }, // hold the active turn
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
    })
    // Active user turn + a task-delivery turn already flushed into the queue.
    void c.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'user turn' } },
      'user',
    )
    const delivery = c.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: '<task-notification>' } },
      'task_delivery',
    )

    c.clearForInterrupt()

    await expect(delivery).resolves.toEqual({
      status: 'aborted',
      reason: 'parent_interrupted',
    })
    // The interrupted turn unwinding must find nothing external to pump.
    c.markStreamStart()
    c.markStreamEnd()
    expect(dispatched).toBe(1)
  })
})
