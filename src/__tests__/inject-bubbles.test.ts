import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { convertBrowserRuntimeStateToThreadMessages } from '../browser/webview/assistantUiAdapter'
import {
  BrowserRuntimeClient,
  type BrowserRuntimeClientState,
  type BrowserWorkerClientTransport,
  type InjectBubble,
} from '../browser/webview/BrowserRuntimeClient'
import type {
  AgentRuntimeWorkerSnapshot,
  AgentWorkerInboundMessage,
} from '../browser/worker/workerProtocol'
import {
  applyInjectRestore,
  shouldQueueOnRunningModEnter,
  takeInjectRestoreFiles,
  userMessageOffersCutActions,
} from '../components/assistant-ui/inject-message-context'

/**
 * The page side of mid-turn input: a plain-Enter send while the agent runs
 * shows IN the conversation as a pending bubble pinned at the bottom, lands in
 * place when the worker hands it to the model, and is never duplicated by the
 * transcript / live copy of the same message.
 */

function snapshot(overrides: Partial<AgentRuntimeWorkerSnapshot> = {}): AgentRuntimeWorkerSnapshot {
  return {
    initialized: true,
    sessionId: 'inject-bubbles-test',
    cwd: '/workspace',
    currentProviderId: 'demo',
    activeModelId: 'mock',
    currentSelection: { providerId: 'demo', modelId: 'mock' },
    modelCatalog: null,
    availableModels: ['mock'],
    toolNames: [],
    commandNames: [],
    messageCount: 0,
    isBusy: true,
    isStopping: false,
    pendingBridgeRequestIds: [],
    ...overrides,
  }
}

function fakeWorker(initial = snapshot()) {
  const listeners = new Set<(message: unknown) => void>()
  const posted: AgentWorkerInboundMessage[] = []
  const emit = (message: unknown) => {
    for (const listener of listeners) listener(message)
  }
  const transport: BrowserWorkerClientTransport = {
    async postMessage(message: AgentWorkerInboundMessage) {
      posted.push(message)
      if (message.type === 'worker.init') {
        emit({ type: 'worker.ready', payload: initial })
      }
    },
    addMessageListener(listener) {
      listeners.add(listener as (message: unknown) => void)
      return () => listeners.delete(listener as (message: unknown) => void)
    },
  }
  const client = new BrowserRuntimeClient({
    createWorkerTransport: () => transport,
    hostBridgeTransport: {
      async request(request) {
        return { id: request.id, route: request.route, ok: true, result: {} as never }
      },
    },
    initPayload: { cwd: '/workspace' },
  })
  return { client, emit, posted }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function lastSubmit(posted: AgentWorkerInboundMessage[]) {
  const submits = posted.filter(
    (m): m is Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }> =>
      m.type === 'worker.submitMessage',
  )
  return submits[submits.length - 1]!
}

