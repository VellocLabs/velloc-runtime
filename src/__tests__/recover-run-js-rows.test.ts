/**
 * extractRecoveredRunJsRows rebuilds the drawer's "Run JS" rows from the loaded transcript's persisted shapes: slim
 * `{description}` args (or none), tool-result parts with only `toolCallId`/`isError`, ISO timestamps.
 */
import { describe, expect, it } from 'vitest'
import {
  extractRecoveredRunJsRows,
  MAX_RECOVERED_RUN_JS_ROWS,
} from '../browser/worker/recoverRunJsRows'

function assistantRunJs(
  callId: string,
  args: unknown,
  timestamp?: string,
): unknown {
  return {
    type: 'assistant',
    ...(timestamp ? { timestamp } : {}),
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: callId, toolName: 'SuperEdit', args }],
    },
  }
}

function userResult(
  callId: string,
  opts: { isError?: boolean; timestamp?: string } = {},
): unknown {
  return {
    type: 'user',
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          ...(opts.isError !== undefined ? { isError: opts.isError } : {}),
        },
      ],
    },
  }
}

describe('extractRecoveredRunJsRows', () => {
  it('projects a settled SuperEdit call to a success row with description + times', () => {
    const rows = extractRecoveredRunJsRows([
      assistantRunJs('call-1', { description: 'Rename files' }, '2026-08-26T10:00:00.000Z'),
      userResult('call-1', { timestamp: '2026-08-26T10:00:05.000Z' }),
    ])
    expect(rows).toEqual([
      {
        callId: 'call-1',
        description: 'Rename files',
        status: 'success',
        startedAt: Date.parse('2026-08-26T10:00:00.000Z'),
        finishedAt: Date.parse('2026-08-26T10:00:05.000Z'),
      },
    ])
  })

  it('maps an isError result to error, and a resultless call to stopped', () => {
    const rows = extractRecoveredRunJsRows([
      assistantRunJs('err-1', { description: 'boom' }),
      userResult('err-1', { isError: true }),
      assistantRunJs('cut-1', { description: 'interrupted' }),
    ])
    expect(rows.map(r => [r.callId, r.status])).toEqual([
      ['err-1', 'error'],
      ['cut-1', 'stopped'],
    ])
  })

  it('tolerates pre-preview history: stripped args produce a row without description', () => {
    const rows = extractRecoveredRunJsRows([
      assistantRunJs('old-1', undefined),
      userResult('old-1'),
    ])
    expect(rows).toEqual([{ callId: 'old-1', status: 'success' }])
  })

  it('ignores every other tool and malformed shapes', () => {
    const rows = extractRecoveredRunJsRows([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool-call', toolCallId: 'r-1', toolName: 'Read', args: {} },
          ],
        },
      },
      { type: 'assistant' }, // no message
      null,
      'text',
      { type: 'user', message: { content: 'plain prompt' } },
    ])
    expect(rows).toEqual([])
  })

  it('accepts the legacy id/name part spellings', () => {
    const rows = extractRecoveredRunJsRows([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'legacy-1', name: 'SuperEdit', args: {} },
          ],
        },
      },
    ])
    expect(rows.map(r => r.callId)).toEqual(['legacy-1'])
  })

  it('caps at the most recent MAX_RECOVERED_RUN_JS_ROWS calls', () => {
    const messages: unknown[] = []
    for (let i = 0; i < MAX_RECOVERED_RUN_JS_ROWS + 5; i++) {
      messages.push(assistantRunJs(`c-${i}`, { description: `run ${i}` }))
      messages.push(userResult(`c-${i}`))
    }
    const rows = extractRecoveredRunJsRows(messages)
    expect(rows).toHaveLength(MAX_RECOVERED_RUN_JS_ROWS)
    expect(rows[0]!.callId).toBe('c-5')
    expect(rows[rows.length - 1]!.callId).toBe(`c-${MAX_RECOVERED_RUN_JS_ROWS + 4}`)
  })
})
