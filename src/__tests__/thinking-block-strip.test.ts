/**
 * `dropReasoningBlocks` and `dropEmptyAssistantTurns` (src/messages/contextAttachments.ts) and their composition in
 * `prepareHistoryForModel`: signed thinking blocks are stripped and assistant turns left with only thinking dropped.
 */

import { describe, expect, it } from 'vitest'
import {
  dropEmptyAssistantTurns,
  prepareHistoryForModel,
  dropReasoningBlocks,
} from '../messages/prepareModelHistory'
import type { Message } from '../runtime/RuntimeTypes'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_USER,
  PART_TEXT,
  PART_THINKING,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  ROLE_ASSISTANT,
  ROLE_USER,
} from '../runtime/VercelModelConstants'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantMessage(
  uuid: string,
  content: Array<Record<string, unknown>>,
): Message {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid,
    message: {
      role: ROLE_ASSISTANT,
      content,
    },
  } as unknown as Message
}

function userMessage(uuid: string, text: string): Message {
  return {
    type: MSG_TYPE_USER,
    uuid,
    message: {
      role: ROLE_USER,
      content: text,
    },
  } as unknown as Message
}

function thinkingBlock(text = ''): Record<string, unknown> {
  return { type: PART_THINKING, thinking: text }
}

function textBlock(text: string): Record<string, unknown> {
  return { type: PART_TEXT, text }
}

function toolCallBlock(id: string, name: string): Record<string, unknown> {
  return {
    type: PART_TOOL_CALL,
    toolCallId: id,
    toolName: name,
    args: {},
  }
}

function toolResultBlock(id: string, result: string): Record<string, unknown> {
  return {
    type: PART_TOOL_RESULT_CANONICAL,
    toolCallId: id,
    result,
  }
}

function getContent(msg: Message): Array<Record<string, unknown>> | undefined {
  const inner = (msg.message as { content?: unknown } | undefined)?.content
  return Array.isArray(inner) ? inner : undefined
}

// ===========================================================================
// dropReasoningBlocks
// ===========================================================================

describe('dropReasoningBlocks', () => {
  it('removes a thinking block sitting alongside text + tool_call', () => {
    const messages = [
      userMessage('u1', 'hi'),
      assistantMessage('a1', [
        thinkingBlock('private reasoning'),
        textBlock('hello'),
        toolCallBlock('tu_1', 'Read'),
      ]),
    ]

    const out = dropReasoningBlocks(messages)
    expect(getContent(out[1]!)).toEqual([
      textBlock('hello'),
      toolCallBlock('tu_1', 'Read'),
    ])
  })

  it('removes empty-content thinking placeholders (the actual bug case)', () => {
    // This is the exact shape the user observed in the request payload:
    // {"thinking": "", "type": "thinking"}
    const messages = [
      assistantMessage('a1', [
        thinkingBlock(''), // ← empty placeholder
        textBlock('Got it'),
      ]),
    ]

    const out = dropReasoningBlocks(messages)
    expect(getContent(out[0]!)).toEqual([textBlock('Got it')])
  })

  it('removes redacted_thinking blocks as well', () => {
    const messages = [
      assistantMessage('a1', [
        { type: 'redacted_thinking', data: 'opaque-bytes' },
        textBlock('ok'),
      ]),
    ]

    const out = dropReasoningBlocks(messages)
    expect(getContent(out[0]!)).toEqual([textBlock('ok')])
  })

  it('leaves assistant messages with no thinking blocks untouched', () => {
    const messages = [
      assistantMessage('a1', [textBlock('plain'), toolCallBlock('t', 'Read')]),
    ]
    const out = dropReasoningBlocks(messages)
    // Should return the same reference shape — and assertively the same content.
    expect(getContent(out[0]!)).toEqual([
      textBlock('plain'),
      toolCallBlock('t', 'Read'),
    ])
  })

  it('does not touch user messages even if they somehow contain a thinking block', () => {
    // Defensive: thinking blocks only ship in assistant content, but
    // verify the function doesn't reach into user-role messages.
    const malformed = {
      type: MSG_TYPE_USER,
      uuid: 'u1',
      message: {
        role: ROLE_USER,
        content: [thinkingBlock('weird'), textBlock('user said')],
      },
    } as unknown as Message

    const out = dropReasoningBlocks([malformed])
    expect(getContent(out[0]!)).toEqual([
      thinkingBlock('weird'),
      textBlock('user said'),
    ])
  })

  it('handles assistant messages with string-typed content (no array)', () => {
    const msg = {
      type: MSG_TYPE_ASSISTANT,
      uuid: 'a1',
      message: {
        role: ROLE_ASSISTANT,
        content: 'plain string content',
      },
    } as unknown as Message

    const out = dropReasoningBlocks([msg])
    expect(out[0]).toBe(msg) // unchanged reference
  })

  it('reduces an assistant message to empty content when it was thinking-only', () => {
    // Strip leaves an empty content array; dropEmptyAssistantTurns
    // is responsible for removing the message. This test just verifies
    // the strip step itself behaves correctly.
    const messages = [
      assistantMessage('a1', [thinkingBlock('only')]),
    ]
    const out = dropReasoningBlocks(messages)
    expect(getContent(out[0]!)).toEqual([])
  })
})