describe('BrowserRuntimeClient — inject bubbles', () => {
  it('a busy plain-Enter send shows an optimistic pending bubble and posts delivery inject', async () => {
    const { client, posted } = fakeWorker()
    await client.start()
    const sent = client.submitMessage('steer it', undefined, 'inject')
    await sent
    const submit = lastSubmit(posted)
    expect(submit.payload.delivery).toBe('inject')
    expect(client.getState().injectBubbles).toEqual([
      {
        uuid: submit.payload.promptUuid,
        text: 'steer it',
        hasAttachments: false,
        state: 'pending',
        optimistic: true,
      },
    ])
    // Never the idle-send optimistic bubble.
    expect(client.getState().pendingPrompt).toBeNull()
  })

  it('a slash command or a Ctrl+Enter send gets no bubble', async () => {
    const { client, posted } = fakeWorker()
    await client.start()
    await client.submitMessage('/compact', undefined, 'inject')
    await client.submitMessage('later please', undefined, 'next')
    expect(lastSubmit(posted).payload.delivery).toBe('next')
    expect(client.getState().injectBubbles ?? []).toEqual([])
  })

  it('an idle send ignores delivery for the bubble (normal optimistic user bubble)', async () => {
    const { client } = fakeWorker(snapshot({ isBusy: false }))
    await client.start()
    await client.submitMessage('hello', undefined, 'inject')
    expect(client.getState().injectBubbles ?? []).toEqual([])
    expect(client.getState().pendingPrompt).toBe('hello')
  })

  it('the worker list confirms the optimistic bubble and adds another window\'s entries', async () => {
    const { client, emit, posted } = fakeWorker()
    await client.start()
    await client.submitMessage('mine', undefined, 'inject')
    const uuid = lastSubmit(posted).payload.promptUuid!
    emit({
      type: 'worker.injectMessagesUpdated',
      payload: {
        entries: [
          { uuid, text: 'mine', hasAttachments: false },
          { uuid: 'other-window', text: 'theirs', hasAttachments: false },
        ],
      },
    })
    await tick()
    expect(client.getState().injectBubbles?.map(b => [b.uuid, b.state, b.optimistic ?? false])).toEqual([
      [uuid, 'pending', false],
      ['other-window', 'pending', false],
    ])
  })

  it('an optimistic bubble the worker parked in the strip is retracted', async () => {
    const { client, emit, posted } = fakeWorker()
    await client.start()
    await client.submitMessage('went to strip', undefined, 'inject')
    const uuid = lastSubmit(posted).payload.promptUuid!
    emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: 'went to strip', reason: 'appended', promptUuids: [uuid], entries: ['went to strip'] },
    })
    await tick()
    expect(client.getState().injectBubbles).toEqual([])
    expect(client.getState().pendingMessage).toBe('went to strip')
  })

  it('landed midturn survives the emptied list and is pruned once the transcript carries its attachment', async () => {
    const { client, emit } = fakeWorker()
    await client.start()
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [{ uuid: 'u-mid', text: 'mid', hasAttachments: false }] } })
    emit({ type: 'worker.injectMessagesLanded', payload: { uuids: ['u-mid'], via: 'midturn' } })
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [] } })
    await tick()
    expect(client.getState().injectBubbles).toEqual([
      expect.objectContaining({ uuid: 'u-mid', state: 'landed', landedVia: 'midturn' }),
    ])
    emit({
      type: 'worker.messages',
      payload: {
        messages: [
          {
            type: 'attachment',
            uuid: 'att-1',
            attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'mid', source_uuid: 'u-mid' },
          },
        ],
      },
    })
    await tick()
    expect(client.getState().injectBubbles).toEqual([])
  })

  it('landed nextturn (inject only) re-arms the optimistic user bubble for the new turn', async () => {
    const { client, emit } = fakeWorker()
    await client.start()
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [
      { uuid: 'u-a', text: 'a', hasAttachments: false },
      { uuid: 'u-b', text: 'b', hasAttachments: false },
    ] } })
    emit({ type: 'worker.injectMessagesLanded', payload: { uuids: ['u-a', 'u-b'], via: 'nextturn', turnUuid: 'u-a', text: 'a\nb' } })
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [] } })
    await tick()
    expect(client.getState().pendingPrompt).toBe('a\nb')
    expect(client.getState().pendingPromptId).toBe('u-a')
    expect(client.getState().injectBubbles).toEqual([])
  })

  it('a background-task delivery turn renders its notification card while the turn runs', async () => {
    const { client, emit } = fakeWorker()
    await client.start()
    const text =
      '<task-notification>\n<task-id>a1</task-id>\n<task-type>local_agent</task-type>\n' +
      '<status>completed</status>\n<summary>Explore finished</summary>\n</task-notification>'
    emit({ type: 'worker.injectMessagesLanded', payload: { uuids: [], via: 'nextturn', turnUuid: 'u-delivery', text } })
    await tick()
    expect(client.getState().pendingPromptId).toBe('u-delivery')
    const card = convertBrowserRuntimeStateToThreadMessages(client.getState())
      .find(m => m.id === 'u-delivery')
    expect(card).toMatchObject({
      metadata: { custom: { sourceType: 'background_results', backgroundResultKind: 'subagent' } },
    })
  })

  it('a second nextturn landing from the same consume keeps its bubble instead of displacing the armed one', async () => {
    const { client, emit } = fakeWorker()
    await client.start()
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [
      { uuid: 'u-t', text: 'text', hasAttachments: false },
      { uuid: 'u-img', text: 'pic.png', hasAttachments: true },
    ] } })
    emit({ type: 'worker.injectMessagesLanded', payload: { uuids: ['u-t'], via: 'nextturn', turnUuid: 'u-t', text: 'text' } })
    emit({ type: 'worker.injectMessagesLanded', payload: { uuids: ['u-img'], via: 'nextturn', turnUuid: 'u-img', text: 'pic.png' } })
    await tick()
    expect(client.getState().pendingPromptId).toBe('u-t')
    expect(client.getState().injectBubbles).toEqual([
      expect.objectContaining({ uuid: 'u-img', state: 'landed', landedVia: 'nextturn', turnUuid: 'u-img' }),
    ])
  })

  it('a nextturn landing merged with a strip batch widens the already-armed bubble to the merged text', async () => {
    const { client, emit } = fakeWorker()
    await client.start()
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [{ uuid: 'u-inj', text: 'B', hasAttachments: false }] } })
    emit({ type: 'worker.pendingMessageUpdated', payload: { text: '', reason: 'consumed', consumed: { text: 'A', promptUuid: 'u-A' } } })
    emit({ type: 'worker.injectMessagesLanded', payload: { uuids: ['u-inj'], via: 'nextturn', turnUuid: 'u-A', text: 'A\nB' } })
    await tick()
    expect(client.getState().pendingPromptId).toBe('u-A')
    expect(client.getState().pendingPrompt).toBe('A\nB')
    expect(client.getState().injectBubbles).toEqual([])
  })

  it('a nextturn landing for a DIFFERENT turn than the strip batch does not displace the strip\'s armed bubble', async () => {
    const { client, emit } = fakeWorker()
    await client.start()
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [{ uuid: 'u-text', text: 'text', hasAttachments: false }] } })
    emit({ type: 'worker.pendingMessageUpdated', payload: { text: '', reason: 'consumed', consumed: { text: 'pic.png', promptUuid: 'u-strip-img' } } })
    await tick()
    const preSplit = client.getState().preSplitPrompt
    emit({ type: 'worker.injectMessagesLanded', payload: { uuids: ['u-text'], via: 'nextturn', turnUuid: 'u-text', text: 'text' } })
    await tick()
    expect(client.getState().pendingPromptId).toBe('u-strip-img')
    expect(client.getState().pendingPrompt).toBe('pic.png')
    expect(client.getState().preSplitPrompt).toBe(preSplit)
    expect(client.getState().injectBubbles).toEqual([
      expect.objectContaining({ uuid: 'u-text', state: 'landed', landedVia: 'nextturn', turnUuid: 'u-text' }),
    ])
  })

  it('an idle-guessed send the worker parked as inject retracts the optimistic user bubble', async () => {
    const { client, emit, posted } = fakeWorker(snapshot({ isBusy: false }))
    await client.start()
    await client.submitMessage('B', undefined, 'inject')
    const uuid = lastSubmit(posted).payload.promptUuid!
    expect(client.getState().pendingPromptId).toBe(uuid)
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [{ uuid, text: 'B', hasAttachments: false }] } })
    await tick()
    expect(client.getState().pendingPrompt).toBeNull()
    expect(client.getState().pendingPromptId).toBeNull()
    expect(client.getState().injectBubbles).toEqual([
      { uuid, text: 'B', hasAttachments: false, state: 'pending' },
    ])
  })

  it('a busy-guessed send the worker started as a turn swaps the pending bubble for the turn\'s user message', async () => {
    const { client, emit, posted } = fakeWorker()
    await client.start()
    await client.submitMessage('answer me', undefined, 'inject')
    const uuid = lastSubmit(posted).payload.promptUuid!
    emit({ type: 'worker.injectMessagesLanded', payload: { uuids: [uuid], via: 'nextturn', turnUuid: uuid, text: 'answer me' } })
    await tick()
    expect(client.getState().injectBubbles).toEqual([])
    expect(client.getState().pendingPromptId).toBe(uuid)
    expect(client.getState().pendingPrompt).toBe('answer me')
  })

  it('removeInjectMessage hides at once and resolves with the worker verdict (ok, then stale)', async () => {
    const { client, emit, posted } = fakeWorker()
    await client.start()
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [{ uuid: 'u-x', text: 'drop me', hasAttachments: false }] } })
    await tick()

    const first = client.removeInjectMessage('u-x')
    expect(client.getState().injectBubbles?.[0]?.removing).toBe(true)
    const request = posted.find(m => m.type === 'worker.removeInjectMessage') as Extract<
      AgentWorkerInboundMessage,
      { type: 'worker.removeInjectMessage' }
    >
    expect(request.payload.uuid).toBe('u-x')
    emit({ type: 'worker.injectMessageRemoved', payload: { uuid: 'u-x', requestId: request.payload.requestId, ok: true, text: 'drop me' } })
    await expect(first).resolves.toEqual({ ok: true, text: 'drop me' })
    expect(client.getState().injectBubbles).toEqual([])

    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [{ uuid: 'u-y', text: 'landed first', hasAttachments: false }] } })
    await tick()
    const second = client.removeInjectMessage('u-y')
    const request2 = posted.filter(m => m.type === 'worker.removeInjectMessage').pop() as Extract<
      AgentWorkerInboundMessage,
      { type: 'worker.removeInjectMessage' }
    >
    emit({ type: 'worker.injectMessageRemoved', payload: { uuid: 'u-y', requestId: request2.payload.requestId, ok: false } })
    await expect(second).resolves.toEqual({ ok: false })
    expect(client.getState().injectBubbles?.[0]).toMatchObject({ uuid: 'u-y', removing: false })
  })

  it('Stop (injectMessagesCleared) drops the pending bubbles; only the stopping page gets the texts back', async () => {
    const { client, emit } = fakeWorker()
    await client.start()
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [{ uuid: 'u-s', text: 'stop me', hasAttachments: false }] } })
    emit({ type: 'worker.injectMessagesCleared', payload: { entries: [{ uuid: 'u-s', text: 'stop me', hasAttachments: false }] } })
    await tick()
    expect(client.getState().injectBubbles).toEqual([])
    expect(client.getState().injectRestore ?? null).toBeNull()

    await client.interrupt()
    emit({ type: 'worker.injectMessagesUpdated', payload: { entries: [
      { uuid: 'u-1', text: 'one', hasAttachments: false },
      { uuid: 'u-2', text: 'two', hasAttachments: false },
    ] } })
    // The worker drained u-1 into the model before the Stop reached it: only
    // what it actually dropped comes back.
    emit({ type: 'worker.injectMessagesCleared', payload: { entries: [{ uuid: 'u-2', text: 'two', hasAttachments: false }] } })
    await tick()
    expect(client.getState().injectRestore).toEqual({ id: expect.any(String), text: 'two' })

    // Settled: a later Stop from another window restores nothing here.
    emit({ type: 'worker.state', payload: snapshot({ isBusy: false }) })
    emit({ type: 'worker.injectMessagesCleared', payload: { entries: [{ uuid: 'u-3', text: 'three', hasAttachments: false }] } })
    await tick()
    expect(client.getState().injectRestore?.text).toBe('two')
  })

  it('a snapshot restores parked input: pending bubbles and the next-message strip', async () => {
    const { client, emit } = fakeWorker()
    await client.start()
    emit({
      type: 'worker.state',
      payload: snapshot({
        injectMessages: [{ uuid: 'u-r', text: 'restored', hasAttachments: false }],
        nextMessages: ['strip one', 'strip two'],
      }),
    })
    await tick()
    expect(client.getState().injectBubbles).toEqual([
      { uuid: 'u-r', text: 'restored', hasAttachments: false, state: 'pending' },
    ])
    expect(client.getState().pendingMessageEntries).toEqual(['strip one', 'strip two'])
    expect(client.getState().pendingMessage).toBe('strip one\nstrip two')
  })
})

