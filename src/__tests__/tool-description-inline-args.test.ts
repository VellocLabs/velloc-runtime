import { expect, it } from 'vitest'
import {
  convertBrowserRuntimeStateToThreadMessages,
  convertTranscriptToThreadMessages,
} from '../browser/webview/assistantUiAdapter'
import type { BrowserRuntimeClientState } from '../browser/webview/BrowserRuntimeClient'

it('keeps the call description inline for a lazily loaded shell or script call', () => {
  const callRow = (toolName: string, args: unknown, result: unknown) => [
    { type: 'user', uuid: `u-${toolName}`, message: { role: 'user', content: 'go' } },
    {
      type: 'assistant',
      uuid: `a-${toolName}`,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: `c-${toolName}`, toolName, args }],
      },
    },
    {
      type: 'user',
      uuid: `r-${toolName}`,
      sourceToolAssistantUUID: `a-${toolName}`,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: `c-${toolName}`, result }],
      },
    },
  ]
  const argsOf = (rows: unknown[]) =>
    (convertTranscriptToThreadMessages(rows as never).messages
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .find(p => p.type === 'tool-call') as { args?: unknown } | undefined)?.args

  expect(
    argsOf(callRow('Bash', { command: 'npm test', description: 'Run the tests' }, '{"output":"ok","exit_code":0}')),
  ).toEqual({ description: 'Run the tests' })
  expect(argsOf(callRow('SuperShell', { code: 'x', description: 'Typecheck' }, 'ok'))).toEqual({
    description: 'Typecheck',
  })
  expect(argsOf(callRow('SuperEdit', { code: 'x', description: 'Edit two files' }, 'ok'))).toEqual({
    description: 'Edit two files',
  })
  expect(argsOf(callRow('Bash', { command: 'npm test', description: '  ' }, 'ok'))).toEqual({})
  expect(argsOf(callRow('Read', { file_path: 'a.ts', description: 'no' }, 'ok'))).toEqual({})

  const live: BrowserRuntimeClientState = {
    status: 'submitting',
    snapshot: null,
    transcriptMessages: [],
    liveEvents: [
      { type: 'stream_request_start' },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool-call',
            toolCallId: 'live-bash',
            toolName: 'Bash',
            args: { command: 'npm test', description: 'Run the tests' },
          },
        },
      },
    ],
    lastError: null,
    pendingPrompt: null,
    pendingPromptId: null,
  } as unknown as BrowserRuntimeClientState
  const livePart = convertBrowserRuntimeStateToThreadMessages(live)
    .flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .find(p => p.type === 'tool-call') as { args?: unknown } | undefined
  expect(livePart?.args).toEqual({ description: 'Run the tests' })
})
