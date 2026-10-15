import { describe, expect, it, vi } from 'vitest'

import {
  ANSWER_HOLD_MS,
  AgentTurnController,
  isSlashCommandPrompt,
  type InjectLandedInfo,
  type InjectMessageEntryView,
  type QueuedTurn,
} from '../browser/worker/AgentTurnController'

/**
 * The inject queue: a plain-Enter submit while the session is busy. It is
 * drained into the RUNNING turn between tool rounds (the query loop calls
 * `drainInjectEntries`), or merged into the next turn at the idle boundary —
 * and it leaves the queue exactly once. Ctrl/Cmd+Enter (`delivery:'next'`,
 * or an older page that omits `delivery`) keeps the next-message strip.
 */

type Recorder = {
  controller: AgentTurnController
  turns: QueuedTurn[]
  injectChanges: InjectMessageEntryView[][]
  landed: InjectLandedInfo[]
  cleared: InjectMessageEntryView[][]
  pending: Array<{ reason: string; extra?: unknown }>
}

function makeRecorder(): Recorder {
  const rec = {
    turns: [],
    injectChanges: [],
    landed: [],
    cleared: [],
    pending: [],
  } as unknown as Recorder
  rec.controller = new AgentTurnController({
    onStateChanged: () => {},
    onTurnReady: turn => rec.turns.push(turn),
    onPendingMessageChanged: (_text, reason, extra) =>
      rec.pending.push({ reason, extra }),
    onPendingMessageCleared: () => {},
    onInjectMessagesChanged: entries => rec.injectChanges.push(entries),
    onInjectMessagesLanded: info => rec.landed.push(info),
    onInjectMessagesCleared: entries => rec.cleared.push(entries),
  })
  return rec
}

function submit(
  prompt: string | Array<Record<string, unknown>>,
  promptUuid: string,
  delivery?: 'inject' | 'next',
  displayPrompt?: string,
) {
  return {
    type: 'worker.submitMessage' as const,
    payload: {
      prompt: prompt as string,
      promptUuid,
      ...(delivery ? { delivery } : {}),
      ...(displayPrompt ? { displayPrompt } : {}),
    },
  }
}

/** Start a turn so the controller is busy. */
function busy(rec: Recorder): void {
  rec.controller.submitUserMessage(submit('first', 'u-first'))
  rec.controller.markStreamStart()
  rec.turns.length = 0
}

/** Finish the running turn at an idle boundary, then settle its execution
 *  (what the worker does when executeSubmit resolves) so the pump can
 *  dispatch whatever the boundary queued. */
function finishTurn(rec: Recorder): void {
  rec.controller.markStreamEnd()
  rec.controller.markExecutionFinished()
}

describe('isSlashCommandPrompt', () => {
  it('detects a leading slash in string and content-array prompts', () => {
    expect(isSlashCommandPrompt('/compact')).toBe(true)
    expect(isSlashCommandPrompt('  /model x')).toBe(true)
    expect(isSlashCommandPrompt('please /compact')).toBe(false)
    expect(
      isSlashCommandPrompt([
        { type: 'image', source: {} },
        { type: 'text', text: '/review' },
      ] as never),
    ).toBe(true)
    expect(isSlashCommandPrompt([{ type: 'image', source: {} }] as never)).toBe(false)
  })
})

