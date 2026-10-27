// @vitest-environment happy-dom
/**
 * Three routes gated by the page connection's grant: the topbar transcript search (`search.queryTranscripts`),
 * `sessionImport.detect` and `session.setActiveSession`. The two background requests also wait while the grant is
 * unknown (`PENDING_GRANT` / `mayIssue`); a `full` grant or no connection behaves as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type {
  BrowserBridgeRequest,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'
import type { DetectedImportSource } from '../browser/bridge/protocol/sessionImport'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import type { CapabilityAdvert, ScopeMode, WelcomeFrame } from '../browser/runtimeProtocol'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import { useDetectedImportSources } from '../browser/webview/sessionImport/useDetectedImportSources'
import { useTranscriptSearchGate } from '../browser/webview/topbar/useTranscriptSearchGate'
import { useActiveSessionOnHost } from '../browser/webview/useActiveSessionOnHost'
import {
  ALLOW_ALL,
  PENDING_GRANT,
  mayIssue,
  useCapabilityQuery,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SCOPED: ScopeMode[] = ['manager', 'control', 'observe']

/** No provider (the desktop tree before WP-6) and a `full` grant: both unchanged. */
const UNCHANGED: Array<[string, CapabilityQuery]> = [
  ['with no connection (ALLOW_ALL)', ALLOW_ALL],
  ['for a full grant', queryFor(advertsForScope('full'))],
]

