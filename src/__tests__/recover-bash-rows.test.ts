/**
 * extractRecoveredBashRows rebuilds the drawer's background-shell rows from the loaded transcript: a shell
 * tool-result's `{ shell_id, status }` handle (`shell_id` is the task id; output lives in the sidecar via
 * `detailId`), and the older `{ task_id, status:'running', output_file }` + `<task-notification>` shape.
 */
import { describe, expect, it } from 'vitest'
import {
  extractRecoveredBashRows,
  MAX_RECOVERED_BASH_ROWS,
} from '../browser/worker/recoverBashRows'

/** The assistant tool-use that launched a shell. */
function launchCall(
  callId: string,
  command: string,
  timestamp?: string,
  toolName = 'Bash',
): unknown {
  return {
    type: 'assistant',
    ...(timestamp ? { timestamp } : {}),
    message: {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: callId, toolName, args: { command } },
      ],
    },
  }
}

/** The REAL persisted shell tool-result: the inline `{ shell_id, status }`
 *  ProcessTool handle. */
function shellResult(
  callId: string,
  shellId: string,
  status: 'completed' | 'running',
  timestamp?: string,
): unknown {
  return {
    type: 'user',
    ...(timestamp ? { timestamp } : {}),
    message: {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: callId, result: { shell_id: shellId, status } },
      ],
    },
  }
}

/** The legacy running-shell handoff object (backgrounded `run_in_background`). */
function launchResult(
  callId: string,
  taskId: string,
  outputFile: string,
  timestamp?: string,
): unknown {
  return {
    type: 'user',
    ...(timestamp ? { timestamp } : {}),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          result: {
            task_id: taskId,
            status: 'running',
            output_file: outputFile,
            message: `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}.`,
          },
        },
      ],
    },
  }
}

