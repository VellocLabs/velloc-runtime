import { describe, expect, it } from 'vitest'
import type { AppendMessage } from '@assistant-ui/react'
import {
  buildPromptFromAppendMessage,
  combineThreadMessages,
  combineThreadMessagesDeps,
  convertBrowserRuntimeStateToThreadMessages,
  convertTranscriptToThreadMessages,
  extractTextFromAppendMessage,
  resolveProviderApiErrorRetryAction,
  shouldDismissBootWelcome,
  shouldShowLoadingSkeleton,
  transcriptWillHydrateAssistantBody,
} from '../browser/webview/assistantUiAdapter'
import type { BrowserRuntimeClientState } from '../browser/webview/BrowserRuntimeClient'
import { attachmentToText } from '../browser/webview/assistantUiAdapterContent'
import type { ContextRow } from '../runtime/RuntimeTypes'
import { renderTeamFrame } from '../team/renderTeamFrame'

function expectUniqueMessageIds(messages: Array<{ id?: string }>): void {
  const ids = messages.map(message => message.id).filter((id): id is string => Boolean(id))
  expect(new Set(ids).size).toBe(ids.length)
}

describe('assistantUiAdapter', () => {
  it('records the transcript lines each row covers', () => {
    // Rows are sparse: this assistant row stands for its own line AND the
    // tool-result line that renders inside its card. A search hit on
    // either has to find this row, and it does so by range — matching a
    // line number to a row would only ever find the first of them.
    const converted = convertTranscriptToThreadMessages([
      {
        type: 'user',
        uuid: 'u-1',
        transcriptLine: 3,
        message: { content: 'run the suite' },
      },
      {
        type: 'assistant',
        uuid: 'a-1',
        transcriptLine: 9,
        message: {
          content: [
            { type: 'text', text: 'starting' },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'Bash',
              args: { command: 'npm test' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'r-1',
        transcriptLine: 12,
        message: {
          content: [
            { type: 'tool-result', toolUseId: 'call-1', result: '6 workers' },
          ],
        },
      },
    ] as never).messages

    const ranges = converted.map(message => {
      const custom = (message.metadata as { custom?: Record<string, unknown> })
        ?.custom
      return [custom?.lineFrom, custom?.lineTo]
    })
    expect(ranges).toEqual([
      [3, 3],
      [9, 12],
    ])
  })

  it('converts automatic background result prompts into collapsed-card metadata', () => {
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'bg-shell-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'user',
            content:
              '<task-notification>\n<task-id>b-shell-1</task-id>\n<task-type>local_bash</task-type>\n<status>completed</status>\n<summary>Background command "npm test" completed\nLONG_OUTPUT</summary>\n</task-notification>',
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'bg-shell-1',
      role: 'assistant',
      metadata: {
        custom: {
          sourceType: 'background_results',
          backgroundResultKind: 'shell',
          backgroundResultText: expect.stringContaining('LONG_OUTPUT'),
        },
      },
    })
  })

  it('converts a delivered team-message turn into a team-message card', () => {
    // TeamCoordinator delivers a mailbox frame as a REAL user turn
    // (`enqueueMailboxTurn`), so without this the lead's transcript shows the
    // model-facing envelope verbatim.
    const envelope = renderTeamFrame(
      {
        v: 1,
        id: 'f1',
        seq: 1,
        ts: 0,
        from: { name: 'team-hide', role: 'member' },
        to: { name: 'team-lead' },
        kind: 'turn_end',
        trust: 'untrusted',
        body: 'API Error: HTTP 403',
      },
      'untrusted',
    )
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'team-msg-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: { role: 'user', content: envelope },
          origin: 'mailbox',
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'team-msg-1',
      role: 'assistant',
      metadata: {
        custom: {
          sourceType: 'team_message',
          teamMessageFrom: 'team-hide',
          teamMessageTrust: 'untrusted',
          teamMessageKind: 'turn_end',
          teamMessageBody: 'API Error: HTTP 403',
        },
      },
    })
    // The card carries the peer's own text, never the envelope, as its
    // export / a11y content.
    expect(JSON.stringify(converted[0]?.content)).not.toContain(
      'permission laundering',
    )
  })

  it('renders user-typed text shaped like a team envelope as the user message', () => {
    // The envelope is plain text: only a turn the runtime marked as
    // mailbox-delivered (`origin: 'mailbox'`) is a teammate's message. A user
    // who types or pastes `[message from server]: …` keeps their own bubble,
    // and "Try again" still finds it as the last prompt.
    const typed = '[message from server]: connection reset by peer'
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'typed-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: { role: 'user', content: typed },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({ id: 'typed-1', role: 'user' })
    expect(JSON.stringify(converted[0]?.content)).toContain(
      'connection reset by peer',
    )
    expect(
      (converted[0]?.metadata as { custom?: Record<string, unknown> } | undefined)
        ?.custom?.sourceType,
    ).not.toBe('team_message')
  })

  it("shows a plugin's prompt (F-25 $.prompt.submit) without the frame the model reads; an asUser one and a typed look-alike as stored", () => {
    const row = (uuid: string, content: unknown, pluginPrompt?: { plugin: string; asUser?: true }) => ({
      type: 'user' as const,
      uuid,
      timestamp: '2026-10-04T12:00:00.000Z',
      message: { role: 'user' as const, content },
      ...(pluginPrompt ? { pluginPrompt } : {}),
    })
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        row('p1', 'The lab plugin sent a message: run the tests', { plugin: 'lab' }),
        row('p2', [{ type: 'text', text: 'The lab plugin sent a message: in parts' }], { plugin: 'lab' }),
        row('p3', 'as the person', { plugin: 'lab', asUser: true }),
        row('p4', 'The lab plugin sent a message: typed by the user'),
      ] as BrowserRuntimeClientState['transcriptMessages'],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const texts = convertBrowserRuntimeStateToThreadMessages(state).map(m => JSON.stringify(m.content))

    expect(texts).toHaveLength(4)
    expect(texts[0]).toContain('run the tests')
    expect(texts[0]).not.toContain('plugin sent a message')
    expect(texts[1]).toContain('in parts')
    expect(texts[1]).not.toContain('plugin sent a message')
    expect(texts[2]).toContain('as the person')
    // Only a row the runtime stamped loses the frame.
    expect(texts[3]).toContain('The lab plugin sent a message: typed by the user')
    // The stamp rides the row's metadata, for a mod's UserMessage `origin`;
    // an unstamped row carries none.
    const stamps = convertBrowserRuntimeStateToThreadMessages(state).map(
      m => (m.metadata as { custom?: { pluginPrompt?: unknown } } | undefined)?.custom?.pluginPrompt,
    )
    expect(stamps).toEqual([{ plugin: 'lab' }, { plugin: 'lab' }, { plugin: 'lab', asUser: true }, undefined])
  })

  it('converts pending background result prompts into card metadata before persistence', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [],
      lastError: null,
      pendingPrompt:
        '<task-notification>\n<task-id>a-1</task-id>\n<task-type>local_agent</task-type>\n<status>completed</status>\n<summary>Explore: LONG_OUTPUT</summary>\n</task-notification>',
      pendingPromptId: 'pending-bg-results',
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'pending-bg-results',
      role: 'assistant',
      metadata: {
        custom: {
          sourceType: 'background_results',
          backgroundResultKind: 'subagent',
        },
      },
    })
  })

  it('renders an imported task-notification (no <task-type>) as a subagent card', () => {
    // An imported sub-agent task-notification carries task-id/tool-use-id/
    // output-file/status/summary/result — and NO <task-type> tag. Session-import
    // keeps it unchanged, so the render gatekeeper must infer the kind from the
    // `Agent "…"` summary instead of falling through to raw XML.
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'cc-tn-agent',
          timestamp: '2026-08-22T23:21:59.046Z',
          message: {
            role: 'user',
            content:
              '<task-notification>\n<task-id>ac9f4e553041936c6</task-id>\n<tool-use-id>toolu_019bL3</tool-use-id>\n<output-file>C:/tasks/ac9f4e.output</output-file>\n<status>completed</status>\n<summary>Agent "Review subagent converter linking" finished</summary>\n<result>Verdict: sound.</result>\n</task-notification>',
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'cc-tn-agent',
      role: 'assistant',
      metadata: {
        custom: {
          sourceType: 'background_results',
          backgroundResultKind: 'subagent',
        },
      },
    })
  })

  it('classifies a task-type-less "Background command" notification as a shell card', () => {
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'cc-tn-shell',
          timestamp: '2026-08-22T23:21:59.046Z',
          message: {
            role: 'user',
            content:
              '<task-notification>\n<task-id>b-shell-cc</task-id>\n<output-file>C:/tasks/b.output</output-file>\n<status>completed</status>\n<summary>Background command "npm test" completed</summary>\n</task-notification>',
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted[0]).toMatchObject({
      metadata: { custom: { sourceType: 'background_results', backgroundResultKind: 'shell' } },
    })
  })

  it('renders a team frame taken MID-TURN as the same team-message card', () => {
    // A frame a running turn took between two tool rounds is persisted as a
    // `queued_command` attachment (`commandMode:'team-message'`). Attachments
    // render nothing by default, so the message would sit in the model's
    // context while the user never saw it.
    const envelope = renderTeamFrame(
      {
        v: 1,
        id: 'f2',
        seq: 2,
        ts: 0,
        from: { name: 'worker-a', role: 'member', display: 'Reviewer' },
        to: { name: 'team-lead' },
        kind: 'message',
        trust: 'trusted',
        body: 'rebase done',
      },
      'trusted',
    )
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'attachment',
          uuid: 'team-midturn-1',
          timestamp: '2026-09-19T12:00:00.000Z',
          attachment: {
            type: 'queued_command',
            commandMode: 'team-message',
            prompt: envelope,
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'team-midturn-1',
      metadata: {
        custom: {
          sourceType: 'team_message',
          teamMessageFrom: 'worker-a',
          teamMessageTrust: 'trusted',
          teamMessageBody: 'rebase done',
        },
      },
    })
  })

  it('renders a queued_command task-notification attachment as a background card', () => {
    // An imported session can hold a completion that arrived while the agent
    // was busy as a `queued_command` attachment (commandMode
    // 'task-notification'). Import preserves it; without special-casing, attachments render nothing and the
    // completion would silently vanish from the transcript.
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'attachment',
          uuid: 'cc-queued-tn',
          timestamp: '2026-08-22T23:05:26.390Z',
          attachment: {
            type: 'queued_command',
            commandMode: 'task-notification',
            prompt:
              '<task-notification>\n<task-id>a612e49a3c31a8a5d</task-id>\n<output-file>C:/tasks/a612.output</output-file>\n<status>completed</status>\n<summary>Agent "Review UI and i18n strings" finished</summary>\n</task-notification>',
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'cc-queued-tn',
      role: 'assistant',
      metadata: {
        custom: {
          sourceType: 'background_results',
          backgroundResultKind: 'subagent',
        },
      },
    })
  })

  it('renders an imported slash-command pill as /name args, not raw tags', () => {
    // An imported session can store a slash-command invocation as a non-meta
    // user message holding only <command-message>/<command-name>/<command-args>.
    // Nexus emits tags + body as one isMeta message, so this shape is
    // import-only and must render as a `/name args` pill rather than as raw XML.
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'cc-cmd-pill',
          timestamp: '2026-08-23T15:23:39.487Z',
          message: {
            role: 'user',
            content:
              '<command-message>velloc-workflow:author</command-message>\n<command-name>/velloc-workflow:author</command-name>\n<command-args>continue the works</command-args>',
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'cc-cmd-pill',
      role: 'user',
      content: '/velloc-workflow:author continue the works',
    })
  })

  it('keeps a background shell result preview on lazy-detail tool parts so collapsed rows can show the jump button', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-ps-bg',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'ps-bg-1',
                toolName: 'PowerShell',
                args: {
                  command: 'Write-Output ok',
                  run_in_background: true,
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'user-ps-bg-result',
          timestamp: '2026-04-03T12:00:01.000Z',
          toolCallDetailRef: {
            toolCallId: 'ps-bg-1',
            toolName: 'PowerShell',
          },
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'ps-bg-1',
                result: {
                  shell_id: 'bg_123',
                  status: 'running',
                  stdout: 'DO_NOT_INLINE',
                },
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const shellPart = converted
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .find(
        (p): p is {
          type: string
          toolName?: string
          args?: unknown
          result?: unknown
        } => p.type === 'tool-call' && p.toolName === 'PowerShell',
      )

    expect(shellPart?.args).toEqual({
      command: 'Write-Output ok',
      run_in_background: true,
    })
    expect(shellPart?.result).toEqual({ shell_id: 'bg_123', status: 'running' })
    expect(JSON.stringify(shellPart)).not.toContain('DO_NOT_INLINE')
  })

  it('treats auto-backgrounded foreground shell results as background tasks and keeps the command preview', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-ps-auto-bg',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'ps-auto-bg-1',
                toolName: 'PowerShell',
                args: {
                  command: 'autoninja -C out/Debug custom_browser_tests.exe',
                  timeout: 1500,
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'user-ps-auto-bg-result',
          timestamp: '2026-04-03T12:00:01.000Z',
          toolCallDetailRef: {
            toolCallId: 'ps-auto-bg-1',
            toolName: 'PowerShell',
          },
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'ps-auto-bg-1',
                result:
                  'Command exceeded its foreground timeout and was moved to the background (shell_id=bg_456).',
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const shellPart = converted
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .find(
        (p): p is {
          type: string
          toolName?: string
          args?: unknown
          result?: unknown
        } => p.type === 'tool-call' && p.toolName === 'PowerShell',
      )

    expect(shellPart?.args).toEqual({
      command: 'autoninja -C out/Debug custom_browser_tests.exe',
    })
    expect(shellPart?.result).toEqual({ shell_id: 'bg_456', status: 'running' })
  })

  it('detects the REAL prose handoff ("with ID: b<base36>") on the string-only path', () => {
    // Regression: buildBackgroundShellRunningResult's message embeds a
    // kind-prefixed mintTaskHandle('local_bash') token (`b…`), not a legacy
    // `bg_…` id. When only that prose string survives (no structured task_id),
    // the string-path regex must still recognize it or the foreground→background
    // card loses its background chrome.
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-bash-handoff',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'bash-handoff-1',
                toolName: 'Bash',
                args: { command: 'npm run build' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'user-bash-handoff-result',
          timestamp: '2026-04-03T12:00:01.000Z',
          toolCallDetailRef: {
            toolCallId: 'bash-handoff-1',
            toolName: 'Bash',
          },
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'bash-handoff-1',
                result:
                  'Command exceeded its foreground timeout and was moved to the background with ID: b7g0ab12x. It is still running — you will be notified when it completes.',
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const shellPart = converted
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .find(
        (p): p is {
          type: string
          toolName?: string
          result?: unknown
        } => p.type === 'tool-call' && p.toolName === 'Bash',
      )

    expect(shellPart?.result).toEqual({ shell_id: 'b7g0ab12x', status: 'running' })
  })

  it('marks provider API-error assistant messages with retry prompt metadata', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-api-error',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'retry this provider call'},
        },
        {
          type: 'assistant',
          uuid: 'a-api-error',
          timestamp: '2026-04-03T12:00:01.000Z',
          isApiErrorMessage: true,
          error: 'server_error',
          errorDetails: 'HTTP 503 service unavailable',
          errorRetryCount: 10,
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: HTTP 503 service unavailable'}],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted[1]).toMatchObject({
      role: 'assistant',
      metadata: {
        custom: {
          sourceType: 'provider_api_error',
          apiErrorKind: 'server_error',
          apiErrorDetails: 'HTTP 503 service unavailable',
          // The card renders "retried N times" from this — it must survive the
          // transcript → thread-message conversion.
          apiErrorRetryCount: 10,
          retryPrompt: 'retry this provider call',
        },
      },
    })
  })

  it('carries a refusal stop category into the provider-error card metadata', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-refusal',
          timestamp: '2026-09-01T12:00:00.000Z',
          message: {role: 'user', content: 'do the thing'},
        },
        {
          type: 'assistant',
          uuid: 'a-refusal',
          timestamp: '2026-09-01T12:00:01.000Z',
          isApiErrorMessage: true,
          error: 'refusal',
          errorDetails: 'category: cyber\nDeclined by a safety classifier.',
          errorRetryCount: 0,
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: The provider declined this request on safety grounds (category: cyber).'}],
            stop_reason: 'content_filter',
            stop_details: {type: 'refusal', category: 'cyber', explanation: 'Declined by a safety classifier.'},
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted[1]).toMatchObject({
      role: 'assistant',
      metadata: {
        custom: {
          sourceType: 'provider_api_error',
          apiErrorKind: 'refusal',
          apiErrorRefusalCategory: 'cyber',
          apiErrorRetryCount: 0,
          retryPrompt: 'do the thing',
        },
      },
    })
  })

  it('hides provider retry system messages from the transcript', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-retry',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'do something'},
        },
        {
          type: 'system',
          subtype: 'api_error',
          uuid: 'sys-retry-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: 'API Error: quota exceeded\nRetrying in 4 seconds… (attempt 4/10)',
          retryInMs: 4000,
          retryAttempt: 4,
          maxRetries: 10,
        },
        {
          type: 'assistant',
          uuid: 'a-final-error',
          timestamp: '2026-04-03T12:00:02.000Z',
          isApiErrorMessage: true,
          error: 'rate_limit',
          errorDetails: 'quota exceeded',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: quota exceeded'}],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // The retry system message must not render — only the user prompt and
    // the final ProviderApiErrorCard.
    expect(converted).toHaveLength(2)
    expect(converted[0]).toMatchObject({ role: 'user' })
    expect(converted[1]).toMatchObject({
      metadata: {
        custom: {
          sourceType: 'provider_api_error',
          apiErrorKind: 'rate_limit',
        },
      },
    })
  })

  it('hides provider retry system messages from live events', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        {
          type: 'system',
          subtype: 'api_error',
          uuid: 'sys-live-retry',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: 'API Error: quota exceeded\nRetrying in 9 seconds… (attempt 5/10)',
          retryInMs: 9000,
          retryAttempt: 5,
          maxRetries: 10,
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(0)
  })

  it('hides a superseded provider API-error card once a visible message follows it', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'flaky call'},
        },
        {
          type: 'assistant',
          uuid: 'a-error-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          isApiErrorMessage: true,
          error: 'server_error',
          errorDetails: 'HTTP 500 upstream is on fire',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: HTTP 500'}],
          },
        },
        // The retried turn's reply lands AFTER the error — the error card is
        // superseded and must not keep rendering above it.
        {
          type: 'assistant',
          uuid: 'a-reply',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'all better now'}],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    const apiErrorCards = converted.filter(
      m =>
        (m.metadata?.custom as {sourceType?: unknown} | undefined)
          ?.sourceType === 'provider_api_error',
    )
    expect(apiErrorCards).toHaveLength(0)
    expect(converted[converted.length - 1]).toMatchObject({
      role: 'assistant',
      content: [{type: 'text', text: 'all better now'}],
    })
  })

  it('keeps only the most recent provider API-error card when errors stack', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'try me'},
        },
        {
          type: 'assistant',
          uuid: 'a-error-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          isApiErrorMessage: true,
          error: 'server_error',
          errorDetails: 'first failure',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: first'}],
          },
        },
        // The retried prompt is appended as a NEW user message...
        {
          type: 'user',
          uuid: 'u-2',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: {role: 'user', content: 'try me'},
        },
        // ...and fails again — two error messages now sit in the transcript.
        {
          type: 'assistant',
          uuid: 'a-error-2',
          timestamp: '2026-04-03T12:00:03.000Z',
          isApiErrorMessage: true,
          error: 'server_error',
          errorDetails: 'second failure',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: second'}],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // Only the trailing error renders — the first is superseded by the user
    // message after it, and rendering both would stack error cards.
    const apiErrorCards = converted.filter(
      m =>
        (m.metadata?.custom as {sourceType?: unknown} | undefined)
          ?.sourceType === 'provider_api_error',
    )
    expect(apiErrorCards).toHaveLength(1)
    expect(apiErrorCards[0]).toMatchObject({
      metadata: {custom: {apiErrorDetails: 'second failure'}},
    })
  })

  it('hides the error card as soon as the retried prompt is pending (before its reply lands)', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'flaky call'},
        },
        {
          type: 'assistant',
          uuid: 'a-error-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          isApiErrorMessage: true,
          error: 'server_error',
          errorDetails: 'HTTP 500',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: HTTP 500'}],
          },
        },
      ],
      // The retry has been submitted but not yet persisted — the prompt sits
      // in the pending window. The card must already be gone.
      pendingPrompt: 'flaky call',
      pendingPromptId: 'u-1-retry',
      liveEvents: [],
      lastError: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    const apiErrorCards = converted.filter(
      m =>
        (m.metadata?.custom as {sourceType?: unknown} | undefined)
          ?.sourceType === 'provider_api_error',
    )
    expect(apiErrorCards).toHaveLength(0)
    // The pending prompt renders as the new trailing user message.
    expect(converted[converted.length - 1]).toMatchObject({
      id: 'u-1-retry',
      role: 'user',
    })
  })

  it('hides the error card while an INVISIBLE resubmission is in flight (meta resume, no pending bubble)', () => {
    // Regression pin: a resume-style retry/continuation is an `isMeta` (or
    // empty) prompt — no optimistic bubble, no visible transcript message —
    // so nothing ever landed after the card and the visible-supersede rule
    // never fired. The card sat there through the entire new attempt. While
    // a turn is submitting, the trailing failure is being retried by
    // definition and the card must be gone.
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'flaky call'},
        },
        {
          type: 'assistant',
          uuid: 'a-error-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          isApiErrorMessage: true,
          error: 'server_error',
          errorDetails: 'HTTP 500',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: HTTP 500'}],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      // The meta resume carries no optimistic bubble.
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    const apiErrorCards = converted.filter(
      m =>
        (m.metadata?.custom as {sourceType?: unknown} | undefined)
          ?.sourceType === 'provider_api_error',
    )
    expect(apiErrorCards).toHaveLength(0)
  })

  it('combineThreadMessagesDeps covers every state field the combine layer reads', () => {
    // `combineThreadMessages` is memoized on this list, so every field it reads must be in the list or the
    // message list goes stale (see ThreadErrorBoundary).
    const base: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'flaky call'},
        },
        {
          type: 'assistant',
          uuid: 'a-error-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          isApiErrorMessage: true,
          error: 'server_error',
          errorDetails: 'HTTP 500',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: HTTP 500'}],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const mutations: Array<[string, BrowserRuntimeClientState]> = [
      // The meta-resume path: nothing changes but the status, and the error
      // card must vanish on that render, not two renders later.
      ['status', {...base, status: 'submitting'}],
      ['pendingPrompt', {...base, pendingPrompt: 'retry', pendingPromptId: 'u-2'}],
      [
        'preSplitPrompt',
        {...base, preSplitPrompt: 'parked', preSplitPromptId: 'u-0'},
      ],
      [
        'liveEvents',
        {
          ...base,
          liveEvents: [
            {
              type: 'assistant',
              uuid: 'a-live',
              message: {
                role: 'assistant',
                content: [{type: 'text', text: 'streaming'}],
              },
            },
          ] as unknown as BrowserRuntimeClientState['liveEvents'],
        },
      ],
    ]

    for (const [field, mutated] of mutations) {
      expect(
        convertBrowserRuntimeStateToThreadMessages(mutated),
        `${field} must change the rendered message list — otherwise this case ` +
          'no longer proves anything',
      ).not.toEqual(convertBrowserRuntimeStateToThreadMessages(base))
      expect(
        combineThreadMessagesDeps(mutated),
        `${field} changes the message list, so it must be a memo dependency`,
      ).not.toEqual(combineThreadMessagesDeps(base))
    }

    // `liveEventsTurnStart` needs live events to split, so it gets its own
    // pair rather than riding on `base`.
    const withLive: BrowserRuntimeClientState = {
      ...base,
      liveEvents: [
        {
          type: 'assistant',
          uuid: 'a-live',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'previous turn'}],
          },
        },
      ] as unknown as BrowserRuntimeClientState['liveEvents'],
      pendingPrompt: 'picked up',
      pendingPromptId: 'u-2',
    }
    const split: BrowserRuntimeClientState = {...withLive, liveEventsTurnStart: 1}
    expect(
      convertBrowserRuntimeStateToThreadMessages(split),
    ).not.toEqual(convertBrowserRuntimeStateToThreadMessages(withLive))
    expect(
      combineThreadMessagesDeps(split),
      'liveEventsTurnStart moves the pickup boundary, so it must be a memo dependency',
    ).not.toEqual(combineThreadMessagesDeps(withLive))
  })

  it('a retry (stream_request_start) SHRINKS the live message\'s parts at a stable id — why by-index reads must clamp', () => {
    // Pins deliberate behavior: each model-call attempt yields `stream_request_start` and the live conversion
    // discards the failed attempt's streamed parts, so a retry shrinks a mounted message's part count. The vendored
    // stale-index clamp (assistant-ui-stale-index-read.render.test.ts) covers the resulting race.
    const failedAttemptEvents = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {type: 'thinking_delta', thinking: 'planning the answer'},
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {type: 'text_delta', text: 'partial answer text'},
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool-call',
            toolCallId: 'tool-failed-1',
            toolName: 'Read',
            args: {file_path: '/tmp/a.txt'},
          },
        },
      },
    ]
    const base: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'do the thing'},
        },
      ],
      liveEvents: failedAttemptEvents as never,
      lastError: null,
      pendingPrompt: 'do the thing',
      pendingPromptId: 'u-1',
    }
    const afterRetry: BrowserRuntimeClientState = {
      ...base,
      liveEvents: [
        ...failedAttemptEvents,
        {type: 'stream_request_start'},
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: {type: 'text_delta', text: 'second attempt'},
          },
        },
      ] as never,
    }

    const before = convertBrowserRuntimeStateToThreadMessages(base)
    const after = convertBrowserRuntimeStateToThreadMessages(afterRetry)

    const liveBefore = before[before.length - 1]!
    const liveAfter = after[after.length - 1]!
    // Same message, same position, same id across the retry boundary…
    expect(before).toHaveLength(2)
    expect(after).toHaveLength(2)
    expect(liveBefore.id).toBe('turn:u-1:assistant')
    expect(liveAfter.id).toBe(liveBefore.id)
    // …but the part list SHRANK: reasoning + text + tool-call → one text.
    expect(liveBefore.content).toHaveLength(3)
    expect(liveAfter.content).toHaveLength(1)
    expect(liveAfter.content).toEqual([
      expect.objectContaining({type: 'text', text: 'second attempt'}),
    ])
  })

  it('keeps the trailing error card once the failed turn has settled', () => {
    // Control for the in-flight test above: same transcript, but the client
    // is back to 'ready' — the card is the terminal UI and must render.
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {role: 'user', content: 'flaky call'},
        },
        {
          type: 'assistant',
          uuid: 'a-error-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          isApiErrorMessage: true,
          error: 'server_error',
          errorDetails: 'HTTP 500',
          message: {
            role: 'assistant',
            content: [{type: 'text', text: 'API Error: HTTP 500'}],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    const apiErrorCards = converted.filter(
      m =>
        (m.metadata?.custom as {sourceType?: unknown} | undefined)
          ?.sourceType === 'provider_api_error',
    )
    expect(apiErrorCards).toHaveLength(1)
  })

  describe('resolveProviderApiErrorRetryAction', () => {
    const persistedPrompt = {
      type: 'user' as const,
      uuid: 'u-1',
      timestamp: '2026-04-03T12:00:00.000Z',
      message: {role: 'user' as const, content: 'flaky call'},
    }
    const errorAssistant = {
      type: 'assistant' as const,
      uuid: 'a-error-1',
      timestamp: '2026-04-03T12:00:01.000Z',
      isApiErrorMessage: true,
      error: 'server_error',
      errorDetails: 'HTTP 500',
      message: {
        role: 'assistant' as const,
        content: [{type: 'text' as const, text: 'API Error: HTTP 500'}],
      },
    }

    it('resumes when the retried prompt is already persisted', () => {
      // Regression pin: resubmitting a persisted prompt appended a duplicate
      // user turn on every retry (`A, tools…, [error], A, [error], A…`).
      expect(
        resolveProviderApiErrorRetryAction(
          [persistedPrompt, errorAssistant],
          'flaky call',
        ),
      ).toBe('resume')
    })

    it('resubmits when the prompt never reached the transcript', () => {
      expect(
        resolveProviderApiErrorRetryAction(
          [errorAssistant],
          'flaky call',
        ),
      ).toBe('resubmit')
    })

    it('does not treat a hidden meta message with matching text as persisted', () => {
      const metaEcho = {
        ...persistedPrompt,
        uuid: 'u-meta',
        isMeta: true,
      }
      expect(
        resolveProviderApiErrorRetryAction(
          [metaEcho, errorAssistant],
          'flaky call',
        ),
      ).toBe('resubmit')
    })
  })

  it('converts transcript and live events into assistant-ui thread messages', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'user',
            content: 'Inspect the current tab.',
          },
        },
        {
          type: 'attachment',
          uuid: 'attachment-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          attachment: {
            type: 'browser_context',
            activeTab: {
              title: 'Dashboard',
              url: 'https://example.com/dashboard',
            },
            tabs: [{ title: 'Dashboard' }],
            session: {},
            workspace: null,
            userProfile: null,
          },
        },
      ],
      liveEvents: [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool-call',
              toolCallId: 'tool-1',
              toolName: 'browser_tabs_context',
              args: {
                includeDom: false,
              },
            },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: {
              type: 'text_delta',
              text: 'Here is the active tab summary.',
            },
          },
        },
      ],
      lastError: null,
      pendingPrompt: 'Follow up while the turn is still running.',
      pendingPromptId: 'pending-uuid-1',
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // Attachment messages (the browser_context attachment here) are internal
    // context for the model, not chat content — the adapter hides them, so
    // `attachment-1` is filtered out and the surrounding messages collapse.
    expect(converted).toHaveLength(3)
    expect(converted[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      content: 'Inspect the current tab.',
    })
    expect(converted.some(message => message.id === 'attachment-1')).toBe(false)
    expect(converted[1]).toMatchObject({
      id: 'pending-uuid-1',
      role: 'user',
      content: 'Follow up while the turn is still running.',
    })
    // The trailing assistant of the current turn gets a stable turn-derived
    // id anchored to the in-flight prompt uuid, so React doesn't remount the
    // message when the live → transcript transition persists the assistant.
    expect(converted[2]).toMatchObject({
      id: 'turn:pending-uuid-1:assistant',
      role: 'assistant',
      status: { type: 'running' },
    })
    expect(Array.isArray(converted[2]?.content)).toBe(true)
    expect(converted[2]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-call',
          toolName: 'browser_tabs_context',
          toolCallId: 'tool-1',
          args: {},
        }),
        expect.objectContaining({
          type: 'text',
          text: 'Here is the active tab summary.',
        }),
      ]),
    )
  })

  it('renders a re-armed next-message bubble AFTER the previous turn\'s live tool block', () => {
    // Pins the queued-pickup ordering bug: a message parked while the agent
    // ran tools is consumed at the turn boundary, re-arming the optimistic
    // bubble while the finished turn's stream is still the ONLY render of
    // that turn (the transcript reconcile hasn't landed). The bubble must
    // render below the tool block it chronologically followed, not above it.
    const previousTurnEvents = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool-call',
            toolCallId: 'tool-prev-1',
            toolName: 'Read',
            args: { file_path: '/tmp/a.txt' },
          },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Done reading.' },
        },
      },
    ]
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-08-05T12:00:00.000Z',
          message: { role: 'user', content: 'Run the tools.' },
        },
      ],
      liveEvents: [
        ...previousTurnEvents,
        // The consumed turn's own stream, appended after the split.
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Picking up your message.' },
          },
        },
      ] as never,
      liveEventsTurnStart: previousTurnEvents.length,
      lastError: null,
      pendingPrompt: 'queued while tools ran',
      pendingPromptId: 'uuid-queued',
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(4)
    expect(converted[0]).toMatchObject({ id: 'user-1', role: 'user' })
    // The finished turn's tool block renders BEFORE the picked-up message,
    // and no longer reads as running (its turn is over).
    expect(converted[1]).toMatchObject({
      role: 'assistant',
      status: { type: 'complete' },
    })
    expect(converted[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-call', toolCallId: 'tool-prev-1' }),
      ]),
    )
    expect(converted[2]).toMatchObject({
      id: 'uuid-queued',
      role: 'user',
      content: 'queued while tools ran',
    })
    // The consumed turn's own stream stays the trailing live assistant.
    expect(converted[3]).toMatchObject({
      id: 'turn:uuid-queued:assistant',
      role: 'assistant',
      status: { type: 'running' },
    })
    expect(converted[3]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Picking up your message.' }),
      ]),
    )
    expectUniqueMessageIds(converted)
  })

  it('keeps the previous turn\'s promoted bubble ABOVE its stream at the pickup boundary', () => {
    // Before the previous turn's transcript reconcile lands, its optimistic
    // bubble is the ONLY render of that user message. The consume promotes it
    // to the pre-split slot; the combine must render it first — making the
    // pickup a pure append ([U, A] → [U, A, U', A']) instead of a reshape.
    // The reshape blanked the previous user message and shifted every message
    // index mid-render, which could crash the thread into ThreadErrorBoundary
    // (assistant-ui `tapClientLookup: Index N out of bounds`).
    const previousTurnEvents = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool-call',
            toolCallId: 'tool-prev-1',
            toolName: 'Read',
            args: { file_path: '/tmp/a.txt' },
          },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Done reading.' },
        },
      },
    ]
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      // No reconcile has landed yet — the transcript is still empty. This is
      // the exact window the pickup crash lived in.
      transcriptMessages: [],
      liveEvents: [
        ...previousTurnEvents,
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Picking up your message.' },
          },
        },
      ] as never,
      liveEventsTurnStart: previousTurnEvents.length,
      lastError: null,
      pendingPrompt: 'queued while tools ran',
      pendingPromptId: 'uuid-queued',
      preSplitPrompt: 'first question',
      preSplitPromptId: 'uuid-first',
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(4)
    expect(converted[0]).toMatchObject({
      id: 'uuid-first',
      role: 'user',
      content: 'first question',
    })
    expect(converted[1]).toMatchObject({
      role: 'assistant',
      status: { type: 'complete' },
    })
    expect(converted[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-call', toolCallId: 'tool-prev-1' }),
      ]),
    )
    expect(converted[2]).toMatchObject({
      id: 'uuid-queued',
      role: 'user',
      content: 'queued while tools ran',
    })
    expect(converted[3]).toMatchObject({
      id: 'turn:uuid-queued:assistant',
      role: 'assistant',
      status: { type: 'running' },
    })
    expectUniqueMessageIds(converted)
  })

  it('drops the promoted pre-split bubble once the transcript carries its uuid', () => {
    // The reconcile clears the slot, but the combine's own dedup must also
    // hold for the window where a stale state still carries both (the same
    // guard the pendingPrompt push uses).
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'uuid-first',
          timestamp: '2026-08-05T12:00:00.000Z',
          message: { role: 'user', content: 'first question' },
        },
      ],
      liveEvents: [],
      liveEventsTurnStart: 0,
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
      preSplitPrompt: 'first question',
      preSplitPromptId: 'uuid-first',
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(
      converted.filter(
        m => m.role === 'user' && m.content === 'first question',
      ),
    ).toHaveLength(1)
    expect(converted[0]).toMatchObject({ id: 'uuid-first', role: 'user' })
    expectUniqueMessageIds(converted)
  })

  it('renders isMeta skill instructions as a Skill card, never as a user bubble', () => {
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'user',
            content: 'Use the browser skill.',
          },
        },
        {
          // The Skill tool injects the expanded SKILL.md body as a generated
          // user message marked isMeta — internal context for the model, not
          // user-authored chat. It must not render as a user bubble.
          type: 'user',
          uuid: 'skill-instructions-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          isMeta: true,
          message: {
            role: 'user',
            content:
              '<command-message>browser</command-message>\n'
              + '<command-name>/browser</command-name>\n'
              + '\n'
              + '## Browser tools',
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // The user prompt renders as before …
    expect(converted[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      content: 'Use the browser skill.',
    })
    // … and the skill invocation is NOT a user bubble: it renders as a Skill
    // tool-call card (name + "View skill"), the body staying out of the
    // bubble. See skill-invocation-lazy-body.test.ts for the card contract.
    expect(converted).toHaveLength(2)
    expect(converted[1]).toMatchObject({
      role: 'assistant',
      content: [expect.objectContaining({ type: 'tool-call', toolName: 'Skill' })],
    })
    expect(converted.some(m => m.role === 'user' && m.id === 'skill-instructions-1')).toBe(false)
  })

  it('hides empty non-meta user messages (legacy continue-after-stop turns)', () => {
    // Regression: the composer's Continue button used to submit an EMPTY
    // non-meta user message after a stop (`submitPrompt('')` on the
    // interrupt-marker-last branch), which persisted and rendered as a blank
    // user bubble. The submit side now sends hidden isMeta continuations,
    // but transcripts written before that fix still carry one empty user
    // message per continue click — drop them at render time.
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'user',
            content: 'test',
          },
        },
        {
          // Persisted by the old continue path: content is the empty STRING
          // (not an array), isMeta absent/false.
          type: 'user',
          uuid: 'empty-continue-1',
          timestamp: '2026-04-03T12:00:05.000Z',
          isMeta: false,
          message: {
            role: 'user',
            content: '',
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-03T12:00:06.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Continued reply.' }],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // No blank user bubble: the only user thread message is the real prompt.
    const userMessages = converted.filter(message => message.role === 'user')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]).toMatchObject({ id: 'user-1', content: 'test' })
    // The reply that followed the hidden turn still renders. (Its thread id
    // is turn-grouped — `turn:<anchor-uuid>:assistant` — so match content.)
    expect(
      converted.some(
        message =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some(
            part => part.type === 'text' && part.text === 'Continued reply.',
          ),
      ),
    ).toBe(true)
  })

  it('drops a turn whose only block is a no-inline-UI a2ui command (no raw-JSON fallback)', () => {
    // Regression: a2ui_delete_surface (and, before the move-to-latest revert,
    // a2ui_update_data_model) is dropped by convertAssistantBlock. When such a
    // tool-call is a turn's ONLY content, contentToAssistantParts used to
    // JSON.stringify the raw block as a fallback → a visible
    // `{"type":"tool-call",…}` dump in the conversation (the counter's "raw
    // JSON" bug). The turn must instead be dropped entirely.
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: { role: 'user', content: 'close the surface' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'del-1',
                toolName: 'a2ui_delete_surface',
                args: { surfaceId: 'counter' },
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const serialized = JSON.stringify(converted)

    // No raw tool-call block leaked into rendered text.
    expect(serialized).not.toContain('"toolName"')
    expect(serialized).not.toContain('a2ui_delete_surface')
    // The delete-only assistant turn produced no parts → it is dropped, leaving
    // just the user message.
    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({ id: 'user-1', role: 'user' })
  })

  it('drops content-less assistant text turns ("" / whitespace) — no stray bubble', () => {
    // Regression: gpt-5.5 in the A2UI action loop (told "do not narrate") emits
    // a turn whose only text is the bare quote-pair `""` (or whitespace). That
    // must not render as a stray `""` bubble — the turn yields zero parts and is
    // dropped. A real text turn is kept.
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: { role: 'user', content: 'increment it' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-empty-quotes',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: '""' }] },
        },
        {
          type: 'assistant',
          uuid: 'assistant-whitespace',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
        },
        {
          type: 'assistant',
          uuid: 'assistant-real',
          timestamp: '2026-04-03T12:00:03.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done — count is 5.' }] },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const serialized = JSON.stringify(converted)
    // The two content-less turns are dropped: neither RENDERS. Asserted on
    // the rendered ids rather than on the serialized JSON, because a
    // dropped line's uuid legitimately reappears in `sourceUuids` — that
    // is the row recording which transcript lines it absorbed, which is
    // how a search hit on one of them still resolves to a row.
    expect(converted.map(message => message.id)).not.toContain(
      'assistant-empty-quotes',
    )
    expect(converted.map(message => message.id)).not.toContain(
      'assistant-whitespace',
    )
    expect(converted).toHaveLength(2)
    expect(serialized).toContain('Done — count is 5.')
  })

  it('extracts plain text from append messages', () => {
    const appendMessage: AppendMessage = {
      parentId: null,
      sourceId: null,
      startRun: true,
      runConfig: undefined,
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Summarize the page.',
        },
      ],
      attachments: [],
      metadata: {
        custom: {},
      },
      createdAt: new Date('2026-04-03T12:00:00.000Z'),
    }

    expect(extractTextFromAppendMessage(appendMessage)).toBe(
      'Summarize the page.',
    )
  })

  it('prepends quoted attachment refs to composer prompts', async () => {
    const appendMessage: AppendMessage = {
      parentId: null,
      sourceId: null,
      startRun: true,
      runConfig: undefined,
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Review the attached file.',
        },
      ],
      attachments: [
        {
          id: 'attachment-1',
          type: 'file',
          name: 'guide.md',
          contentType: 'text/markdown',
          content: [
            {
              type: 'text',
              text: 'guide.md',
            },
          ],
          status: {
            type: 'complete',
          },
        },
      ],
      metadata: {
        custom: {},
      },
      createdAt: new Date('2026-04-03T12:00:00.000Z'),
    }

    const prompt = await buildPromptFromAppendMessage(
      appendMessage,
      async () => '/workspace/.velloc/uploads/session/abcd1234-guide.md',
    )

    expect(prompt).toBe(
      '@"/workspace/.velloc/uploads/session/abcd1234-guide.md" Review the attached file.',
    )
  })

  it('supports attachment-only composer prompts', async () => {
    const appendMessage: AppendMessage = {
      parentId: null,
      sourceId: null,
      startRun: true,
      runConfig: undefined,
      role: 'user',
      content: [],
      attachments: [
        {
          id: 'attachment-1',
          type: 'document',
          name: 'spec.pdf',
          contentType: 'application/pdf',
          content: [
            {
              type: 'text',
              text: 'spec.pdf',
            },
          ],
          status: {
            type: 'complete',
          },
        },
      ],
      metadata: {
        custom: {},
      },
      createdAt: new Date('2026-04-03T12:00:00.000Z'),
    }

    const prompt = await buildPromptFromAppendMessage(
      appendMessage,
      async () => '/workspace/.velloc/uploads/session/spec.pdf',
    )

    expect(prompt).toBe('@"/workspace/.velloc/uploads/session/spec.pdf"')
  })

  it('renders a sent prompt\'s upload prefix as attachment cards, persisted and pending', () => {
    // The composer writes one `@"<cwd>/.velloc/uploads/<session>/<8hex>-<name>"`
    // per uploaded file ahead of the text (the prompt shapes above). A reload
    // showed that raw path in the bubble; the conversion lifts the run out
    // into `attachments`, named without the random upload prefix.
    const sent = '@"/workspace/.velloc/uploads/s/abcd1234-pasted-text-1.txt" hello'
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'u-upload',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: { role: 'user', content: sent },
        },
        {
          type: 'user',
          uuid: 'u-typed',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: { role: 'user', content: '@"src/foo.ts" explain' },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: '@"C:\\w\\.velloc\\uploads\\s\\0a1b2c3d-spec.pdf"',
      pendingPromptId: 'u-pending',
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const byId = new Map(converted.map(message => [message.id, message]))

    expect(byId.get('u-upload')).toMatchObject({
      role: 'user',
      content: 'hello',
      attachments: [{ name: 'pasted-text-1.txt', type: 'file' }],
    })
    // A user-typed mention is not an upload: it stays text, no cards.
    expect(byId.get('u-typed')).toMatchObject({ content: '@"src/foo.ts" explain' })
    expect(byId.get('u-typed')?.attachments).toBeUndefined()
    // An attachment-only optimistic bubble is kept, as a card.
    expect(byId.get('u-pending')).toMatchObject({
      role: 'user',
      content: '',
      attachments: [{ name: 'spec.pdf', type: 'document' }],
    })
  })

  it('stamps a TodoWrite-bearing turn with the plan state of the previous turn (priorTodos)', () => {
    // The body segments one message at a time, so a plan resumed after a
    // turn boundary (a user reply, a teammate's report) re-listed every step
    // in its new card. The conversion records, per TodoWrite-bearing turn,
    // the LAST plan state of any earlier turn; the body hides the steps that
    // were already finished there.
    const todoWriteRow = (uuid: string, id: string, statuses: string[]) => ({
      type: 'assistant' as const,
      uuid,
      timestamp: '2026-04-03T12:00:00.000Z',
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: id,
            toolName: 'TodoWrite',
            args: {
              todos: statuses.map((status, i) => ({
                content: `step ${i + 1}`,
                activeForm: `doing step ${i + 1}`,
                status,
              })),
            },
          },
        ],
      },
    })
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        todoWriteRow('a1', 'tw1', ['in_progress', 'pending', 'pending']),
        // A second write in the SAME turn: the later one is the turn's state.
        todoWriteRow('a1b', 'tw1b', ['completed', 'in_progress', 'pending']),
        {
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-04-03T12:01:00.000Z',
          message: { role: 'user', content: 'continue' },
        },
        todoWriteRow('a2', 'tw2', ['completed', 'completed', 'in_progress']),
        {
          type: 'user',
          uuid: 'u3',
          timestamp: '2026-04-03T12:02:00.000Z',
          message: { role: 'user', content: 'and now?' },
        },
        {
          type: 'assistant',
          uuid: 'a3',
          timestamp: '2026-04-03T12:02:30.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'no plan here' }] },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const assistants = converted.filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(3)

    // The first plan of the session has nothing before it.
    const first = assistants[0]!.metadata?.custom as Record<string, unknown> | undefined
    expect(first?.priorTodos).toBeUndefined()

    // The continuation carries the previous turn's LAST write, as JSON.
    const second = assistants[1]!.metadata?.custom as Record<string, unknown>
    expect(second.priorTodos).toBe(
      JSON.stringify([
        { content: 'step 1', status: 'completed' },
        { content: 'step 2', status: 'in_progress' },
        { content: 'step 3', status: 'pending' },
      ]),
    )

    // A turn without a TodoWrite is left alone.
    const third = assistants[2]!.metadata?.custom as Record<string, unknown> | undefined
    expect(third?.priorTodos).toBeUndefined()
  })

  it('marks unresolved assistant tool calls on the last transcript message as interrupted (settled)', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-pending-tool',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tool-pending-1',
                toolName: 'select_date',
                args: {
                  prompt: 'Pick a meeting date.',
                },
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'assistant-pending-tool',
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      content: [
        expect.objectContaining({
          type: 'tool-call',
          toolName: 'select_date',
          result: { interruptedOnRestart: true },
        }),
      ],
    })
  })

  it('does NOT patch tool calls that already have a result', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-resolved',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tool-resolved-1',
                toolName: 'Grep',
                args: { pattern: 'foo' },
                result: 'found it',
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    const part = (converted[0]!.content as unknown as Array<{ type: string; result?: unknown }>)
      .find(p => p.type === 'tool-call')
    // Already had a result — must NOT be overwritten with the interrupted sentinel.
    expect(part!.result).not.toEqual({ interruptedOnRestart: true })
    expect(part!.result).not.toBeUndefined()
  })

  // A `requiresUserInteraction` halt (AskUserQuestion) leaves its tool_use
  // deliberately unanswered while the worker persists the assistant message —
  // so the restore pass sees an unresolved tool call on a LIVE turn. Stamping
  // it makes `result` defined, and AskUserQuestionToolUI reads any defined
  // result as "answered": the question form is replaced by an empty collapsed
  // answered card and the turn can never be resumed. The snapshot's
  // `pendingUserInteraction` is what distinguishes parked from dead.
  it('does NOT patch a tool call the live turn is PARKED on (pendingUserInteraction)', () => {
    const askCall = {
      type: 'tool-call' as const,
      toolCallId: 'call-ask-1',
      toolName: 'AskUserQuestion',
      args: { questions: [{ question: 'Which?', header: 'H', options: [] }] },
    }
    const transcriptMessages = [
      {
        type: 'assistant',
        uuid: 'assistant-parked',
        timestamp: '2026-04-03T12:00:00.000Z',
        message: { role: 'assistant', content: [askCall] },
      },
    ] as unknown as BrowserRuntimeClientState['transcriptMessages']
    const baseState: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: {
        pendingUserInteraction: {
          'call-ask-1': { toolName: 'AskUserQuestion' },
        },
      } as unknown as BrowserRuntimeClientState['snapshot'],
      transcriptMessages,
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const parked = convertBrowserRuntimeStateToThreadMessages(baseState)
    const parkedPart = (
      parked[0]!.content as unknown as Array<{ type: string; result?: unknown }>
    ).find(p => p.type === 'tool-call')
    // Still unanswered — the card must render its question form.
    expect(parkedPart!.result).toBeUndefined()

    // Same transcript, but the halt is gone from the snapshot (the app was
    // killed mid-run rather than parked): the sentinel applies as before.
    const dead = convertBrowserRuntimeStateToThreadMessages({
      ...baseState,
      snapshot: {} as unknown as BrowserRuntimeClientState['snapshot'],
    })
    const deadPart = (
      dead[0]!.content as unknown as Array<{ type: string; result?: unknown }>
    ).find(p => p.type === 'tool-call')
    expect(deadPart!.result).toEqual({ interruptedOnRestart: true })
  })

  it('treats an unresolved ExitPlanMode tool call as SETTLED, not requires-action (no perpetual spinner)', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-exit-plan',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tool-exit-plan-1',
                toolName: 'ExitPlanMode',
                args: { plan: '# Plan\n1. Do the thing' },
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    // ExitPlanMode HALTS (resolved by the footer approval control, not a
    // tool_result), so its unanswered tool_use must NOT pin the message to
    // requires-action — that rendered a perpetual "planning" spinner even while
    // later tools executed. It reads as a settled record instead.
    expect(converted[0]!.status).toEqual({ type: 'complete', reason: 'stop' })
    const exitPart = (
      converted[0]!.content as Array<{
        type: string
        toolName?: string
        result?: unknown
      }>
    ).find(p => p.type === 'tool-call' && p.toolName === 'ExitPlanMode')
    expect(exitPart).toBeDefined()
    expect(exitPart!.result).not.toBeUndefined()
  })

  it('does NOT leave an approved tool card spinning: the resolved transcript part wins over the live in-flight copy', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-edit',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'edit-1',
                toolName: 'Edit',
                args: { file_path: 'MEMORY.md' },
              },
            ],
          },
        },
        // The permission-approval resume result for the SAME toolCallId. This
        // tool_result user message is internal (filtered from the chat), so the
        // resolved assistant becomes adjacent to the live in-flight copy below
        // and the two merge — the exact path that used to keep the card spinning.
        {
          type: 'user',
          uuid: 'user-grant',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'edit-1',
                result:
                  'Permission granted by the user — the rule is now active. Retry the call.',
                isError: false,
              },
            ],
          },
        },
      ],
      // The stale live in-flight copy of the SAME tool call: hard-coded running,
      // no result — kept while status==='submitting'.
      liveEvents: [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool-call',
              toolCallId: 'edit-1',
              toolName: 'Edit',
              args: { file_path: 'MEMORY.md' },
            },
          },
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // Every rendered copy of edit-1 must carry its result (the resolved
    // transcript part wins over the unresolved live one).
    const editParts = converted
      .flatMap(m =>
        Array.isArray(m.content)
          ? (m.content as Array<{ type: string; toolCallId?: string; result?: unknown }>)
          : [],
      )
      .filter(p => p.type === 'tool-call' && p.toolCallId === 'edit-1')
    expect(editParts.length).toBeGreaterThan(0)
    for (const p of editParts) {
      expect(p.result, 'approved tool must carry its result, not stay unresolved').not.toBeUndefined()
    }
    // The merged message's run-STATE is deliberately NOT asserted here: a
    // resolved tool CARD (the PART above) is independent of the turn run-state.
    // With status==='submitting' the turn is still in flight, so the message
    // correctly stays 'running' — pinned by the dedicated regression test below.
    // The card stops spinning purely via the resolved PART, not the message
    // status.
  })

  it('marks live background Agent launches as settled tool parts so they do not spin inline', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool-call',
              toolCallId: 'agent-bg-1',
              toolName: 'Agent',
              args: {
                description: 'audit coverage',
                prompt: 'inspect the implementation',
                run_in_background: true,
              },
            },
          },
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const agentPart = converted
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .find(
        (p): p is { type: string; toolName?: string; result?: unknown } =>
          p.type === 'tool-call' && p.toolName === 'Agent',
      )

    expect(agentPart?.result).toMatchObject({
      backgroundAgentLaunchPending: true,
    })
  })

  it('marks restored unresolved background Agent tool calls as settled so stale sessions do not hang', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-agent-stale',
          timestamp: '2026-06-26T22:38:55.805Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'I’m doing a deeper second pass now.',
              },
              {
                type: 'tool-call',
                toolCallId: 'call_TcKdx2UU23ktRuGsZyl4HApf',
                toolName: 'Agent',
                args: {
                  description: 'Audit shell behaviour',
                  isolation: 'worktree',
                  name: '',
                  prompt: 'Report remaining mismatches only.',
                  run_in_background: true,
                  subagent_type: 'Explore',
                  team_name: '',
                },
              },
            ],
            model: 'gpt-5.5',
            usage: {
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 5632,
              input_tokens: 262078,
              output_tokens: 3465,
            },
            stop_reason: 'tool_use',
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    expect(converted).toHaveLength(1)
    expect(converted[0]?.status).toMatchObject({ type: 'complete' })
    const agentPart = Array.isArray(converted[0]?.content)
      ? converted[0]?.content.find(
          (p): p is { type: string; toolName?: string; result?: unknown } =>
            p.type === 'tool-call' && p.toolName === 'Agent',
        )
      : undefined
    expect(agentPart?.result).toMatchObject({
      backgroundAgentLaunchPending: true,
    })
  })

  it('keeps the merged assistant message "running" mid-turn when a tool resolves (composer must not flip to paused on every tool — regression for a3f586c)', () => {
    // A resolved tool result merged with its stale live copy while the turn is in flight: the merged message must
    // stay 'running', since assistant-ui derives `thread.isRunning` from the last assistant message's status.
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-read',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'read-1',
                toolName: 'Read',
                args: { file_path: 'a.ts' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'user-read-result',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'read-1',
                result: 'file contents',
                isError: false,
              },
            ],
          },
        },
      ],
      liveEvents: [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool-call',
              toolCallId: 'read-1',
              toolName: 'Read',
              args: { file_path: 'a.ts' },
            },
          },
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const lastAssistant = [...converted]
      .reverse()
      .find(m => m.role === 'assistant')
    expect(lastAssistant, 'expected a merged assistant message').toBeDefined()
    expect(
      (lastAssistant!.status as { type?: string } | undefined)?.type,
      'merged assistant message must stay "running" while the turn is in flight',
    ).toBe('running')
  })

  it('hides raw tool_result transcript messages and attaches results to tool calls', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-tool',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'glic_test_tool',
                args: {
                  note: 'demo',
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'tool-result-user',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'tool-1',
                result: '{"ok":true,"durationMs":20000,"note":"demo"}',
              },
            ],
          },
          toolUseResult: '{"ok":true,"durationMs":20000,"note":"demo"}',
        },
        {
          type: 'assistant',
          uuid: 'assistant-final',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Mock test tool completed.',
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // The adapter merges consecutive assistant transcript messages into one
    // (the user-role tool_result between them is hidden), so we end up with
    // a single assistant message whose content carries both the tool-call
    // (with its result attached) and the trailing text follow-up.
    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'assistant-tool',
      role: 'assistant',
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-call',
          toolName: 'glic_test_tool',
          toolCallId: 'tool-1',
          artifact: {
            lazyToolDetail: true,
          },
        }),
        expect.objectContaining({
          type: 'text',
          text: 'Mock test tool completed.',
        }),
      ]),
    })
  })

  it('shows assistant follow-up messages after tool results', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'assistant',
          uuid: 'assistant-tool',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'glic_test_tool',
                args: {
                  note: 'demo',
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'tool-result-user',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'tool-1',
                result: '{"ok":true,"durationMs":20000,"note":"demo"}',
              },
            ],
          },
          toolUseResult: '{"ok":true,"durationMs":20000,"note":"demo"}',
        },
        {
          type: 'assistant',
          uuid: 'assistant-follow-up',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text:
                  'The mock test tool finished successfully.\n\nSummary: demo\nDuration: 20 seconds',
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // The adapter merges consecutive assistant transcript messages, so the
    // tool-call assistant and the text follow-up assistant collapse into one
    // entry whose content carries both pieces.
    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'assistant-tool',
      role: 'assistant',
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-call',
          toolName: 'glic_test_tool',
          toolCallId: 'tool-1',
          artifact: {
            lazyToolDetail: true,
          },
        }),
        expect.objectContaining({
          type: 'text',
          text:
            'The mock test tool finished successfully.\n\nSummary: demo\nDuration: 20 seconds',
        }),
      ]),
    })
  })

  it('renders live compact boundary as the final saved-token divider, not raw system text', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'compact-boundary-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: 'Conversation compacted',
          compactMetadata: { trigger: 'auto', preTokens: 159_200 },
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'compact-boundary-1',
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      metadata: {
        custom: {
          sourceType: 'compact_boundary',
          preTokens: 159_200,
        },
      },
      content: [
        {
          type: 'text',
          text: 'Compacted conversation · saved 159.2k tokens',
        },
      ],
    })
    expect(JSON.stringify(converted)).not.toContain('Conversation compacted')
  })


  it('renders tool progress stream events as live output', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        {
          type: 'stream_event',
          event: {
            type: 'tool_progress',
            toolName: 'Bash',
            data: {
              kind: 'shell_output',
              output: 'partial stdout',
              elapsed_time_seconds: 3,
            },
          },
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(JSON.stringify(converted)).toContain('partial stdout')
    expect(converted[0]).toMatchObject({
      role: 'assistant',
      status: { type: 'running' },
    })
  })

  it('renders compact progress stream events as a running status row', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        {
          type: 'stream_event',
          event: { type: 'compact_progress', stage: 'start' },
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'live-compact-progress',
      role: 'assistant',
      status: { type: 'running' },
      metadata: { custom: { sourceType: 'compact_progress', stage: 'start' } },
      content: [{ type: 'text', text: 'Compacting conversation' }],
    })
  })


  it('discards orphaned tool-call parts from a failed stream attempt on retry', () => {
    // Regression: when a stream times out mid-args (e.g. Read cards whose
    // content_block_start arrived but args never completed), the retry
    // emits stream_request_start. Parts from the FAILED attempt must be
    // discarded so orphaned running tool cards don't linger forever.
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        // Attempt 1: stream starts, emits tool-call content_block_start,
        // then dies (timeout).
        { type: 'stream_request_start' },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool-call',
              toolCallId: 'orphan-read-1',
              toolName: 'Read',
              args: {},
            },
          },
        },
        // Attempt 2: retry starts — must discard attempt 1's parts.
        { type: 'stream_request_start' },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'text',
              text: 'Retry succeeded',
            },
          },
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    // The orphaned Read tool-call from attempt 1 must NOT appear.
    expect(JSON.stringify(converted)).not.toContain('orphan-read-1')
    expect(JSON.stringify(converted)).not.toContain('Read')
    // The retry's text content IS present.
    expect(JSON.stringify(converted)).toContain('Retry succeeded')
  })
  it('hides raw live sdk events and keeps a readable live tool state', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-1',
          uuid: 'session-1',
          model: 'inherit',
          tools: ['glic_test_tool'],
        },
        {
          type: 'stream_request_start',
        },
        {
          type: 'assistant',
          uuid: 'assistant-tool',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'glic_test_tool',
                args: {
                  note: 'demo',
                },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'tool-result-user',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'tool-1',
                result: '{"ok":true,"durationMs":20000,"note":"demo"}',
              },
            ],
          },
          toolUseResult: '{"ok":true,"durationMs":20000,"note":"demo"}',
        },
        {
          type: 'assistant',
          uuid: 'assistant-empty',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: {
            role: 'assistant',
            content: [],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-1',
          uuid: 'result-1',
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'assistant-tool',
      role: 'assistant',
      status: { type: 'running' },
      content: [
        expect.objectContaining({
          type: 'tool-call',
          toolName: 'glic_test_tool',
          toolCallId: 'tool-1',
          artifact: {
            lazyToolDetail: true,
          },
        }),
      ],
    })
    expect(JSON.stringify(converted[0]?.content)).not.toContain('"subtype":"init"')
    expect(JSON.stringify(converted[0]?.content)).not.toContain(
      '"type":"stream_request_start"',
    )
  })

  it('merges consecutive assistant tool-call messages into a single message so ToolGroup can group them', () => {
    const toolCallBlock = (toolCallId: string, toolName: string) => ({
      type: 'tool-call' as const,
      toolCallId,
      toolName,
      args: {},
    })

    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: {
            role: 'user',
            content: 'Inspect the current tab.',
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-tool-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'assistant',
            content: [toolCallBlock('tool-1', 'browser_navigate')],
          },
        },
        {
          type: 'user',
          uuid: 'tool-result-1',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'tool-1',
                result: '{"ok":true}',
              },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-tool-2',
          timestamp: '2026-04-03T12:00:03.000Z',
          message: {
            role: 'assistant',
            content: [toolCallBlock('tool-2', 'browser_act')],
          },
        },
        {
          type: 'user',
          uuid: 'tool-result-2',
          timestamp: '2026-04-03T12:00:04.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'tool-2',
                result: '{"ok":true}',
              },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-tool-3',
          timestamp: '2026-04-03T12:00:05.000Z',
          message: {
            role: 'assistant',
            content: [toolCallBlock('tool-3', 'browser_act')],
          },
        },
        {
          type: 'user',
          uuid: 'tool-result-3',
          timestamp: '2026-04-03T12:00:06.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'tool-3',
                result: '{"ok":true}',
              },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-final',
          timestamp: '2026-04-03T12:00:07.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Done.',
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(2)
    expect(converted[0]).toMatchObject({ role: 'user' })

    const assistant = converted[1]
    expect(assistant?.role).toBe('assistant')
    // Merged trailing assistant of the current turn uses the stable turn id
    // anchored to the last real user message (user-1 here).
    expect(assistant?.id).toBe('turn:user-1:assistant')
    expect(Array.isArray(assistant?.content)).toBe(true)

    const parts = (assistant?.content ?? []) as Array<{
      type: string
      toolCallId?: string
      toolName?: string
      text?: string
    }>
    expect(parts).toHaveLength(4)
    expect(parts[0]).toMatchObject({ type: 'tool-call', toolCallId: 'tool-1' })
    expect(parts[1]).toMatchObject({ type: 'tool-call', toolCallId: 'tool-2' })
    expect(parts[2]).toMatchObject({ type: 'tool-call', toolCallId: 'tool-3' })
    expect(parts[3]).toMatchObject({ type: 'text', text: 'Done.' })
  })

  it('does not merge across a user message', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: { role: 'user', content: 'First turn.' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Reply 1.' }],
          },
        },
        {
          type: 'user',
          uuid: 'user-2',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: { role: 'user', content: 'Second turn.' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-2',
          timestamp: '2026-04-03T12:00:03.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Reply 2.' }],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(4)
    expect(converted.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    // Earlier turn keeps its uuid-based id; only the trailing (current-turn)
    // assistant is rewritten with the stable turn id so React doesn't remount
    // it across live → transcript transitions.
    expect(converted[1]?.id).toBe('assistant-1')
    expect(converted[3]?.id).toBe('turn:user-2:assistant')
  })

  it('keeps assistant-ui message ids unique when transcript uuids repeat', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'duplicate-user',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: { role: 'user', content: 'First prompt.' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'First reply.' }],
          },
        },
        {
          type: 'user',
          uuid: 'duplicate-user',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: { role: 'user', content: 'Second prompt.' },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expectUniqueMessageIds(converted)
    expect(converted.map(message => message.id)).toEqual([
      'duplicate-user',
      'assistant-1',
      'duplicate-user:duplicate-1',
    ])
  })

  it('keeps ids unique when a compact boundary appears in transcript and live events', () => {
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary-1',
      timestamp: '2026-04-03T12:00:01.000Z',
      message: 'Conversation compacted',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 1234,
      },
    }
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-03T12:00:00.000Z',
          message: { role: 'user', content: 'Compact this.' },
        },
        boundary,
      ],
      liveEvents: [boundary],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expectUniqueMessageIds(converted)
    expect(converted.map(message => message.id)).toEqual([
      'user-1',
      'compact-boundary-1',
      'compact-boundary-1:duplicate-1',
    ])
  })

  it('does not render raw tool-call streaming deltas as JSON text', () => {
    const state: BrowserRuntimeClientState = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        {
          type: 'stream_event',
          event: {
            type: 'tool-call-streaming-start',
            toolCallId: 'tool-stream-1',
            toolName: 'glic_test_tool',
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'tool-call-delta',
            toolCallId: 'tool-stream-1',
            argsTextDelta: '{"note":"partial"}',
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'message_delta',
            delta: {
              stop_reason: 'tool_use',
            },
          },
        },
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'live-assistant-message',
      role: 'assistant',
      status: { type: 'running' },
      content: [
        expect.objectContaining({
          type: 'tool-call',
          toolCallId: 'tool-stream-1',
          toolName: 'glic_test_tool',
        }),
      ],
    })
    expect(JSON.stringify(converted[0])).not.toContain('argsTextDelta')
    expect(JSON.stringify(converted[0])).not.toContain('message_delta')
  })

  it('renders [Request interrupted by user] as a muted inline marker instead of a user bubble', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-real',
          message: { role: 'user', content: 'Do a slow task' },
        },
        {
          type: 'assistant',
          uuid: 'assistant-partial',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Working on it…' }],
          },
        },
        {
          type: 'user',
          uuid: 'user-interrupt',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)

    expect(converted).toHaveLength(3)
    expect(converted[0]).toMatchObject({ id: 'user-real', role: 'user' })
    expect(converted[1]).toMatchObject({ role: 'assistant' })
    // The sentinel becomes a `role: 'system'` marker carrying a
    // `sourceType: 'interrupt'` flag that Thread.tsx dispatches on to
    // render the dim inline "Interrupted" line.
    expect(converted[2]).toMatchObject({
      id: 'user-interrupt',
      role: 'system',
    })
    expect(converted[2].metadata?.custom).toMatchObject({
      sourceType: 'interrupt',
      variant: 'plain',
    })
    // The raw sentinel text must NOT appear anywhere in the rendered
    // content — we substitute a short "Interrupted" label for display.
    expect(JSON.stringify(converted)).not.toContain(
      '[Request interrupted by user]',
    )
    // The anchor uuid the trailing assistant is re-keyed on must NOT be
    // the interrupt sentinel's uuid.
    expect(converted[1].id).not.toContain('user-interrupt')
  })

  it('flags the "for tool use" interrupt variant in metadata', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-interrupt-tool',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '[Request interrupted by user for tool use]',
              },
            ],
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      role: 'system',
    })
    expect(converted[0].metadata?.custom).toMatchObject({
      sourceType: 'interrupt',
      variant: 'for_tool_use',
    })
  })

  it('keeps a user message that merely contains but does not exactly equal the sentinel', () => {
    const state: BrowserRuntimeClientState = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'user',
          uuid: 'user-quoting',
          message: {
            role: 'user',
            content:
              'Why did you write "[Request interrupted by user]" in your last reply?',
          },
        },
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }

    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    expect(converted).toHaveLength(1)
    expect(converted[0]).toMatchObject({
      id: 'user-quoting',
      role: 'user',
    })
  })
})

