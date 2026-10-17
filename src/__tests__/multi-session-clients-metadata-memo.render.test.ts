// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { BrowserWorkerClientTransport } from '../browser/webview/BrowserRuntimeClient'
import { useMultiSessionClients } from '../browser/webview/useMultiSessionClients'
import type {
  AgentRuntimeWorkerSnapshot,
  AgentWorkerInboundMessage,
} from '../browser/worker/workerProtocol'
import { deriveSessionMetadataFromMessages } from '../sessions/sessionStore'

vi.mock('../sessions/sessionStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../sessions/sessionStore')>()
  return {
    ...actual,
    deriveSessionMetadataFromMessages: vi.fn(actual.deriveSessionMetadataFromMessages),
  }
})

/**
 * The sidebar metadata for a session is derived from its transcript. Stream
 * ticks push new client state with the same transcript, so the derive runs
 * once per transcript, not once per push.
 */

function snapshot(sessionId: string): AgentRuntimeWorkerSnapshot {
  return {
    initialized: true,
    sessionId,
    cwd: '/workspace',
    currentProviderId: 'demo',
    activeModelId: 'mock',
    currentSelection: { providerId: 'demo', modelId: 'mock' },
    modelCatalog: null,
    availableModels: ['mock'],
    toolNames: [],
    commandNames: [],
    messageCount: 1,
    isBusy: false,
    isStopping: false,
    pendingBridgeRequestIds: [],
  }
}

const rows = [
  {
    type: 'user',
    uuid: 'u0',
    message: { role: 'user', content: [{ type: 'text', text: 'plan the trip' }] },
  },
] as never[]

function workerWithStream() {
  let emit: (message: unknown) => void = () => {}
  const createWorkerTransport = (): BrowserWorkerClientTransport => {
    const listeners = new Set<(message: unknown) => void>()
    let sessionId = ''
    emit = message => {
      for (const listener of listeners) listener(message)
    }
    return {
      async postMessage(message: AgentWorkerInboundMessage) {
        if (message.type === 'worker.init') {
          sessionId = message.payload.sessionId ?? ''
          emit({ type: 'worker.ready', payload: snapshot(sessionId) })
          return
        }
        if (message.type === 'worker.getMessages') {
          emit({ type: 'worker.messages', payload: { messages: rows } })
        }
      },
      addMessageListener(listener) {
        listeners.add(listener as (message: unknown) => void)
        return () => listeners.delete(listener as (message: unknown) => void)
      },
    }
  }
  return { createWorkerTransport, emit: (message: unknown) => emit(message) }
}

describe('useMultiSessionClients — sidebar metadata derive', () => {
  it('derives once per transcript, not on every stream push', async () => {
    const derive = vi.mocked(deriveSessionMetadataFromMessages)
    const worker = workerWithStream()
    const changes: Array<{ firstPrompt?: string }> = []
    renderHook(() =>
      useMultiSessionClients({
        activeSessionId: 'session-a',
        mountedSessionIds: ['session-a'],
        createWorkerTransport: worker.createWorkerTransport,
        hostBridgeTransport: {
          async request(request) {
            return { id: request.id, route: request.route, ok: true, result: {} as never }
          },
        },
        createInitPayload: sessionId => ({ cwd: '/workspace', sessionId }),
        onSessionStateChange: (_sessionId, _state, metadata) => {
          changes.push(metadata)
        },
      }),
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const callsWithTranscript = () =>
      derive.mock.calls.filter(([messages]) => messages.length > 0).length
    expect(callsWithTranscript()).toBe(1)
    expect(changes.at(-1)?.firstPrompt).toBe('plan the trip')

    await act(async () => {
      for (let tick = 0; tick < 5; tick++) {
        worker.emit({
          type: 'worker.stream',
          payload: { event: { type: 'content_block_delta', index: 0 } },
        })
      }
    })

    expect(callsWithTranscript()).toBe(1)
  })
})