describe('AgentTurnController inject queue — submit routing', () => {
  it('a busy plain-Enter submit parks in the inject queue, not the strip', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('steer left', 'u-a', 'inject'))
    expect(rec.injectChanges.at(-1)).toEqual([
      { uuid: 'u-a', text: 'steer left', hasAttachments: false },
    ])
    expect(rec.pending).toHaveLength(0)
    expect(rec.turns).toHaveLength(0)
    expect(rec.controller.getInjectMessageViews()).toHaveLength(1)
  })

  it('a busy slash command with delivery inject goes to the strip instead', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('/compact', 'u-s', 'inject'))
    expect(rec.injectChanges).toHaveLength(0)
    expect(rec.pending.map(p => p.reason)).toEqual(['appended'])
  })

  it('a parked slash command flushes as its own turn, never newline-joined with parked text', () => {
    // Text then slash: joined, "/compact" reached the model as literal text.
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('also update the docs', 'u-text', 'next'))
    rec.controller.submitUserMessage(submit('/compact', 'u-slash', 'inject'))
    finishTurn(rec)
    const dispatched = (r: Recorder) =>
      r.turns.map(t => [t.message.payload.prompt, t.message.payload.promptUuid])
    // The text turn dispatches; the slash turn waits in the queue behind it.
    expect(dispatched(rec)).toEqual([['also update the docs', 'u-text']])
    rec.controller.markStreamStart()
    finishTurn(rec)
    expect(dispatched(rec)).toEqual([
      ['also update the docs', 'u-text'],
      ['/compact', 'u-slash'],
    ])

    // Slash then text: joined, "/compact" ran with the message as junk args.
    const rev = makeRecorder()
    busy(rev)
    rev.controller.submitUserMessage(submit('/compact', 'u-slash', 'inject'))
    rev.controller.submitUserMessage(submit('also update the docs', 'u-text', 'inject'))
    finishTurn(rev)
    rev.controller.markStreamStart()
    finishTurn(rev)
    expect(dispatched(rev)).toEqual([
      ['/compact', 'u-slash'],
      ['also update the docs', 'u-text'],
    ])
    // The inject entry landed as ITS turn, not under the slash command's uuid.
    expect(rev.landed).toEqual([
      { uuids: ['u-text'], via: 'nextturn', turnUuid: 'u-text', text: 'also update the docs' },
    ])
  })

  it('delivery next, and an older page that omits delivery, keep the strip', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('queued', 'u-n', 'next'))
    rec.controller.submitUserMessage(submit('legacy', 'u-l'))
    expect(rec.injectChanges).toHaveLength(0)
    expect(rec.controller.getNextMessageTexts()).toEqual(['queued', 'legacy'])
  })

  it('an idle submit runs immediately whatever its delivery', () => {
    const rec = makeRecorder()
    rec.controller.submitUserMessage(submit('hello', 'u-idle', 'inject'))
    expect(rec.turns.map(t => t.message.payload.promptUuid)).toEqual(['u-idle'])
    expect(rec.injectChanges).toHaveLength(0)
    // The page sent it as mid-turn input (its snapshot still read busy): it is
    // told the message landed as this turn, so its pending bubble goes.
    expect(rec.landed).toEqual([
      { uuids: ['u-idle'], via: 'nextturn', turnUuid: 'u-idle', text: 'hello' },
    ])
  })

  it('an idle submit without delivery inject reports no landing', () => {
    const rec = makeRecorder()
    rec.controller.submitUserMessage(submit('hello', 'u-plain'))
    rec.controller.markExecutionFinished()
    rec.controller.submitUserMessage(submit('/compact', 'u-slash', 'inject'))
    expect(rec.landed).toEqual([])
  })

  it('an attachment send reports hasAttachments and keeps its display label', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(
      submit([{ type: 'image', source: {} }], 'u-img', 'inject', 'shot.png'),
    )
    expect(rec.controller.getInjectMessageViews()).toEqual([
      { uuid: 'u-img', text: 'shot.png', hasAttachments: true },
    ])
  })
})