// Regression guard for the transcript/live conversion split (perf fix:
// stop re-converting the whole transcript on every streaming token). The
// React layer memoizes `convertTranscriptToThreadMessages` on
// `state.transcriptMessages` alone and only re-runs `combineThreadMessages`
// per token. These tests pin the two invariants that makes safe:
//   1. composition equivalence — split output === monolithic output, and
//   2. transcript-independence — the transcript half depends ONLY on
//      `transcriptMessages`, so it is correct to reuse it across live ticks.
describe('assistantUiAdapter transcript/live split', () => {
  const transcriptMessages: BrowserRuntimeClientState['transcriptMessages'] = [
    {
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-04-03T12:00:00.000Z',
      message: { role: 'user', content: 'First question.' },
    },
    {
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp: '2026-04-03T12:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'A persisted answer.' }],
      },
    } as unknown as BrowserRuntimeClientState['transcriptMessages'][number],
  ]

  const liveEventsA: BrowserRuntimeClientState['liveEvents'] = [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Streaming ' },
      },
    } as unknown as BrowserRuntimeClientState['liveEvents'][number],
  ]
  const liveEventsB: BrowserRuntimeClientState['liveEvents'] = [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Streaming more tokens' },
      },
    } as unknown as BrowserRuntimeClientState['liveEvents'][number],
  ]

  const makeState = (
    liveEvents: BrowserRuntimeClientState['liveEvents'],
  ): BrowserRuntimeClientState => ({
    status: 'submitting',
    snapshot: null,
    transcriptMessages,
    liveEvents,
    lastError: null,
    pendingPrompt: 'In-flight prompt.',
    pendingPromptId: 'pending-1',
  })

  it('combine(convertTranscript(...)) equals the monolithic conversion', () => {
    const state = makeState(liveEventsA)
    const split = combineThreadMessages(
      convertTranscriptToThreadMessages(state.transcriptMessages),
      state,
    )
    expect(split).toEqual(convertBrowserRuntimeStateToThreadMessages(state))
  })

  it('reuses ONE transcript conversion across differing live ticks', () => {
    // Simulate the React memo: convert the transcript exactly once, then
    // combine it against two distinct live-event sets that share the same
    // transcript reference (the per-streaming-token scenario).
    const transcript = convertTranscriptToThreadMessages(transcriptMessages)

    const fromShared = [liveEventsA, liveEventsB].map(live =>
      combineThreadMessages(transcript, makeState(live)),
    )
    const fromMonolithic = [liveEventsA, liveEventsB].map(live =>
      convertBrowserRuntimeStateToThreadMessages(makeState(live)),
    )

    // Reusing the single transcript conversion yields byte-identical results
    // to re-deriving everything from scratch each tick — proving the heavy
    // transcript pass is safe to skip when only liveEvents changed.
    expect(fromShared).toEqual(fromMonolithic)
  })

  it('does not mutate the shared transcript result when combined repeatedly', () => {
    const transcript = convertTranscriptToThreadMessages(transcriptMessages)
    const lengthBefore = transcript.messages.length

    // Two combines (pending + live appended each time). If combine pushed into
    // the shared `transcript.messages` instead of a copy, the second call would
    // see a polluted, ever-growing base and the outputs would diverge / throw
    // duplicate-id in assistant-ui.
    const first = combineThreadMessages(transcript, makeState(liveEventsA))
    const second = combineThreadMessages(transcript, makeState(liveEventsA))

    expect(transcript.messages).toHaveLength(lengthBefore)
    expect(second).toEqual(first)
  })
})

