import { describe, expect, it } from 'vitest'
import { convertBrowserRuntimeStateToThreadMessages } from '../browser/webview/assistantUiAdapter'
import type { BrowserRuntimeClientState } from '../browser/webview/BrowserRuntimeClient'

// The step list and the closing box (F-41) draw what the two `session_turn`
// calls carry, so neither call also appears as a transcript tool line. The drop
// is a render concern only: the stored rows keep both calls.

describe('assistantUiAdapter — turn-board calls', () => {
  const userRow = {
    type: 'user',
    uuid: 'user-1',
    timestamp: '2026-04-03T12:00:00.000Z',
    message: { role: 'user', content: 'fix it' },
  }

  it('draws no tool line for a session_turn call, stored or streaming', () => {
    const stored: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        userRow,
        {
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'plan-1', toolName: 'mcp__session_turn__set_plan', args: { items: [] } },
              { type: 'tool-call', toolCallId: 'read-1', toolName: 'Read', args: { file_path: '/tmp/a.txt' } },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-2',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'close-1', toolName: 'mcp__session_turn__close', args: { summary: 'done' } },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const storedMessages = convertBrowserRuntimeStateToThreadMessages(stored)
    const fromStored = JSON.stringify(storedMessages)
    expect(fromStored).toContain('read-1')
    expect(fromStored).not.toContain('session_turn')
    // The close-only row yields no parts, so it is dropped rather than kept as
    // an empty assistant bubble.
    expect(storedMessages.filter(message => message.role === 'assistant')).toHaveLength(1)
    // Rendering drops the parts; the persisted rows keep both calls.
    const rawRows = JSON.stringify(stored.transcriptMessages)
    expect(rawRows).toContain('mcp__session_turn__set_plan')
    expect(rawRows).toContain('mcp__session_turn__close')

    const streaming: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [userRow],
      liveEvents: [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool-call', toolCallId: 'plan-2', toolName: 'mcp__session_turn__set_plan', args: { next: true } },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool-call', toolCallId: 'close-2', toolName: 'mcp__session_turn__close', args: { summary: 'done' } },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool-call', toolCallId: 'read-2', toolName: 'Read', args: { file_path: '/tmp/b.txt' } },
          },
        },
      ] as never,
      lastError: null,
      pendingPrompt: 'fix it',
      pendingPromptId: 'user-1',
    } as unknown as BrowserRuntimeClientState

    const fromLive = JSON.stringify(convertBrowserRuntimeStateToThreadMessages(streaming))
    expect(fromLive).toContain('read-2')
    expect(fromLive).not.toContain('session_turn')
  })
})
