// @vitest-environment happy-dom
import { createElement, type FC, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useAssistantState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import {
  ComposerAction,
  ComposerCancelStateProvider,
} from '../components/assistant-ui/thread'
import { PendingMessageProvider } from '../components/assistant-ui/next-message-strip'
import { TooltipProvider } from '../components/ui/tooltip'
import { convertBrowserRuntimeStateToThreadMessages } from '../browser/webview/assistantUiAdapter'
import type { BrowserRuntimeClientState } from '../browser/webview/BrowserRuntimeClient'

// The composer's labels go through i18n; echo the key.
vi.mock('../browser/webview/i18n', () => ({
  useT: () => (key: string) => key,
}))

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
// Stop must not adopt assistant-ui's "cancel undoes the last user message" (`cancelRun()` deletes the trailing
// user message and refills the composer): the worker persists the message, so taking both shows it twice.
// ---------------------------------------------------------------------------

const SENT = 'stop me right after sending'

const MESSAGES: ThreadMessageLike[] = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: SENT }] },
]

function Harness({
  onCancel,
  pendingMessage = null,
  messages = MESSAGES,
  isRunning = true,
  children,
}: {
  onCancel: () => void
  pendingMessage?: string | null
  messages?: ThreadMessageLike[]
  isRunning?: boolean
  /** Extra controls rendered inside the composer (the upstream-contract test
   *  mounts a bare `ComposerPrimitive.Cancel` here). */
  children?: ReactNode
}) {
  // `isRunning: true` + an empty composer is exactly what makes Stop visible
  // (`resolveComposerActionVisibility`), and it is the state a send-then-Stop
  // lands in.
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: m => m,
    isRunning,
    onNew: async () => {},
    onCancel: async () => {
      onCancel()
    },
  })

  const composer = createElement(
    ComposerPrimitive.Root,
    null,
    createElement(ComposerPrimitive.Input as never, {}),
    createElement(ComposerTextProbe),
    createElement(ComposerAction),
    children,
  )

  return createElement(
    TooltipProvider,
    null,
    createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(
        ComposerCancelStateProvider,
        { value: { isStopping: false, onCancel } },
        createElement(
          PendingMessageProvider,
          { value: pendingMessage },
          composer,
        ),
      ),
    ),
  ) as ReturnType<FC>
}

/**
 * The composer's own state, not the DOM `<textarea>`. `ComposerPrimitive.Input`
 * renders through `react-textarea-autosize`, whose value does not settle in
 * happy-dom — and the state is the thing under test anyway (what `setText` put
 * there), with the input merely mirroring it in a real browser.
 */
const ComposerTextProbe: FC = () => {
  const text = useAssistantState(s => s.composer.text)
  return createElement('span', { 'data-testid': 'composer-text' }, text)
}

function composerValue(container: HTMLElement): string {
  return (
    container.querySelector('[data-testid="composer-text"]')?.textContent ?? ''
  )
}

describe('composer Stop button', () => {
  it('stays available across a mid-turn completion and the next response boundary', async () => {
    const onCancel = vi.fn()
    const state = {
      status: 'submitting', snapshot: null, lastError: null,
      transcriptMessages: [], liveEvents: [],
      pendingPrompt: 'work', pendingPromptId: 'user-1',
    } as unknown as BrowserRuntimeClientState
    const notice = { type: 'attachment', uuid: 'notice', attachment: {
      type: 'queued_command', commandMode: 'task-notification',
      prompt: '<task-notification>\n<task-id>b12345678</task-id>\n<task-type>local_bash</task-type>\n<status>completed</status>\n<summary>Finished</summary>\n</task-notification>',
    } }
    const events = [
      { type: 'assistant', uuid: 'tool-a', message: { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'Bash', args: { command: 'pwd' } },
      ] } },
      notice,
      { type: 'stream_request_start' },
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } },
      { type: 'assistant', uuid: 'tool-b', message: { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'b', toolName: 'Bash', args: { command: 'pwd' } },
      ] } },
    ]
    const element = () => createElement(Harness, {
      onCancel, messages: convertBrowserRuntimeStateToThreadMessages(state),
      isRunning: state.status === 'submitting',
    })
    const { container, rerender } = render(element())
    for (const event of events) {
      state.liveEvents = [...state.liveEvents, event as never]
      rerender(element())
      expect(container.querySelector('[data-testid="composer-cancel"]')).not.toBeNull()
    }
    state.status = 'ready'
    state.liveEvents = []
    state.transcriptMessages = [{ type: 'assistant', uuid: 'tool-b', message: {
      role: 'assistant', content: [{ type: 'text', text: 'done' }],
    } } as never]
    state.pendingPrompt = null
    rerender(element())
    await waitFor(() => expect(container.querySelector('[data-testid="composer-cancel"]')).toBeNull())
  })

  it('halts the turn without putting the sent message back in the composer', async () => {
    const onCancel = vi.fn()
    const { container } = render(createElement(Harness, { onCancel }))

    const stop = container.querySelector(
      '[data-testid="composer-cancel"]',
    ) as HTMLButtonElement | null
    expect(stop, 'Stop is visible while running with an empty composer').not
      .toBeNull()

    fireEvent.click(stop!)

    expect(onCancel).toHaveBeenCalledTimes(1)
    // The refill lands a microtask after the click (cancelRun → setText), so
    // give React a flush before believing the composer is clean.
    await waitFor(() => {
      expect(
        composerValue(container),
        'a SENT message must stay in the conversation only — refilling the composer shows it twice',
      ).toBe('')
    })
    expect(composerValue(container)).toBe('')
  })

  it('assistant-ui`s own Cancel primitive DOES refill it — which is why Stop bypasses it', async () => {
    // Pins the upstream behaviour the bypass exists for. If an @assistant-ui
    // upgrade makes this fail, `cancelRun` stopped undoing the send and the
    // bypass in `handleCancelClick` can be reconsidered.
    const onCancel = vi.fn()
    const { container } = render(
      createElement(Harness, {
        onCancel,
        children: createElement(
          ComposerPrimitive.Cancel as never,
          { 'data-testid': 'upstream-cancel' },
          'stop',
        ),
      }),
    )

    fireEvent.click(
      container.querySelector(
        '[data-testid="upstream-cancel"]',
      ) as HTMLButtonElement,
    )

    await waitFor(() => {
      expect(composerValue(container)).toBe(SENT)
    })
  })

  it('still hands a PARKED next message back to the composer', async () => {
    // The other half of the matrix: a parked message never entered the
    // conversation, so Stop must return it rather than destroy it. This is the
    // case that accidentally masked the bug above.
    const onCancel = vi.fn()
    const { container } = render(
      createElement(Harness, { onCancel, pendingMessage: 'parked follow-up' }),
    )

    fireEvent.click(
      container.querySelector(
        '[data-testid="composer-cancel"]',
      ) as HTMLButtonElement,
    )

    expect(onCancel).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(composerValue(container)).toBe('parked follow-up')
    })
    // …and only the parked text — never the message that started the turn.
    expect(composerValue(container)).not.toContain(SENT)
  })
})