// `worker.completed` flips the client to `ready` while the live half stays on
// screen until the transcript refetch. The live message stays `running` until
// then — assistant-ui derives `thread.isRunning` from it, and the composer
// must not read idle before the final reply is displayed —
// but it is stamped `turnSettled` so its streamed text can stop animating and
// show whole.
describe('assistantUiAdapter live half after the turn ends', () => {
  const liveEvents: BrowserRuntimeClientState['liveEvents'] = [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'The final reply.' },
      },
    } as unknown as BrowserRuntimeClientState['liveEvents'][number],
  ]
  const state = (status: BrowserRuntimeClientState['status']): BrowserRuntimeClientState => ({
    status,
    snapshot: null,
    transcriptMessages: [],
    liveEvents,
    lastError: null,
    pendingPrompt: null,
    pendingPromptId: null,
  })
  const lastLive = (s: BrowserRuntimeClientState) => {
    const messages = combineThreadMessages(convertTranscriptToThreadMessages([]), s)
    const last = messages[messages.length - 1]!
    expect(last.role).toBe('assistant')
    return last
  }
  const settled = (s: BrowserRuntimeClientState) =>
    (lastLive(s).metadata?.custom as Record<string, unknown> | undefined)?.turnSettled

  it('keeps the live message running and unsettled while the turn is in flight', () => {
    expect(lastLive(state('submitting')).status?.type).toBe('running')
    expect(settled(state('submitting'))).toBeUndefined()
  })

  it('keeps it running once the client is ready — so the composer is not idle before the reply is shown — but marks the turn settled', () => {
    expect(lastLive(state('ready')).status?.type).toBe('running')
    expect(settled(state('ready'))).toBe(true)
  })
})