describe('BrowserRuntimeClient — an inject message hands its attachments back', () => {
  // The worker returns a removed / Stop-dropped inject message as its display
  // text only — for an image-only send, the file NAME. The page keeps what it
  // sent, so the composer gets the typed text and the files back instead.

  // The image -> base64 step needs a FileReader; this suite runs in the node
  // environment, so stand one up for these tests.
  const originalFileReader = (globalThis as { FileReader?: unknown }).FileReader
  beforeEach(() => {
    ;(globalThis as { FileReader?: unknown }).FileReader = class {
      result: string | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(): void {
        this.result = 'data:image/png;base64,AQID'
        queueMicrotask(() => this.onload?.())
      }
    }
  })
  afterEach(() => {
    ;(globalThis as { FileReader?: unknown }).FileReader = originalFileReader
  })

  const screenshot = () =>
    new File([new Uint8Array([1, 2, 3])], 'screenshot.png', { type: 'image/png' })
  const imageMessage = (file: File, text: string) =>
    ({
      role: 'user',
      content: text ? [{ type: 'text', text }] : [],
      attachments: [
        {
          id: 'att-1',
          type: 'image',
          name: file.name,
          contentType: file.type,
          file,
          content: [],
          status: { type: 'complete' },
        },
      ],
    }) as never

  it('x on an image-only bubble restores the file, not its name as text', async () => {
    const { client, emit, posted } = fakeWorker()
    await client.start()
    const file = screenshot()
    await client.submitComposerMessage(imageMessage(file, ''), { delivery: 'inject' })
    const uuid = lastSubmit(posted).payload.promptUuid!

    const removed = client.removeInjectMessage(uuid)
    const request = posted.filter(m => m.type === 'worker.removeInjectMessage').pop() as Extract<
      AgentWorkerInboundMessage,
      { type: 'worker.removeInjectMessage' }
    >
    emit({ type: 'worker.injectMessageRemoved', payload: { uuid, requestId: request.payload.requestId, ok: true, text: 'screenshot.png' } })
    await expect(removed).resolves.toEqual({ ok: true, text: '', files: [file] })
  })

  it('Stop hands back the typed text and the files of the dropped message', async () => {
    const { client, emit, posted } = fakeWorker()
    await client.start()
    const file = screenshot()
    await client.submitComposerMessage(imageMessage(file, 'look at this'), { delivery: 'inject' })
    const uuid = lastSubmit(posted).payload.promptUuid!

    await client.interrupt()
    emit({ type: 'worker.injectMessagesCleared', payload: { entries: [{ uuid, text: 'look at this', hasAttachments: true }] } })
    await tick()
    expect(client.getState().injectRestore).toEqual({
      id: expect.any(String),
      text: 'look at this',
      files: [file],
    })
  })
})

