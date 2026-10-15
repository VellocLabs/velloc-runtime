// @vitest-environment happy-dom
import { createElement as h, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useAssistantState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

/**
 * Pins the vendored `@assistant-ui/store` patch (`patches/@assistant-ui+store+*.patch`): a by-index read past
 * the end of a non-empty client lookup clamps to the last element instead of throwing
 * (`tapClientLookup: Index N out of bounds`). Fails after an @assistant-ui upgrade if the patch did not apply.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const MESSAGES: ThreadMessageLike[] = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
]

const Row: FC = () => {
  const id = useAssistantState(s => s.message.id)
  const role = useAssistantState(s => s.message.role)
  return h('div', { 'data-slot': 'row' }, `${role}:${id}`)
}

const ROW_COMPONENTS = { Message: Row }

const Harness: FC<{ index: number }> = ({ index }) => {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: MESSAGES,
    convertMessage: m => m,
    isRunning: false,
    onNew: async () => {},
  })
  return h(
    AssistantRuntimeProvider,
    { runtime },
    h(
      ThreadPrimitive.Root,
      null,
      h(ThreadPrimitive.MessageByIndex, {
        index,
        components: ROW_COMPONENTS,
      } as never),
    ),
  )
}

describe('stale by-index reads against a shrunk client lookup', () => {
  it('clamps a read past the end to the last element instead of crashing the render', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Index 5 against a 2-message list — what a still-mounted row at a
    // removed index sees for one frame after the list shrinks.
    const { container } = render(h(Harness, { index: 5 }))

    expect(container.querySelector('[data-slot="row"]')?.textContent).toBe(
      'assistant:a1',
    )
    // The clamp is observable in the console (rate-limited), so the races it
    // absorbs stay diagnosable — the boundary's crash log disappears with the
    // crash itself.
    expect(
      warn.mock.calls.some(call => String(call[0]).includes('tapClientLookup')),
    ).toBe(true)
  })

  it('still throws for a negative index — the clamp only forgives the shrink race', () => {
    // Silence React's error-boundary-less render error reporting.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(h(Harness, { index: -1 }))).toThrow(/out of bounds/)
  })
})