describe('AgentTurnController — background-task delivery turns', () => {
  const notification =
    '<task-notification>\n<task-id>a1</task-id>\n<task-type>local_agent</task-type>\n' +
    '<status>completed</status>\n<summary>done</summary>\n</task-notification>'

  it('a dispatched delivery turn gets a uuid and is reported landed nextturn with its prompt', () => {
    const rec = makeRecorder()
    rec.controller.enqueueExternalTurn(
      { type: 'worker.submitMessage', payload: { prompt: notification } },
      'task_delivery',
    )
    const uuid = rec.turns[0]?.message.payload.promptUuid
    expect(typeof uuid).toBe('string')
    expect(uuid).not.toBe('')
    expect(rec.landed).toEqual([
      { uuids: [], via: 'nextturn', turnUuid: uuid, text: notification },
    ])
  })

  it('is announced at dispatch, not while it waits behind a running turn', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.enqueueExternalTurn(
      { type: 'worker.submitMessage', payload: { prompt: notification } },
      'task_delivery',
    )
    expect(rec.landed).toEqual([])
    finishTurn(rec)
    expect(rec.turns).toHaveLength(1)
    expect(rec.landed).toEqual([
      expect.objectContaining({ via: 'nextturn', text: notification }),
    ])
  })

  it('mailbox turns and hidden meta turns are not announced', () => {
    const mailbox = makeRecorder()
    mailbox.controller.enqueueExternalTurn(
      { type: 'worker.submitMessage', payload: { prompt: 'frame' } },
      'mailbox',
    )
    const meta = makeRecorder()
    meta.controller.enqueueExternalTurn(
      { type: 'worker.submitMessage', payload: { prompt: notification, isMeta: true } },
      'task_delivery',
    )
    expect(mailbox.turns).toHaveLength(1)
    expect(meta.turns).toHaveLength(1)
    expect(mailbox.landed).toEqual([])
    expect(meta.landed).toEqual([])
  })
})

describe('AgentTurnController — a plugin\'s prompt (F-25 $.prompt.submit)', () => {
  const plugin = { text: 'run the tests', context: ['CTX'], plugin: 'lab' }

  it('runs once the session is idle, as a turn of its own carrying the plugin, after a user turn queued with it', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.enqueuePluginTurn(submit('run the tests', 'u-plugin'), plugin)
    rec.controller.enqueueExternalTurn(submit('typed later', 'u-typed'), 'mailbox')
    expect(rec.turns).toHaveLength(0)
    finishTurn(rec)
    // The mailbox frame (priority 1) goes first; the plugin's turn (2) after.
    expect(rec.turns.map(t => [t.source, t.message.payload.promptUuid])).toEqual([['mailbox', 'u-typed']])
    finishTurn(rec)
    expect(rec.turns.map(t => [t.source, t.message.payload.promptUuid])).toEqual([
      ['mailbox', 'u-typed'],
      ['plugin', 'u-plugin'],
    ])
    expect(rec.turns[1]!.plugin).toEqual(plugin)
  })

  it('is not announced as a delivery', () => {
    const rec = makeRecorder()
    rec.controller.enqueuePluginTurn(submit('run the tests', 'u-plugin'), plugin)
    expect(rec.turns).toHaveLength(1)
    expect(rec.landed).toEqual([])
  })
})

