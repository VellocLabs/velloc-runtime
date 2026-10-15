// @vitest-environment happy-dom
/**
 * `useModsUiView` across a session switch (F-25): the
 * value is the view read for the CURRENT session — never, for the render
 * before the new view lands, the previous session's panes, which the shell
 * would fold into the new session's Right Panel as freshly opened tabs.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { useModsUiView } from '../browser/webview/mods/modsUiView'

afterEach(() => cleanup())

type Handler = (event: { type?: string; payload: unknown }) => void

function fakeConnection() {
  const handlers = new Map<string, Handler>()
  const connection = {
    subscribe: (topic: string, handler: Handler) => {
      handlers.set(topic, handler)
      return () => handlers.delete(topic)
    },
    can: () => true,
    request: async () => ({}),
  } as unknown as RuntimeConnection
  return {
    getConnection: async () => connection,
    emit: (topic: string, type: string, payload: unknown) => handlers.get(topic)?.({ type, payload }),
    has: (topic: string) => handlers.has(topic),
  }
}

const pane = (id: string) => ({ plugin: 'p', id, title: id, isShown: true, isFocused: false, closeOnEscape: false })

describe('useModsUiView — a session switch', () => {
  it("shows nothing of the old session's panes until the new session's state lands", async () => {
    const fake = fakeConnection()
    const { result, rerender } = renderHook(({ sessionId }) => useModsUiView(fake.getConnection, sessionId), {
      initialProps: { sessionId: 's1' },
    })
    expect(result.current.isLoaded ?? false).toBe(false)
    await waitFor(() => expect(fake.has('mods/ui/s1')).toBe(true))
    act(() => fake.emit('mods/ui/s1', 'state', { status: [], notices: [], panes: [pane('a')] }))
    expect(result.current.isLoaded).toBe(true)
    expect(result.current.panes.map(row => row.id)).toEqual(['a'])

    rerender({ sessionId: 's2' })
    // The first render under s2: s1's panes are gone, and the view is not loaded.
    expect(result.current.panes).toEqual([])
    expect(result.current.isLoaded ?? false).toBe(false)
    await waitFor(() => expect(fake.has('mods/ui/s2')).toBe(true))
    act(() => fake.emit('mods/ui/s2', 'state', { status: [], notices: [], panes: [pane('b')] }))
    expect(result.current.panes.map(row => row.id)).toEqual(['b'])
  })
})