// Regression guard for the "loading session animation hangs forever" bug.
// The skeleton (ThreadWelcome) is shown while the thread is empty AND
// shouldShowLoadingSkeleton() is true. The hang happened when the worker
// reported messageCount > 0, the full transcript was delivered, but every
// message converted to nothing (system/init, attachments, isMeta, internal
// tool-results, interrupt markers) — `thread.isEmpty` then stayed true forever.
describe('shouldShowLoadingSkeleton', () => {
  const transcriptOf = (
    n: number,
  ): BrowserRuntimeClientState['transcriptMessages'] =>
    Array.from({length: n}, (_unused, i) => ({
      type: 'user',
      uuid: `u${i}`,
      message: {role: 'user', content: 'hi'},
    })) as unknown as BrowserRuntimeClientState['transcriptMessages']

  const makeState = (
    snapshot: {
      messageCount: number
      initialized?: boolean
      uiReady?: boolean
    } | null,
    transcriptMessages: BrowserRuntimeClientState['transcriptMessages'],
  ): BrowserRuntimeClientState => ({
    status: snapshot ? 'ready' : 'initializing',
    // Default to an initialized (runtime-built) snapshot; the pre-runtime
    // degenerate case passes `initialized: false` explicitly.
    snapshot: (snapshot
      ? {initialized: true, ...snapshot}
      : null) as unknown as BrowserRuntimeClientState['snapshot'],
    transcriptMessages,
    liveEvents: [],
    lastError: null,
    pendingPrompt: null,
    pendingPromptId: null,
  })

  it('shows for a pre-runtime snapshot (initialized false) so a mid-boot restored session never flashes empty', () => {
    // The worker can emit a transient snapshot with the runtime not yet built
    // (initialized false, messageCount 0). Without this the messageCount<=0
    // "empty thread" branch would hide the skeleton and surface the composer +
    // welcome page for a RESTORED session while its transcript is still loading.
    expect(
      shouldShowLoadingSkeleton(
        makeState({messageCount: 0, initialized: false}, transcriptOf(0)),
        0,
      ),
    ).toBe(true)
  })

  it('shows while the snapshot has not arrived yet', () => {
    expect(shouldShowLoadingSkeleton(makeState(null, transcriptOf(0)), 0)).toBe(
      true,
    )
  })

  it('hides for an empty new thread (messageCount === 0)', () => {
    expect(
      shouldShowLoadingSkeleton(makeState({messageCount: 0}, transcriptOf(0)), 0),
    ).toBe(false)
  })

  it('shows while a non-empty transcript is still being delivered', () => {
    // messageCount 3 but 0 delivered so far → still loading.
    expect(
      shouldShowLoadingSkeleton(makeState({messageCount: 3}, transcriptOf(0)), 0),
    ).toBe(true)
  })

  it('shows once a delivered transcript yields renderable messages (until it paints)', () => {
    expect(
      shouldShowLoadingSkeleton(makeState({messageCount: 2}, transcriptOf(2)), 2),
    ).toBe(true)
  })

  it('HIDES when the fully-delivered transcript converts to nothing (forever-skeleton guard)', () => {
    // messageCount 2, transcript delivered (length 2), but every message was
    // filtered out by the adapter (convertedMessageCount 0). The pre-fix gate
    // (`messageCount > 0`) kept the skeleton up forever; now we surface the
    // empty composer instead.
    expect(
      shouldShowLoadingSkeleton(makeState({messageCount: 2}, transcriptOf(2)), 0),
    ).toBe(false)
  })

  // --- Transcript-only (the shutdown teammate's read-only tab) ---------------
  // `startReadOnly` loads the transcript without a runtime, so this client never gets a snapshot; a settled
  // read-only tab must not read as loading.

  it('shows while the read-only transcript load is still in flight', () => {
    // `transcriptOnly` is set when the read SETTLES, so its absence here is the
    // in-flight state and the skeleton must still cover it.
    expect(shouldShowLoadingSkeleton(makeState(null, transcriptOf(0)), 0)).toBe(
      true,
    )
  })

  it('HIDES for a settled read-only view that found messages', () => {
    expect(
      shouldShowLoadingSkeleton(
        {
          ...makeState(null, transcriptOf(3)),
          status: 'ready',
          transcriptOnly: true,
        },
        3,
      ),
    ).toBe(false)
  })

  it('HIDES for a settled read-only view whose transcript is EMPTY', () => {
    // The shape the mis-routed read produced: no error, just nothing. Before
    // the flag this was indistinguishable from "still loading".
    expect(
      shouldShowLoadingSkeleton(
        {
          ...makeState(null, transcriptOf(0)),
          status: 'ready',
          transcriptOnly: true,
        },
        0,
      ),
    ).toBe(false)
  })

  it('HIDES for a FAILED read-only load, so its error banner is not covered', () => {
    // The overlay is `absolute inset-0 z-30` — it painted over the very
    // `transcript_read_failed` banner the read-only path raises.
    expect(
      shouldShowLoadingSkeleton(
        {
          ...makeState(null, transcriptOf(0)),
          status: 'error',
          lastError: {code: 'transcript_read_failed', message: 'timed out'},
          transcriptOnly: true,
        },
        0,
      ),
    ).toBe(false)
  })

  // --- UI-ready split: a PROVISIONAL snapshot (initialized false but
  // uiReady true) is renderable content and takes the same branches as an
  // initialized one — the worker pushed the real messageCount + transcript
  // while the MCP connect / engine build still runs.

  it('UI-ready split: hides for an empty provisional snapshot (new thread renders its composer mid-build)', () => {
    expect(
      shouldShowLoadingSkeleton(
        makeState(
          {messageCount: 0, initialized: false, uiReady: true},
          transcriptOf(0),
        ),
        0,
      ),
    ).toBe(false)
  })

  it('UI-ready split: shows while the provisional transcript push is still in flight', () => {
    expect(
      shouldShowLoadingSkeleton(
        makeState(
          {messageCount: 3, initialized: false, uiReady: true},
          transcriptOf(0),
        ),
        0,
      ),
    ).toBe(true)
  })

  it('UI-ready split: forever-skeleton guard also applies to a provisional snapshot', () => {
    expect(
      shouldShowLoadingSkeleton(
        makeState(
          {messageCount: 2, initialized: false, uiReady: true},
          transcriptOf(2),
        ),
        0,
      ),
    ).toBe(false)
  })
})

