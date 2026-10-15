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
  children,
}: {
  onCancel: () => void
  pendingMessage?: string | null
  /** Extra controls rendered inside the composer (the upstream-contract test
   *  mounts a bare `ComposerPrimitive.Cancel` here). */
  children?: ReactNode
}) {
  // `isRunning: true` + an empty composer is exactly what makes Stop visible
  // (`resolveComposerActionVisibility`), and it is the state a send-then-Stop
  // lands in.
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: MESSAGES,
    convertMessage: m => m,
    isRunning: true,
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
