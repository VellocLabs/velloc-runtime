// @vitest-environment happy-dom
/**
 * An assistant reply's text part as a mod's `AssistantMessage` site (F-25): "one text block of an assistant reply in the transcript; a rewrite
 * changes the drawing and leaves the stored message alone". Driven through a
 * real assistant-ui runtime, so the part's index — the `requestId`'s second
 * half — is the one `PartByIndex` gives it.
 */
import { createElement, type FC } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { AssistantText, isModelReplyRow } from '../components/assistant-ui/assistant-text'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'

const reply = (over: Partial<ThreadMessageLike> = {}): ThreadMessageLike => ({
  id: 'm-1',
  role: 'assistant',
  content: [
    { type: 'text', text: 'First block.' },
    { type: 'reasoning', text: 'thinking it over' },
    { type: 'text', text: 'Second block.' },
  ],
  status: { type: 'complete', reason: 'stop' },
  ...over,
})

function Harness({ message, ui, isRunning = false }: { message: ThreadMessageLike; ui: Partial<ModUiContextValue>; isRunning?: boolean }) {
  const AssistantMessage: FC = () =>
    createElement(MessagePrimitive.Parts, {
      components: { Text: AssistantText, Reasoning: () => createElement('i', null, 'reasoning') },
    })
  const UserMessage: FC = () => null
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [message],
    convertMessage: (m) => m,
    isRunning,
    onNew: async () => {},
  })
  return createElement(
    ModUiContext.Provider,
    { value: { ...EMPTY_MOD_UI, ...ui } },
    createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(
        ThreadPrimitive.Root,
        null,
        createElement(ThreadPrimitive.Messages, { components: { AssistantMessage, UserMessage } }),
      ),
    ),
  )
}

const HOOKED = [{ plugin: 'memaid', component: 'AssistantMessage' }]

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AssistantText — the AssistantMessage site', () => {
  it("unhooked, each block is the engine's markdown and asks for nothing", async () => {
    const renderSite = vi.fn()
    const { container } = render(createElement(Harness, { message: reply(), ui: { render: renderSite } }))
    await waitFor(() => expect(container.textContent).toContain('Second block.'))
    expect(container.querySelector('[data-slot="mod-assistant-message"]')).toBeNull()
    expect(renderSite).not.toHaveBeenCalled()
  })

  it('hooked, each text block asks once with its own id and its place in the reply; reasoning asks nothing', async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const }))
    render(createElement(Harness, { message: reply(), ui: { render: renderSite, hooked: HOOKED } }))
    // Each block is asked again once the site measures its viewport, as every
    // engine-drawn site is; what matters is which blocks are asked, and as what.
    const asked = () => [...new Set((renderSite.mock.calls as unknown as Array<[{ requestId: string }]>).map(([input]) => input.requestId))].sort()
    await waitFor(() => expect(asked()).toEqual(['m-1:0', 'm-1:2']))
    expect(renderSite).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'AssistantMessage', requestId: 'm-1:0', props: { text: 'First block.', isFirstOfReply: true } }),
    )
    expect(renderSite).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'AssistantMessage', requestId: 'm-1:2', props: { text: 'Second block.', isFirstOfReply: false } }),
    )
  })

  it("a text rewrite draws in the block alone, as markdown; a hook's tree draws in its place", async () => {
    const renderSite = vi.fn(async (input: { requestId: string }) =>
      input.requestId === 'm-1:0'
        ? { kind: 'engine' as const, rewrite: { text: 'Rewritten **first**.' } }
        : { kind: 'tree' as const, tree: { type: 'Text', children: ['DRAWN BY MOD'] }, plugin: 'memaid' },
    )
    const { container } = render(createElement(Harness, { message: reply(), ui: { render: renderSite as never, hooked: HOOKED } }))
    await waitFor(() => expect(container.textContent).toContain('DRAWN BY MOD'))
    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('first'))
    expect(container.textContent).not.toContain('First block.')
    expect(container.textContent).not.toContain('Second block.')
  })

  it('a block still streaming draws as the engine\'s and asks nothing until it settles', async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const }))
    const streaming = reply({ content: [{ type: 'text', text: 'Partial' }], status: { type: 'running' } })
    const { rerender } = render(createElement(Harness, { message: streaming, isRunning: true, ui: { render: renderSite, hooked: HOOKED } }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(renderSite).not.toHaveBeenCalled()
    const settled = reply({ content: [{ type: 'text', text: 'Partial, now whole.' }] })
    rerender(createElement(Harness, { message: settled, ui: { render: renderSite, hooked: HOOKED } }))
    await waitFor(() =>
      expect(renderSite).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'm-1:0', props: { text: 'Partial, now whole.', isFirstOfReply: true } }),
      ),
    )
  })

  it("a row the adapter made of something else — a system row, a command's output — is not raised", async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const }))
    const system = reply({ content: [{ type: 'text', text: 'Total: $0.12' }], metadata: { custom: { sourceType: 'system' } } })
    const { container } = render(createElement(Harness, { message: system, ui: { render: renderSite, hooked: HOOKED } }))
    await waitFor(() => expect(container.textContent).toContain('Total: $0.12'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(renderSite).not.toHaveBeenCalled()
  })
})

describe('isModelReplyRow', () => {
  it('a persisted reply and a live one are replies; a live system row and every other source are not', () => {
    expect(isModelReplyRow(undefined)).toBe(true)
    expect(isModelReplyRow({})).toBe(true)
    expect(isModelReplyRow({ sourceType: 'live_events' })).toBe(true)
    expect(isModelReplyRow({ sourceType: 'live_events', subtype: 'informational' })).toBe(false)
    expect(isModelReplyRow({ sourceType: 'system' })).toBe(false)
    expect(isModelReplyRow({ sourceType: 'provider_api_error' })).toBe(false)
    expect(isModelReplyRow({ sourceType: 'interrupt' })).toBe(false)
  })
})
