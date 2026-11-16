// @vitest-environment happy-dom
/**
 * The phone shell (F-24) mounts the shared conversation view with no desktop shell around it: it
 * boots into the stored session, names it from the session list, renders the conversation and its
 * composer, and tells the runtime which session it views. Its chrome drives the same session
 * requests as the desktop: the drawer switches and starts sessions, the menu renames and archives.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { SessionListChannel } from '../browser/runtimeClient'
import type { BrowserWorkerClientTransport } from '../browser/webview/BrowserRuntimeClient'
import { ACTIVE_SESSION_STORAGE_KEY } from '../browser/webview/bootSessionPointer'
import type {
  AgentRuntimeWorkerInitPayload,
  AgentRuntimeWorkerSnapshot,
  AgentWorkerInboundMessage,
} from '../browser/worker/workerProtocol'
import { MobileShell } from '../mobile/MobileShell'

// This realm's `localStorage` is not a working Storage; a Map-backed stub stands in.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

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

const transcript = [
  {
    type: 'user',
    uuid: 'u0',
    message: { role: 'user', content: [{ type: 'text', text: 'plan the trip' }] },
  },
] as never[]

function fakeWorker() {
  const initialized: string[] = []
  const createWorkerTransport = (): BrowserWorkerClientTransport => {
    const listeners = new Set<(message: unknown) => void>()
    const emit = (message: unknown) => {
      for (const listener of listeners) listener(message)
    }
    return {
      async postMessage(message: AgentWorkerInboundMessage) {
        if (message.type === 'worker.init') {
          const sessionId = message.payload.sessionId ?? ''
          initialized.push(sessionId)
          emit({ type: 'worker.ready', payload: snapshot(sessionId) })
          return
        }
        if (message.type === 'worker.getMessages') {
          emit({ type: 'worker.messages', payload: { messages: transcript } })
        }
      },
      addMessageListener(listener) {
        listeners.add(listener as (message: unknown) => void)
        return () => listeners.delete(listener as (message: unknown) => void)
      },
    }
  }
  return { createWorkerTransport, initialized }
}

function fakeSessionChannel() {
  const listeners = new Set<(message: Record<string, unknown>) => void>()
  const requests: Array<{ route: string; payload: Record<string, unknown> }> = []
  const channel: SessionListChannel = {
    onMessage(listener) {
      listeners.add(listener as (message: Record<string, unknown>) => void)
      return () => listeners.delete(listener as (message: Record<string, unknown>) => void)
    },
    request(route, payload) {
      requests.push({ route, payload })
    },
  }
  const emit = (message: Record<string, unknown>) => {
    for (const listener of listeners) listener(message)
  }
  return { channel, emit, requests }
}

const hostBridgeTransport = {
  async request() {
    return { ok: true } as never
  },
} as unknown as BrowserBridgeTransport

const createInitPayload = (sessionId: string): AgentRuntimeWorkerInitPayload =>
  ({ sessionId, runtimeName: 'test' }) as AgentRuntimeWorkerInitPayload

describe('MobileShell', () => {
  it('opens the stored session, titles it from the list, and renders its conversation', async () => {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, 'session-a')
    const worker = fakeWorker()
    const sessions = fakeSessionChannel()

    render(createElement(MobileShell, { createWorkerTransport: worker.createWorkerTransport, hostBridgeTransport, createInitPayload, sessionChannel: sessions.channel }))

    expect(screen.getByTestId('mobile-shell')).toBeTruthy()
    // Untitled until the list names it.
    expect(screen.getByTestId('mobile-topbar-title').textContent).toBe('New session')

    act(() => {
      sessions.emit({
        type: 'session.list',
        payload: { sessions: [{ sessionId: 'session-a', title: 'Trip planning', customTitle: 'Trip planning', updatedAt: 1 }] },
      })
    })
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-title').textContent).toBe('Trip planning'))

    await waitFor(() => expect(worker.initialized).toContain('session-a'))
    await waitFor(() => expect(screen.getByText('plan the trip')).toBeTruthy())
    expect(screen.getByTestId('mobile-thread').querySelector('textarea')).not.toBeNull()

    expect(sessions.requests).toContainEqual({
      route: 'presence.setViewing',
      payload: { sessionId: 'session-a' },
    })
  })

  it('follows a list update and a removal of another session without switching', async () => {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, 'session-a')
    const worker = fakeWorker()
    const sessions = fakeSessionChannel()
    render(createElement(MobileShell, { createWorkerTransport: worker.createWorkerTransport, hostBridgeTransport, createInitPayload, sessionChannel: sessions.channel }))
    act(() => {
      sessions.emit({
        type: 'session.list',
        payload: {
          sessions: [
            { sessionId: 'session-a', title: 'First', updatedAt: 2 },
            { sessionId: 'session-b', title: 'Second', updatedAt: 1 },
          ],
        },
      })
    })
    act(() => {
      sessions.emit({
        type: 'session.updated',
        payload: { session: { sessionId: 'session-a', title: 'First, renamed', customTitle: 'First, renamed', updatedAt: 3 } },
      })
      sessions.emit({ type: 'session.removed', payload: { sessionId: 'session-b' } })
    })
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-title').textContent).toBe('First, renamed'))
    expect(localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe('session-a')
  })

  function mountWithTwoSessions() {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, 'session-a')
    const worker = fakeWorker()
    const sessions = fakeSessionChannel()
    render(createElement(MobileShell, { createWorkerTransport: worker.createWorkerTransport, hostBridgeTransport, createInitPayload, sessionChannel: sessions.channel }))
    act(() => {
      sessions.emit({
        type: 'session.list',
        payload: {
          sessions: [
            { sessionId: 'session-a', title: 'Trip', customTitle: 'Trip', projectRoot: 'C:\\work\\holiday', updatedAt: 3 },
            { sessionId: 'session-b', title: 'Budget', customTitle: 'Budget', projectRoot: 'C:\\work\\money', updatedAt: 2 },
            { sessionId: 'session-old', title: 'Old', customTitle: 'Old', archived: true, updatedAt: 1 },
          ],
        },
      })
    })
    return { worker, sessions }
  }

  it('shows the project under the title, and the running state the runtime reports', async () => {
    const { sessions } = mountWithTwoSessions()
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-title').textContent).toBe('Trip'))
    expect(screen.getByTestId('mobile-topbar-project').textContent).toBe('holiday')
    expect(screen.queryByTestId('mobile-topbar-running')).toBeNull()
    act(() => {
      sessions.emit({ type: 'session.summary', payload: { sessions: [{ sessionId: 'session-a', running: true }] } })
    })
    expect(screen.getByTestId('mobile-topbar-running')).toBeTruthy()
    act(() => {
      sessions.emit({ type: 'session.summary', payload: { sessions: [{ sessionId: 'session-a', running: false }] } })
    })
    expect(screen.queryByTestId('mobile-topbar-running')).toBeNull()
  })

  it('switches sessions from the drawer, which then closes', async () => {
    const { sessions } = mountWithTwoSessions()
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-title').textContent).toBe('Trip'))
    fireEvent.click(screen.getByTestId('mobile-topbar-drawer'))
    const listed = screen.getAllByTestId('mobile-session-row').map(r => r.getAttribute('data-session-id'))
    expect(listed).toEqual(['session-a', 'session-b'])
    fireEvent.click(screen.getAllByTestId('mobile-session-row')[1])
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-title').textContent).toBe('Budget'))
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
    expect(sessions.requests).toContainEqual({ route: 'presence.setViewing', payload: { sessionId: 'session-b' } })
    expect(localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe('session-b')
  })

  it('starts a new session in the project of the open session', async () => {
    const { worker } = mountWithTwoSessions()
    await waitFor(() => expect(worker.initialized).toContain('session-a'))
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-project').textContent).toBe('holiday'))
    fireEvent.click(screen.getByTestId('mobile-topbar-drawer'))
    fireEvent.click(screen.getByTestId('mobile-drawer-new-session'))
    await waitFor(() => expect(localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).not.toBe('session-a'))
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
    // The list merges on a short debounce; the new session is in the same project.
    await waitFor(() => expect(worker.initialized).toContain(localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)))
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-project').textContent).toBe('holiday'))
  })

  it('renames and archives the open session from the menu', async () => {
    const { sessions } = mountWithTwoSessions()
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-title').textContent).toBe('Trip'))
    fireEvent.click(screen.getByTestId('mobile-topbar-menu'))
    fireEvent.click(screen.getByTestId('mobile-menu-rename'))
    fireEvent.change(screen.getByTestId('mobile-rename-input'), { target: { value: 'Road trip' } })
    fireEvent.click(screen.getByTestId('mobile-rename-save'))
    await waitFor(() => expect(screen.getByTestId('mobile-topbar-title').textContent).toBe('Road trip'))
    expect(sessions.requests).toContainEqual(
      expect.objectContaining({
        route: 'session.rename',
        payload: expect.objectContaining({ sessionId: 'session-a', title: 'Road trip' }),
      }),
    )

    fireEvent.click(screen.getByTestId('mobile-topbar-menu'))
    fireEvent.click(screen.getByTestId('mobile-menu-archive'))
    expect(sessions.requests).toContainEqual(
      expect.objectContaining({
        route: 'session.archive',
        payload: expect.objectContaining({ sessionId: 'session-a', archived: true }),
      }),
    )
    expect(screen.queryByTestId('mobile-session-menu')).toBeNull()
  })
})
