/**
 * Transcript-recovery filters on resume/continue: `isApiErrorMessage` assistants, whitespace-only assistant turns
 * and inline base64 images are filtered from the request, and turn-interruption detection skips error messages.
 */

import { describe, expect, it } from 'vitest'
import {
  dropEmptyAssistantTurns,
  dropErrorCardTurns,
  dropBlankAssistantTurns,
  isErrorCardTurn,
  prepareHistoryForModel,
  dropMediaBeforeMediaError,
} from '../messages/prepareModelHistory'
import type { Message } from '../runtime/RuntimeTypes'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_USER,
  PART_IMAGE,
  PART_TEXT,
  ROLE_ASSISTANT,
  ROLE_USER,
} from '../runtime/VercelModelConstants'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantMessage(
  uuid: string,
  content: Array<Record<string, unknown>>,
  extra?: Record<string, unknown>,
): Message {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid,
    message: { role: ROLE_ASSISTANT, content },
    ...extra,
  } as unknown as Message
}

function apiErrorAssistant(
  uuid: string,
  text: string,
  error = 'server_error',
): Message {
  return assistantMessage(uuid, [{ type: PART_TEXT, text }], {
    isApiErrorMessage: true,
    error,
    errorDetails: text,
  })
}

function userMessage(uuid: string, text: string): Message {
  return {
    type: MSG_TYPE_USER,
    uuid,
    message: { role: ROLE_USER, content: text },
  } as unknown as Message
}

function userMessageWithImage(uuid: string, text: string): Message {
  return {
    type: MSG_TYPE_USER,
    uuid,
    message: {
      role: ROLE_USER,
      content: [
        { type: PART_IMAGE, image: 'iVBORw0KGgoAAAANSUhEUg==', mimeType: 'image/png' },
        { type: PART_TEXT, text },
      ],
    },
  } as unknown as Message
}

function systemApiError(uuid: string, attempt: number): Message {
  return {
    type: MSG_TYPE_SYSTEM,
    uuid,
    subtype: 'api_error',
    message: `API Error: stream_idle_timeout (attempt ${attempt}/10)`,
  } as unknown as Message
}

function textBlock(text: string): Record<string, unknown> {
  return { type: PART_TEXT, text }
}

function getContent(msg: Message): Array<Record<string, unknown>> | undefined {
  const inner = (msg.message as { content?: unknown } | undefined)?.content
  return Array.isArray(inner) ? inner : undefined
}

// ===========================================================================
// isApiErrorMessage
// ===========================================================================

describe('isApiErrorMessage', () => {
  it('returns true for assistant messages with isApiErrorMessage flag', () => {
    expect(isErrorCardTurn(apiErrorAssistant('a1', 'API Error: timeout'))).toBe(true)
  })

  it('returns false for normal assistant messages', () => {
    expect(isErrorCardTurn(assistantMessage('a1', [textBlock('hello')]))).toBe(false)
  })

  it('returns false for user messages', () => {
    expect(isErrorCardTurn(userMessage('u1', 'hi'))).toBe(false)
  })
})

// ===========================================================================
// dropErrorCardTurns
// ===========================================================================

describe('dropErrorCardTurns', () => {
  it('removes isApiErrorMessage assistant messages', () => {
    const messages = [
      userMessage('u1', 'hi'),
      apiErrorAssistant('a1', 'API Error: stream_idle_timeout'),
      userMessage('u2', 'try again'),
    ]
    const out = dropErrorCardTurns(messages)
    expect(out.map(m => m.uuid)).toEqual(['u1', 'u2'])
  })

  it('keeps normal assistant messages', () => {
    const messages = [
      userMessage('u1', 'hi'),
      assistantMessage('a1', [textBlock('hello')]),
    ]
    const out = dropErrorCardTurns(messages)
    expect(out).toHaveLength(2)
  })

  it('removes multiple consecutive API error messages', () => {
    const messages = [
      userMessage('u1', 'hi'),
      apiErrorAssistant('a1', 'API Error: timeout 1'),
      apiErrorAssistant('a2', 'API Error: timeout 2'),
      apiErrorAssistant('a3', 'API Error: timeout 3'),
    ]
    const out = dropErrorCardTurns(messages)
    expect(out.map(m => m.uuid)).toEqual(['u1'])
  })
})

// ===========================================================================
// dropBlankAssistantTurns
// ===========================================================================

describe('dropBlankAssistantTurns', () => {
  it('drops assistant with empty-string text block', () => {
    const messages = [
      userMessage('u1', 'hi'),
      assistantMessage('a1', [textBlock('')]),
      userMessage('u2', 'still there?'),
    ]
    const out = dropBlankAssistantTurns(messages)
    expect(out.map(m => m.uuid)).toEqual(['u1', 'u2'])
  })

  it('drops assistant with whitespace-only text blocks', () => {
    const messages = [
      assistantMessage('a1', [textBlock('\n\n'), textBlock('  ')]),
    ]
    const out = dropBlankAssistantTurns(messages)
    expect(out).toHaveLength(0)
  })

  it('keeps assistant with actual text content', () => {
    const messages = [
      assistantMessage('a1', [textBlock('hello world')]),
    ]
    const out = dropBlankAssistantTurns(messages)
    expect(out).toHaveLength(1)
  })

  it('keeps assistant with tool-call blocks even if text is whitespace', () => {
    const messages = [
      assistantMessage('a1', [
        textBlock(''),
        { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: {} },
      ]),
    ]
    const out = dropBlankAssistantTurns(messages)
    expect(out).toHaveLength(1)
  })

  it('never drops user messages', () => {
    const messages = [userMessage('u1', '')]
    const out = dropBlankAssistantTurns(messages)
    expect(out).toHaveLength(1)
  })
})