// ===========================================================================
// dropEmptyAssistantTurns
// ===========================================================================

describe('dropEmptyAssistantTurns', () => {
  it('drops an assistant message with empty content array', () => {
    const messages = [
      userMessage('u1', 'first'),
      assistantMessage('a1', []),
      userMessage('u2', 'second'),
    ]
    const out = dropEmptyAssistantTurns(messages)
    expect(out.map(m => m.uuid)).toEqual(['u1', 'u2'])
  })

  it('keeps assistant messages that have any content blocks', () => {
    const messages = [
      assistantMessage('a1', [textBlock('hi')]),
      assistantMessage('a2', [toolCallBlock('t', 'Read')]),
    ]
    const out = dropEmptyAssistantTurns(messages)
    expect(out).toHaveLength(2)
  })

  it('keeps assistant messages with string-typed content', () => {
    const msg = {
      type: MSG_TYPE_ASSISTANT,
      uuid: 'a1',
      message: { role: ROLE_ASSISTANT, content: 'plain' },
    } as unknown as Message
    const out = dropEmptyAssistantTurns([msg])
    expect(out).toHaveLength(1)
  })

  it('never drops user messages (even with empty content)', () => {
    const empty = {
      type: MSG_TYPE_USER,
      uuid: 'u1',
      message: { role: ROLE_USER, content: [] },
    } as unknown as Message
    const out = dropEmptyAssistantTurns([empty])
    expect(out).toHaveLength(1)
  })
})

// ===========================================================================
// prepareHistoryForModel — end-to-end integration
// ===========================================================================