describe('AgentTurnController inject queue — mid-turn drain', () => {
  it('drains every entry in submit order, reports them landed midturn, and empties the queue', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('one', 'u-1', 'inject'))
    rec.controller.submitUserMessage(submit('two', 'u-2', 'inject'))

    const drained = rec.controller.drainInjectEntries()
    expect(drained.map(d => [d.uuid, d.prompt])).toEqual([
      ['u-1', 'one'],
      ['u-2', 'two'],
    ])
    expect(drained[0]!.enqueuedAt).toBeLessThanOrEqual(drained[1]!.enqueuedAt)
    expect(rec.landed).toEqual([{ uuids: ['u-1', 'u-2'], via: 'midturn' }])
    expect(rec.injectChanges.at(-1)).toEqual([])
    expect(rec.controller.drainInjectEntries()).toEqual([])
  })

  it('a drained entry is not removable, not cleared by Stop, and not resubmitted at idle', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('once', 'u-once', 'inject'))
    rec.controller.drainInjectEntries()

    expect(rec.controller.removeInjectEntry('u-once')).toBeNull()
    rec.controller.beginStopping()
    rec.controller.clearForInterrupt()
    expect(rec.cleared).toHaveLength(0)
    rec.controller.finishStopping()
    finishTurn(rec)
    expect(rec.turns).toHaveLength(0)
    expect(rec.landed).toHaveLength(1)
  })

  it('hasInjectEntries peeks the queue without taking it, and is false while Stop unwinds', () => {
    // The Sleep tool's wake signal: true exactly when a drain would return
    // something, and reading it never removes an entry.
    const rec = makeRecorder()
    busy(rec)
    expect(rec.controller.hasInjectEntries()).toBe(false)
    rec.controller.submitUserMessage(submit('wake up', 'u-wake', 'inject'))
    expect(rec.controller.hasInjectEntries()).toBe(true)
    expect(rec.controller.hasInjectEntries()).toBe(true)
    expect(rec.controller.getInjectMessageViews()).toHaveLength(1)

    rec.controller.beginStopping()
    expect(rec.controller.hasInjectEntries()).toBe(false)
    expect(rec.controller.drainInjectEntries()).toEqual([])
    rec.controller.finishStopping()

    expect(rec.controller.hasInjectEntries()).toBe(true)
    rec.controller.drainInjectEntries()
    expect(rec.controller.hasInjectEntries()).toBe(false)
  })

  it('a tool ending mid-turn (not idle) does not consume inject entries', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.markToolStart('Bash', 'local')
    rec.controller.submitUserMessage(submit('wait', 'u-w', 'inject'))
    rec.controller.markToolEnd()
    expect(rec.controller.getInjectMessageViews()).toHaveLength(1)
    expect(rec.turns).toHaveLength(0)
  })
})

describe('AgentTurnController inject queue — no tool round: merged into the next turn', () => {
  it('inject-only entries become one next turn under the first uuid, landed nextturn at the consume', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('a', 'u-a', 'inject'))
    rec.controller.submitUserMessage(submit('b', 'u-b', 'inject'))
    finishTurn(rec)

    expect(rec.turns).toHaveLength(1)
    expect(rec.turns[0]!.message.payload).toMatchObject({ prompt: 'a\nb', promptUuid: 'u-a' })
    expect(rec.landed).toEqual([
      { uuids: ['u-a', 'u-b'], via: 'nextturn', turnUuid: 'u-a', text: 'a\nb' },
    ])
    // No strip entries → no strip 'consumed' event (the WebView keeps the
    // inject bubbles and re-arms from the landed event instead).
    expect(rec.pending).toHaveLength(0)
    expect(rec.injectChanges.at(-1)).toEqual([])
  })

  it('strip and inject entries merge in SUBMIT order, each reported once', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('A', 'u-A', 'next'))
    rec.controller.submitUserMessage(submit('B', 'u-B', 'inject'))
    rec.controller.submitUserMessage(submit('C', 'u-C', 'next'))
    finishTurn(rec)

    expect(rec.turns).toHaveLength(1)
    expect(rec.turns[0]!.message.payload).toMatchObject({ prompt: 'A\nB\nC', promptUuid: 'u-A' })
    expect(rec.pending.map(p => p.reason)).toEqual(['appended', 'appended', 'consumed'])
    expect(rec.landed).toEqual([
      { uuids: ['u-B'], via: 'nextturn', turnUuid: 'u-A', text: 'A\nB\nC' },
    ])
  })

  it('an attachment inject entry is its own turn; every merged turn is reported landed at the consume', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('text first', 'u-t', 'inject'))
    rec.controller.submitUserMessage(
      submit([{ type: 'image', source: {} }], 'u-img', 'inject', 'pic.png'),
    )
    finishTurn(rec)

    // Only the first turn is dispatched; the attachment turn waits in the queue
    // but is already reported landed (a queued user turn survives Stop).
    expect(rec.turns.map(t => t.message.payload.promptUuid)).toEqual(['u-t'])
    expect(rec.landed.map(l => [l.uuids, l.turnUuid, l.text])).toEqual([
      [['u-t'], 'u-t', 'text first'],
      [['u-img'], 'u-img', 'pic.png'],
    ])

    // The first merged turn runs and settles → the attachment turn dispatches,
    // with no second landed report.
    rec.controller.markStreamStart()
    finishTurn(rec)
    expect(rec.turns.map(t => t.message.payload.promptUuid)).toEqual(['u-t', 'u-img'])
    expect(rec.landed).toHaveLength(2)
  })

  it('reports landed BEFORE the list goes empty (drain and consume)', () => {
    const order: string[] = []
    const controller = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: () => {},
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
      onInjectMessagesChanged: entries => order.push(`changed:${entries.length}`),
      onInjectMessagesLanded: info => order.push(`landed:${info.via}`),
    })
    controller.submitUserMessage(submit('first', 'u-first'))
    controller.markStreamStart()
    controller.submitUserMessage(submit('a', 'u-a', 'inject'))
    controller.drainInjectEntries()
    controller.submitUserMessage(submit('b', 'u-b', 'inject'))
    controller.markStreamEnd()
    expect(order).toEqual([
      'changed:1', 'landed:midturn', 'changed:0',
      'changed:1', 'landed:nextturn', 'changed:0',
    ])
  })
})