// shouldDismissBootWelcome() is the DISMISS half of the loading contract that
// `shouldShowLoadingSkeleton` (above) opens. It gates when the host WebUI's
// `<nexus-welcome>` boot splash may be torn down. The regression it guards: a
// restored session with messages must keep the host splash up until the
// conversation has actually PAINTED — never dismiss at snapshot-ready and hand
// off to the guest's own `NexusLoadingPage` skeleton (the "double wait" a
// 2 s wall-clock cap used to cause). The gate is now purely event-driven.
describe('shouldDismissBootWelcome', () => {
  const transcriptOf = (
    n: number,
  ): BrowserRuntimeClientState['transcriptMessages'] =>
    Array.from({length: n}, (_unused, i) => ({
      type: 'user',
      uuid: `u${i}`,
      message: {role: 'user', content: 'hi'},
    })) as unknown as BrowserRuntimeClientState['transcriptMessages']

  const makeState = (
    snapshot: {
      messageCount: number
      initialized?: boolean
      uiReady?: boolean
    } | null,
    transcriptMessages: BrowserRuntimeClientState['transcriptMessages'],
    status: BrowserRuntimeClientState['status'] = snapshot
      ? 'ready'
      : 'initializing',
  ): BrowserRuntimeClientState => ({
    status,
    // Default to an initialized (runtime-built) snapshot; the pre-runtime
    // degenerate case passes `initialized: false` explicitly.
    snapshot: (snapshot
      ? {initialized: true, ...snapshot}
      : null) as unknown as BrowserRuntimeClientState['snapshot'],
    transcriptMessages,
    liveEvents: [],
    lastError: null,
    pendingPrompt: null,
    pendingPromptId: null,
  })

  const painted = {threadWelcomeUnmounted: true, bodyHydrated: true}
  const notPainted = {threadWelcomeUnmounted: false, bodyHydrated: false}

  it('HOLDS on a pre-runtime snapshot (ready but initialized false) — the "uninit session" flash', () => {
    // The reported bug: on resume the client flips to `ready` on a transient
    // snapshot with the runtime not yet built (initialized false, messageCount
    // 0). The messageCount<=0 branch would dismiss the host splash HERE, mid-
    // boot, exposing the guest's welcome/guidance page. It must hold until the
    // real initialized snapshot arrives.
    expect(
      shouldDismissBootWelcome(
        makeState({messageCount: 0, initialized: false}, transcriptOf(0)),
        painted,
      ),
    ).toBe(false)
  })

  it('holds while the worker snapshot has not arrived yet', () => {
    expect(shouldDismissBootWelcome(makeState(null, transcriptOf(0)), painted)).toBe(
      false,
    )
  })

  it('holds while the client is ready but the snapshot is still null', () => {
    // A cold switch briefly reports status ready with a null snapshot.
    expect(
      shouldDismissBootWelcome(makeState(null, transcriptOf(0), 'ready'), painted),
    ).toBe(false)
  })

  it('dismisses immediately for an empty new thread (messageCount === 0)', () => {
    // Nothing to paint — the composer is the resting state, so the guest is
    // already showing stable content regardless of the paint events.
    expect(
      shouldDismissBootWelcome(makeState({messageCount: 0}, transcriptOf(0)), notPainted),
    ).toBe(true)
  })

  it('HOLDS for a session with messages until the conversation has painted', () => {
    // The core regression: snapshot is ready with messages but the conversation
    // has not painted (skeleton still up). The old 2 s cap dismissed here after
    // a timeout; the event-driven gate must keep waiting.
    expect(
      shouldDismissBootWelcome(makeState({messageCount: 5}, transcriptOf(5)), notPainted),
    ).toBe(false)
    // Skeleton gone but bodies not yet hydrated (the empty-frames flash) — still hold.
    expect(
      shouldDismissBootWelcome(makeState({messageCount: 5}, transcriptOf(5)), {
        threadWelcomeUnmounted: true,
        bodyHydrated: false,
      }),
    ).toBe(false)
  })

  it('dismisses a session with messages once it has painted', () => {
    expect(
      shouldDismissBootWelcome(makeState({messageCount: 5}, transcriptOf(5)), painted),
    ).toBe(true)
  })

  it('dismisses an all-internal transcript via the bodyHydrated signal', () => {
    // messageCount > 0 but the transcript converts to nothing (mirrors the
    // shouldShowLoadingSkeleton forever-skeleton guard). AssistantUiThread fires
    // `bodyHydrated` once the transcript is fully delivered since there is
    // nothing to hydrate, so the gate resolves on a real event — no 10 s hang.
    expect(
      shouldDismissBootWelcome(makeState({messageCount: 2}, transcriptOf(2)), painted),
    ).toBe(true)
  })

  // --- Transcript-only (the boot-active shutdown teammate) -------------------
  // A settled read-only view (no runtime, so no snapshot) is a finished load: it dismisses the host splash, and
  // the SHOW half returns false for the same state.

  it('HOLDS while the read-only transcript load is still in flight', () => {
    expect(
      shouldDismissBootWelcome(makeState(null, transcriptOf(0)), notPainted),
    ).toBe(false)
  })

  it('dismisses for a settled read-only view, with no paint events at all', () => {
    // The paint gates cannot help here: `ThreadWelcome` never mounts for this
    // state (the SHOW half is false), so `threadWelcomeUnmounted` can never
    // fire. Requiring it would BE the hang.
    expect(
      shouldDismissBootWelcome(
        {
          ...makeState(null, transcriptOf(4)),
          status: 'ready',
          transcriptOnly: true,
        },
        notPainted,
      ),
    ).toBe(true)
  })

  it('dismisses for a settled read-only view with an EMPTY transcript', () => {
    expect(
      shouldDismissBootWelcome(
        {
          ...makeState(null, transcriptOf(0)),
          status: 'ready',
          transcriptOnly: true,
        },
        notPainted,
      ),
    ).toBe(true)
  })

  it('dismisses for a FAILED read-only load (status error is still settled)', () => {
    // Checked BEFORE the `status !== 'ready'` guard: a read that failed has
    // finished, and holding the splash for it strands the user on the splash.
    expect(
      shouldDismissBootWelcome(
        {
          ...makeState(null, transcriptOf(0)),
          status: 'error',
          lastError: {code: 'transcript_read_failed', message: 'timed out'},
          transcriptOnly: true,
        },
        notPainted,
      ),
    ).toBe(true)
  })

  // --- UI-ready split: a PROVISIONAL snapshot (initialized false but uiReady
  // true) is dismissal-worthy — the whole point of the split is tearing the
  // splash down while the MCP connect / engine build still runs. The paint
  // gates keep doing their job for non-empty sessions.

  it('UI-ready split: dismisses immediately for an empty provisional snapshot', () => {
    expect(
      shouldDismissBootWelcome(
        makeState(
          {messageCount: 0, initialized: false, uiReady: true},
          transcriptOf(0),
        ),
        notPainted,
      ),
    ).toBe(true)
  })

  it('UI-ready split: a provisional snapshot with messages still waits for the paint gates', () => {
    expect(
      shouldDismissBootWelcome(
        makeState(
          {messageCount: 5, initialized: false, uiReady: true},
          transcriptOf(5),
        ),
        notPainted,
      ),
    ).toBe(false)
    expect(
      shouldDismissBootWelcome(
        makeState(
          {messageCount: 5, initialized: false, uiReady: true},
          transcriptOf(5),
        ),
        painted,
      ),
    ).toBe(true)
  })
})

