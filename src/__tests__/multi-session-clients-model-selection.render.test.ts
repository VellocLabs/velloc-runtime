// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { BrowserWorkerClientTransport } from '../browser/webview/BrowserRuntimeClient'
import { useMultiSessionClients } from '../browser/webview/useMultiSessionClients'
import type {
  AgentRuntimeWorkerSnapshot,
  AgentWorkerInboundMessage,
} from '../browser/worker/workerProtocol'

/**
 * The composer's effort control applies to the session it belongs to
 * (F-12, "Session effort") — bound to that thread's
 * sessionId, never routed to whichever session happens to be active. A pick
 * landing in the same tick as a session switch must not change the model of
 * the session switched to.
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
    messageCount: 0,
    isBusy: false,
    isStopping: false,
    pendingBridgeRequestIds: [],
  }
}

/** One fake worker per created client, recording what each was sent. */
function workerFactory() {
  const postedBySession = new Map<string, AgentWorkerInboundMessage[]>()
  const createWorkerTransport = (): BrowserWorkerClientTransport => {
    const listeners = new Set<(message: unknown) => void>()
    let sessionId = ''
    const emit = (message: unknown) => {
      for (const listener of listeners) listener(message)
    }
    return {
      async postMessage(message: AgentWorkerInboundMessage) {
        if (message.type === 'worker.init') {
          sessionId = message.payload.sessionId ?? ''
          emit({ type: 'worker.ready', payload: snapshot(sessionId) })
          return
        }
        const posted = postedBySession.get(sessionId) ?? []
        posted.push(message)
        postedBySession.set(sessionId, posted)
        if (message.type === 'worker.getState') {
          emit({ type: 'worker.state', payload: snapshot(sessionId) })
        }
      },
      addMessageListener(listener) {
        listeners.add(listener as (message: unknown) => void)
        return () => listeners.delete(listener as (message: unknown) => void)
      },
    }
  }
  return { createWorkerTransport, postedBySession }
}

describe('useMultiSessionClients — setModelSelectionForSession', () => {
  it('applies the selection to the NAMED session, not the active one', async () => {
    const workers = workerFactory()
    const { result } = renderHook(() =>
      useMultiSessionClients({
        activeSessionId: 'session-a',
        mountedSessionIds: ['session-a', 'session-b'],
        createWorkerTransport: workers.createWorkerTransport,
        hostBridgeTransport: {
          async request(request) {
            return { id: request.id, route: request.route, ok: true, result: {} as never }
          },
        },
        createInitPayload: sessionId => ({ cwd: '/workspace', sessionId }),
      }),
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    const selection = { providerId: 'demo', modelId: 'mock', thinkingTier: 'high' }
    await act(async () => {
      await result.current.setModelSelectionForSession('session-b', selection)
    })

    const sentTo = (sessionId: string) =>
      (workers.postedBySession.get(sessionId) ?? []).filter(
        message => message.type === 'worker.setModelSelection',
      )
    expect(sentTo('session-b')).toEqual([
      { type: 'worker.setModelSelection', payload: { selection } },
    ])
    expect(sentTo('session-a')).toEqual([])
  })
})