function baseState(overrides: Partial<BrowserRuntimeClientState> = {}): BrowserRuntimeClientState {
  return {
    status: 'submitting',
    snapshot: null,
    transcriptMessages: [
      { type: 'user', uuid: 'user-1', timestamp: '2026-09-13T00:00:00.000Z', message: { role: 'user', content: 'start' } },
    ],
    liveEvents: [],
    lastError: null,
    pendingPrompt: null,
    pendingPromptId: null,
    ...overrides,
  } as BrowserRuntimeClientState
}

const assistantEvent = (text: string, uuid?: string) => ({
  type: 'assistant',
  ...(uuid ? { uuid } : {}),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

const bubble = (overrides: Partial<InjectBubble>): InjectBubble => ({
  uuid: 'u-p',
  text: 'pending text',
  hasAttachments: false,
  state: 'pending',
  ...overrides,
})

describe('assistantUiAdapter — inject bubbles', () => {
  it('pins a pending bubble BELOW the running turn and keeps the running assistant id stable', () => {
    const live = [assistantEvent('working on it')] as never
    const without = convertBrowserRuntimeStateToThreadMessages(
      baseState({ liveEvents: live, pendingPrompt: 'start', pendingPromptId: 'user-1' }),
    )
    const withBubble = convertBrowserRuntimeStateToThreadMessages(
      baseState({ liveEvents: live, pendingPrompt: 'start', pendingPromptId: 'user-1', injectBubbles: [bubble({})] }),
    )
    const last = withBubble[withBubble.length - 1]!
    expect(last).toMatchObject({
      id: 'u-p',
      role: 'user',
      content: 'pending text',
      metadata: { custom: { injectState: 'pending', injectUuid: 'u-p' } },
    })
    const runningWithout = without.find(m => m.role === 'assistant')!
    const runningWith = withBubble.find(m => m.role === 'assistant')!
    expect(runningWith.id).toBe(runningWithout.id)
  })

  it('a removing bubble is hidden', () => {
    const converted = convertBrowserRuntimeStateToThreadMessages(
      baseState({ injectBubbles: [bubble({ removing: true })] }),
    )
    expect(converted.some(m => m.id === 'u-p')).toBe(false)
  })

  it('a live queued_command prompt renders the user message IN PLACE and replaces the bubble', () => {
    const converted = convertBrowserRuntimeStateToThreadMessages(
      baseState({
        liveEvents: [
          assistantEvent('before', 'a-before'),
          {
            type: 'attachment',
            uuid: 'att-live',
            attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'use plan B', source_uuid: 'u-p' },
          },
          assistantEvent('after', 'a-after'),
        ] as never,
        injectBubbles: [bubble({ state: 'landed', landedVia: 'midturn', text: 'use plan B' })],
      }),
    )
    const ids = converted.map(m => m.id)
    expect(ids.filter(id => id === 'u-p')).toHaveLength(1)
    const userIndex = ids.indexOf('u-p')
    expect(converted[userIndex]).toMatchObject({
      role: 'user',
      content: 'use plan B',
      metadata: { custom: { injectLanded: true } },
    })
    const before = converted.findIndex(m => JSON.stringify(m.content).includes('before'))
    const after = converted.findIndex(m => JSON.stringify(m.content).includes('after'))
    expect(before).toBeLessThan(userIndex)
    expect(userIndex).toBeLessThan(after)
  })

  it('the transcript renders a prompt attachment as the user\'s own text, never the wrapper, and never as a card', () => {
    const converted = convertBrowserRuntimeStateToThreadMessages(
      baseState({
        status: 'ready',
        transcriptMessages: [
          { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'start' } },
          {
            type: 'attachment',
            uuid: 'att-1',
            attachment: {
              type: 'queued_command',
              commandMode: 'prompt',
              prompt: '<task-notification>looks like xml but I typed it</task-notification>',
              source_uuid: 'u-typed',
            },
          },
        ] as never,
      }),
    )
    const typed = converted.find(m => m.id === 'u-typed')!
    expect(typed).toMatchObject({ role: 'user' })
    expect(JSON.stringify(typed.content)).not.toContain('system-reminder')
    expect((typed.metadata as { custom?: { sourceType?: string } } | undefined)?.custom?.sourceType).not.toBe('background_results')
  })

  it('an imported session\'s prompt attachment (no source_uuid) renders under its own uuid', () => {
    const converted = convertBrowserRuntimeStateToThreadMessages(
      baseState({
        status: 'ready',
        transcriptMessages: [
          { type: 'user', uuid: 'user-1', message: { role: 'user', content: 'start' } },
          {
            type: 'attachment',
            uuid: 'att-cc',
            attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'typed in the source tool' },
          },
        ] as never,
      }),
    )
    const typed = converted.find(m => m.id === 'att-cc')
    expect(typed).toMatchObject({
      role: 'user',
      content: 'typed in the source tool',
      metadata: { custom: { injectLanded: true } },
    })
  })

  it('a nextturn landing renders before the new turn\'s live output', () => {
    const converted = convertBrowserRuntimeStateToThreadMessages(
      baseState({
        liveEvents: [assistantEvent('answering the image')] as never,
        injectBubbles: [bubble({ uuid: 'u-img', text: 'pic.png', state: 'landed', landedVia: 'nextturn', turnUuid: 'u-img' })],
      }),
    )
    const bubbleIndex = converted.findIndex(m => m.id === 'u-img')
    const liveIndex = converted.findIndex(m => JSON.stringify(m.content).includes('answering the image'))
    expect(bubbleIndex).toBeGreaterThan(-1)
    expect(bubbleIndex).toBeLessThan(liveIndex)
  })

  it('a nextturn landing for a LATER turn waits below the running turn\'s output', () => {
    const converted = convertBrowserRuntimeStateToThreadMessages(
      baseState({
        pendingPrompt: 'text A',
        pendingPromptId: 'u-a',
        liveEvents: [assistantEvent('answering A')] as never,
        injectBubbles: [bubble({ uuid: 'u-img', text: 'pic.png', state: 'landed', landedVia: 'nextturn', turnUuid: 'u-img' })],
      }),
    )
    const aIndex = converted.findIndex(m => m.id === 'u-a')
    const liveIndex = converted.findIndex(m => JSON.stringify(m.content).includes('answering A'))
    const bubbleIndex = converted.findIndex(m => m.id === 'u-img')
    expect(aIndex).toBeLessThan(liveIndex)
    expect(liveIndex).toBeLessThan(bubbleIndex)
  })

  it('a bubble whose message the transcript already carries is not duplicated', () => {
    const converted = convertBrowserRuntimeStateToThreadMessages(
      baseState({
        status: 'ready',
        transcriptMessages: [
          { type: 'user', uuid: 'u-p', message: { role: 'user', content: 'pending text' } },
        ] as never,
        injectBubbles: [bubble({ state: 'landed', landedVia: 'nextturn', turnUuid: 'u-p' })],
      }),
    )
    expect(converted.filter(m => m.id === 'u-p')).toHaveLength(1)
  })
})