describe('AgentTurnController — an immediate command typed mid-turn', () => {
  function immediateController(immediate: (prompt: string) => boolean) {
    const ran: string[] = []
    const turns: QueuedTurn[] = []
    const pendingReasons: string[] = []
    const controller = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: turn => turns.push(turn),
      onPendingMessageChanged: (_t, reason) => pendingReasons.push(reason),
      onPendingMessageCleared: () => {},
      runImmediateCommand: message => {
        const prompt = message.payload.prompt as string
        if (!immediate(prompt)) return false
        ran.push(prompt)
        return true
      },
    })
    return { controller, ran, turns, pendingReasons }
  }

  it('runs at once instead of parking in the strip, and takes no turn', () => {
    const { controller, ran, turns, pendingReasons } = immediateController(p => p.startsWith('/diff'))
    controller.submitUserMessage(submit('first', 'u-first'))
    controller.markStreamStart()
    controller.submitUserMessage(submit('/diff', 'u-d', 'inject'))
    expect(ran).toEqual(['/diff'])
    expect(pendingReasons).toEqual([])
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns.map(t => t.message.payload.prompt)).toEqual(['first'])
  })

  it('a command that is not immediate still parks; an idle one runs as a turn, never beside one', () => {
    const { controller, ran, turns, pendingReasons } = immediateController(p => p.startsWith('/diff'))
    controller.submitUserMessage(submit('/diff', 'u-idle'))
    expect(ran).toEqual([])
    expect(turns.map(t => t.message.payload.prompt)).toEqual(['/diff'])
    controller.markStreamStart()
    controller.submitUserMessage(submit('/compact', 'u-c', 'inject'))
    expect(pendingReasons).toEqual(['appended'])
    expect(ran).toEqual([])
  })
})

