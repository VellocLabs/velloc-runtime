// @vitest-environment happy-dom
import { createElement as h, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import { TRANSCRIPT_MESSAGE_COMPONENTS } from '../components/assistant-ui/thread'
import {
  USER_MESSAGE_MAX_DISPLAY_LINES,
  userMessageTranscriptLine,
} from '../components/assistant-ui/user-message-text'
import { TooltipProvider } from '../components/ui/tooltip'
import { withoutReasoningParts } from '../browser/webview/showReasoning'

// The row's labels go through i18n; echo the key.
vi.mock('../browser/webview/i18n', () => ({
  useT: () => (key: string) => key,
}))

afterEach(() => cleanup())

/**
 * A user row declares the transcript line it renders (`data-line-ordinal`), so a search reveal can flash inside it.
 * Mounted through `TRANSCRIPT_MESSAGE_COMPONENTS` with parts stamped as the conversion stamps them (`sourceLine`).
 */

const SHORT = '实现这个 last_event_time + idle，但是注意两种不同的provider'
const LONG = Array.from(
  { length: USER_MESSAGE_MAX_DISPLAY_LINES + 5 },
  (_, i) => `line-${i + 1} 如何移除？我验证一下`,
).join('\n')

// The shapes the adapter really produces (`convertTranscriptToThreadMessages`):
// a plain user message is a STRING with the row's range in
// `metadata.custom` — the parts it becomes are rebuilt by assistant-ui and
// carry no stamp — while a message with images is a parts ARRAY whose parts
// carry `sourceLine`.
const MESSAGES: ThreadMessageLike[] = [
  {
    id: 'u-short',
    role: 'user',
    content: SHORT,
    metadata: { custom: { lineFrom: 72, lineTo: 72 } },
  },
  {
    id: 'u-long',
    role: 'user',
    content: LONG,
    metadata: { custom: { lineFrom: 88, lineTo: 90 } },
  },
  // A live turn: not persisted yet, no line to declare.
  {
    id: 'u-live',
    role: 'user',
    content: 'still streaming',
  },
  {
    id: 'u-image',
    role: 'user',
    content: [
      { type: 'image', image: 'data:image/png;base64,AA==', sourceLine: 5 } as never,
      { type: 'text', text: 'what is this', sourceLine: 5 } as never,
    ],
    metadata: { custom: { lineFrom: 5, lineTo: 5 } },
  },
]

const Harness: FC<{ index: number }> = ({ index }) => {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: MESSAGES,
    convertMessage: m => m,
    isRunning: false,
    onNew: async () => {},
  })
  return h(
    TooltipProvider,
    null,
    h(
      AssistantRuntimeProvider,
      { runtime },
      h(
        ThreadPrimitive.Root,
        null,
        h(ThreadPrimitive.MessageByIndex, {
          index,
          components: TRANSCRIPT_MESSAGE_COMPONENTS,
        } as never),
      ),
    ),
  )
}

const bubble = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.aui-user-message-content')