describe('prepareHistoryForModel composes strip + drop + merge', () => {
  it('strips empty thinking placeholder + merges parallel tool results in one pass', () => {
    // The exact pattern observed in the "I'm a doctor" log:
    //   assistant: [thinking(""), text, tool_call_1]
    //   tool: [tool_result_1]
    //   assistant: [thinking(""), tool_call_2]
    //   tool: [tool_result_2]
    const messages = [
      userMessage('u1', "I'm a doctor"),
      assistantMessage('a1', [
        thinkingBlock(''),
        textBlock('Got it'),
        toolCallBlock('tu_read', 'Read'),
      ]),
      // Tool result as a single-block user message (Nexus storage shape).
      {
        type: MSG_TYPE_USER,
        uuid: 'tr1',
        message: {
          role: ROLE_USER,
          content: [toolResultBlock('tu_read', 'file contents')],
        },
      } as unknown as Message,
      assistantMessage('a2', [thinkingBlock(''), toolCallBlock('tu_edit', 'Edit')]),
      {
        type: MSG_TYPE_USER,
        uuid: 'tr2',
        message: {
          role: ROLE_USER,
          content: [toolResultBlock('tu_edit', 'edit ok')],
        },
      } as unknown as Message,
    ]

    const out = prepareHistoryForModel(messages)

    // Assistant messages now lack thinking placeholders.
    const a1 = out.find(m => m.uuid === 'a1')!
    expect(getContent(a1)).toEqual([
      textBlock('Got it'),
      toolCallBlock('tu_read', 'Read'),
    ])

    const a2 = out.find(m => m.uuid === 'a2')!
    expect(getContent(a2)).toEqual([toolCallBlock('tu_edit', 'Edit')])

    // No assistant message has a thinking block anywhere.
    for (const msg of out) {
      const content = getContent(msg)
      if (content) {
        for (const block of content) {
          expect((block as { type?: unknown }).type).not.toBe(PART_THINKING)
        }
      }
    }
  })

  it('drops a thinking-only assistant message after the strip', () => {
    const messages = [
      userMessage('u1', 'hi'),
      assistantMessage('a1', [thinkingBlock('private')]),
      userMessage('u2', 'still here?'),
    ]
    const out = prepareHistoryForModel(messages)
    // The 'a1' assistant message had only thinking; after strip it's
    // empty; dropEmptyAssistantTurns removes it.
    expect(out.find(m => m.uuid === 'a1')).toBeUndefined()
    // The two users are now adjacent, so they merge into u1; both texts
    // survive.
    expect(out.map(m => m.uuid)).toEqual(['u1'])
    expect(JSON.stringify(getContent(out[0]!))).toContain('hi')
    expect(JSON.stringify(getContent(out[0]!))).toContain('still here?')
  })

  it('preserves message structure when no thinking blocks are present (baseline check)', () => {
    const messages = [
      userMessage('u1', 'hi'),
      assistantMessage('a1', [textBlock('hello')]),
    ]
    const out = prepareHistoryForModel(messages)
    expect(out).toHaveLength(2)
    expect(out[0]?.uuid).toBe('u1')
    expect(out[1]?.uuid).toBe('a1')
  })
})

// ===========================================================================
// Reasoning replay (velloc-replay-v1 signatures)
// ===========================================================================

describe('dropReasoningBlocks keeps reasoning replay blocks', () => {
  // A thinking block whose signature is a host-made replay envelope carries
  // the `reasoning_details` a gateway (OpenRouter / Vercel) needs back on the
  // next request. The host drops it for any other provider or model, so the
  // guest must keep it; Anthropic signatures are still stripped.
  const replay = {
    type: PART_THINKING,
    thinking: 'weigh it',
    signature: 'velloc-replay-v1:{"provider":"p","model":"m","field":"reasoning_details","value":[]}',
  }

  it('keeps a replay-signed thinking block beside the tool call', () => {
    const messages = [
      assistantMessage('a1', [replay, toolCallBlock('tu_1', 'Read')]),
    ]
    const out = dropReasoningBlocks(messages)
    expect(getContent(out[0]!)).toEqual([replay, toolCallBlock('tu_1', 'Read')])
  })

  it('still strips an Anthropic-signed thinking block', () => {
    const messages = [
      assistantMessage('a1', [
        { type: PART_THINKING, thinking: 'x', signature: 'EqQBCkgIARABGAIi' },
        textBlock('hello'),
      ]),
    ]
    const out = dropReasoningBlocks(messages)
    expect(getContent(out[0]!)).toEqual([textBlock('hello')])
  })

  it('drops a turn whose only block is a replay-signed thinking block', () => {
    // max_tokens during reasoning: no text, no tool call. Sending it would be
    // a reasoning-only assistant turn (or an empty one for another model).
    const messages = [
      userMessage('u1', 'hi'),
      assistantMessage('a1', [replay]),
      userMessage('u2', 'go on'),
    ]
    const stripped = dropReasoningBlocks(messages)
    expect(getContent(stripped[1]!)).toEqual([])
    const out = prepareHistoryForModel(messages)
    expect(out.find(m => m.uuid === 'a1')).toBeUndefined()
  })

  it('survives prepareHistoryForModel', () => {
    const messages = [
      userMessage('u1', 'hi'),
      assistantMessage('a1', [replay, textBlock('Pick B.')]),
    ]
    const out = prepareHistoryForModel(messages)
    expect(getContent(out[1]!)).toEqual([replay, textBlock('Pick B.')])
  })
})
