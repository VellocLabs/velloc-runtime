import { describe, expect, it } from 'vitest'
import { deriveSessionMetadataFromMessages } from '../sessions/sessionStore'
import type { Message } from '../runtime/RuntimeTypes'

// The sidebar preview skips internal context (the `isMeta` post-compact summary, tool-result carriers), as the
// assistant-ui adapter's transcript filtering does.

function userMessage(text: string, extra: Record<string, unknown> = {}): Message {
  return {
    type: 'user',
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
    ...extra,
  } as unknown as Message
}

function assistantMessage(text: string): Message {
  return {
    type: 'assistant',
    uuid: `a-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as Message
}

const COMPACT_SUMMARY_BODY =
  'This session is being continued from a previous conversation segment ' +
  'that grew too large for context. NEXUS_E2E_COMPACT_SUMMARY_MARKER'

describe('deriveSessionMetadataFromMessages — preview text', () => {
  it('skips the isMeta compaction summary so it never becomes the preview', () => {
    const messages: Message[] = [
      userMessage('hello there'),
      assistantMessage('Here is some context about the task.'),
      userMessage('/compact'),
      userMessage(COMPACT_SUMMARY_BODY, { isMeta: true }),
    ]

    const meta = deriveSessionMetadataFromMessages(messages, null)

    expect(meta.previewText).not.toContain('This session is being continued')
    expect(meta.previewText).not.toContain('NEXUS_E2E_COMPACT_SUMMARY_MARKER')
    // The latest VISIBLE message is the user's "/compact" command echo.
    expect(meta.previewText).toBe('/compact')
  })

  it('skips tool-result carrier user messages when choosing the preview', () => {
    const messages: Message[] = [
      userMessage('run the tool'),
      assistantMessage('Working on it.'),
      userMessage('', { toolUseResult: { stdout: 'done' } }),
    ]

    const meta = deriveSessionMetadataFromMessages(messages, null)

    expect(meta.previewText).toBe('Working on it.')
  })

  it('still surfaces a plain trailing assistant message as the preview', () => {
    const messages: Message[] = [
      userMessage('hello there'),
      assistantMessage('Here is the final answer.'),
    ]

    const meta = deriveSessionMetadataFromMessages(messages, null)

    expect(meta.previewText).toBe('Here is the final answer.')
  })
})

// `messageCount` is not just a display figure: `messageCount === 0` is the
// authoritative "empty session" signal (sidebar visibility in
// summarizeStoredSessionMetadata + New Thread reuse in useSessionManager).
// Since shownRowCount replaced the raw length, a
// user turn that carries only media blocks must still count as visible — an
// image-only first prompt otherwise marks a real session as never-used
// (hidden from the sidebar and eligible to be reused/overwritten).
describe('deriveSessionMetadataFromMessages — visible message count', () => {
  it('counts an image-only user prompt as a visible turn', () => {
    const messages: Message[] = [
      {
        type: 'user',
        uuid: 'u-img',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
              },
            },
          ],
        },
      } as unknown as Message,
    ]

    const meta = deriveSessionMetadataFromMessages(messages, null)

    expect(meta.messageCount).toBe(1)
  })

  it('still excludes tool-result carriers, isMeta turns, and tool_use-only assistants', () => {
    const messages: Message[] = [
      userMessage('', { toolUseResult: { stdout: 'done' } }),
      userMessage('injected context', { isMeta: true }),
      {
        type: 'assistant',
        uuid: 'a-tool',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        },
      } as unknown as Message,
    ]

    const meta = deriveSessionMetadataFromMessages(messages, null)

    expect(meta.messageCount).toBe(0)
  })

  it('counts plain text user + assistant turns', () => {
    const messages: Message[] = [
      userMessage('hello there'),
      assistantMessage('Here is the final answer.'),
    ]

    const meta = deriveSessionMetadataFromMessages(messages, null)

    expect(meta.messageCount).toBe(2)
  })
})