describe('AgentTurnController parked input — halted on the user', () => {
  it('a turn that ends halted on an unanswered question keeps inject AND strip entries parked', () => {
    // Raised BY the first turn, so it is not set while that turn is dispatched
    // (the dispatch gate would hold a plain turn submitted under a halt).
    let awaiting = false
    const landed: InjectLandedInfo[] = []
    const turns: QueuedTurn[] = []
    const pendingReasons: string[] = []
    const controller = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: turn => turns.push(turn),
      onPendingMessageChanged: (_t, reason) => pendingReasons.push(reason),
      onPendingMessageCleared: () => {},
      onInjectMessagesLanded: info => landed.push(info),
      isAwaitingUser: () => awaiting,
    })
    controller.submitUserMessage(submit('first', 'u-first'))
    controller.markStreamStart()
    turns.length = 0
    controller.submitUserMessage(submit('while running', 'u-inj', 'inject'))
    controller.submitUserMessage(submit('queued', 'u-next', 'next'))

    // The turn ends halted on AskUserQuestion.
    awaiting = true
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns).toHaveLength(0)
    expect(landed).toHaveLength(0)
    expect(controller.getInjectMessageViews()).toHaveLength(1)
    expect(controller.getNextMessageTexts()).toEqual(['queued'])

    // The user answers: the answer runs as its own turn; parked input flushes
    // at that turn's end.
    awaiting = false
    controller.submitUserMessage(submit('answer', 'u-answer'))
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer'])
    controller.markStreamStart()
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer', 'u-inj'])
    expect(landed).toEqual([
      { uuids: ['u-inj'], via: 'nextturn', turnUuid: 'u-inj', text: 'while running\nqueued' },
    ])
    expect(pendingReasons.at(-1)).toBe('consumed')
  })

  // The sources (mailbox, task delivery, routines) each check the halt before
  // they enqueue, but that check and the dispatch are not atomic: a turn
  // enqueued while the ASKING turn still ran reaches the pump after it parked.
  // Seen for real — a teammate report started a lead's next turn 54ms after
  // its AskUserQuestion, the question died, and the composer stayed disabled.
  function haltedController(isAwaiting: () => boolean) {
    const turns: QueuedTurn[] = []
    const controller = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: turn => turns.push(turn),
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
      isAwaitingUser: isAwaiting,
    })
    return { controller, turns }
  }
  const answer = (uuid: string) =>
    submit([{ type: 'tool-result', toolCallId: 'call_ask', result: 'A' }], uuid)

  it('a mailbox / task-delivery turn queued during the asking turn does NOT start underneath the halt', () => {
    let awaiting = false
    const { controller, turns } = haltedController(() => awaiting)
    controller.submitUserMessage(submit('first', 'u-first'))
    controller.markStreamStart()
    turns.length = 0
    controller.enqueueExternalTurn(submit('[message from Reviewer]: done', 'u-mail'), 'mailbox')
    controller.enqueueExternalTurn(submit('<task-notification/>', 'u-task'), 'task_delivery')

    // The turn ends halted on AskUserQuestion.
    awaiting = true
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns).toHaveLength(0)
    // Nor does a later pump, or a turn enqueued while parked.
    controller.enqueueExternalTurn(submit('late', 'u-late'), 'task_delivery')
    controller.pumpSubmits()
    expect(turns).toHaveLength(0)

    // The answer is the one turn the halt admits — past the queued mailbox
    // turn, whatever its priority.
    controller.submitUserMessage(answer('u-answer'))
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer'])

    // The worker clears the halt as the answer's turn starts; the held turns
    // run, in priority order, once it settles.
    awaiting = false
    controller.markStreamStart()
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer', 'u-mail'])
  })

  it('a plain user turn submitted while halted is held, not run', () => {
    const { controller, turns } = haltedController(() => true)
    controller.submitUserMessage(submit('not an answer', 'u-plain'))
    expect(turns).toHaveLength(0)
    controller.submitUserMessage(answer('u-answer'))
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer'])
  })

  it('a plain send under a halt (plan approval keeps the composer enabled) parks in the visible strip and runs after the answer', () => {
    let awaiting = true
    const { controller, turns } = haltedController(() => awaiting)
    controller.submitUserMessage(submit('also handle X', 'u-plain'))
    expect(turns).toHaveLength(0)
    // Visible (and removable) in the strip — not hidden in the dispatch queue.
    expect(controller.getNextMessageTexts()).toEqual(['also handle X'])

    controller.submitUserMessage(answer('u-answer'))
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer'])
    awaiting = false
    controller.markStreamStart()
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer', 'u-plain'])
    expect(controller.getNextMessageTexts()).toEqual([])
  })

  // The plan-approval control clears the halt record BEFORE it submits the
  // answer (resolvePlanApproval: clear → mode → submit, so the control
  // dismisses at once). Between the two messages the gate read "not halted",
  // and a turn held under the halt — a teammate report, a hidden A2UI action —
  // started ahead of the approval: the engine paired the open ExitPlanMode
  // call with a synthetic error, and the approval then landed as a duplicate
  // tool_result. The worker now holds the gate closed on that clear until the
  // answer is dispatched.
  it('a halt cleared ahead of its answer keeps held turns parked until the answer has dispatched', () => {
    let awaiting = false
    const { controller, turns } = haltedController(() => awaiting)
    controller.submitUserMessage(submit('first', 'u-first'))
    controller.markStreamStart()
    turns.length = 0
    controller.enqueueExternalTurn(submit('[message from Reviewer]: done', 'u-mail'), 'mailbox')
    awaiting = true
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns).toHaveLength(0)

    // worker.clearPlanApproval: the record is gone, the answer is on the wire.
    controller.holdForAnswer()
    awaiting = false
    controller.pumpSubmits()
    expect(turns).toHaveLength(0)

    controller.submitUserMessage(answer('u-answer'))
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer'])
    controller.markStreamStart()
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-answer', 'u-mail'])
  })

  it('a halt cleared WITHOUT an answer turn flushes the strip and the held queue', () => {
    // Nothing used to re-run the consume / pump when a halt record went away
    // outside an answer turn: the parked input sat until some unrelated later
    // turn ended.
    let awaiting = true
    const { controller, turns } = haltedController(() => awaiting)
    controller.enqueueExternalTurn(submit('<task-notification/>', 'u-task'), 'task_delivery')
    controller.submitUserMessage(submit('typed under the halt', 'u-typed'))
    expect(turns).toHaveLength(0)
    expect(controller.getNextMessageTexts()).toEqual(['typed under the halt'])

    awaiting = false
    controller.haltCleared()
    // The strip's turn (user, priority 0) outranks the task delivery.
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-typed'])
    expect(controller.getNextMessageTexts()).toEqual([])
    controller.markStreamStart()
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-typed', 'u-task'])
  })

  it('an answer hold whose answer never arrives expires and releases the held turns', () => {
    vi.useFakeTimers()
    try {
      const { controller, turns } = haltedController(() => false)
      controller.enqueueExternalTurn(submit('<task-notification/>', 'u-task'), 'task_delivery')
      turns.length = 0
      controller.markStreamStart()
      controller.markStreamEnd()
      controller.markExecutionFinished()
      turns.length = 0
      controller.holdForAnswer()
      controller.enqueueExternalTurn(submit('late', 'u-late'), 'task_delivery')
      expect(turns).toHaveLength(0)
      vi.advanceTimersByTime(ANSWER_HOLD_MS)
      expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-late'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Stop releases an answer hold', () => {
    const { controller, turns } = haltedController(() => false)
    controller.submitUserMessage(submit('first', 'u-first'))
    controller.markStreamStart()
    turns.length = 0
    controller.holdForAnswer()
    controller.beginStopping()
    controller.clearForInterrupt()
    controller.finishStopping()
    controller.markStreamEnd()
    controller.markExecutionFinished()
    controller.submitUserMessage(submit('after stop', 'u-after'))
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-after'])
  })

  // A read-only built-in (`/status`, `/cost`, …) never starts a model turn
  // and touches no open tool call, so parking it behind an unanswered question
  // hides it for no reason. A `/<skill>` IS a model turn and stays held.
  it('a halt-safe slash command runs under a halt; a skill slash command is held', () => {
    const { controller, turns } = haltedController(() => true)
    controller.submitUserMessage(submit('/status', 'u-status'))
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-status'])
    controller.markStreamStart()
    controller.markStreamEnd()
    controller.markExecutionFinished()
    controller.submitUserMessage(submit('/simplify', 'u-skill'))
    expect(turns.map(t => t.message.payload.promptUuid)).toEqual(['u-status'])
    expect(controller.getNextMessageTexts()).toEqual(['/simplify'])
  })

  // `/compact` under a pending question summarises the open tool_use away, so
  // the answer's tool_result pairs with nothing; `/clear` drops the transcript
  // under a staged plan; `/plan` / `/exit-plan` flip the mode a staged
  // approval decides. All four wait for the answer like any prompt.
  it('/compact, /clear, /plan and /exit-plan are held under a halt', () => {
    const { controller, turns } = haltedController(() => true)
    for (const cmd of ['/compact', '/clear', '/plan', '/exit-plan']) {
      controller.submitUserMessage(submit(cmd, `u-${cmd.slice(1)}`))
    }
    expect(turns).toEqual([])
    expect(controller.getNextMessageTexts()).toEqual(['/compact', '/clear', '/plan', '/exit-plan'])
  })
})

