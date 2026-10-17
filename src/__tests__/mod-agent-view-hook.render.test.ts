// @vitest-environment happy-dom
/**
 * `useModAgentView` (F-25, `$.ui.view`): each new `seq` on the watched
 * session's mods UI state acts once — a teammate is focused and the lead stays
 * the one watched, a subagent is shown over the conversation, a view with no
 * agent goes back; the first state read is taken as seen.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { useModAgentView } from '../browser/webview/mods/useModAgentView'

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
    state: (sessionId: string, view?: unknown) =>
      handlers.get(`mods/ui/${sessionId}`)?.({ type: 'state', payload: { status: [], notices: [], ...(view ? { view } : {}) } }),
    has: (sessionId: string) => handlers.has(`mods/ui/${sessionId}`),
  }
}

function mount(fake: ReturnType<typeof fakeConnection>, initial: string) {
  const calls: string[] = []
  const hook = renderHook(
    ({ active }) =>
      useModAgentView(fake.getConnection, active, {
        focusSession: id => calls.push(`focus ${id}`),
        showSubagent: id => calls.push(`show ${id}`),
        leaveSubagent: () => calls.push('leave'),
      }),
    { initialProps: { active: initial } },
  )
  return { calls, hook }
}

describe('useModAgentView', () => {
  it('a view already asked for before the page read the state is not replayed; a later one acts once', async () => {
    const fake = fakeConnection()
    const { calls } = mount(fake, 'lead')
    await waitFor(() => expect(fake.has('lead')).toBe(true))
    act(() => fake.state('lead', { seq: 4, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }))
    expect(calls).toEqual([])
    act(() => fake.state('lead', { seq: 5, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }))
    act(() => fake.state('lead', { seq: 5, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }))
    expect(calls).toEqual(['show a1'])
    act(() => fake.state('lead', { seq: 6 }))
    expect(calls).toEqual(['show a1', 'leave'])
  })

  it("a teammate is focused and the lead's state stays watched; the way back focuses the lead", async () => {
    const fake = fakeConnection()
    const { calls, hook } = mount(fake, 'lead')
    await waitFor(() => expect(fake.has('lead')).toBe(true))
    act(() => fake.state('lead'))
    act(() => fake.state('lead', { seq: 1, agentId: 'teammate-bo', kind: 'teammate', sessionId: 'teammate-bo' }))
    expect(calls).toEqual(['focus teammate-bo'])
    hook.rerender({ active: 'teammate-bo' })
    expect(fake.has('lead')).toBe(true)
    expect(fake.has('teammate-bo')).toBe(false)
    act(() => fake.state('lead', { seq: 2 }))
    expect(calls).toEqual(['focus teammate-bo', 'focus lead'])
  })

  it("a subagent asked for while a teammate is shown: the lead is focused, then the subagent shown there", async () => {
    const fake = fakeConnection()
    const { calls, hook } = mount(fake, 'lead')
    await waitFor(() => expect(fake.has('lead')).toBe(true))
    act(() => fake.state('lead'))
    act(() => fake.state('lead', { seq: 1, agentId: 'teammate-bo', kind: 'teammate', sessionId: 'teammate-bo' }))
    hook.rerender({ active: 'teammate-bo' })
    act(() => fake.state('lead', { seq: 2, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }))
    expect(calls).toEqual(['focus teammate-bo', 'focus lead'])
    hook.rerender({ active: 'lead' })
    await waitFor(() => expect(calls).toEqual(['focus teammate-bo', 'focus lead', 'show a1']))
  })

  it('once the person leaves the shown teammate, the active session is read and the lead can no longer pull them back', async () => {
    const fake = fakeConnection()
    const { calls, hook } = mount(fake, 'lead')
    await waitFor(() => expect(fake.has('lead')).toBe(true))
    act(() => fake.state('lead'))
    act(() => fake.state('lead', { seq: 1, agentId: 'teammate-bo', kind: 'teammate', sessionId: 'teammate-bo' }))
    hook.rerender({ active: 'teammate-bo' })
    hook.rerender({ active: 'other' })
    await waitFor(() => expect(fake.has('other')).toBe(true))
    expect(fake.has('lead')).toBe(false)
    act(() => fake.state('other'))
    act(() => fake.state('other', { seq: 7, agentId: 'a9', kind: 'subagent', sessionId: 'a9' }))
    expect(calls).toEqual(['focus teammate-bo', 'show a9'])
  })

  it('a subagent asked for by the lead after the person went back to it by hand is shown at once', async () => {
    const fake = fakeConnection()
    const { calls, hook } = mount(fake, 'lead')
    await waitFor(() => expect(fake.has('lead')).toBe(true))
    act(() => fake.state('lead'))
    act(() => fake.state('lead', { seq: 1, agentId: 'teammate-bo', kind: 'teammate', sessionId: 'teammate-bo' }))
    hook.rerender({ active: 'teammate-bo' })
    hook.rerender({ active: 'lead' })
    await waitFor(() => expect(fake.has('lead')).toBe(true))
    act(() => fake.state('lead', { seq: 2 }))
    act(() => fake.state('lead', { seq: 3, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }))
    expect(calls).toEqual(['focus teammate-bo', 'show a1'])
  })

  it('a view a session asked for while the page watched another is not replayed on return', async () => {
    const fake = fakeConnection()
    const { calls, hook } = mount(fake, 'a')
    await waitFor(() => expect(fake.has('a')).toBe(true))
    act(() => fake.state('a', { seq: 1 }))
    hook.rerender({ active: 'b' })
    await waitFor(() => expect(fake.has('b')).toBe(true))
    act(() => fake.state('b'))
    hook.rerender({ active: 'a' })
    await waitFor(() => expect(fake.has('a')).toBe(true))
    act(() => fake.state('a', { seq: 2, agentId: 'teammate-bo', kind: 'teammate', sessionId: 'teammate-bo' }))
    expect(calls).toEqual([])
    act(() => fake.state('a', { seq: 3, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }))
    expect(calls).toEqual(['show a1'])
  })

  it("going back in one session leaves another session's subagent shown", async () => {
    const fake = fakeConnection()
    const { calls, hook } = mount(fake, 'a')
    await waitFor(() => expect(fake.has('a')).toBe(true))
    act(() => fake.state('a'))
    act(() => fake.state('a', { seq: 1, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }))
    hook.rerender({ active: 'b' })
    await waitFor(() => expect(fake.has('b')).toBe(true))
    act(() => fake.state('b'))
    act(() => fake.state('b', { seq: 2 }))
    expect(calls).toEqual(['show a1'])
    hook.rerender({ active: 'a' })
    await waitFor(() => expect(fake.has('a')).toBe(true))
    act(() => fake.state('a', { seq: 1, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }))
    act(() => fake.state('a', { seq: 3 }))
    expect(calls).toEqual(['show a1', 'leave'])
  })
})
