import { describe, expect, it } from 'vitest'
import { isConversationResumable } from '../sessions/sessionStore'
import type { Message } from '../runtime/RuntimeTypes'
import {
  TERMINAL_ABORTED,
  TERMINAL_API_ERROR,
  TERMINAL_COMPLETED,
  TERMINAL_MAX_OUTPUT_TOKENS,
} from '../runtime/VercelModelConstants'

const userPrompt: Message = {
  type: 'user',
  uuid: 'u-1',
  timestamp: '2026-04-03T12:00:00.000Z',
  message: { role: 'user', content: 'do the thing' },
} as Message

const apiErrorAssistant: Message = {
  type: 'assistant',
  uuid: 'a-error',
  timestamp: '2026-04-03T12:00:01.000Z',
  isApiErrorMessage: true,
  error: 'server_error',
  errorDetails: 'HTTP 503',
  errorRetryCount: 10,
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'API Error: HTTP 503' }],
  },
} as unknown as Message

describe('isConversationResumable', () => {
  it('is NOT resumable after an api_error terminal — the ProviderApiErrorCard owns retry', () => {
    // Regression pin: an exhausted-retry turn ends via `worker.completed`
    // (client status 'ready', never 'error') with the synthetic error
    // ASSISTANT message as the last transcript entry. `api_error` used to be
    // absent from BOTH reason sets, fell through to the last-message-type
    // check, and returned true — rendering the "Continue" control side by
    // side with the error card's own Retry button.
    expect(
      isConversationResumable(
        TERMINAL_API_ERROR,
        [userPrompt, apiErrorAssistant],
        'ready',
      ),
    ).toBe(false)
  })

  it('stays resumable for an aborted turn', () => {
    expect(
      isConversationResumable(TERMINAL_ABORTED, [userPrompt], 'ready'),
    ).toBe(true)
  })

  it('stays resumable after hitting the output-token limit', () => {
    expect(
      isConversationResumable(
        TERMINAL_MAX_OUTPUT_TOKENS,
        [userPrompt],
        'ready',
      ),
    ).toBe(true)
  })

  it('is not resumable after natural completion', () => {
    expect(
      isConversationResumable(TERMINAL_COMPLETED, [userPrompt], 'ready'),
    ).toBe(false)
  })

  it('is not resumable while the client is in the error state', () => {
    expect(
      isConversationResumable(TERMINAL_ABORTED, [userPrompt], 'error'),
    ).toBe(false)
  })

  it('is not resumable while the terminal reason is unknown — the UI-ready split provisional window', () => {
    // During the provisional boot window (`worker.uiReady`) the transcript is
    // visible and the client status is 'ready', but `lastTerminalReason` is
    // not restored until just before `worker.ready`. The Continue affordance
    // must stay hidden until then: an undefined reason cannot distinguish an
    // interrupted turn from a normal completion, and any premature click
    // would inject a continuation into a conversation that may not need one.
    // (Once the reason IS restored, the runtime build is complete, so a
    // Continue click never needs the submit hold.)
    expect(isConversationResumable(undefined, [userPrompt], 'ready')).toBe(
      false,
    )
  })
})