describe('user message rows declare their transcript line', () => {
  it('reads the line off the parts when stamped, else off the row range', () => {
    // The common shape: string content, line only in the row range.
    expect(
      userMessageTranscriptLine(MESSAGES[0]!.content, MESSAGES[0]!.metadata),
    ).toBe(72)
    // The parts win when they carry it (they are exact by construction).
    expect(
      userMessageTranscriptLine(MESSAGES[3]!.content, {
        custom: { lineFrom: 999 },
      }),
    ).toBe(5)
    // Nothing anywhere → null; a negative or non-numeric stamp is no stamp.
    expect(userMessageTranscriptLine('still streaming', undefined)).toBeNull()
    expect(userMessageTranscriptLine('x', { custom: {} })).toBeNull()
    expect(userMessageTranscriptLine('x', { custom: { lineFrom: '72' } })).toBeNull()
    expect(
      userMessageTranscriptLine([{ type: 'text', text: 'x', sourceLine: -1 }], {
        custom: { lineFrom: -1 },
      }),
    ).toBeNull()
  })

  it('stamps the bubble of a short message with its line', () => {
    const { container } = render(h(Harness, { index: 0 }))
    const el = bubble(container)
    expect(el, 'the user bubble rendered').not.toBeNull()
    // THE regression: without this the reveal finds nothing carrying the
    // line inside the row and goes quiet.
    expect(el!.getAttribute('data-line-ordinal')).toBe('72')
    expect(el!.textContent).toContain('last_event_time + idle')
  })

  it('stamps the visible text of a long (collapsed) message, and the full body once opened', () => {
    const { container } = render(h(Harness, { index: 1 }))
    expect(bubble(container)?.getAttribute('data-line-ordinal')).toBe('88')
    // The collapsed preview is what is on screen, so it carries the line
    // too — one level below the bubble, which makes it the innermost
    // element the reveal stops on. Stopping there (and not on the bubble)
    // is what keeps the reveal from clicking the "show full" toggle just
    // to look inside.
    const preview = container.querySelector<HTMLElement>(
      '[data-role="user-message-preview"]',
    )
    expect(preview).not.toBeNull()
    expect(preview!.getAttribute('data-line-ordinal')).toBe('88')
    // Radix keeps the full body MOUNTED while collapsed — hidden and empty.
    // It must not carry the line in that state: it would be the innermost
    // match, and the reveal would stop on an invisible element (no flash,
    // arrow parked on a zero-size rect).
    const hiddenFull = container.querySelector<HTMLElement>(
      '[data-role="user-message-full"]',
    )
    expect(hiddenFull?.hasAttribute('hidden')).toBe(true)
    expect(hiddenFull?.hasAttribute('data-line-ordinal')).toBe(false)

    const toggle = container.querySelector<HTMLButtonElement>(
      '.aui-user-message-toggle',
    )
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle!)

    const full = container.querySelector<HTMLElement>(
      '[data-role="user-message-full"]',
    )
    expect(full, 'expanded').not.toBeNull()
    expect(full!.getAttribute('data-line-ordinal')).toBe('88')
  })

  it('declares nothing for a message that has no line yet', () => {
    const { container } = render(h(Harness, { index: 2 }))
    const el = bubble(container)
    expect(el).not.toBeNull()
    expect(el!.hasAttribute('data-line-ordinal')).toBe(false)
  })

  it('stamps a message with images from its parts', () => {
    const { container } = render(h(Harness, { index: 3 }))
    expect(bubble(container)?.getAttribute('data-line-ordinal')).toBe('5')
  })
})

// Same row routing, for the assistant row Show reasoning (off) strips to
// nothing (`withoutReasoningParts`). It stays in the list — rows are indexed
// one-for-one — but must not draw an empty bubble.
const RowHarness: FC<{ messages: ThreadMessageLike[]; index: number }> = ({
  messages,
  index,
}) => {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: m => m,
    isRunning: false,
    onNew: async () => {},
  })
  return h(
    TooltipProvider,
    null,
    h(
      AssistantRuntimeProvider,
      { runtime },
      h(
        ThreadPrimitive.Root,
        null,
        h(ThreadPrimitive.MessageByIndex, {
          index,
          components: TRANSCRIPT_MESSAGE_COMPONENTS,
        } as never),
      ),
    ),
  )
}

describe('assistant row stripped of all its reasoning', () => {
  const rows = withoutReasoningParts([
    { id: 'u-1', role: 'user', content: 'hi' },
    {
      id: 'a-thinking',
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'pondering' }],
    },
    {
      id: 'a-text',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'pondering' },
        { type: 'text', text: 'Hello.' },
      ],
    },
  ] as ThreadMessageLike[])
  const root = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.aui-assistant-message-root')

  it('collapses instead of rendering a blank bubble', () => {
    const { container } = render(h(RowHarness, { messages: rows, index: 1 }))
    expect(root(container), 'the row stays mounted').not.toBeNull()
    expect(root(container)!.classList.contains('hidden')).toBe(true)
  })

  it('leaves a row with something left to show alone', () => {
    const { container } = render(h(RowHarness, { messages: rows, index: 2 }))
    expect(root(container)!.classList.contains('hidden')).toBe(false)
  })
})