// transcriptWillHydrateAssistantBody() decides whether `nexus:assistantMessageBody:firstHydrated` can ever fire
// for a converted transcript; AssistantUiThread fires the signal on transcript-settled when it cannot.
describe('transcriptWillHydrateAssistantBody', () => {
  type Msg = Parameters<typeof transcriptWillHydrateAssistantBody>[0][number]

  const user = (text: string): Msg =>
    ({role: 'user', content: [{type: 'text', text}]}) as unknown as Msg
  const assistant = (text: string, sourceType?: string): Msg =>
    ({
      role: 'assistant',
      content: [{type: 'text', text}],
      ...(sourceType ? {metadata: {custom: {sourceType}}} : {}),
    }) as unknown as Msg

  it('is false for an empty transcript', () => {
    expect(transcriptWillHydrateAssistantBody([])).toBe(false)
  })

  it('is false for a user-only transcript — the mid-turn-killed shape', () => {
    expect(transcriptWillHydrateAssistantBody([user('test3')])).toBe(false)
  })

  it('is true when a plain assistant message is present', () => {
    expect(
      transcriptWillHydrateAssistantBody([user('hi'), assistant('hello')]),
    ).toBe(true)
  })

  it('is false when every assistant-shaped message renders a dedicated card', () => {
    expect(
      transcriptWillHydrateAssistantBody([
        user('hi'),
        assistant('API Error: …', 'provider_api_error'),
        assistant('compacted', 'compact_boundary'),
        assistant('bg', 'background_results'),
      ]),
    ).toBe(false)
  })

  it('is true when a plain assistant message follows dedicated cards', () => {
    expect(
      transcriptWillHydrateAssistantBody([
        user('hi'),
        assistant('API Error: …', 'provider_api_error'),
        assistant('real answer'),
      ]),
    ).toBe(true)
  })

  it('treats an unknown sourceType as hydratable (fail open — a newer build must not hold the splash)', () => {
    expect(
      transcriptWillHydrateAssistantBody([
        assistant('novel', 'some_future_card'),
      ]),
    ).toBe(true)
  })
})