describe('user row actions on inject rows', () => {
  it('Rewind / Fork are offered only on ordinary user messages', () => {
    expect(userMessageOffersCutActions(undefined)).toBe(true)
    expect(userMessageOffersCutActions({})).toBe(true)
    expect(userMessageOffersCutActions({ injectState: 'pending' })).toBe(false)
    expect(userMessageOffersCutActions({ injectState: 'landed' })).toBe(false)
    expect(userMessageOffersCutActions({ injectLanded: true })).toBe(false)
  })

  it('every inject row the adapter emits (pending, landed from the attachment) hides them', () => {
    const converted = convertBrowserRuntimeStateToThreadMessages(
      baseState({
        liveEvents: [
          {
            type: 'attachment',
            uuid: 'att-live',
            attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'landed', source_uuid: 'u-l' },
          },
        ] as never,
        injectBubbles: [bubble({ uuid: 'u-p', text: 'pending' })],
      }),
    )
    const custom = (id: string) =>
      (converted.find(m => m.id === id)!.metadata as { custom?: unknown } | undefined)?.custom
    expect(userMessageOffersCutActions(custom('u-p'))).toBe(false)
    expect(userMessageOffersCutActions(custom('u-l'))).toBe(false)
  })
})

describe('composer helpers', () => {
  const base = {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    isRunning: true,
    sendBlocked: false,
    hasContent: true,
  }

  it('Ctrl/Cmd+Enter while running queues; everything else does not', () => {
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true })).toBe(true)
    expect(shouldQueueOnRunningModEnter({ ...base, metaKey: true })).toBe(true)
    expect(shouldQueueOnRunningModEnter(base)).toBe(false)
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true, isRunning: false })).toBe(false)
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true, shiftKey: true })).toBe(false)
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true, altKey: true })).toBe(false)
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true, sendBlocked: true })).toBe(false)
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true, hasContent: false })).toBe(false)
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true, isComposing: true })).toBe(false)
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true, defaultPrevented: true })).toBe(false)
    expect(shouldQueueOnRunningModEnter({ ...base, ctrlKey: true, key: 'a' })).toBe(false)
  })

  it('Stop\'s dropped inject texts go before the restored strip batch, once per restore', () => {
    const restore = { id: 'r-1', text: 'one\ntwo' }
    expect(applyInjectRestore('strip', restore)).toBe('one\ntwo\nstrip')
    expect(applyInjectRestore('strip', restore)).toBeNull()
    expect(applyInjectRestore('', { id: 'r-2', text: 'only' })).toBe('only')
    expect(applyInjectRestore('x', null)).toBeNull()
  })

  it('an attachment-only restore leaves the text alone; its files are taken once', () => {
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    const restore = { id: 'r-files', text: '', files: [file] }
    // No stray separator in front of what the user is typing.
    expect(applyInjectRestore('draft', restore)).toBeNull()
    expect(takeInjectRestoreFiles(restore)).toEqual([file])
    expect(takeInjectRestoreFiles(restore)).toEqual([])
    expect(takeInjectRestoreFiles({ id: 'r-none', text: 'x' })).toEqual([])
  })
})