/** Let an issued request's promise settle, so its result would have landed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function fakeConnection(capabilities: CapabilityAdvert[]): RuntimeConnection {
  const welcome = {
    kind: 'welcome',
    v: 1,
    connectionId: 'c1',
    resumed: false,
    scope: { mode: 'manager', sessions: 'all' },
    server: { runtimeVersion: 'test', capabilities },
  } as WelcomeFrame
  return {
    welcome,
    can(cap: string, act?: string) {
      const advert = welcome.server.capabilities.find(entry => entry.cap === cap)
      if (!advert) return false
      return act === undefined || advert.acts.includes(act)
    },
    watchLinkState: () => () => {},
  } as unknown as RuntimeConnection
}

describe('useCapabilityQuery — an unknown grant renders controls but holds requests', () => {
  it('answers ALLOW_ALL, never pending, with no connection wired', () => {
    const { result } = renderHook(() => useCapabilityQuery(undefined))
    expect(result.current).toBe(ALLOW_ALL)
    expect(mayIssue(result.current, 'session', 'setActiveSession')).toBe(true)
  })

  it('is pending while a wired connection has not answered: can() yes, mayIssue() no', () => {
    const connection = () => new Promise<RuntimeConnection>(() => {})
    const { result } = renderHook(() => useCapabilityQuery(connection))
    expect(result.current.pending).toBe(true)
    expect(result.current.can('search', 'queryTranscripts')).toBe(true)
    expect(mayIssue(result.current, 'sessionImport', 'detect')).toBe(false)
  })

  it('answers from the welcome once the connection resolves', async () => {
    const conn = fakeConnection(advertsForScope('manager'))
    const connection = () => Promise.resolve(conn)
    const { result } = renderHook(() => useCapabilityQuery(connection))
    await waitFor(() => expect(result.current.pending).toBeFalsy())
    expect(mayIssue(result.current, 'session', 'setActiveSession')).toBe(false)
    expect(mayIssue(result.current, 'providers', 'list')).toBe(true)
  })

  it('falls back to ALLOW_ALL when the connection never comes up', async () => {
    const connection = () => Promise.reject(new Error('runtime down'))
    const { result } = renderHook(() => useCapabilityQuery(connection))
    await waitFor(() => expect(result.current).toBe(ALLOW_ALL))
    expect(mayIssue(result.current, 'sessionImport', 'detect')).toBe(true)
  })
})

function pressCtrlK(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'k',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

describe('useTranscriptSearchGate — the topbar search follows the grant', () => {
  it.each(UNCHANGED)('renders, and Ctrl+K opens it, %s', (_label, capabilities) => {
    const { result } = renderHook(() => useTranscriptSearchGate(true, capabilities))
    expect(result.current.enabled).toBe(true)
    const event = pressCtrlK()
    expect(event.defaultPrevented).toBe(true)
    expect(result.current.openToken).toBe(1)
  })

  it.each(['manager', 'control'] as const)('renders for a %s grant, and Ctrl+K opens it', mode => {
    const { result } = renderHook(() =>
      useTranscriptSearchGate(true, queryFor(advertsForScope(mode))),
    )
    expect(result.current.enabled).toBe(true)
    expect(pressCtrlK().defaultPrevented).toBe(true)
    expect(result.current.openToken).toBe(1)
  })

  it.each(['observe'] as const)('is absent for a %s grant, and Ctrl+K is left alone', mode => {
    const { result } = renderHook(() =>
      useTranscriptSearchGate(true, queryFor(advertsForScope(mode))),
    )
    expect(result.current.enabled).toBe(false)
    const event = pressCtrlK()
    expect(event.defaultPrevented).toBe(false)
    expect(result.current.openToken).toBe(0)
  })

  it('renders with the shortcut off, and Ctrl+K is left to the page', () => {
    const { result } = renderHook(() => useTranscriptSearchGate(true, ALLOW_ALL, false))
    expect(result.current.enabled).toBe(true)
    const event = pressCtrlK()
    expect(event.defaultPrevented).toBe(false)
    expect(result.current.openToken).toBe(0)
  })

  it('still renders while the grant is unknown (it is a control)', () => {
    const { result } = renderHook(() => useTranscriptSearchGate(true, PENDING_GRANT))
    expect(result.current.enabled).toBe(true)
  })

  it('stays absent when the host does not serve search, whatever the grant', () => {
    const { result } = renderHook(() => useTranscriptSearchGate(false, ALLOW_ALL))
    expect(result.current.enabled).toBe(false)
    pressCtrlK()
    expect(result.current.openToken).toBe(0)
  })
})

const DETECTED: DetectedImportSource[] = [
  { source: 'claude-code', rootPath: 'C:/Users/u/.claude/projects' },
]

function fakeSettingsBridge() {
  const request = vi.fn(async () => ({ sources: DETECTED }))
  return { bridge: { request } as unknown as NexusSettingsBridge, request }
}

describe('useDetectedImportSources — the import probe follows the grant', () => {
  it.each(UNCHANGED)('probes once and returns the sources %s', async (_label, capabilities) => {
    const { bridge, request } = fakeSettingsBridge()
    const { result } = renderHook(() => useDetectedImportSources(bridge, capabilities))
    await waitFor(() => expect(result.current).toEqual(DETECTED))
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      { namespace: 'nexus', capability: 'sessionImport', action: 'detect' },
      {},
    )
  })

  it.each(['manager', 'control'] as const)('probes once and returns the sources for a %s grant', async mode => {
    const { bridge, request } = fakeSettingsBridge()
    const { result } = renderHook(() =>
      useDetectedImportSources(bridge, queryFor(advertsForScope(mode))),
    )
    await waitFor(() => expect(result.current).toEqual(DETECTED))
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['observe'] as const)('never probes for a %s grant, and returns no sources', async mode => {
    const { bridge, request } = fakeSettingsBridge()
    const { result } = renderHook(() =>
      useDetectedImportSources(bridge, queryFor(advertsForScope(mode))),
    )
    await settle()
    expect(request).not.toHaveBeenCalled()
    expect(result.current).toEqual([])
  })

  it('waits while the grant is unknown, then probes once when it is full', async () => {
    const { bridge, request } = fakeSettingsBridge()
    const { result, rerender } = renderHook(
      ({ capabilities }) => useDetectedImportSources(bridge, capabilities),
      { initialProps: { capabilities: PENDING_GRANT } },
    )
    await settle()
    expect(request).not.toHaveBeenCalled()
    rerender({ capabilities: queryFor(advertsForScope('full')) })
    await waitFor(() => expect(result.current).toEqual(DETECTED))
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('drops the sources when a reconnect comes back without the action', async () => {
    const { bridge } = fakeSettingsBridge()
    const { result, rerender } = renderHook(
      ({ capabilities }) => useDetectedImportSources(bridge, capabilities),
      { initialProps: { capabilities: queryFor(advertsForScope('full')) } },
    )
    await waitFor(() => expect(result.current).toEqual(DETECTED))
    rerender({ capabilities: queryFor(advertsForScope('observe')) })
    expect(result.current).toEqual([])
  })
})

function fakeHostTransport() {
  const request = vi.fn(async (_request: BrowserBridgeRequest) => ({
    ok: true,
    result: { ok: true, activated: true, nexusTabCount: 2, totalTabCount: 3 },
  }))
  return { transport: { request } as unknown as BrowserBridgeTransport, request }
}

/** The session ids of every `session.setActiveSession` the hook sent. */
function activated(request: ReturnType<typeof fakeHostTransport>['request']): string[] {
  return request.mock.calls
    .map(([sent]) => sent)
    .filter(sent => sent.route.capability === 'session' && sent.route.action === 'setActiveSession')
    .map(sent => (sent.payload as { sessionId: string }).sessionId)
}

