/**
 * Characterization tests for AgentRuntimeWorker's phase machine,
 * submit queue, and pending message behaviors.
 *
 * These tests pin the CURRENT external behavior so the modular refactoring
 * can proceed without regressions. They exercise the public API surface
 * that the SharedWorkerSessionManager and UI depend on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentRuntimeWorker } from '../browser/worker/AgentRuntimeWorker'
import {
  AgentTurnController,
  type QueuedTurn,
} from '../browser/worker/AgentTurnController'
import { AgentWorkerEventRecorder } from './_helpers/AgentWorkerEventRecorder'
import type { AgentWorkerInboundMessage } from '../browser/worker/workerProtocol'

function createWorker(recorder: AgentWorkerEventRecorder): AgentRuntimeWorker {
  return new AgentRuntimeWorker({ emit: recorder.emit })
}

function submitMessage(prompt: string): AgentWorkerInboundMessage {
  return { type: 'worker.submitMessage', payload: { prompt } }
}

describe('AgentRuntimeWorker — phase machine', () => {
  let recorder: AgentWorkerEventRecorder
  let worker: AgentRuntimeWorker

  beforeEach(() => {
    recorder = new AgentWorkerEventRecorder()
    worker = createWorker(recorder)
  })

  it('starts in idle phase', () => {
    expect(worker.isBusy()).toBe(false)
    expect(worker.getPhase()).toEqual({ kind: 'idle' })
  })

  it('markStreamStart transitions idle → running/streaming', () => {
    worker.markStreamStart()
    expect(worker.isBusy()).toBe(true)
    expect(worker.getPhase()).toEqual({
      kind: 'running',
      sub: { type: 'streaming' },
    })
  })

  it('markStreamStart is idempotent when already running', () => {
    worker.markStreamStart()
    worker.markToolStart('Bash', 'local')
    // Stream start during tools should NOT override tools sub-state.
    worker.markStreamStart()
    expect(worker.getPhase()).toEqual({
      kind: 'running',
      sub: { type: 'tools', tools: [{ name: 'Bash', kind: 'local' }] },
    })
  })

  it('markStreamEnd transitions running/streaming → idle', () => {
    worker.markStreamStart()
    worker.markStreamEnd()
    expect(worker.isBusy()).toBe(false)
    expect(worker.getPhase()).toEqual({ kind: 'idle' })
  })

  it('markStreamEnd does NOT transition when tools are in flight', () => {
    worker.markStreamStart()
    worker.markToolStart('Bash', 'local')
    worker.markStreamEnd()
    // Still running because a tool is active.
    expect(worker.isBusy()).toBe(true)
    expect(worker.getPhase()).toEqual({
      kind: 'running',
      sub: { type: 'tools', tools: [{ name: 'Bash', kind: 'local' }] },
    })
  })

  it('markToolStart pushes onto the tool stack', () => {
    worker.markStreamStart()
    worker.markToolStart('Bash', 'local')
    expect(worker.getPhase()).toEqual({
      kind: 'running',
      sub: { type: 'tools', tools: [{ name: 'Bash', kind: 'local' }] },
    })
  })

  it('supports multiple in-flight tools', () => {
    worker.markStreamStart()
    worker.markToolStart('Bash', 'local')
    worker.markToolStart('Read', 'local', 'read')
    expect(worker.getPhase()).toEqual({
      kind: 'running',
      sub: {
        type: 'tools',
        tools: [
          { name: 'Bash', kind: 'local' },
          { name: 'Read', kind: 'local', actionType: 'read' },
        ],
      },
    })
  })

  it('markToolEnd pops one tool, keeps remaining', () => {
    worker.markStreamStart()
    worker.markToolStart('Bash', 'local')
    worker.markToolStart('Read', 'local')
    const ended = worker.markToolEnd()
    expect(ended).toEqual({ name: 'Read', kind: 'local' })
    expect(worker.getPhase()).toEqual({
      kind: 'running',
      sub: { type: 'tools', tools: [{ name: 'Bash', kind: 'local' }] },
    })
  })

  it('last tool end with stream active → streaming', () => {
    worker.markStreamStart()
    worker.markToolStart('Bash', 'local')
    worker.markToolEnd()
    expect(worker.getPhase()).toEqual({
      kind: 'running',
      sub: { type: 'streaming' },
    })
  })

  it('last tool end with stream inactive → idle', () => {
    worker.markStreamStart()
    worker.markToolStart('Bash', 'local')
    worker.markStreamEnd() // stream ends while tool is active
    worker.markToolEnd() // last tool ends → idle
    expect(worker.isBusy()).toBe(false)
    expect(worker.getPhase()).toEqual({ kind: 'idle' })
  })
})

describe('AgentRuntimeWorker — inject messages (plain Enter while busy)', () => {
  let recorder: AgentWorkerEventRecorder
  let worker: AgentRuntimeWorker

  beforeEach(() => {
    recorder = new AgentWorkerEventRecorder()
    worker = createWorker(recorder)
  })

  const inject = (prompt: string, promptUuid: string): AgentWorkerInboundMessage => ({
    type: 'worker.submitMessage',
    payload: { prompt, promptUuid, delivery: 'inject' },
  })

  it('a busy inject submit emits injectMessagesUpdated and rides the snapshot', () => {
    worker.markStreamStart()
    worker.receiveFrame(inject('steer', 'u-steer'))
    expect(recorder.last('worker.injectMessagesUpdated')?.payload.entries).toEqual([
      { uuid: 'u-steer', text: 'steer', hasAttachments: false },
    ])
    expect(recorder.last('worker.pendingMessageUpdated')).toBeUndefined()
    expect(worker.getSnapshot().injectMessages).toEqual([
      { uuid: 'u-steer', text: 'steer', hasAttachments: false },
    ])
  })

  it('the next-message strip entries ride the snapshot too', () => {
    worker.markStreamStart()
    worker.receiveFrame(submitMessage('queued'))
    expect(worker.getSnapshot().nextMessages).toEqual(['queued'])
  })

  it('removeInjectMessage replies ok with the text once, then ok:false', () => {
    worker.markStreamStart()
    worker.receiveFrame(inject('drop me', 'u-drop'))
    recorder.clear()
    worker.receiveFrame({
      type: 'worker.removeInjectMessage',
      payload: { uuid: 'u-drop', requestId: 'r1' },
    })
    expect(recorder.last('worker.injectMessageRemoved')?.payload).toEqual({
      uuid: 'u-drop',
      requestId: 'r1',
      ok: true,
      text: 'drop me',
    })
    expect(recorder.last('worker.injectMessagesUpdated')?.payload.entries).toEqual([])
    worker.receiveFrame({
      type: 'worker.removeInjectMessage',
      payload: { uuid: 'u-drop', requestId: 'r2' },
    })
    expect(recorder.last('worker.injectMessageRemoved')?.payload).toEqual({
      uuid: 'u-drop',
      requestId: 'r2',
      ok: false,
    })
  })

  it('a stale permission ask / confirm entry does not hold parked input at the turn end', () => {
    worker.markStreamStart()
    worker.receiveFrame(inject('steer', 'u-steer'))
    worker.receiveFrame(submitMessage('queued'))
    const real = worker.getSnapshot()
    vi.spyOn(worker, 'getSnapshot').mockReturnValue({
      ...real,
      pendingPermissions: { 'tc-stale': {} as never },
      approvalQueue: [{ toolName: 'Bash', approvalCallId: 'tc-stale' }] as never,
    })
    recorder.clear()
    worker.markStreamEnd()
    expect(recorder.last('worker.injectMessagesLanded')?.payload).toMatchObject({
      uuids: ['u-steer'],
      via: 'nextturn',
    })
    expect(recorder.last('worker.pendingMessageUpdated')?.payload.reason).toBe('consumed')
  })

  it('a turn that ended halted on a question or a plan approval keeps parked input', () => {
    for (const halt of [
      { pendingUserInteraction: { 'tc-q': { toolName: 'AskUserQuestion' } } },
      { pendingPlanApproval: { 'tc-p': {} as never } },
    ]) {
      recorder = new AgentWorkerEventRecorder()
      worker = createWorker(recorder)
      worker.markStreamStart()
      worker.receiveFrame(inject('steer', 'u-steer'))
      // The worker reads the halt records off the engine (not a snapshot), so
      // the halt is staged there: an engine holding only the two records.
      const engine = {
        getPendingUserInteraction: () => halt.pendingUserInteraction ?? {},
        getPendingPlanApproval: () => halt.pendingPlanApproval ?? {},
      }
      const spy = vi
        .spyOn(worker as unknown as { runtime: unknown }, 'runtime', 'get')
        .mockReturnValue({ engine })
      worker.markStreamEnd()
      spy.mockRestore()
      expect(recorder.last('worker.injectMessagesLanded')).toBeUndefined()
      expect(worker.getSnapshot().injectMessages).toHaveLength(1)
    }
  })

  it('Stop emits injectMessagesCleared with the entries', async () => {
    worker.markStreamStart()
    worker.receiveFrame(inject('stopped', 'u-stop'))
    recorder.clear()
    await worker.receiveFrame({ type: 'worker.interrupt', payload: {} })
    expect(recorder.last('worker.injectMessagesCleared')?.payload.entries).toEqual([
      { uuid: 'u-stop', text: 'stopped', hasAttachments: false },
    ])
  })
})

describe('AgentRuntimeWorker — submit queue', () => {
  let recorder: AgentWorkerEventRecorder
  let worker: AgentRuntimeWorker

  beforeEach(() => {
    recorder = new AgentWorkerEventRecorder()
    worker = createWorker(recorder)
  })

  it('busy submit accumulates into pending message', () => {
    worker.markStreamStart()
    worker.receiveFrame(submitMessage('hello'))
    const update = recorder.last('worker.pendingMessageUpdated')
    expect(update?.payload.text).toBe('hello')
    expect(update?.payload.reason).toBe('appended')
  })

  it('multiple pending messages append with newline', () => {
    worker.markStreamStart()
    worker.receiveFrame(submitMessage('first'))
    worker.receiveFrame(submitMessage('second'))
    const update = recorder.last('worker.pendingMessageUpdated')
    expect(update?.payload.text).toBe('first\nsecond')
  })

  it('clearPendingMessage clears and emits', () => {
    worker.markStreamStart()
    worker.receiveFrame(submitMessage('hello'))
    recorder.clear()
    worker.receiveFrame({ type: 'worker.clearPendingMessage', payload: {} })
    expect(recorder.last('worker.pendingMessageCleared')).toBeDefined()
  })

  it('active → idle boundary consumes pending as next turn', () => {
    worker.markStreamStart()
    worker.receiveFrame(submitMessage('queued text'))
    recorder.clear()
    // End the stream → idle boundary triggers consume.
    worker.markStreamEnd()
    // Should emit consumed + empty text.
    const update = recorder.last('worker.pendingMessageUpdated')
    expect(update?.payload.text).toBe('')
    expect(update?.payload.reason).toBe('consumed')
  })

  it('stop clears pending message', async () => {
    worker.markStreamStart()
    worker.receiveFrame(submitMessage('will be cleared'))
    recorder.clear()
    // Interrupt clears pending.
    await worker.receiveFrame({ type: 'worker.interrupt', payload: {} })
    expect(recorder.last('worker.pendingMessageCleared')).toBeDefined()
  })

  it('stop re-entrancy is a no-op', async () => {
    // Not busy → interrupt is a no-op (just emits state).
    recorder.clear()
    await worker.receiveFrame({ type: 'worker.interrupt', payload: {} })
    expect(recorder.types()).toContain('worker.state')
    expect(worker.isStopping()).toBe(false)
  })

  it('stop sets stopping flag when busy', async () => {
    worker.markStreamStart()
    await worker.receiveFrame({ type: 'worker.interrupt', payload: {} })
    expect(worker.isStopping()).toBe(true)
  })

  it('priority ordering: user > mailbox > delivery', async () => {
    // Enqueue in reverse priority order.
    worker.enqueueSubmit(submitMessage('delivery'), 2)
    worker.enqueueSubmit(submitMessage('mailbox'), 1)
    worker.enqueueSubmit(submitMessage('user'), 0)
    // The queue should dispatch user first (lowest number = highest priority).
    // A dispatched turn counts as busy IMMEDIATELY (the
    // dequeue→first-stream window was previously invisible to isBusy).
    expect(worker.isBusy()).toBe(true)
    // No runtime → each executeSubmit fails fast; once all three settle the
    // queue drains back to idle.
    await vi.waitFor(() => {
      expect(worker.isBusy()).toBe(false)
    })
  })

  it('a busy isMeta submit is queued, not shown in the strip', async () => {
    // An A2UI surface action is model-only context (`isMeta`), hidden from the
    // conversation. Flattening it into the pending text both surfaced it in the
    // user-visible strip and dropped `isMeta` on the way back out, turning a
    // hidden prompt into a visible user turn.
    worker.markStreamStart()
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: '[surface] clicked Approve', isMeta: true },
    })
    expect(recorder.last('worker.pendingMessageUpdated')).toBeUndefined()
  })

  it('reports the parked prompt uuids on append', async () => {
    worker.markStreamStart()
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'hello', promptUuid: 'u-1' },
    })
    const update = recorder.last('worker.pendingMessageUpdated')
    expect(update?.payload.promptUuids).toEqual(['u-1'])
  })

  it('reports the parked batch as an entry list, not just the joined text', async () => {
    // Regression: `text` is the entries newline-joined, and the strip counted
    // the queue by splitting it back apart. A submit can be multi-line
    // (Shift+Enter in the composer), so that split over-counted — one 3-line
    // parked message rendered a `[3]` badge. The list is what the UI counts.
    worker.markStreamStart()
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'first line\nsecond line\nthird line' },
    })
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'a later one' },
    })
    const update = recorder.last('worker.pendingMessageUpdated')
    expect(update?.payload.entries).toEqual([
      'first line\nsecond line\nthird line',
      'a later one',
    ])
    // The joined text is unchanged — it still feeds the ×/Stop restore, which
    // wants the whole batch verbatim.
    expect(update?.payload.text).toBe(
      'first line\nsecond line\nthird line\na later one',
    )
  })

  it('an image submit contributes its display label to the entry list', async () => {
    // `pendingEntryTexts` applies the same non-empty filter as the join, so the
    // list and the text never disagree about what is in the batch.
    worker.markStreamStart()
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: {
        prompt: [{ type: 'image', image: 'data:image/png;base64,AQID' }] as never,
        displayPrompt: 'screenshot.png',
      },
    })
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'describe it' },
    })
    const update = recorder.last('worker.pendingMessageUpdated')
    expect(update?.payload.entries).toEqual(['screenshot.png', 'describe it'])
    expect(update?.payload.entries?.join('\n')).toBe(update?.payload.text)
  })

  it('consume names the turn the batch became', async () => {
    worker.markStreamStart()
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'first', promptUuid: 'u-1' },
    })
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'second', promptUuid: 'u-2' },
    })
    recorder.clear()
    worker.markStreamEnd()
    const update = recorder.last('worker.pendingMessageUpdated')
    expect(update?.payload.reason).toBe('consumed')
    expect(update?.payload.text).toBe('')
    // The merged turn carries the FIRST uuid, so the UI's optimistic bubble
    // dedups against the message the turn persists.
    expect(update?.payload.consumed).toEqual({
      text: 'first\nsecond',
      promptUuid: 'u-1',
    })
  })

  it('an image submit parked while busy shows its display label', async () => {
    worker.markStreamStart()
    worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: {
        prompt: [{ type: 'image', image: 'data:image/png;base64,AQID' }] as never,
        promptUuid: 'u-img',
        displayPrompt: 'screenshot.png',
      },
    })
    expect(recorder.last('worker.pendingMessageUpdated')?.payload.text).toBe(
      'screenshot.png',
    )
  })
})

describe('AgentTurnController — pending batch flush', () => {
  function createController() {
    const dispatched: QueuedTurn[] = []
    const pending: Array<{
      text: string
      reason: string
      extra?: {
        promptUuids?: string[]
        entries?: string[]
        consumed?: { text: string; promptUuid?: string }
      }
    }> = []
    const controller = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: turn => {
        dispatched.push(turn)
        // Stand in for executeSubmit settling, in the same order the worker
        // does it (normalizeTurnEndPhase → markExecutionFinished), so the
        // queue keeps draining.
        controller.setPhase({ kind: 'idle' })
        controller.markExecutionFinished()
      },
      onPendingMessageChanged: (text, reason, extra) => {
        pending.push({ text, reason, extra })
      },
      onPendingMessageCleared: () => {},
    })
    return { controller, dispatched, pending }
  }

  function submit(
    payload: Partial<
      Extract<
        AgentWorkerInboundMessage,
        { type: 'worker.submitMessage' }
      >['payload']
    >,
  ): Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }> {
    return {
      type: 'worker.submitMessage',
      payload: { prompt: '', ...payload },
    } as Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>
  }

  it('the merged turn keeps the first submit\'s promptUuid', () => {
    // Regression: the flush built a bare `{prompt}` message, so the auto-run
    // turn persisted under a fresh uuid the UI could not anchor a bubble to —
    // the user's own message was invisible for the whole turn.
    const { controller, dispatched } = createController()
    controller.markStreamStart()
    controller.submitUserMessage(submit({ prompt: 'one', promptUuid: 'u-1' }))
    controller.submitUserMessage(submit({ prompt: 'two', promptUuid: 'u-2' }))
    controller.markStreamEnd()

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.message.payload.prompt).toBe('one\ntwo')
    expect(dispatched[0]!.message.payload.promptUuid).toBe('u-1')
  })

  it('a parked image submit flushes as its own turn, in submit order', () => {
    // Regression: a content-array submit made while busy was enqueued straight
    // into the priority queue with no strip entry and no bubble — invisible
    // until it ran — and it ran BEFORE text submitted earlier (the text was
    // enqueued later, at consume time, so it took a higher sequence).
    const { controller, dispatched } = createController()
    const image = [{ type: 'image', image: 'data:image/png;base64,AQID' }]
    controller.markStreamStart()
    controller.submitUserMessage(submit({ prompt: 'look at this', promptUuid: 'u-1' }))
    controller.submitUserMessage(
      submit({ prompt: image as never, promptUuid: 'u-2', displayPrompt: 'shot.png' }),
    )
    controller.markStreamEnd()

    expect(dispatched.map(t => t.message.payload.promptUuid)).toEqual(['u-1', 'u-2'])
    expect(dispatched[1]!.message.payload.prompt).toBe(image)
  })

  it('an isMeta submit keeps isMeta and stays out of the strip', () => {
    const { controller, dispatched, pending } = createController()
    controller.markStreamStart()
    controller.submitUserMessage(
      submit({ prompt: '[surface] approve', promptUuid: 'u-meta', isMeta: true }),
    )
    expect(pending).toHaveLength(0)

    controller.markStreamEnd()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.message.payload.isMeta).toBe(true)
  })

  it('Stop drops a queued isMeta submit along with the pending batch', () => {
    // `isMeta` submits are queued (not parked) so they keep their flag — but
    // they are context for the turn the user just stopped, not new user input.
    // Leaving them queued let a hidden A2UI action revive the halted session.
    const { controller, dispatched } = createController()
    controller.markStreamStart()
    controller.submitUserMessage(
      submit({ prompt: '[surface] approve', promptUuid: 'u-meta', isMeta: true }),
    )
    controller.submitUserMessage(submit({ prompt: 'typed text', promptUuid: 'u-1' }))
    controller.clearForInterrupt()
    controller.markStreamEnd()

    expect(dispatched).toHaveLength(0)
  })

  it('a plain queued user turn still survives Stop', () => {
    const { controller, dispatched } = createController()
    controller.markStreamStart()
    // Enqueued directly (not parked) — e.g. a submit that landed in the
    // dequeue window. Stop must not eat genuine user input.
    controller.enqueueExternalTurn(
      submit({ prompt: 'mailbox', promptUuid: 'u-mail' }),
      'mailbox',
    )
    controller.submitAndWait(submit({ prompt: 'user', promptUuid: 'u-user' }), 'user')
    controller.clearForInterrupt()
    controller.markStreamEnd()

    expect(dispatched.map(t => t.message.payload.promptUuid)).toEqual(['u-user'])
  })
})

describe('AgentRuntimeWorker — snapshot shape', () => {
  let recorder: AgentWorkerEventRecorder
  let worker: AgentRuntimeWorker

  beforeEach(() => {
    recorder = new AgentWorkerEventRecorder()
    worker = createWorker(recorder)
  })

  it('uninitialized snapshot has expected shape', () => {
    const snapshot = worker.getSnapshot()
    expect(snapshot.initialized).toBe(false)
    expect(snapshot.isBusy).toBe(false)
    expect(snapshot.isStopping).toBe(false)
    expect(snapshot.modelCatalog).toBeNull()
    expect(snapshot.availableModels).toEqual([])
    expect(snapshot.toolNames).toEqual([])
    expect(snapshot.messageCount).toBe(0)
    expect(snapshot.pendingBridgeRequestIds).toEqual([])
  })

  it('snapshot reflects busy state', () => {
    worker.markStreamStart()
    const snapshot = worker.getSnapshot()
    expect(snapshot.isBusy).toBe(true)
    expect(snapshot.isStopping).toBe(false)
  })

  it('snapshot reflects stopping state', async () => {
    worker.markStreamStart()
    await worker.receiveFrame({ type: 'worker.interrupt', payload: {} })
    const snapshot = worker.getSnapshot()
    expect(snapshot.isBusy).toBe(true)
    expect(snapshot.isStopping).toBe(true)
  })
})