describe('AgentTurnController inject queue — removal, Stop, reset', () => {
  it('removeInjectEntry removes one entry once; a second remove is null (first writer wins)', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('keep', 'u-k', 'inject'))
    rec.controller.submitUserMessage(submit('drop', 'u-d', 'inject'))

    expect(rec.controller.removeInjectEntry('u-d')).toEqual({ text: 'drop' })
    expect(rec.controller.removeInjectEntry('u-d')).toBeNull()
    expect(rec.injectChanges.at(-1)).toEqual([
      { uuid: 'u-k', text: 'keep', hasAttachments: false },
    ])
    finishTurn(rec)
    expect(rec.turns[0]!.message.payload.prompt).toBe('keep')
  })

  it('Stop clears inject entries, hands them back, and nothing is sent afterwards', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('one', 'u-1', 'inject'))
    rec.controller.submitUserMessage(submit('queued', 'u-q', 'next'))

    rec.controller.beginStopping()
    rec.controller.clearForInterrupt()
    expect(rec.cleared).toEqual([[{ uuid: 'u-1', text: 'one', hasAttachments: false }]])
    expect(rec.injectChanges.at(-1)).toEqual([])
    rec.controller.finishStopping()
    finishTurn(rec)
    expect(rec.turns).toHaveLength(0)
    expect(rec.landed).toHaveLength(0)
  })

  it('Enter while Stop unwinds is not drained into the stopped turn; it is sent once as the next turn', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.beginStopping()
    rec.controller.clearForInterrupt()
    // Still running (the turn is unwinding): the page parks this as inject.
    rec.controller.submitUserMessage(submit('after stop', 'u-late', 'inject'))
    expect(rec.controller.getInjectMessageViews()).toHaveLength(1)

    // The unwinding query loop reaches its between-round drain.
    expect(rec.controller.drainInjectEntries()).toEqual([])
    expect(rec.landed).toHaveLength(0)
    expect(rec.controller.getInjectMessageViews()).toHaveLength(1)

    rec.controller.finishStopping()
    finishTurn(rec)
    expect(rec.turns.map(t => t.message.payload.prompt)).toEqual(['after stop'])
    expect(rec.landed).toEqual([
      { uuids: ['u-late'], via: 'nextturn', turnUuid: 'u-late', text: 'after stop' },
    ])
    expect(rec.controller.getInjectMessageViews()).toEqual([])
  })

  it('reset empties the inject queue and reports the empty list', () => {
    const rec = makeRecorder()
    busy(rec)
    rec.controller.submitUserMessage(submit('one', 'u-1', 'inject'))
    rec.controller.reset()
    expect(rec.controller.getInjectMessageViews()).toEqual([])
    expect(rec.injectChanges.at(-1)).toEqual([])
  })
})