describe('useActiveSessionOnHost — the switch report follows the grant', () => {
  it.each(UNCHANGED)('reports boot and every switch, and forwards the counts, %s', async (_label, capabilities) => {
    const { transport, request } = fakeHostTransport()
    const onTabCounts = vi.fn()
    const { rerender } = renderHook(
      ({ sessionId }) => useActiveSessionOnHost(transport, sessionId, capabilities, onTabCounts),
      { initialProps: { sessionId: 's1' } },
    )
    await waitFor(() => expect(onTabCounts).toHaveBeenCalledWith('s1', 2, 3))
    rerender({ sessionId: 's2' })
    await waitFor(() => expect(onTabCounts).toHaveBeenCalledWith('s2', 2, 3))
    expect(activated(request)).toEqual(['s1', 's2'])
  })

  it.each(SCOPED)('never reports for a %s grant, across a switch', async mode => {
    const { transport, request } = fakeHostTransport()
    const onTabCounts = vi.fn()
    const capabilities = queryFor(advertsForScope(mode))
    const { rerender } = renderHook(
      ({ sessionId }) => useActiveSessionOnHost(transport, sessionId, capabilities, onTabCounts),
      { initialProps: { sessionId: 's1' } },
    )
    rerender({ sessionId: 's2' })
    await settle()
    expect(request).not.toHaveBeenCalled()
    expect(onTabCounts).not.toHaveBeenCalled()
  })

  it('waits while the grant is unknown, then reports the current session once', async () => {
    const { transport, request } = fakeHostTransport()
    const onTabCounts = vi.fn()
    const { rerender } = renderHook(
      ({ sessionId, capabilities }) =>
        useActiveSessionOnHost(transport, sessionId, capabilities, onTabCounts),
      { initialProps: { sessionId: 's1', capabilities: PENDING_GRANT } },
    )
    rerender({ sessionId: 's2', capabilities: PENDING_GRANT })
    await settle()
    expect(request).not.toHaveBeenCalled()
    rerender({ sessionId: 's2', capabilities: queryFor(advertsForScope('full')) })
    await waitFor(() => expect(onTabCounts).toHaveBeenCalledWith('s2', 2, 3))
    expect(activated(request)).toEqual(['s2'])
  })
})

describe('useActiveSessionOnHost — paused while another screen owns the tab view', () => {
  it('sends nothing while paused and reports the session again on resume', async () => {
    const { transport, request } = fakeHostTransport()
    const onTabCounts = vi.fn()
    const capabilities = queryFor(advertsForScope('full'))
    const { rerender } = renderHook(
      ({ paused }) =>
        useActiveSessionOnHost(transport, 's1', capabilities, onTabCounts, undefined, paused),
      { initialProps: { paused: false } },
    )
    await waitFor(() => expect(activated(request)).toEqual(['s1']))
    rerender({ paused: true })
    await settle()
    expect(activated(request)).toEqual(['s1'])
    rerender({ paused: false })
    await waitFor(() => expect(activated(request)).toEqual(['s1', 's1']))
  })
})