/** A `<task-notification>` completion turn (as formatTaskNotifications emits). */
function completionTurn(
  taskId: string,
  command: string,
  status: 'completed' | 'failed',
  outputFile: string,
  timestamp?: string,
): unknown {
  const text =
    `<task-notification>\n` +
    `<task-id>${taskId}</task-id>\n` +
    `<task-type>local_bash</task-type>` +
    `\n<output-file>${outputFile}</output-file>\n` +
    `<status>${status}</status>\n` +
    `<summary>Background command "${command}" ${status}</summary>\n` +
    `</task-notification>`
  return {
    type: 'user',
    ...(timestamp ? { timestamp } : {}),
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

describe('extractRecoveredBashRows — real inline {shell_id,status} shape', () => {
  it('recovers a completed foreground shell with BOTH startedAt (launch turn) and finishedAt (result turn), so the drawer can show "started … · took …"', () => {
    const rows = extractRecoveredBashRows([
      launchCall('call_a', 'git status', '2026-08-29T10:00:00.000Z'),
      shellResult('call_a', 'b383hxx6x', 'completed', '2026-08-29T10:00:03.000Z'),
    ])
    expect(rows).toEqual([
      {
        taskId: 'b383hxx6x',
        command: 'git status',
        detailId: 'call_a',
        status: 'success',
        // startedAt from the launching tool-use turn — this is the field that
        // was missing before the fix, collapsing the drawer meta to bare "done".
        startedAt: Date.parse('2026-08-29T10:00:00.000Z'),
        finishedAt: Date.parse('2026-08-29T10:00:03.000Z'),
      },
    ])
  })

  it('a completed shell whose launch turn has no timestamp still recovers, with only finishedAt', () => {
    const rows = extractRecoveredBashRows([
      launchCall('call_a2', 'git status'),
      shellResult('call_a2', 'bnodate', 'completed', '2026-08-29T10:00:03.000Z'),
    ])
    expect(rows).toEqual([
      {
        taskId: 'bnodate',
        command: 'git status',
        detailId: 'call_a2',
        status: 'success',
        finishedAt: Date.parse('2026-08-29T10:00:03.000Z'),
      },
    ])
  })

  it('recovers a shell still running at app close as stopped (startedAt from the launch turn)', () => {
    const rows = extractRecoveredBashRows([
      launchCall('call_b', 'npm run dev', '2026-08-29T10:00:00.000Z'),
      shellResult('call_b', 'brun1', 'running', '2026-08-29T10:00:00.500Z'),
    ])
    expect(rows).toEqual([
      {
        taskId: 'brun1',
        command: 'npm run dev',
        detailId: 'call_b',
        status: 'stopped',
        startedAt: Date.parse('2026-08-29T10:00:00.000Z'),
      },
    ])
  })

  it('a still-running shell whose launch turn was trimmed falls back to the result turn for startedAt', () => {
    const rows = extractRecoveredBashRows([
      shellResult('call_b2', 'brun2', 'running', '2026-08-29T10:00:00.500Z'),
    ])
    expect(rows).toEqual([
      {
        taskId: 'brun2',
        detailId: 'call_b2',
        status: 'stopped',
        startedAt: Date.parse('2026-08-29T10:00:00.500Z'),
      },
    ])
  })

  it('recovers many completed foreground shells (the real-session case: rows reappear after restart)', () => {
    const messages: unknown[] = []
    for (let i = 0; i < 5; i++) {
      messages.push(launchCall(`call_${i}`, `cmd ${i}`))
      messages.push(shellResult(`call_${i}`, `bid${i}`, 'completed'))
    }
    const rows = extractRecoveredBashRows(messages)
    expect(rows.map(r => [r.taskId, r.command, r.status, r.detailId])).toEqual([
      ['bid0', 'cmd 0', 'success', 'call_0'],
      ['bid1', 'cmd 1', 'success', 'call_1'],
      ['bid2', 'cmd 2', 'success', 'call_2'],
      ['bid3', 'cmd 3', 'success', 'call_3'],
      ['bid4', 'cmd 4', 'success', 'call_4'],
    ])
  })

  it('a completed shell result whose launch ack was trimmed still recovers (command absent)', () => {
    const rows = extractRecoveredBashRows([
      shellResult('call_x', 'borphan', 'completed'),
    ])
    expect(rows).toEqual([
      { taskId: 'borphan', detailId: 'call_x', status: 'success' },
    ])
  })
})

describe('extractRecoveredBashRows — legacy backgrounded handoff shape', () => {
  it('projects a completed background shell to a success row with output-file + times', () => {
    const rows = extractRecoveredBashRows([
      launchCall('c1', 'npm run build', '2026-08-29T10:00:00.000Z'),
      launchResult('c1', 'b-aaa', '/tmp/bg_aaa.log', '2026-08-29T10:00:00.500Z'),
      completionTurn(
        'b-aaa',
        'npm run build',
        'completed',
        '/tmp/bg_aaa.log',
        '2026-08-29T10:05:00.000Z',
      ),
    ])
    expect(rows).toEqual([
      {
        taskId: 'b-aaa',
        command: 'npm run build',
        detailId: 'c1',
        outputFilePath: '/tmp/bg_aaa.log',
        status: 'success',
        startedAt: Date.parse('2026-08-29T10:00:00.500Z'),
        finishedAt: Date.parse('2026-08-29T10:05:00.000Z'),
      },
    ])
  })

  it('maps a failed completion to error', () => {
    const rows = extractRecoveredBashRows([
      launchCall('c1', 'make test'),
      launchResult('c1', 'b-bbb', '/tmp/bg_bbb.log'),
      completionTurn('b-bbb', 'make test', 'failed', '/tmp/bg_bbb.log'),
    ])
    expect(rows.map(r => [r.taskId, r.status])).toEqual([['b-bbb', 'error']])
  })

  it('a legacy launch with no completion (killed / read inline) is stopped', () => {
    const rows = extractRecoveredBashRows([
      launchCall('c1', 'tail -f server.log'),
      launchResult('c1', 'b-ccc', '/tmp/bg_ccc.log'),
    ])
    expect(rows).toEqual([
      {
        taskId: 'b-ccc',
        command: 'tail -f server.log',
        detailId: 'c1',
        outputFilePath: '/tmp/bg_ccc.log',
        status: 'stopped',
      },
    ])
  })

  it('recovers a completion whose launch ack was trimmed (command from the summary)', () => {
    const rows = extractRecoveredBashRows([
      completionTurn('b-ddd', 'echo hi', 'completed', '/tmp/bg_ddd.log'),
    ])
    expect(rows).toEqual([
      {
        taskId: 'b-ddd',
        command: 'echo hi',
        outputFilePath: '/tmp/bg_ddd.log',
        status: 'success',
      },
    ])
  })

  it('batches multiple completions in one notification turn', () => {
    const twoBlocks =
      `<task-notification>\n<task-id>b-1</task-id>\n<task-type>local_bash</task-type>` +
      `\n<output-file>/tmp/1.log</output-file>\n<status>completed</status>\n` +
      `<summary>Background command "one" completed</summary>\n</task-notification>\n` +
      `<task-notification>\n<task-id>b-2</task-id>\n<task-type>local_bash</task-type>` +
      `\n<output-file>/tmp/2.log</output-file>\n<status>failed</status>\n` +
      `<summary>Background command "two" failed</summary>\n</task-notification>`
    const rows = extractRecoveredBashRows([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: twoBlocks }] } },
    ])
    expect(rows.map(r => [r.taskId, r.command, r.status])).toEqual([
      ['b-1', 'one', 'success'],
      ['b-2', 'two', 'error'],
    ])
  })
})