describe('end_turn reply marking', () => {
  const assistant = (uuid: string, stop_reason: string, texts: string[]) => ({
    type: 'assistant',
    uuid,
    timestamp: '2026-09-20T10:00:00.000Z',
    message: {
      role: 'assistant',
      content: texts.map(text => ({ type: 'text', text })),
      model: 'claude-opus-5',
      stop_reason,
    },
  })

  it('marks only the LAST text of an end_turn message, never text from a tool_use message', () => {
    const state = {
      status: 'ready',
      snapshot: null,
      transcriptMessages: [
        assistant('a1', 'tool_use', ['preamble']),
        assistant('a2', 'end_turn', ['first half', 'the reply']),
      ],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const texts = convertBrowserRuntimeStateToThreadMessages(state)
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter(p => p.type === 'text') as Array<{ text: string; endTurn?: boolean }>

    expect(texts.map(p => [p.text, p.endTurn === true])).toEqual([
      ['preamble', false],
      ['first half', false],
      ['the reply', true],
    ])
  })

  it('marks the end_turn reply on the LIVE path too, before the turn persists', () => {
    // While the turn is live, its messages come from liveEvents, not the
    // transcript; an unmarked reply there folds into a collapsed tool group
    // until the transcript copy replaces it.
    const state = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [],
      liveEvents: [
        assistant('l1', 'tool_use', ['preamble']),
        assistant('l2', 'end_turn', ['first half', 'the reply']),
      ],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState

    const texts = convertBrowserRuntimeStateToThreadMessages(state)
      .flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter(p => p.type === 'text') as Array<{ text: string; endTurn?: boolean }>

    expect(texts.map(p => [p.text, p.endTurn === true])).toEqual([
      ['preamble', false],
      ['first half', false],
      ['the reply', true],
    ])
  })
})

// attachmentToText had no case for the @-mention attachments `file_parts`
// (an image, a notebook, PDF page images, a Read error) and `directory`, so
// both read as ''. The switch is exhaustive now: a new type fails to compile.
describe('attachmentToText for @-mention attachments', () => {
  const asMessage = (attachment: ContextRow['attachment']): ContextRow =>
    ({ type: 'attachment', uuid: 'a1', attachment }) as ContextRow

  it('describes a file_parts attachment', () => {
    expect(
      attachmentToText(
        asMessage({
          type: 'file_parts',
          filename: '/w/doc.pdf',
          displayPath: 'doc.pdf',
          pages: '1-2',
          parts: [
            { type: 'text', text: 'PDF file read: /w/doc.pdf (pages 1-2 of 2)' },
            { type: 'image', image: 'AA', mimeType: 'image/jpeg' },
            { type: 'image', image: 'BB', mimeType: 'image/jpeg' },
          ],
        }),
      ),
    ).toBe('Attached file: /w/doc.pdf\nPath: doc.pdf\nPages: 1-2\nImages: 2')
  })

  it('describes a directory attachment', () => {
    expect(
      attachmentToText(
        asMessage({ type: 'directory', path: '/w/src', displayPath: 'src', content: 'a.ts\nb.ts' }),
      ),
    ).toBe('Attached directory: /w/src\nPath: src\nEntries: 2')
  })
})

describe('assistantUiAdapter — a slash command\'s output row (CommandOutput)', () => {
  it('carries the row\'s command and args onto its metadata; another system row carries none', () => {
    const state: BrowserRuntimeClientState = {
      status: 'idle',
      snapshot: null,
      transcriptMessages: [
        {
          type: 'system',
          subtype: 'informational',
          uuid: 'out-1',
          timestamp: '2026-04-03T12:00:01.000Z',
          message: 'Total: $0.12',
          slashCommand: { name: 'cost', args: '--all' },
        },
        {
          type: 'system',
          subtype: 'informational',
          uuid: 'note-1',
          timestamp: '2026-04-03T12:00:02.000Z',
          message: 'a note',
        },
      ] as BrowserRuntimeClientState['transcriptMessages'],
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    }
    const converted = convertBrowserRuntimeStateToThreadMessages(state)
    const custom = converted.map(m => (m.metadata as { custom?: Record<string, unknown> } | undefined)?.custom)
    expect(custom[0]).toMatchObject({ sourceType: 'system', commandOutput: { command: 'cost', args: '--all' } })
    expect(custom[1]).toMatchObject({ sourceType: 'system' })
    expect(custom[1]?.commandOutput).toBeUndefined()
  })
})
