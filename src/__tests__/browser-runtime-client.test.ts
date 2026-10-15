import { describe, expect, it, vi } from 'vitest'
import type {
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
  AgentRuntimeWorkerSnapshot,
} from '../browser/worker/workerProtocol'
import {
  BrowserRuntimeClient,
  CONTINUE_CONVERSATION_PROMPT,
  RESUME_INTERRUPTED_TOOLS_PROMPT,
  setModelUploadHandler,
  type BrowserWorkerClientTransport,
} from '../browser/webview/BrowserRuntimeClient'
import {
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS,
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES,
} from '../browser/webview/BrowserComposerAttachmentAdapter'

function createSnapshot(): AgentRuntimeWorkerSnapshot {
  return {
    initialized: true,
    sessionId: 'browser-runtime-client-test-session',
    cwd: '/workspace',
    currentProviderId: 'demo',
    activeModelId: 'mock-browser-model',
    currentSelection: {
      providerId: 'demo',
      modelId: 'mock-browser-model',
    },
    modelCatalog: null,
    availableModels: ['mock-browser-model'],
    toolNames: ['select_date'],
    commandNames: [],
    messageCount: 0,
    isBusy: false,
    isStopping: false,
    pendingBridgeRequestIds: [],
  }
}

function createFakeWorkerTransport(
  initialMessages: Array<Record<string, unknown>> = [],
) {
  const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
  let lastSubmittedMessage: AgentWorkerInboundMessage | null = null
  const snapshot = createSnapshot()

  const emit = (message: AgentWorkerOutboundMessage) => {
    for (const listener of listeners) {
      listener(message)
    }
  }

  const transport: BrowserWorkerClientTransport = {
    async postMessage(message: AgentWorkerInboundMessage) {
      switch (message.type) {
        case 'worker.init':
          emit({
            type: 'worker.ready',
            payload: snapshot,
          })
          return

        case 'worker.getMessages':
          emit({
            type: 'worker.messages',
            payload: {
              messages: initialMessages as never[],
            },
          })
          return

        case 'worker.submitMessage':
          lastSubmittedMessage = message
          emit({
            type: 'worker.completed',
            payload: {
              ...snapshot,
              reason: 'submitMessage_complete',
            },
          })
          return

        case 'worker.getState':
          emit({
            type: 'worker.state',
            payload: snapshot,
          })
          return

        case 'worker.getToolCallDetail':
          emit({
            type: 'worker.toolCallDetail',
            payload: {
              toolCallId: message.payload.toolCallId,
              detail: {
                toolCallId: message.payload.toolCallId,
                toolName: 'glic_test_tool',
                args: {
                  note: 'persist me',
                },
                result: {
                  ok: true,
                },
              },
            },
          })
          return

        case 'worker.getSkillBody':
          emit({
            type: 'worker.skillBody',
            payload: {
              name: message.payload.name,
              result: { kind: 'static', body: `# ${message.payload.name}` },
            },
          })
          return

        default:
          return
      }
    },
    addMessageListener(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  return {
    transport,
    getLastSubmittedMessage: () => lastSubmittedMessage,
  }
}

function createBusyCompletionTransport() {
  const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
  let submittedCount = 0
  const baseSnapshot = createSnapshot()

  const emit = (message: AgentWorkerOutboundMessage) => {
    for (const listener of listeners) {
      listener(message)
    }
  }

  const transport: BrowserWorkerClientTransport = {
    async postMessage(message: AgentWorkerInboundMessage) {
      switch (message.type) {
        case 'worker.init':
          emit({
            type: 'worker.ready',
            payload: baseSnapshot,
          })
          return

        case 'worker.getMessages':
          emit({
            type: 'worker.messages',
            payload: {
              messages: [],
            },
          })
          return

        case 'worker.submitMessage':
          submittedCount += 1
          emit({
            type: 'worker.completed',
            payload: {
              ...baseSnapshot,
              isBusy: true,
              reason: 'submitMessage_complete',
            },
          })
          return

        default:
          return
      }
    },
    addMessageListener(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  return {
    transport,
    getSubmittedCount: () => submittedCount,
  }
}

function createSubscriptionToolDetailTransport() {
  const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
  const managerListeners = new Set<(data: unknown) => void>()
  const subscribeCalls: unknown[] = []
  const snapshot = createSnapshot()

  const emit = (message: AgentWorkerOutboundMessage) => {
    for (const listener of listeners) {
      listener(message)
    }
  }

  const pushToolDetailReady = (
    toolCallId: string,
    detail: { toolCallId: string; toolName: string; args: unknown; result: unknown } | null,
  ) => {
    const msg = {
      type: 'toolDetail.ready',
      payload: { toolCallId, detail },
    }
    for (const listener of managerListeners) {
      listener(msg)
    }
  }

  const transport: BrowserWorkerClientTransport = {
    async postMessage(message: AgentWorkerInboundMessage) {
      switch (message.type) {
        case 'worker.init':
          emit({ type: 'worker.ready', payload: snapshot })
          return
        case 'worker.getMessages':
          emit({ type: 'worker.messages', payload: { messages: [] } })
          return
        default:
          return
      }
    },
    addMessageListener(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    postManagerMessage(data: unknown) {
      const msg = data as { type?: string; toolCallIds?: string[] }
      if (msg?.type === 'toolDetail.subscribe') {
        subscribeCalls.push(msg)
        // Simulate the manager finding the sidecar and pushing the
        // detail back to every subscriber — on the same microtask tick
        // so the test doesn't wait on the client's 15 s timeout.
        for (const toolCallId of msg.toolCallIds ?? []) {
          pushToolDetailReady(toolCallId, {
            toolCallId,
            toolName: 'browser_navigate',
            args: { tab_id: 9 },
            result: { ok: true },
          })
        }
      }
    },
    addManagerListener(listener) {
      managerListeners.add(listener)
      return () => managerListeners.delete(listener)
    },
  }

  return {
    transport,
    getSubscribeCalls: () => subscribeCalls,
  }
}

// Simulates a submit that fails AFTER the engine persisted the user
// message: `worker.submitMessage` is answered with `worker.error`
// (worker_submit_failed), and `worker.getMessages` returns the one
// persisted message. Tracks how many times the client asks for messages so
// the test can assert the post-error reconciliation actually happened.
function createSubmitErrorTransport() {
  const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
  // The engine only holds the user message AFTER the (failed) submit — it is
  // persisted as part of the request. Before submit, getMessages is empty.
  // This is what makes the test a real guard: at init the client's
  // requestMessages() returns [], so transcriptMessages only becomes
  // non-empty if the worker.error handler re-fetches (the fix).
  let submitted = false
  let postSubmitGetMessages = 0
  const snapshot = createSnapshot()
  // Minimal persisted-message stand-in — only its presence (length) matters
  // for the assertion. Cast through unknown to the protocol's Message type.
  const persisted = [
    { type: 'user', message: { role: 'user', content: 'hello — will fail' } },
  ] as unknown as Extract<
    AgentWorkerOutboundMessage,
    { type: 'worker.messages' }
  >['payload']['messages']

  const emit = (message: AgentWorkerOutboundMessage) => {
    for (const listener of listeners) {
      listener(message)
    }
  }

  const currentMessages = () => (submitted ? persisted : [])

  const transport: BrowserWorkerClientTransport = {
    async postMessage(message: AgentWorkerInboundMessage) {
      switch (message.type) {
        case 'worker.init':
          emit({ type: 'worker.ready', payload: snapshot })
          return

        case 'worker.submitMessage':
          // Provider rejected the request (e.g. "Stream must be set to
          // true") — the worker's submit catch emits worker.error. No
          // worker.completed, no implicit message broadcast. The user
          // message is now persisted in the engine.
          submitted = true
          emit({
            type: 'worker.error',
            payload: {
              code: 'worker_submit_failed',
              message: 'LLM_ERROR: Stream must be set to true',
            },
          })
          return

        case 'worker.getMessages':
          if (submitted) postSubmitGetMessages += 1
          emit({ type: 'worker.messages', payload: { messages: currentMessages() } })
          return

        case 'worker.getMessagesSince':
          if (submitted) postSubmitGetMessages += 1
          emit({
            type: 'worker.messages',
            payload: {
              messages: currentMessages(),
              sinceOrdinal: message.payload.sinceOrdinal,
            },
          })
          return

        default:
          return
      }
    },
    addMessageListener(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  return {
    transport,
    getPostSubmitGetMessages: () => postSubmitGetMessages,
  }
}

describe('BrowserRuntimeClient', () => {
  it('submits structured tool_result payloads back through worker.submitMessage', async () => {
    const fakeTransport = createFakeWorkerTransport()
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: {
        cwd: '/workspace',
      },
    })

    await client.start()
    await client.submitToolResult({
      toolCallId: 'tool-1',
      toolName: 'select_date',
      result: {
        date: '2026-04-10T00:00:00.000Z',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    const submitted = fakeTransport.getLastSubmittedMessage()
    expect(submitted?.type).toBe('worker.submitMessage')
    if (!submitted || submitted.type !== 'worker.submitMessage') {
      throw new Error('Expected a worker.submitMessage payload.')
    }

    expect(submitted.payload.prompt).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'tool-1',
        result: '{"date":"2026-04-10T00:00:00.000Z"}',
      },
    ])
    expect(client.getState().pendingPrompt).toBeNull()
    expect(client.getState().pendingPromptId).toBeNull()
  })

  it('clears busy state when a completed snapshot is emitted with stale isBusy=true', async () => {
    const fakeTransport = createBusyCompletionTransport()
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: {
        cwd: '/workspace',
      },
    })

    await client.start()
    await client.submitMessage('hello')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fakeTransport.getSubmittedCount()).toBe(1)
    expect(client.getState().status).toBe('ready')
    expect(client.getState().snapshot?.isBusy).toBe(false)
    expect(client.getState().pendingPrompt).toBeNull()
    expect(client.getState().pendingPromptId).toBeNull()
  })

  it('reconciles the transcript after worker.error so an errored turn does not leave the thread empty', async () => {
    // Regression guard for the "model switch after a submit error wedges the
    // conversation in the loading skeleton" bug. The worker.error handler
    // must fetch messages (symmetric with worker.completed) so the persisted
    // user message reaches `transcriptMessages`; otherwise a later fresh
    // snapshot (messageCount > 0) against an empty thread trips the
    // loading-overlay gate in AssistantUiThread.tsx forever.
    const fakeTransport = createSubmitErrorTransport()
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: {
        cwd: '/workspace',
      },
    })

    await client.start()
    // Let the init-time requestMessages() (fired fire-and-forget in start())
    // settle FIRST — it returns [] because nothing is persisted yet. Without
    // this, that fetch races the submit and can land after `submitted` flips
    // true, making the guard timing-dependent.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    await client.submitMessage('hello — will fail')
    // Let the worker.error → requestMessages → worker.messages round-trip
    // settle (a couple of microtask ticks).
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    const state = client.getState()
    expect(state.status).toBe('error')
    expect(state.lastError?.code).toBe('worker_submit_failed')
    // The fix: the client asked the worker for messages AFTER the error
    // (the init-time fetch returned empty because nothing was persisted yet)…
    expect(fakeTransport.getPostSubmitGetMessages()).toBeGreaterThan(0)
    // …and the now-persisted message landed, so the thread is not left empty.
    expect(state.transcriptMessages.length).toBeGreaterThan(0)
  })

  it('preserves the failed turn\'s pendingPrompt and liveEvents so the current turn view does not vanish', async () => {
    // Regression guard: a mid-turn `worker_submit_failed` (e.g. FS_ERROR while
    // writing a file) used to null `pendingPrompt` and let the reconcile
    // `worker.messages` clear `liveEvents` (status !== 'submitting'), which
    // wiped the entire current turn from the thread — the user saw only the
    // previous conversation. The fix keeps both populated while status is
    // 'error' so the partial turn stays visible under the error banner.
    const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
    const snapshot = createSnapshot()
    const persisted = [
      { type: 'user', message: { role: 'user', content: 'do the thing' } },
    ] as unknown as Extract<
      AgentWorkerOutboundMessage,
      { type: 'worker.messages' }
    >['payload']['messages']

    const emit = (message: AgentWorkerOutboundMessage) => {
      for (const listener of listeners) listener(message)
    }

    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        switch (message.type) {
          case 'worker.init':
            emit({ type: 'worker.ready', payload: snapshot })
            return
          case 'worker.submitMessage':
            // A stream event lands first (partial assistant content), THEN the
            // turn fails mid-flight.
            emit({
              type: 'worker.stream',
              payload: { event: { type: 'assistant', message: { role: 'assistant', content: 'partial…' } } } as never,
            })
            emit({
              type: 'worker.error',
              payload: {
                code: 'worker_submit_failed',
                message: 'FS_ERROR: Failed to write file',
              },
            })
            return
          case 'worker.getMessages':
          case 'worker.getMessagesSince':
            emit({ type: 'worker.messages', payload: { messages: persisted } })
            return
          default:
            return
        }
      },
      addMessageListener(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
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

    await client.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    await client.submitMessage('do the thing')
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    const state = client.getState()
    expect(state.status).toBe('error')
    expect(state.lastError?.code).toBe('worker_submit_failed')
    // The failed turn's partial content survives the error + reconcile.
    expect(state.liveEvents.length).toBeGreaterThan(0)
    expect(state.pendingPrompt).toBe('do the thing')
    // And the persisted user message was still reconciled into the transcript.
    expect(state.transcriptMessages.length).toBeGreaterThan(0)
  })

  it('reports submitting status when worker.ready arrives with isBusy=true (LRU re-attach)', async () => {
    // Regression: switching away from a running session (LRU evicts the
    // client), then switching back re-creates the client. The SharedWorker's
    // reuse branch replies `worker.ready` with a live snapshot where
    // isBusy===true. The handler must derive status from isBusy (like
    // `worker.state` does), NOT hardcode 'ready' — otherwise the composer
    // shows as editable for an in-flight turn.
    const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
    const busySnapshot: AgentRuntimeWorkerSnapshot = {
      ...createSnapshot(),
      isBusy: true,
      messageCount: 3,
    }

    const emit = (message: AgentWorkerOutboundMessage) => {
      for (const listener of listeners) listener(message)
    }

    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        switch (message.type) {
          case 'worker.init':
            // Simulates the SharedWorker reuse branch: the worker is still
            // running, so it replies immediately with a busy snapshot.
            emit({ type: 'worker.ready', payload: busySnapshot })
            return
          case 'worker.getMessages':
            emit({ type: 'worker.messages', payload: { messages: [] } })
            return
          default:
            return
        }
      },
      addMessageListener(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
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

    await client.start()

    const state = client.getState()
    expect(state.status).toBe('submitting')
    expect(state.snapshot?.isBusy).toBe(true)
  })

  it('loads a single tool detail through worker.getToolCallDetail', async () => {
    const fakeTransport = createFakeWorkerTransport()
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: {
        cwd: '/workspace',
      },
    })

    await client.start()
    const detail = await client.loadToolCallDetail('tool-1')

    expect(detail).toMatchObject({
      toolCallId: 'tool-1',
      toolName: 'glic_test_tool',
      args: {
        note: 'persist me',
      },
      result: {
        ok: true,
      },
    })
  })

  it('loads a bundled skill body through worker.getSkillBody', async () => {
    const fakeTransport = createFakeWorkerTransport()
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: {
        cwd: '/workspace',
      },
    })

    await client.start()
    const result = await client.loadBundledSkillBody('commit-helper')

    expect(result).toEqual({ kind: 'static', body: '# commit-helper' })
  })

  it('loads a tool detail via toolDetail.subscribe and resolves on the push', async () => {
    const fakeTransport = createSubscriptionToolDetailTransport()
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: {
        cwd: '/workspace',
        sessionId: 'test-session',
      },
    })

    await client.start()
    const detail = await client.loadToolCallDetail('tool-1')

    const subs = fakeTransport.getSubscribeCalls() as Array<{
      type: string
      toolCallIds: string[]
      sessionId?: string
    }>
    expect(subs).toHaveLength(1)
    expect(subs[0]!.toolCallIds).toEqual(['tool-1'])
    expect(subs[0]!.sessionId).toBe('test-session')
    expect(detail).toMatchObject({
      toolCallId: 'tool-1',
      toolName: 'browser_navigate',
      args: { tab_id: 9 },
      result: { ok: true },
    })
  })
})