describe('extractRecoveredBashRows — mid-turn queued_command completion', () => {
  it('recovers a completion delivered mid-turn as a queued_command attachment', () => {
    const prompt =
      `<task-notification>\n<task-id>b-mid</task-id>\n<task-type>local_bash</task-type>` +
      `\n<output-file>/tmp/mid.log</output-file>\n<status>failed</status>\n` +
      `<summary>Background command "npm test" failed</summary>\n</task-notification>`
    const rows = extractRecoveredBashRows([
      launchCall('c1', 'npm test', '2026-09-13T10:00:00.000Z'),
      launchResult('c1', 'b-mid', '/tmp/mid.log', '2026-09-13T10:00:00.500Z'),
      {
        type: 'attachment',
        timestamp: '2026-09-13T10:01:00.000Z',
        attachment: { type: 'queued_command', prompt, commandMode: 'task-notification' },
      },
    ])
    expect(rows).toEqual([
      {
        taskId: 'b-mid',
        command: 'npm test',
        detailId: 'c1',
        outputFilePath: '/tmp/mid.log',
        status: 'error',
        startedAt: Date.parse('2026-09-13T10:00:00.500Z'),
        finishedAt: Date.parse('2026-09-13T10:01:00.000Z'),
      },
    ])
  })

  it('ignores user input injected mid-turn even when its text looks like a notification', () => {
    const rows = extractRecoveredBashRows([
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          source_uuid: 'u-1',
          prompt:
            '<task-notification>\n<task-id>b-fake</task-id>\n<task-type>local_bash</task-type>\n' +
            '<status>completed</status>\n</task-notification>',
        },
      },
    ])
    expect(rows).toEqual([])
  })

  it('ignores other attachment types', () => {
    const rows = extractRecoveredBashRows([
      { type: 'attachment', attachment: { type: 'date_change', newDate: '2026-09-13' } },
    ])
    expect(rows).toEqual([])
  })
})

describe('extractRecoveredBashRows — idle completion turn', () => {
  it('reads a completion from a turn whose content is a plain string (the persisted idle-delivery shape)', () => {
    // The idle re-activation turn submits the batch as a string prompt, and the
    // user message keeps it as its whole content — there is no text part. A
    // shell still running when its call returned then settles from it instead
    // of staying stopped.
    const text =
      `<task-notification>\n<task-id>b-idle</task-id>\n<task-type>local_bash</task-type>` +
      `\n<output-file>/tmp/idle.log</output-file>\n<status>completed</status>\n` +
      `<summary>Background command "npm run build" completed</summary>\n</task-notification>`
    const rows = extractRecoveredBashRows([
      launchCall('c-idle', 'npm run build', '2026-09-14T10:00:00.000Z'),
      shellResult('c-idle', 'b-idle', 'running', '2026-09-14T10:00:02.000Z'),
      { type: 'user', timestamp: '2026-09-14T10:04:00.000Z', message: { role: 'user', content: text } },
    ])
    expect(rows).toEqual([
      {
        taskId: 'b-idle',
        command: 'npm run build',
        detailId: 'c-idle',
        outputFilePath: '/tmp/idle.log',
        status: 'success',
        startedAt: Date.parse('2026-09-14T10:00:00.000Z'),
        finishedAt: Date.parse('2026-09-14T10:04:00.000Z'),
      },
    ])
  })
})

describe('extractRecoveredBashRows — filtering', () => {
  it('does not confuse a sub-agent completion for a shell', () => {
    const agentNote = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `<task-notification>\n<task-id>a-xyz</task-id>\n<task-type>local_agent</task-type>\n` +
              `<status>completed</status>\n<summary>Explore: done</summary>\n</task-notification>`,
          },
        ],
      },
    }
    expect(extractRecoveredBashRows([agentNote])).toEqual([])
  })

  it('ignores a result with neither a shell_id nor a legacy running handoff', () => {
    const rows = extractRecoveredBashRows([
      launchCall('c1', 'ls'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              result: { output: 'a\nb', exit_code: 0, task_id: 'b-fg' },
            },
          ],
        },
      },
    ])
    expect(rows).toEqual([])
  })

  it('accepts the PowerShell tool and legacy id/name spellings', () => {
    const rows = extractRecoveredBashRows([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'p1', name: 'PowerShell', input: { command: 'Get-Date' } },
          ],
        },
      },
      shellResult('p1', 'bps', 'completed'),
    ])
    expect(rows.map(r => [r.taskId, r.command])).toEqual([['bps', 'Get-Date']])
  })

  it('ignores unrelated tools and malformed shapes', () => {
    const rows = extractRecoveredBashRows([
      launchCall('r1', 'noop', undefined, 'Read'), // not a shell tool
      { type: 'assistant' },
      null,
      'text',
      { type: 'user', message: { content: 'plain prompt' } },
    ])
    expect(rows).toEqual([])
  })

  it('caps at the most recent MAX_RECOVERED_BASH_ROWS shells', () => {
    const messages: unknown[] = []
    for (let i = 0; i < MAX_RECOVERED_BASH_ROWS + 5; i++) {
      messages.push(launchCall(`c-${i}`, `cmd ${i}`))
      messages.push(shellResult(`c-${i}`, `b-${i}`, 'completed'))
    }
    const rows = extractRecoveredBashRows(messages)
    expect(rows).toHaveLength(MAX_RECOVERED_BASH_ROWS)
    expect(rows[0]!.taskId).toBe('b-5')
    expect(rows[rows.length - 1]!.taskId).toBe(`b-${MAX_RECOVERED_BASH_ROWS + 4}`)
  })
})