// ===========================================================================
// dropMediaBeforeMediaError
// ===========================================================================

describe('dropMediaBeforeMediaError', () => {
  it('strips image blocks from user message preceding a media-related API error', () => {
    const messages = [
      userMessageWithImage('u1', 'look at this'),
      apiErrorAssistant('a1', 'API Error: image exceeds maximum size'),
    ]
    const out = dropMediaBeforeMediaError(messages)
    const content = getContent(out[0]!)
    expect(content).toEqual([textBlock('look at this')])
  })

  it('does not strip images when the API error is not media-related', () => {
    const messages = [
      userMessageWithImage('u1', 'look at this'),
      apiErrorAssistant('a1', 'API Error: stream_idle_timeout'),
    ]
    const out = dropMediaBeforeMediaError(messages)
    const content = getContent(out[0]!)
    expect(content).toHaveLength(2) // image + text preserved
  })

  it('strips document blocks too', () => {
    const messages = [
      {
        type: MSG_TYPE_USER,
        uuid: 'u1',
        message: {
          role: ROLE_USER,
          content: [
            { type: 'document', data: 'base64pdf' },
            { type: PART_TEXT, text: 'read this pdf' },
          ],
        },
      } as unknown as Message,
      apiErrorAssistant('a1', 'API Error: PDF processing failed, document too large'),
    ]
    const out = dropMediaBeforeMediaError(messages)
    const content = getContent(out[0]!)
    expect(content).toEqual([textBlock('read this pdf')])
  })

  it('handles multiple media errors targeting different user messages', () => {
    const messages = [
      userMessageWithImage('u1', 'first image'),
      apiErrorAssistant('a1', 'API Error: image too large'),
      userMessageWithImage('u2', 'second image'),
      apiErrorAssistant('a2', 'API Error: image size exceeded'),
    ]
    const out = dropMediaBeforeMediaError(messages)
    expect(getContent(out[0]!)).toEqual([textBlock('first image')])
    expect(getContent(out[2]!)).toEqual([textBlock('second image')])
  })

  it('returns unchanged array when no API errors present', () => {
    const messages = [
      userMessageWithImage('u1', 'look'),
      assistantMessage('a1', [textBlock('nice image')]),
    ]
    const out = dropMediaBeforeMediaError(messages)
    expect(getContent(out[0]!)).toHaveLength(2)
  })
})

// ===========================================================================
// prepareHistoryForModel — full pipeline integration
// ===========================================================================

describe('prepareHistoryForModel filters broken messages end-to-end', () => {
  it('removes API error assistants + whitespace-only assistants in one pass', () => {
    // Reproduces the exact pattern from session 89e78a70:
    //   user(image) → api_error × N → assistant(error text) → assistant("") → user(interrupted)
    const messages = [
      userMessage('u1', 'fix the crash'),
      assistantMessage('a1', [textBlock('Let me investigate.')]),
      apiErrorAssistant('a2', 'API Error: stream_idle_timeout: native host reported no chunks for 90s'),
      assistantMessage('a3', [textBlock('')]),
      userMessage('u2', '[Request interrupted by user]'),
      userMessage('u3', 'continue please'),
    ]

    const out = prepareHistoryForModel(messages)
    const uuids = out.map(m => m.uuid)

    // API error assistant removed
    expect(uuids).not.toContain('a2')
    // Whitespace-only assistant removed
    expect(uuids).not.toContain('a3')
    // Normal messages preserved
    expect(uuids).toContain('u1')
    expect(uuids).toContain('a1')
    expect(uuids).toContain('u2')
    // u3 follows u2 directly, so the two adjacent user turns merge into u2.
    expect(uuids).not.toContain('u3')
    const u2 = out.find(m => m.uuid === 'u2')!
    expect(getContent(u2)).toEqual([
      // A newline added at the seam keeps the texts apart.
      textBlock('[Request interrupted by user]\n'),
      textBlock('continue please'),
    ])
  })

  it('strips images from user message before a media API error', () => {
    const messages = [
      userMessageWithImage('u1', 'what is this?'),
      apiErrorAssistant('a1', 'API Error: image exceeds maximum allowed size'),
      userMessage('u2', 'try without the image'),
    ]

    const out = prepareHistoryForModel(messages)
    // API error removed
    expect(out.find(m => m.uuid === 'a1')).toBeUndefined()
    // Image stripped from u1; with the error gone, u2 merges into it.
    const u1 = out.find(m => m.uuid === 'u1')!
    expect(getContent(u1)).toEqual([
      textBlock('what is this?\n'),
      textBlock('try without the image'),
    ])
  })

  it('preserves valid conversation structure (baseline)', () => {
    const messages = [
      userMessage('u1', 'hi'),
      assistantMessage('a1', [textBlock('hello')]),
      userMessage('u2', 'bye'),
    ]
    const out = prepareHistoryForModel(messages)
    expect(out.map(m => m.uuid)).toEqual(['u1', 'a1', 'u2'])
  })
})

// ===========================================================================
// dropEmptyAssistantTurns (existing behavior preserved)
// ===========================================================================

describe('dropEmptyAssistantTurns still works after pipeline changes', () => {
  it('drops empty-array content but not whitespace-only (that is the new filter)', () => {
    const messages = [
      assistantMessage('a1', []),
      assistantMessage('a2', [textBlock('')]),
      assistantMessage('a3', [textBlock('real')]),
    ]
    const out = dropEmptyAssistantTurns(messages)
    // a1 dropped (empty array), a2 kept (non-empty array), a3 kept
    expect(out.map(m => m.uuid)).toEqual(['a2', 'a3'])
  })
})