describe('BrowserRuntimeClient pending message (next message)', () => {
  function createPendingTransport() {
    const listeners = new Set<(message: unknown) => void>()
    const posted: AgentWorkerInboundMessage[] = []
    const snapshot = createSnapshot()
    const emit = (message: unknown) => {
      for (const listener of listeners) {
        listener(message)
      }
    }
    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        posted.push(message)
        if (message.type === 'worker.init') {
          emit({ type: 'worker.ready', payload: snapshot })
        }
      },
      addMessageListener(listener) {
        listeners.add(listener as (message: unknown) => void)
        return () => {
          listeners.delete(listener as (message: unknown) => void)
        }
      },
    }
    return { transport, emit, posted }
  }

  function createClient(fake: ReturnType<typeof createPendingTransport>) {
    return new BrowserRuntimeClient({
      createWorkerTransport: () => fake.transport,
      hostBridgeTransport: {
        async request(request) {
          return { id: request.id, route: request.route, ok: true, result: {} as never }
        },
      },
      initPayload: { cwd: '/workspace' },
    })
  }

  it('stores the full pending text on worker.pendingMessageUpdated and clears it on empty text', async () => {
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: 'update the README', reason: 'appended' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBe('update the README')

    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: '', reason: 'consumed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBeNull()
  })

  it('clearPendingMessage hides the strip optimistically, marks the clear in-flight, and posts worker.clearPendingMessage', async () => {
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: 'to clear', reason: 'appended' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBe('to clear')

    client.clearPendingMessage()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBeNull()
    expect(client.getState().pendingClearInFlight).toBe(true)
    expect(
      fake.posted.some(m => m.type === 'worker.clearPendingMessage'),
    ).toBe(true)
  })

  it('ignores stale pendingMessageUpdated events while a clear is in flight, then re-arms on worker.pendingMessageCleared', async () => {
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: 'old text', reason: 'appended' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    client.clearPendingMessage()
    await new Promise(resolve => setTimeout(resolve, 0))

    // A stale append (queued before the manager saw our clear) must NOT
    // re-flash the strip.
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: 'old text\nand more', reason: 'appended' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBeNull()
    expect(client.getState().pendingClearInFlight).toBe(true)

    // The manager's clear confirmation resets the in-flight flag.
    fake.emit({ type: 'worker.pendingMessageCleared' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBeNull()
    expect(client.getState().pendingClearInFlight).toBe(false)

    // After confirmation, new updates flow through again.
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: 'fresh text', reason: 'appended' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBe('fresh text')
  })

  it('does NOT flash an optimistic conversation bubble for a submit made while the session is busy', async () => {
    // Regression: a busy-session submit is routed by the manager into the
    // session's "next message" strip, NOT into the conversation. Setting
    // pendingPrompt here used to render a bogus user bubble ahead of the live
    // tool UI (and wedge the assistant-id anchor). The strip
    // (worker.pendingMessageUpdated) is the only visible surface while busy.
    const listeners = new Set<(message: unknown) => void>()
    const busySnapshot = { ...createSnapshot(), isBusy: true }
    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        if (message.type === 'worker.init') {
          for (const l of listeners) l({ type: 'worker.ready', payload: busySnapshot })
        }
      },
      addMessageListener(listener) {
        listeners.add(listener as (message: unknown) => void)
        return () => {
          listeners.delete(listener as (message: unknown) => void)
        }
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
    await client.start()
    expect(client.getState().snapshot?.isBusy).toBe(true)

    void client.submitMessage('queued follow-up')
    // Synchronous read (submitInput sets state before its yield): a busy
    // submit must NOT flash an optimistic conversation bubble.
    expect(client.getState().pendingPrompt).toBeNull()
    expect(client.getState().pendingPromptId).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('STILL flashes the optimistic bubble for an idle-session submit', async () => {
    // The idle path must keep its optimistic bubble — only the busy path is
    // suppressed. A silent transport (init replies ready, submit replies
    // NOTHING) keeps the just-started turn live, so the idle-submitted bubble
    // is still present after the submit resolves.
    const listeners = new Set<(message: unknown) => void>()
    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        if (message.type === 'worker.init') {
          for (const l of listeners) l({ type: 'worker.ready', payload: createSnapshot() })
        }
        // submitMessage → no reply: the turn stays live, bubble persists.
      },
      addMessageListener(listener) {
        listeners.add(listener as (message: unknown) => void)
        return () => {
          listeners.delete(listener as (message: unknown) => void)
        }
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
    await client.start()
    expect(client.getState().snapshot?.isBusy).toBe(false)

    await client.submitMessage('hello')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingPrompt).toBe('hello')
  })

  it('preserves liveEvents on a busy submit so the running turn does not truncate', async () => {
    // Regression: `submitInput` cleared `liveEvents` unconditionally. While the
    // session is busy the submit goes to the next-message strip and the running
    // turn keeps streaming — but the transcript is not refetched until turn
    // end, so wiping the live events deleted everything the turn had rendered
    // so far. Only a submit that actually STARTS a turn may reset the stream.
    const listeners = new Set<(message: unknown) => void>()
    const busySnapshot = { ...createSnapshot(), isBusy: true }
    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        if (message.type === 'worker.init') {
          for (const l of listeners) l({ type: 'worker.ready', payload: busySnapshot })
        }
      },
      addMessageListener(listener) {
        listeners.add(listener as (message: unknown) => void)
        return () => {
          listeners.delete(listener as (message: unknown) => void)
        }
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
    await client.start()

    // The running turn has streamed some content.
    for (const l of listeners) {
      l({
        type: 'worker.stream',
        payload: { event: { type: 'assistant', uuid: 'a-1' } },
      })
    }
    expect(client.getState().liveEvents).toHaveLength(1)

    void client.submitMessage('type while it works')
    expect(client.getState().liveEvents).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().liveEvents).toHaveLength(1)
  })

  it('preserves the RUNNING turn\'s optimistic bubble when a busy submit is parked', async () => {
    // Same class of bug as the liveEvents wipe: the busy branch wrote
    // `pendingPrompt: null`, which belongs to the turn already in flight — its
    // user message is rendered from that bubble alone until the transcript is
    // refetched at turn end, so typing ahead made it disappear.
    const listeners = new Set<(message: unknown) => void>()
    let isBusy = false
    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        if (message.type === 'worker.init') {
          for (const l of listeners) {
            l({ type: 'worker.ready', payload: { ...createSnapshot(), isBusy } })
          }
        }
      },
      addMessageListener(listener) {
        listeners.add(listener as (message: unknown) => void)
        return () => {
          listeners.delete(listener as (message: unknown) => void)
        }
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
    await client.start()

    // Turn one starts while idle → it owns the optimistic bubble.
    await client.submitMessage('the running turn')
    await new Promise(resolve => setTimeout(resolve, 0))
    const runningId = client.getState().pendingPromptId
    expect(client.getState().pendingPrompt).toBe('the running turn')

    // The session is now busy; a second submit is parked by the worker.
    isBusy = true
    for (const l of listeners) {
      l({ type: 'worker.state', payload: { ...createSnapshot(), isBusy: true } })
    }
    void client.submitMessage('typed while it works')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(client.getState().pendingPrompt).toBe('the running turn')
    expect(client.getState().pendingPromptId).toBe(runningId)
  })

  it('drops the optimistic bubble once the transcript carries it, whatever the status', async () => {
    // `pendingPrompt !== null` feeds the composer's busy gate, so a bubble that
    // outlives its own turn wedges the composer in the running state. Once the
    // persisted message has arrived the bubble has no job left — clear it
    // rather than waiting for a status transition that may never come (e.g. a
    // re-armed next-message bubble whose broadcast lost the race with the
    // reconcile that persisted the turn).
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    await client.submitMessage('persisted already')
    await new Promise(resolve => setTimeout(resolve, 0))
    const uuid = client.getState().pendingPromptId
    expect(uuid).not.toBeNull()
    // Still 'submitting' — the old rule would have kept the bubble forever.
    expect(client.getState().status).toBe('submitting')

    fake.emit({
      type: 'worker.messages',
      payload: {
        messages: [
          { type: 'user', uuid, message: { role: 'user', content: 'persisted already' } },
        ] as never,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingPrompt).toBeNull()
    expect(client.getState().pendingPromptId).toBeNull()
  })

  it('does not re-arm a consumed bubble the transcript already carries', async () => {
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    fake.emit({
      type: 'worker.messages',
      payload: {
        messages: [
          {
            type: 'user',
            uuid: 'uuid-late',
            message: { role: 'user', content: 'already ran' },
          },
        ] as never,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    // The consume broadcast lands AFTER the turn it describes was persisted.
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: '',
        reason: 'consumed',
        consumed: { text: 'already ran', promptUuid: 'uuid-late' },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingPrompt).toBeNull()
    expect(client.getState().pendingPromptId).toBeNull()
  })

  it('keeps the worker’s pending entry list beside the joined text', async () => {
    // The strip counts the queue from the list: `text` is the entries joined
    // with newlines, and a submit can itself be multi-line, so splitting the
    // text back apart over-counted. The list must survive the wire AND be
    // dropped in lockstep with the text on consume — a stale list would
    // outlive the strip it describes.
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: 'do this\nand that\nthen ship it',
        reason: 'appended',
        entries: ['do this\nand that', 'then ship it'],
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBe('do this\nand that\nthen ship it')
    expect(client.getState().pendingMessageEntries).toEqual([
      'do this\nand that',
      'then ship it',
    ])

    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: '', reason: 'consumed' },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBeNull()
    expect(client.getState().pendingMessageEntries).toBeNull()
  })

  it('drops the pending entry list when the manager confirms a clear', async () => {
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: 'one\ntwo', reason: 'appended', entries: ['one', 'two'] },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessageEntries).toEqual(['one', 'two'])

    // The × path hides the strip optimistically, before the manager answers.
    client.clearPendingMessage()
    expect(client.getState().pendingMessageEntries).toBeNull()

    fake.emit({ type: 'worker.pendingMessageCleared', payload: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessageEntries).toBeNull()
    expect(client.getState().pendingClearInFlight).toBe(false)
  })

  it('re-arms the optimistic bubble when the worker consumes the pending batch', async () => {
    // The consumed batch becomes a real turn whose user message is persisted
    // but never streamed back, and the transcript is not refetched until that
    // turn ends — so without this the user's own message was invisible for the
    // whole turn. The uuid is the one the turn persists under, so the bubble
    // dedups against the transcript exactly like a normal send.
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: 'and also fix the tests',
        reason: 'appended',
        promptUuids: ['uuid-next'],
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().pendingMessage).toBe('and also fix the tests')

    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: '',
        reason: 'consumed',
        consumed: { text: 'and also fix the tests', promptUuid: 'uuid-next' },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const state = client.getState()
    expect(state.pendingMessage).toBeNull()
    expect(state.pendingPrompt).toBe('and also fix the tests')
    expect(state.pendingPromptId).toBe('uuid-next')
  })

  it('splits liveEvents at the consume boundary and drops the pre-split half once a reconcile lands', async () => {
    // The consume fires at the previous turn's boundary, while that turn's
    // stream (its tool cards) is still the only render of the turn. Without
    // the split the re-armed bubble rendered BEFORE those events — the
    // picked-up message jumped above the tool block it followed.
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    // Two stream events belonging to the finishing turn.
    fake.emit({
      type: 'worker.stream',
      payload: { event: { type: 'stream_event', event: { type: 'ping' } } },
    })
    fake.emit({
      type: 'worker.stream',
      payload: { event: { type: 'stream_event', event: { type: 'ping' } } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().liveEvents).toHaveLength(2)

    // The worker consumes the parked batch → bubble re-armed, split recorded.
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: '',
        reason: 'consumed',
        consumed: { text: 'queued while tools ran', promptUuid: 'uuid-queued' },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().liveEventsTurnStart).toBe(2)

    // The consumed turn starts streaming its own events after the split.
    fake.emit({
      type: 'worker.stream',
      payload: { event: { type: 'stream_event', event: { type: 'ping', turn: 'next' } } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().liveEvents).toHaveLength(3)

    // The reconcile lands while the consumed turn is live ('submitting'):
    // pre-split events are persisted by construction, so they are dropped
    // (or they'd render twice), the split resets, and the bubble is released
    // because the transcript now carries its uuid.
    fake.emit({
      type: 'worker.messages',
      payload: {
        messages: [
          {
            type: 'user',
            uuid: 'uuid-queued',
            message: { role: 'user', content: 'queued while tools ran' },
          },
        ] as never,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const state = client.getState()
    expect(state.status).toBe('submitting')
    expect(state.liveEvents).toHaveLength(1)
    expect(
      (state.liveEvents[0] as { event?: { turn?: string } }).event?.turn,
    ).toBe('next')
    expect(state.liveEventsTurnStart).toBe(0)
    expect(state.pendingPrompt).toBeNull()
    expect(state.pendingPromptId).toBeNull()
  })

  it('worker.streamGap drops only the current turn\'s live events, keeps the bubble, and the refetch renders the turn', async () => {
    // The seam emits it when the stream topic recovered from a gap: a
    // stream with a hole cannot be rebuilt, so the current turn's partial
    // events go; the finished turn's pre-split events still wait for their
    // reconcile, and the optimistic bubble stays until the transcript has it.
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()
    const ping = (turn: string) =>
      fake.emit({
        type: 'worker.stream',
        payload: { event: { type: 'stream_event', event: { type: 'ping', turn } } },
      })
    ping('previous')
    ping('previous')
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: '',
        reason: 'consumed',
        consumed: { text: 'queued while tools ran', promptUuid: 'uuid-queued' },
      },
    })
    ping('current')
    ping('current')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getState().liveEvents).toHaveLength(4)
    expect(client.getState().liveEventsTurnStart).toBe(2)

    fake.emit({ type: 'worker.streamGap' })
    await new Promise(resolve => setTimeout(resolve, 0))
    let state = client.getState()
    expect(
      state.liveEvents.map(e => (e as { event?: { turn?: string } }).event?.turn),
    ).toEqual(['previous', 'previous'])
    expect(state.liveEventsTurnStart).toBe(2)
    expect(state.status).toBe('submitting')
    expect(state.pendingPrompt).toBe('queued while tools ran')
    expect(state.pendingPromptId).toBe('uuid-queued')

    // The refetch the seam sends alongside lands: the turn renders from the
    // transcript, and nothing of the holed stream comes back.
    fake.emit({
      type: 'worker.messages',
      payload: {
        messages: [
          { type: 'user', uuid: 'uuid-queued', message: { role: 'user', content: 'queued while tools ran' } },
          { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: 'persisted so far' } },
        ] as never,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    state = client.getState()
    expect(state.transcriptMessages.map(m => (m as { uuid?: string }).uuid)).toEqual(['uuid-queued', 'a-1'])
    expect(state.liveEvents).toEqual([])
    expect(state.pendingPrompt).toBeNull()
  })

  it('promotes the finished turn\'s bubble to the pre-split slot at the consume, and the reconcile clears it', async () => {
    // At the consume the previous turn's own optimistic bubble may still be
    // the ONLY render of its user message (its reconcile hasn't landed).
    // Overwriting the single pendingPrompt slot made that message vanish and
    // reshaped every thread index — which could crash the thread mid-render
    // (assistant-ui `tapClientLookup: Index N out of bounds` →
    // ThreadErrorBoundary). The consume must instead promote it, so the
    // thread transition is a pure append.
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    // The running turn's own bubble (snapshot idle → bubble flashes).
    await client.submitMessage('first question')
    await new Promise(resolve => setTimeout(resolve, 0))
    const firstId = client.getState().pendingPromptId
    expect(client.getState().pendingPrompt).toBe('first question')
    expect(firstId).not.toBeNull()

    // Its stream is on screen when the parked batch is consumed.
    fake.emit({
      type: 'worker.stream',
      payload: { event: { type: 'stream_event', event: { type: 'ping' } } },
    })
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: '',
        reason: 'consumed',
        consumed: { text: 'queued while tools ran', promptUuid: 'uuid-queued' },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    let state = client.getState()
    expect(state.pendingPrompt).toBe('queued while tools ran')
    expect(state.pendingPromptId).toBe('uuid-queued')
    expect(state.preSplitPrompt).toBe('first question')
    expect(state.preSplitPromptId).toBe(firstId)

    // Any reconcile arriving after the consume carries the persisted copy
    // (it has been in the engine's list since the turn started) — the
    // optimistic pre-split copy drops with the pre-split events.
    fake.emit({
      type: 'worker.messages',
      payload: {
        messages: [
          {
            type: 'user',
            uuid: firstId,
            message: { role: 'user', content: 'first question' },
          },
          {
            type: 'user',
            uuid: 'uuid-queued',
            message: { role: 'user', content: 'queued while tools ran' },
          },
        ] as never,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    state = client.getState()
    expect(state.preSplitPrompt).toBeNull()
    expect(state.preSplitPromptId).toBeNull()
  })

  it('retracts an optimistic bubble the worker reports as parked', async () => {
    // `submitInput` decides whether to flash a bubble from `snapshot.isBusy`,
    // which lags the worker by a postMessage. When it guesses wrong the same
    // text renders twice (bubble + strip); the worker names the parked uuids,
    // so the bubble is retracted and the strip stays the single surface.
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    // Snapshot still says idle → the client flashes a bubble.
    await client.submitMessage('raced submit')
    await new Promise(resolve => setTimeout(resolve, 0))
    const optimisticId = client.getState().pendingPromptId
    expect(client.getState().pendingPrompt).toBe('raced submit')
    expect(optimisticId).not.toBeNull()

    // …but the worker was busy and parked it.
    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: 'raced submit',
        reason: 'appended',
        promptUuids: [optimisticId!],
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const state = client.getState()
    expect(state.pendingMessage).toBe('raced submit')
    expect(state.pendingPrompt).toBeNull()
    expect(state.pendingPromptId).toBeNull()
  })

  it('keeps the bubble of a DIFFERENT in-flight turn when an unrelated submit is parked', async () => {
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    await client.submitMessage('the running turn')
    await new Promise(resolve => setTimeout(resolve, 0))
    const runningId = client.getState().pendingPromptId

    fake.emit({
      type: 'worker.pendingMessageUpdated',
      payload: {
        text: 'a later message',
        reason: 'appended',
        promptUuids: ['some-other-uuid'],
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const state = client.getState()
    expect(state.pendingPrompt).toBe('the running turn')
    expect(state.pendingPromptId).toBe(runningId)
  })

  it('sends displayPrompt so an image-only send has a next-message label', async () => {
    // An image-only send carries no text in `prompt`; without a display label
    // it sat in the pending batch with nothing to render, so the send looked
    // like it had been dropped.
    const fake = createPendingTransport()
    const client = createClient(fake)
    await client.start()

    // The image → base64 step needs a FileReader; this suite runs in the node
    // environment, so stand one up for the duration of the test.
    const originalFileReader = (globalThis as { FileReader?: unknown }).FileReader
    ;(globalThis as { FileReader?: unknown }).FileReader = class {
      result: string | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(): void {
        this.result = 'data:image/png;base64,AQID'
        queueMicrotask(() => this.onload?.())
      }
    }

    await client.submitComposerMessage({
      role: 'user',
      content: [],
      attachments: [
        {
          id: 'att-1',
          type: 'image',
          name: 'screenshot.png',
          contentType: 'image/png',
          file: new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
            type: 'image/png',
          }),
          content: [],
          status: { type: 'complete' },
        },
      ],
    } as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    ;(globalThis as { FileReader?: unknown }).FileReader = originalFileReader

    const submit = fake.posted.find(m => m.type === 'worker.submitMessage')
    expect(submit).toBeDefined()
    expect(
      (submit as Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>)
        .payload.displayPrompt,
    ).toBe('screenshot.png')
  })
})

// Regression guards for the `worker.debugLog` routing: NexusTrace/ModelUpload
// info entries are trace-UI records (the overlay's Model-JSON tab, via the
// upload-bus handler) and must NOT ALSO be console.info'd — that printed the
// full sanitized request payload object into DevTools on every model call.
// Warn-level entries and plain text lines keep their console behavior.
describe('BrowserRuntimeClient worker.debugLog routing', () => {
  function createDebugLogHarness() {
    const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
    const emit = (message: AgentWorkerOutboundMessage) => {
      for (const listener of listeners) {
        listener(message)
      }
    }
    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        if (message.type === 'worker.init') {
          emit({ type: 'worker.ready', payload: createSnapshot() })
        } else if (message.type === 'worker.getMessages') {
          emit({ type: 'worker.messages', payload: { messages: [] } })
        }
      },
      addMessageListener(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: {
        cwd: '/workspace',
      },
    })
    return { client, emit }
  }

  const modelUploadEntry = {
    trace: 'NexusTrace',
    scope: 'ModelUpload',
    event: 'request',
    index: 0,
  }

  it('routes ModelUpload info entries to the trace-UI handler only, not the console', async () => {
    const { client, emit } = createDebugLogHarness()
    await client.start()
    const received: unknown[] = []
    setModelUploadHandler(entry => received.push(entry))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      emit({
        type: 'worker.debugLog',
        payload: { level: 'info', data: modelUploadEntry },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(received).toEqual([modelUploadEntry])
      expect(info).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
      setModelUploadHandler(null)
    }
  })

  it('falls back to console.info when no trace-UI handler is installed', async () => {
    const { client, emit } = createDebugLogHarness()
    await client.start()
    setModelUploadHandler(null)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      emit({
        type: 'worker.debugLog',
        payload: { level: 'info', data: modelUploadEntry },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(info).toHaveBeenCalledWith(modelUploadEntry)
    } finally {
      info.mockRestore()
    }
  })

  it('keeps warn-level ModelUpload entries on the console AND forwards them to the handler', async () => {
    const { client, emit } = createDebugLogHarness()
    await client.start()
    const received: unknown[] = []
    setModelUploadHandler(entry => received.push(entry))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const droppedEntry = {
      trace: 'NexusTrace',
      scope: 'ModelUpload',
      event: 'serialization-dropped-messages',
    }
    try {
      emit({
        type: 'worker.debugLog',
        payload: { level: 'warn', data: droppedEntry },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(warn).toHaveBeenCalledWith(droppedEntry)
      expect(received).toEqual([droppedEntry])
    } finally {
      warn.mockRestore()
      setModelUploadHandler(null)
    }
  })

  it('still console.infos plain text debug lines', async () => {
    const { client, emit } = createDebugLogHarness()
    await client.start()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      emit({
        type: 'worker.debugLog',
        payload: { level: 'info', message: '[NexusModelCatalog] source=x' },
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(info).toHaveBeenCalledWith('[NexusModelCatalog] source=x')
    } finally {
      info.mockRestore()
    }
  })
})

describe('BrowserRuntimeClient refreshModelCatalog state-waiter hygiene', () => {
  function createRefreshTransport(opts: { emitStateOnRefresh: boolean }) {
    const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
    const snapshot = createSnapshot()
    const emit = (message: AgentWorkerOutboundMessage) => {
      for (const listener of listeners) {
        listener(message)
      }
    }
    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        switch (message.type) {
          case 'worker.init':
            emit({ type: 'worker.ready', payload: snapshot })
            return
          case 'worker.getMessages':
            emit({ type: 'worker.messages', payload: { messages: [] } })
            return
          case 'worker.getState':
            emit({ type: 'worker.state', payload: snapshot })
            return
          case 'worker.refreshModelCatalog':
            if (opts.emitStateOnRefresh) {
              emit({ type: 'worker.state', payload: snapshot })
            }
            // Hung-refresh mode: never emit — the client's 10s fallback is
            // the only way out.
            return
          default:
            return
        }
      },
      addMessageListener(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    return { transport }
  }

  function stateWaitersOf(client: BrowserRuntimeClient): unknown[] {
    return (client as unknown as { stateWaiters: unknown[] }).stateWaiters
  }

  function makeClient(transport: BrowserWorkerClientTransport) {
    return new BrowserRuntimeClient({
      createWorkerTransport: () => transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: { cwd: '/workspace' },
    })
  }

  it('resolves on the post-refresh state push and leaves no waiter or live timer behind', async () => {
    const { transport } = createRefreshTransport({ emitStateOnRefresh: true })
    const client = makeClient(transport)
    await client.start()

    await client.refreshModelCatalog()

    // The registered waiter was consumed by the state push, not left behind.
    expect(stateWaitersOf(client)).toHaveLength(0)
  })

  it('on a hung refresh, the 10s fallback fires AND the dead waiter is removed', async () => {
    // Regression: the timeout path used to leave the resolver parked in
    // `stateWaiters` forever (a leak per hung refresh, flushed only by an
    // unrelated state push).
    const { transport } = createRefreshTransport({ emitStateOnRefresh: false })
    const client = makeClient(transport)
    await client.start()

    vi.useFakeTimers()
    try {
      const refresh = client.refreshModelCatalog()
      await vi.advanceTimersByTimeAsync(10_000)
      await refresh
    } finally {
      vi.useRealTimers()
    }

    expect(stateWaitersOf(client)).toHaveLength(0)
  })
})

describe('BrowserRuntimeClient pickComposerAttachmentFiles capability filter', () => {
  // Regression: the native paperclip picker (`ui.pickAttachmentFiles`) sent
  // the FULL extension list — images included — regardless of the active
  // model's `supportsImageInput`. On a text-only model (e.g. DeepSeek V4)
  // the dialog offered images that were then silently rejected at the
  // adapter, so the per-model capability config appeared to do nothing.
  // The fix forwards `allowImages` and swaps the dialog's default filter
  // group to the image-free list when the active model is text-only.

  function createPickerHarness() {
    const fakeTransport = createFakeWorkerTransport()
    const pickRequests: Array<{ extensions: string[] }> = []
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          if (request.route.action === 'pickAttachmentFiles') {
            pickRequests.push(request.payload as { extensions: string[] })
            return {
              id: request.id,
              route: request.route,
              ok: true,
              result: { paths: [], canceled: true } as never,
            }
          }
          return { id: request.id, route: request.route, ok: true, result: {} as never }
        },
      },
      initPayload: { cwd: '/workspace' },
    })
    return { client, pickRequests }
  }

  it('sends the full extension list by default (images allowed)', async () => {
    const { client, pickRequests } = createPickerHarness()
    await client.start()

    await client.pickComposerAttachmentFiles()

    expect(pickRequests).toHaveLength(1)
    expect(pickRequests[0].extensions).toEqual(
      [...BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS],
    )
  })

  it('withholds image extensions from the native dialog when allowImages=false', async () => {
    const { client, pickRequests } = createPickerHarness()
    await client.start()

    await client.pickComposerAttachmentFiles({ allowImages: false })

    expect(pickRequests).toHaveLength(1)
    expect(pickRequests[0].extensions).toEqual(
      [...BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES],
    )
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
      expect(pickRequests[0].extensions).not.toContain(ext)
    }
  })

  it('an explicit extensions override wins over the capability flag', async () => {
    const { client, pickRequests } = createPickerHarness()
    await client.start()

    await client.pickComposerAttachmentFiles({
      allowImages: false,
      extensions: ['md'],
    })

    expect(pickRequests).toHaveLength(1)
    expect(pickRequests[0].extensions).toEqual(['md'])
  })
})

describe('BrowserRuntimeClient submitActionMessage', () => {
  it('sends isMeta: true so resume/continue turns are hidden from the transcript', async () => {
    // Regression: handleContinueConversation used submitPrompt (isMeta absent)
    // for '[Resume interrupted tool execution]', which rendered as a visible
    // user bubble. The fix routes through submitActionMessage (isMeta: true),
    // which the adapter filters out of the rendered transcript.
    const fakeTransport = createFakeWorkerTransport()
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          return { id: request.id, route: request.route, ok: true, result: {} as never }
        },
      },
      initPayload: { cwd: '/workspace' },
    })

    await client.start()
    await client.submitActionMessage('[Resume interrupted tool execution]')
    await new Promise(resolve => setTimeout(resolve, 0))

    const submitted = fakeTransport.getLastSubmittedMessage()
    expect(submitted?.type).toBe('worker.submitMessage')
    if (!submitted || submitted.type !== 'worker.submitMessage') {
      throw new Error('Expected a worker.submitMessage payload.')
    }
    expect(submitted.payload.isMeta).toBe(true)
    expect(submitted.payload.prompt).toBe('[Resume interrupted tool execution]')
    // No optimistic bubble for meta turns.
    expect(client.getState().pendingPrompt).toBeNull()
  })
})

describe('BrowserRuntimeClient continueConversation', () => {
  function createClientWithTranscript(
    transcript: Array<Record<string, unknown>>,
  ) {
    const fakeTransport = createFakeWorkerTransport(transcript)
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => fakeTransport.transport,
      hostBridgeTransport: {
        async request(request) {
          return { id: request.id, route: request.route, ok: true, result: {} as never }
        },
      },
      initPayload: { cwd: '/workspace' },
    })
    return { client, fakeTransport }
  }

  function expectSubmittedContinuation(
    fakeTransport: ReturnType<typeof createFakeWorkerTransport>,
    prompt: string,
  ) {
    const submitted = fakeTransport.getLastSubmittedMessage()
    expect(submitted?.type).toBe('worker.submitMessage')
    if (!submitted || submitted.type !== 'worker.submitMessage') {
      throw new Error('Expected a worker.submitMessage payload.')
    }
    expect(submitted.payload.isMeta).toBe(true)
    expect(submitted.payload.prompt).toBe(prompt)
  }

  it('continues after a stop (interrupt marker last) with a hidden non-empty isMeta turn', async () => {
    // Regression: after Stop, the transcript ends on the
    // `[Request interrupted by user]` marker — a user-TYPE message — so
    // continue took the user-last branch and submitted a visible EMPTY
    // prompt (`submitMessage('')`), persisting an empty non-meta user
    // message that rendered as a blank bubble in the conversation.
    const { client, fakeTransport } = createClientWithTranscript([
      {
        type: 'user',
        uuid: 'u-1',
        message: { role: 'user', content: 'test' },
      },
      {
        type: 'assistant',
        uuid: 'a-1',
        message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
      },
      {
        type: 'user',
        uuid: 'u-2',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
      },
    ])

    await client.start()
    await client.continueConversation()
    await new Promise(resolve => setTimeout(resolve, 0))

    expectSubmittedContinuation(fakeTransport, CONTINUE_CONVERSATION_PROMPT)
    // No optimistic bubble — nothing may flash in the transcript either.
    expect(client.getState().pendingPrompt).toBeNull()
    expect(client.getState().pendingPromptId).toBeNull()
  })

  it('continues an assistant turn that ended on tool calls with the hidden resume note', async () => {
    const { client, fakeTransport } = createClientWithTranscript([
      {
        type: 'user',
        uuid: 'u-1',
        message: { role: 'user', content: 'test' },
      },
      {
        type: 'assistant',
        uuid: 'a-1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'Skill' }],
        },
      },
    ])

    await client.start()
    await client.continueConversation()
    await new Promise(resolve => setTimeout(resolve, 0))

    expectSubmittedContinuation(fakeTransport, RESUME_INTERRUPTED_TOOLS_PROMPT)
  })

  it('continues a plain assistant ending with the hidden continuation prompt', async () => {
    const { client, fakeTransport } = createClientWithTranscript([
      {
        type: 'user',
        uuid: 'u-1',
        message: { role: 'user', content: 'test' },
      },
      {
        type: 'assistant',
        uuid: 'a-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial answer' }],
        },
      },
    ])

    await client.start()
    await client.continueConversation()
    await new Promise(resolve => setTimeout(resolve, 0))

    expectSubmittedContinuation(fakeTransport, CONTINUE_CONVERSATION_PROMPT)
  })

  it('does nothing on an empty transcript', async () => {
    const { client, fakeTransport } = createClientWithTranscript([])

    await client.start()
    await client.continueConversation()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fakeTransport.getLastSubmittedMessage()).toBeNull()
  })
})

