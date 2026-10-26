// @vitest-environment happy-dom
/**
 * The Customize screen's utility tab when it cannot show (F-35): a failed
 * `customizePage.show`, no runtime connection, or `available: false` on
 * `customizePage/status` all mark the tab unavailable; the screen then shows
 * a message and a retry in place of the native view's placeholder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'

import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { useCustomizeTab } from '../browser/webview/customize/useCustomizeTab'
import { CustomizeScreen } from '../browser/webview/customize/CustomizeScreen'
import { customizeUrl } from '../browser/webview/customize/customizeRoutes'
import { EMPTY_INVENTORY, buildInstalledRows } from '../browser/webview/customize/installedRows'
import { en as EN_MESSAGES } from '../browser/webview/i18n/messages/en'

vi.mock('../browser/webview/customize/useInstalledInventory', () => ({
  useInstalledInventory: () => ({ loading: false, rows: buildInstalledRows(EMPTY_INVENTORY) }),
}))

afterEach(() => cleanup())

const STATUS = 'customizePage/status'
type Handler = (event: { type?: string; payload: unknown }) => void

/** A connection whose `show` answers come from `answers`, in order; the last one repeats. */
function fakeConnection(answers: Array<'ok' | 'fail'>) {
  const handlers = new Map<string, Handler>()
  const shows: unknown[] = []
  const connection = {
    subscribe: (topic: string, handler: Handler) => {
      handlers.set(topic, handler)
      return () => handlers.delete(topic)
    },
    can: () => true,
    request: async (route: string, payload: unknown) => {
      if (route !== 'customizePage.show') return {}
      shows.push(payload)
      const answer = answers[Math.min(shows.length - 1, answers.length - 1)]
      if (answer === 'fail') throw new Error('UI_ERROR: openUtilityTab: no tab was created')
      return { tabId: 7, created: shows.length === 1 }
    },
  } as unknown as RuntimeConnection
  return {
    getConnection: async () => connection,
    status: (payload: unknown) => handlers.get(STATUS)?.({ type: 'state', payload }),
    subscribed: () => handlers.has(STATUS),
    shows,
  }
}

describe('useCustomizeTab — a show that fails', () => {
  it('a refused show marks the tab unavailable, and retry shows it again', async () => {
    const fake = fakeConnection(['fail', 'ok'])
    const { result } = renderHook(() => useCustomizeTab(fake.getConnection, true))
    expect(result.current.unavailable).toBe(false)
    await waitFor(() => expect(result.current.unavailable).toBe(true))
    expect(fake.shows).toHaveLength(1)

    act(() => result.current.retry())
    expect(result.current.unavailable).toBe(false)
    await waitFor(() => expect(fake.shows).toHaveLength(2))
    await act(async () => {})
    expect(result.current.unavailable).toBe(false)
  })

  it('a successful show stays available', async () => {
    const fake = fakeConnection(['ok'])
    const { result } = renderHook(() => useCustomizeTab(fake.getConnection, true))
    await waitFor(() => expect(fake.shows).toHaveLength(1))
    await act(async () => {})
    expect(result.current.unavailable).toBe(false)
  })

  it('a connection that cannot be had counts as a failed show', async () => {
    const getConnection = () => Promise.reject(new Error('no runtime'))
    const { result } = renderHook(() => useCustomizeTab(getConnection, true))
    await waitFor(() => expect(result.current.unavailable).toBe(true))
  })

  it('no runtime connection at all is unavailable', () => {
    const { result } = renderHook(() => useCustomizeTab(undefined, true))
    expect(result.current.unavailable).toBe(true)
  })

  it('a closed screen asks nothing and reports nothing', async () => {
    const fake = fakeConnection(['fail'])
    const { result } = renderHook(() => useCustomizeTab(fake.getConnection, false))
    await act(async () => {})
    expect(fake.shows).toHaveLength(0)
    expect(result.current.unavailable).toBe(false)
  })
})

describe('useCustomizeTab — the host port', () => {
  it('available: false is unavailable, and the port coming back shows the tab again', async () => {
    const fake = fakeConnection(['fail', 'ok'])
    const { result } = renderHook(() => useCustomizeTab(fake.getConnection, true))
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: false }))
    expect(result.current.unavailable).toBe(true)
    await waitFor(() => expect(fake.shows).toHaveLength(1))

    act(() => fake.status({ available: true }))
    await waitFor(() => expect(fake.shows).toHaveLength(2))
    act(() => fake.status({ available: true, tabId: 7 }))
    await waitFor(() => expect(result.current.unavailable).toBe(false))
    expect(result.current.tabId).toBe(7)
  })

  it('an available host that was never missing asks for no extra show', async () => {
    const fake = fakeConnection(['ok'])
    renderHook(() => useCustomizeTab(fake.getConnection, true))
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true }))
    act(() => fake.status({ available: true, tabId: 7 }))
    await act(async () => {})
    expect(fake.shows).toHaveLength(1)
  })
})

/** Flips `document.visibilityState` and fires `visibilitychange`, as a parked page does. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useCustomizeTab — the page turning visible again', () => {
  afterEach(() => setVisibility('visible'))

  it('a page reopened from the tray shows the tab again, at the segment it was on', async () => {
    const fake = fakeConnection(['ok'])
    renderHook(() => useCustomizeTab(fake.getConnection, true))
    await waitFor(() => expect(fake.subscribed()).toBe(true))
    act(() => fake.status({ available: true, tabId: 7, path: '/customize/plugins' }))
    expect(fake.shows).toHaveLength(1)

    act(() => setVisibility('hidden'))
    await act(async () => {})
    expect(fake.shows).toHaveLength(1)

    act(() => setVisibility('visible'))
    await waitFor(() => expect(fake.shows).toHaveLength(2))
    expect(fake.shows[1]).toEqual({ url: customizeUrl('plugins') })
  })

  it('a closed screen does not show the tab when the page turns visible', async () => {
    const fake = fakeConnection(['ok'])
    const { rerender } = renderHook(({ open }) => useCustomizeTab(fake.getConnection, open), {
      initialProps: { open: true },
    })
    await waitFor(() => expect(fake.shows).toHaveLength(1))
    rerender({ open: false })
    act(() => setVisibility('hidden'))
    act(() => setVisibility('visible'))
    await act(async () => {})
    expect(fake.shows).toHaveLength(1)
  })
})

describe('CustomizeScreen — the unavailable state', () => {
  const screen = (getConnection: () => Promise<RuntimeConnection>) =>
    render(
      createElement(CustomizeScreen, {
        runtimeConnection: getConnection,
        shell: null,
        onClose: () => {},
        onOpenSettings: () => {},
      }),
    )

  it('replaces the placeholder with a message and a retry, and the retry brings the placeholder back', async () => {
    const fake = fakeConnection(['fail', 'ok'])
    const view = screen(fake.getConnection)
    expect(view.queryByTestId('webview-area')).not.toBeNull()

    await waitFor(() => expect(view.queryByTestId('customize-unavailable')).not.toBeNull())
    expect(view.queryByTestId('webview-area')).toBeNull()
    expect(view.getByTestId('customize-unavailable').textContent).toContain(EN_MESSAGES['customize.unavailable'])
    const retry = view.getByTestId('customize-retry')
    expect(retry.textContent).toBe(EN_MESSAGES['customize.retry'])

    fireEvent.click(retry)
    await waitFor(() => expect(fake.shows).toHaveLength(2))
    await act(async () => {})
    expect(view.queryByTestId('customize-unavailable')).toBeNull()
    expect(view.queryByTestId('webview-area')).not.toBeNull()
  })
})