// UI-ready split: the worker publishes `worker.uiReady` (a provisional
// snapshot, initialized false / uiReady true) plus a proactive
// `worker.messages` push BEFORE the MCP connect + engine build complete;
// `worker.ready` follows later as the commit barrier.
describe('BrowserRuntimeClient — UI-ready split (worker.uiReady)', () => {
  function createUiReadySplitTransport() {
    const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
    const readySnapshot: AgentRuntimeWorkerSnapshot = {
      ...createSnapshot(),
      messageCount: 2,
    }
    const provisionalSnapshot: AgentRuntimeWorkerSnapshot = {
      ...createSnapshot(),
      initialized: false,
      uiReady: true,
      messageCount: 2,
      toolNames: [],
    }
    const pushedMessages = [
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        uuid: 'a0',
        message: { role: 'assistant', content: [] },
      },
    ] as never[]

    const emit = (message: AgentWorkerOutboundMessage) => {
      for (const listener of listeners) {
        listener(message)
      }
    }

    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        switch (message.type) {
          case 'worker.init':
            // The worker's provisional publish: uiReady, then the transcript
            // push. worker.ready does NOT arrive here — the build is still
            // running; tests fire it explicitly via armWorkerReady().
            emit({ type: 'worker.uiReady', payload: provisionalSnapshot })
            emit({
              type: 'worker.messages',
              payload: { messages: pushedMessages },
            })
            return

          case 'worker.getMessages':
            // The real worker PARKS this route on waitForInit until the build
            // completes — modeled here as a no-op (no reply mid-build).
            return

          default:
            return
        }
      },
      addMessageListener(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }

    return {
      transport,
      armWorkerReady: () => emit({ type: 'worker.ready', payload: readySnapshot }),
      reEmitUiReady: () =>
        emit({ type: 'worker.uiReady', payload: provisionalSnapshot }),
    }
  }

  function createClient(transport: BrowserWorkerClientTransport) {
    return new BrowserRuntimeClient({
      createWorkerTransport: () => transport,
      hostBridgeTransport: {
        async request(request) {
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: {} as never,
          }
        },
      },
      initPayload: {
        cwd: '/workspace',
      },
    })
  }

  it('start() resolves on worker.uiReady with the provisional snapshot and the pushed transcript', async () => {
    const split = createUiReadySplitTransport()
    const client = createClient(split.transport)

    // Resolves WITHOUT any worker.ready — the provisional publish unblocks it.
    await client.start()

    const state = client.getState()
    expect(state.status).toBe('ready')
    expect(state.snapshot?.initialized).toBe(false)
    expect(state.snapshot?.uiReady).toBe(true)
    expect(state.snapshot?.messageCount).toBe(2)
    // The proactive push delivered the transcript with no getMessages round-trip.
    expect(state.transcriptMessages).toHaveLength(2)
  })

  it('worker.ready upgrades the provisional snapshot in place, keeping the pushed transcript', async () => {
    const split = createUiReadySplitTransport()
    const client = createClient(split.transport)
    await client.start()

    split.armWorkerReady()

    const state = client.getState()
    expect(state.status).toBe('ready')
    expect(state.snapshot?.initialized).toBe(true)
    expect(state.snapshot?.uiReady).toBeUndefined()
    // The transcript delivered during the provisional window survives the
    // upgrade (worker.ready's own getMessages refresh is parked/no-op here).
    expect(state.transcriptMessages).toHaveLength(2)
  })

  it('a stale worker.uiReady never replaces an initialized snapshot', async () => {
    const split = createUiReadySplitTransport()
    const client = createClient(split.transport)
    await client.start()
    split.armWorkerReady()

    split.reEmitUiReady()

    const state = client.getState()
    expect(state.snapshot?.initialized).toBe(true)
    expect(state.snapshot?.uiReady).toBeUndefined()
  })

  // Read-only transcript loading for a SHUTDOWN teammate: the tab must load
  // from disk without worker.init, and a failed read must NOT look like an
  // empty transcript.
  describe('startReadOnly', () => {
    // A transport that ONLY speaks the manager channel — the read-only path
    // must never touch worker.init.
    function createReadOnlyTransport(opts: {
      reply?: { messages?: unknown[]; error?: string } | null
      withManagerChannel?: boolean
    }) {
      const managerListeners = new Set<(data: unknown) => void>()
      const workerInits: unknown[] = []
      const posted: unknown[] = []
      const transport: BrowserWorkerClientTransport = {
        async postMessage(message) {
          if ((message as { type?: string }).type === 'worker.init') {
            workerInits.push(message)
          }
        },
        addMessageListener() {
          return () => {}
        },
        ...(opts.withManagerChannel === false
          ? {}
          : {
              postManagerMessage(data: unknown) {
                posted.push(data)
                const reply = opts.reply
                if (reply === null) return // simulate a wedged manager (timeout)
                const req = data as { type?: string; requestId?: string; sessionId?: string }
                queueMicrotask(() => {
                  for (const l of managerListeners) {
                    l({
                      type: 'session.transcript',
                      payload: {
                        sessionId: req.sessionId,
                        requestId: req.requestId,
                        messages: reply?.messages ?? [],
                        ...(reply?.error !== undefined ? { error: reply.error } : {}),
                      },
                    })
                  }
                })
              },
              addManagerListener(listener: (data: unknown) => void) {
                managerListeners.add(listener)
                return () => {
                  managerListeners.delete(listener)
                }
              },
            }),
      }
      return { transport, workerInits, posted }
    }

    function readOnlyClient(transport: BrowserWorkerClientTransport) {
      return new BrowserRuntimeClient({
        createWorkerTransport: () => transport,
        hostBridgeTransport: {
          async request(request) {
            return { id: request.id, route: request.route, ok: true, result: {} as never }
          },
        },
        initPayload: { cwd: '/workspace', sessionId: 'shutdown-child' },
      })
    }

    it('loads the transcript via the manager channel and never sends worker.init', async () => {
      const fake = createReadOnlyTransport({
        reply: { messages: [{ type: 'user', uuid: 'u1' }] },
      })
      const client = readOnlyClient(fake.transport)
      const state = await client.startReadOnly()
      expect(state.status).toBe('ready')
      expect(state.lastError).toBeNull()
      expect(state.transcriptMessages).toEqual([{ type: 'user', uuid: 'u1' }])
      expect(fake.workerInits).toHaveLength(0)
      expect(fake.posted[0]).toMatchObject({ type: 'session.transcript' })
    })

    it('surfaces a manager-reported read error as an error state, not an empty transcript', async () => {
      const fake = createReadOnlyTransport({
        reply: { error: 'EIO: disk read failed' },
      })
      const client = readOnlyClient(fake.transport)
      const state = await client.startReadOnly()
      expect(state.status).toBe('error')
      expect(state.lastError?.code).toBe('transcript_read_failed')
      expect(state.lastError?.message).toContain('EIO')
      expect(state.transcriptMessages).toEqual([])
    })

    it('fails (does not render empty) when the transport has no manager channel', async () => {
      const fake = createReadOnlyTransport({ withManagerChannel: false })
      const client = readOnlyClient(fake.transport)
      const state = await client.startReadOnly()
      expect(state.status).toBe('error')
      expect(state.lastError?.code).toBe('transcript_read_failed')
    })

    it('times out as a failure rather than an empty success when the manager never replies', async () => {
      vi.useFakeTimers()
      try {
        const fake = createReadOnlyTransport({ reply: null })
        const client = readOnlyClient(fake.transport)
        const pending = client.startReadOnly()
        await vi.advanceTimersByTimeAsync(15_000)
        const state = await pending
        expect(state.status).toBe('error')
        expect(state.lastError?.message).toMatch(/timed out/)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a failed read can be retried — the failure does not stick to the client', async () => {
      let reply: { messages?: unknown[]; error?: string } = { error: 'read-only transcript: request timed out' }
      const managerListeners = new Set<(data: unknown) => void>()
      const posted: unknown[] = []
      const transport: BrowserWorkerClientTransport = {
        async postMessage() {},
        addMessageListener() {
          return () => {}
        },
        postManagerMessage(data: unknown) {
          posted.push(data)
          const req = data as { requestId?: string; sessionId?: string }
          const current = reply
          queueMicrotask(() => {
            for (const l of managerListeners) {
              l({
                type: 'session.transcript',
                payload: { sessionId: req.sessionId, requestId: req.requestId, messages: current.messages ?? [], ...(current.error !== undefined ? { error: current.error } : {}) },
              })
            }
          })
        },
        addManagerListener(listener: (data: unknown) => void) {
          managerListeners.add(listener)
          return () => {
            managerListeners.delete(listener)
          }
        },
      }
      const client = readOnlyClient(transport)
      expect((await client.startReadOnly()).lastError?.code).toBe('transcript_read_failed')

      // The read would succeed now (e.g. the cold profile warmed up).
      reply = { messages: [{ type: 'user', uuid: 'u1' }] }
      const state = await client.startReadOnly()
      expect(posted).toHaveLength(2)
      expect(state.status).toBe('ready')
      expect(state.transcriptMessages).toEqual([{ type: 'user', uuid: 'u1' }])
    })

    it('a dispose mid-read cancels it: the late outcome never lands on the disposed client', async () => {
      vi.useFakeTimers()
      try {
        const fake = createReadOnlyTransport({ reply: null }) // never replies
        const client = readOnlyClient(fake.transport)
        const pending = client.startReadOnly()
        await client.dispose()
        await pending
        // The 15s timer died with the read: nothing fires later.
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(15_000)
        const state = client.getState()
        expect(state.status).toBe('idle')
        expect(state.lastError).toBeNull()
        expect(state.transcriptOnly).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    // The boot-active case: the boot client is created
    // before session.list lands, so it calls start() — but the manager's init
    // gate refuses worker.init for a shutdown-marked session, and start() must
    // degrade to the read-only transcript rather than register a runtime or
    // hang waiting for a worker.ready that never comes.
    it('start() degrades to read-only when the manager refuses worker.init as session_shutdown', async () => {
      const workerListeners = new Set<(m: unknown) => void>()
      const managerListeners = new Set<(data: unknown) => void>()
      let sawWorkerInit = false
      const transport: BrowserWorkerClientTransport = {
        async postMessage(message) {
          if ((message as { type?: string }).type === 'worker.init') {
            sawWorkerInit = true
            // The manager gate answers with the refusal error (no worker.ready).
            queueMicrotask(() => {
              for (const l of workerListeners) {
                l({
                  type: 'worker.error',
                  payload: { code: 'session_shutdown', message: 'read-only' },
                })
              }
            })
          }
        },
        addMessageListener(listener) {
          workerListeners.add(listener as never)
          return () => { workerListeners.delete(listener as never) }
        },
        postManagerMessage(data: unknown) {
          const req = data as { type?: string; requestId?: string; sessionId?: string }
          if (req.type !== 'session.transcript') return
          queueMicrotask(() => {
            for (const l of managerListeners) {
              l({
                type: 'session.transcript',
                payload: {
                  sessionId: req.sessionId,
                  requestId: req.requestId,
                  messages: [{ type: 'user', uuid: 'u1' }],
                },
              })
            }
          })
        },
        addManagerListener(listener) {
          managerListeners.add(listener)
          return () => { managerListeners.delete(listener) }
        },
      }
      const client = readOnlyClient(transport)
      const state = await client.start()
      expect(sawWorkerInit).toBe(true) // it tried the normal path first
      // …then degraded to read-only and loaded the transcript.
      expect(state.status).toBe('ready')
      expect(state.lastError).toBeNull()
      expect(state.transcriptMessages).toEqual([{ type: 'user', uuid: 'u1' }])
      expect(state.snapshot).toBeNull()
      // And it says so. Both loading gates read "still loading?" off
      // `snapshot != null`, which this client never satisfies — so without the
      // marker the degraded tab is indistinguishable from one mid-boot, and
      // both the skeleton and the host boot splash stay up forever.
      expect(state.transcriptOnly).toBe(true)
    })

    it('a shutdown refusal is consumed: a later start() after dispose asks the manager again', async () => {
      const workerListeners = new Set<(m: unknown) => void>()
      const managerListeners = new Set<(data: unknown) => void>()
      let refuse = true
      const transport: BrowserWorkerClientTransport = {
        async postMessage(message) {
          if ((message as { type?: string }).type !== 'worker.init') return
          const shutdownRefusal = refuse
          queueMicrotask(() => {
            for (const l of workerListeners) {
              l(
                shutdownRefusal
                  ? { type: 'worker.error', payload: { code: 'session_shutdown', message: 'read-only' } }
                  : { type: 'worker.ready', payload: createSnapshot() },
              )
            }
          })
        },
        addMessageListener(listener) {
          workerListeners.add(listener as never)
          return () => { workerListeners.delete(listener as never) }
        },
        postManagerMessage(data: unknown) {
          const req = data as { type?: string; requestId?: string; sessionId?: string }
          if (req.type !== 'session.transcript') return
          queueMicrotask(() => {
            for (const l of managerListeners) {
              l({ type: 'session.transcript', payload: { sessionId: req.sessionId, requestId: req.requestId, messages: [] } })
            }
          })
        },
        addManagerListener(listener) {
          managerListeners.add(listener)
          return () => { managerListeners.delete(listener) }
        },
      }
      const client = readOnlyClient(transport)
      expect((await client.start()).transcriptOnly).toBe(true)
      // No ready waiter outlives the refused start.
      expect((client as unknown as { readyWaiters: unknown[] }).readyWaiters).toHaveLength(0)

      // The session was restored; the next start must not reuse the old refusal.
      await client.dispose()
      refuse = false
      const state = await client.start()
      expect(state.snapshot).not.toBeNull()
      expect(state.transcriptOnly).toBe(false)
    })

    // `transcriptOnly` is the ONLY signal that a read-only load has finished.
    // It must be set on every terminal outcome — including the failures, whose
    // error banner the loading overlay would otherwise cover — and must NOT be
    // set while the load is in flight or after a dispose.
    it('marks every settled outcome as transcript-only', async () => {
      const loaded = readOnlyClient(
        createReadOnlyTransport({
          reply: { messages: [{ type: 'user', uuid: 'u1' }] },
        }).transport,
      )
      expect((await loaded.startReadOnly()).transcriptOnly).toBe(true)

      const emptied = readOnlyClient(
        createReadOnlyTransport({ reply: { messages: [] } }).transport,
      )
      // The mis-routed read: no error, just nothing. Settled all the same.
      const emptyState = await emptied.startReadOnly()
      expect(emptyState.transcriptMessages).toEqual([])
      expect(emptyState.transcriptOnly).toBe(true)

      const failed = readOnlyClient(
        createReadOnlyTransport({ reply: { error: 'EIO' } }).transport,
      )
      const failedState = await failed.startReadOnly()
      expect(failedState.status).toBe('error')
      expect(failedState.transcriptOnly).toBe(true)
    })

    it('is not set while the read is in flight, and is cleared by dispose', async () => {
      vi.useFakeTimers()
      let client: ReturnType<typeof readOnlyClient>
      try {
        const fake = createReadOnlyTransport({ reply: null }) // never replies
        client = readOnlyClient(fake.transport)
        const pending = client.startReadOnly()
        expect(client.getState().transcriptOnly).toBeFalsy()
        await vi.advanceTimersByTimeAsync(15_000)
        expect((await pending).transcriptOnly).toBe(true)
      } finally {
        vi.useRealTimers()
      }
      await client!.dispose()
      // A disposed client restarts through `start()`; leaving the flag set
      // would tell both gates the next load had already finished.
      expect(client!.getState().transcriptOnly).toBe(false)
    })
  })
})

describe('BrowserRuntimeClient never executes host calls for the runtime', () => {
  it('a worker.bridgeRequest reaching a client runs on no transport and is not answered', async () => {
    const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
    const posted: AgentWorkerInboundMessage[] = []
    const transport: BrowserWorkerClientTransport = {
      async postMessage(message: AgentWorkerInboundMessage) {
        posted.push(message)
        if (message.type === 'worker.init') {
          for (const l of listeners) l({ type: 'worker.ready', payload: createSnapshot() })
        }
      },
      addMessageListener(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    // The runtime reaches C++ over its own host port (BridgeRequestRouter). A
    // client — possibly remote, possibly scoped — is never its executor.
    const hostRequest = vi.fn(async () => {
      throw new Error('a client must not run host calls for the runtime')
    })
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => transport,
      hostBridgeTransport: { request: hostRequest as never },
      initPayload: { cwd: '/workspace' },
    })
    await client.start()

    const request = {
      id: 'relay-1',
      route: { namespace: 'nexus', capability: 'network', action: 'httpGet' },
      payload: { url: 'https://example.com/' },
    }
    for (const l of listeners) l({ type: 'worker.bridgeRequest', payload: request } as never)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(hostRequest).not.toHaveBeenCalled()
    expect(posted.some(m => m.type === 'worker.bridgeResponse')).toBe(false)
  })
})
