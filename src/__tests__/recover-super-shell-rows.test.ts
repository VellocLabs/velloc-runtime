/**
 * extractRecoveredSuperShellRows + resolveRecoveredSuperShellRows: the drawer's "Super Shell" rows from what a
 * reloaded session holds (slim `{description}` call, redacted result, idle and mid-turn `<task-notification>`
 * shapes, TaskOutput args in sidecars); the texts come from their real producers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractRecoveredSuperShellRows,
  MAX_RECOVERED_SUPER_SHELL_ROWS,
  MAX_RECOVERY_TASK_OUTPUT_READS,
  parseSuperShellBackgroundStepTaskIds,
  parseSuperShellTaskOutputResult,
  RECOVERY_SIDECAR_READ_CONCURRENCY,
  resolveRecoveredSuperShellRows,
  type ToolDetailSidecar,
} from '../browser/worker/recoverSuperShellRows'
import { formatTaskNotifications } from '../browser/worker/taskProjection'
import {
  setSubAgentController,
  type SubAgentController,
  type SubAgentSnapshot,
} from '../team/subAgentController'
import { JobReadTool } from '../toolkit/builtin/subAgentControlTools'

afterEach(() => setSubAgentController(null))

const T0 = '2026-09-14T10:00:00.000Z'
const T1 = '2026-09-14T10:02:00.000Z'
const T2 = '2026-09-14T10:05:00.000Z'

function superShellCall(callId: string, args?: unknown, timestamp?: string): unknown {
  return {
    type: 'assistant',
    ...(timestamp ? { timestamp } : {}),
    message: {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: callId, toolName: 'SuperShell', ...(args ? { args } : {}) },
      ],
    },
  }
}

/** A TaskOutput call as persisted: its arguments are redacted whole. */
function taskOutputCall(callId: string, timestamp?: string): unknown {
  return {
    type: 'assistant',
    ...(timestamp ? { timestamp } : {}),
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: callId, toolName: 'TaskOutput' }],
    },
  }
}

function toolResult(callId: string, opts: { isError?: boolean; timestamp?: string } = {}): unknown {
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

/** The real `<task-notification>` a finished detached run is delivered as. */
function notificationText(
  taskId: string,
  status: 'success' | 'error',
  resultText: string,
  description = 'Build and test',
): string {
  return formatTaskNotifications([
    { type: 'local_supershell', taskId, description, status, summary: resultText },
  ])
}

/** The idle notification turn: its prompt is persisted as string content. */
function idleNotificationTurn(text: string, timestamp?: string): unknown {
  return {
    type: 'user',
    ...(timestamp ? { timestamp } : {}),
    message: { role: 'user', content: text },
  }
}

function handOff(taskId: string, progress = 'No command has finished yet.'): string {
  return (
    `SuperShell is still running after 120s and continues in the background with ID: ${taskId}. ` +
    'You will be notified when it completes. Use TaskOutput with this ID to see its progress or wait for its result, ' +
    'and TaskStop to stop it (that also stops the commands and background processes it started).\n\n' +
    `Progress so far:\n${progress}`
  )
}

/** A TaskOutput result from the real tool, over a controller holding `snap`. */
async function taskOutputText(taskId: string, snap: Partial<SubAgentSnapshot>): Promise<string> {
  const controller = {
    getSnapshot: () => ({
      sessionId: taskId,
      status: 'success',
      description: 'Build and test',
      taskType: 'local_supershell',
      output: '',
      startedAt: 0,
      ...snap,
    }),
    acknowledgeResult: () => {},
  } as unknown as SubAgentController
  setSubAgentController(controller)
  const res = (await JobReadTool.call(
    { task_id: taskId, block: false },
    { options: {} } as never,
    (async () => ({ behavior: 'allow' })) as never,
    {} as never,
  )) as { data: string }
  return res.data
}

function sidecars(records: Record<string, ToolDetailSidecar>) {
  const loaded: string[] = []
  const load = async (toolCallId: string) => {
    loaded.push(toolCallId)
    return records[toolCallId] ?? null
  }
  return { load, loaded }
}

describe('extractRecoveredSuperShellRows — the transcript pass', () => {
  it('projects each SuperShell call to a row: description, times, and the inline outcome', () => {
    const scan = extractRecoveredSuperShellRows([
      superShellCall('ok-1', { description: '  Typecheck  ' }, T0),
      toolResult('ok-1', { timestamp: T1 }),
      superShellCall('err-1', { description: 'Tests' }),
      toolResult('err-1', { isError: true }),
      superShellCall('cut-1'),
    ])
    expect(scan.rows).toEqual([
      {
        callId: 'ok-1',
        description: 'Typecheck',
        status: 'success',
        startedAt: Date.parse(T0),
        finishedAt: Date.parse(T1),
      },
      { callId: 'err-1', description: 'Tests', status: 'error' },
      // No result: interrupted with its turn.
      { callId: 'cut-1', status: 'stopped' },
    ])
  })

  it('collects local_supershell notifications from an idle turn, a text part, and a mid-turn attachment', () => {
    const scan = extractRecoveredSuperShellRows([
      // The idle delivery — a plain-string prompt (the real persisted shape).
      idleNotificationTurn(notificationText('h-idle', 'success', 'IDLE_RESULT\nSteps:\n✓ make  exit 0  1.0s'), T1),
      {
        type: 'user',
        timestamp: T2,
        message: {
          role: 'user',
          content: [{ type: 'text', text: notificationText('h-part', 'error', 'PART_RESULT', 'a "quoted" <run>') }],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'task-notification',
          prompt: notificationText('h-mid', 'success', 'MID_RESULT'),
        },
      },
      // The user's own input injected mid-turn is never a completion.
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          source_uuid: 'u-1',
          prompt: notificationText('h-fake', 'success', 'FAKE'),
        },
      },
    ])
    expect(Object.fromEntries(scan.notifications)).toEqual({
      'h-idle': {
        status: 'success',
        // The "SuperShell script "…" completed" line is the notification's, not the run's.
        resultText: 'IDLE_RESULT\nSteps:\n✓ make  exit 0  1.0s',
        finishedAt: Date.parse(T1),
      },
      'h-part': { status: 'error', resultText: 'PART_RESULT', finishedAt: Date.parse(T2) },
      'h-mid': { status: 'success', resultText: 'MID_RESULT' },
    })
  })

  it('ignores other task kinds in a batch, other tools, and malformed shapes', () => {
    const shell =
      '<task-notification>\n<task-id>b-1</task-id>\n<task-type>local_bash</task-type>\n' +
      '<status>completed</status>\n<summary>Background command "make" completed</summary>\n</task-notification>'
    const scan = extractRecoveredSuperShellRows([
      idleNotificationTurn(`${shell}\n${notificationText('h-1', 'success', 'R')}`),
      {
        type: 'assistant',
        message: { content: [{ type: 'tool-call', toolCallId: 'r-1', toolName: 'SuperEdit', args: {} }] },
      },
      { type: 'assistant' },
      null,
      'text',
      { type: 'user', message: { content: 'plain prompt' } },
    ])
    expect(scan.rows).toEqual([])
    expect([...scan.notifications.keys()]).toEqual(['h-1'])
    expect(scan.taskOutputCalls).toEqual([])
  })

  it('records every TaskOutput call in order with its result time, and each row call’s position', () => {
    const scan = extractRecoveredSuperShellRows([
      taskOutputCall('to-early'),
      superShellCall('ss-1', { description: 'Long build' }),
      toolResult('ss-1'),
      taskOutputCall('to-late', T1),
      toolResult('to-late', { timestamp: T2 }),
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'to-alias', name: 'BashOutput', input: {} }] },
      },
    ])
    expect(scan.taskOutputCalls).toEqual([
      { callId: 'to-early', order: 0 },
      { callId: 'to-late', order: 3, finishedAt: Date.parse(T2) },
      { callId: 'to-alias', order: 5 },
    ])
    expect(scan.callOrder.get('ss-1')).toBe(1)
  })

  it('accepts the legacy id/name/input part spellings', () => {
    const scan = extractRecoveredSuperShellRows([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'legacy-1', name: 'SuperShell', input: { description: 'Old' } }],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', toolUseId: 'legacy-1' }] } },
    ])
    expect(scan.rows).toEqual([{ callId: 'legacy-1', description: 'Old', status: 'success' }])
  })

  it('caps at the most recent MAX_RECOVERED_SUPER_SHELL_ROWS calls', () => {
    const messages: unknown[] = []
    for (let i = 0; i < MAX_RECOVERED_SUPER_SHELL_ROWS + 5; i++) {
      messages.push(superShellCall(`c-${i}`, { description: `run ${i}` }))
      messages.push(toolResult(`c-${i}`))
    }
    const { rows } = extractRecoveredSuperShellRows(messages)
    expect(rows).toHaveLength(MAX_RECOVERED_SUPER_SHELL_ROWS)
    expect(rows[0]!.callId).toBe('c-5')
    expect(rows[rows.length - 1]!.callId).toBe(`c-${MAX_RECOVERED_SUPER_SHELL_ROWS + 4}`)
  })
})

describe('resolveRecoveredSuperShellRows — each call’s sidecar', () => {
  it('an inline run keeps its transcript outcome; its sidecar can only mark it failed', async () => {
    const scan = extractRecoveredSuperShellRows([
      superShellCall('inline-ok', { description: 'ok' }, T0),
      toolResult('inline-ok', { timestamp: T1 }),
      superShellCall('inline-bad', { description: 'bad' }),
      toolResult('inline-bad'),
      superShellCall('no-sidecar', { description: 'lost' }),
      toolResult('no-sidecar'),
    ])
    const { load } = sidecars({
      'inline-ok': { toolName: 'SuperShell', result: 'DONE\n\nSteps:\n✓ make  exit 0  1.0s' },
      'inline-bad': { toolName: 'SuperShell', result: 'SuperShell error: boom', isError: true },
    })
    const { rows } = await resolveRecoveredSuperShellRows(scan, load)
    expect(rows).toEqual([
      { callId: 'inline-ok', description: 'ok', status: 'success', startedAt: Date.parse(T0), finishedAt: Date.parse(T1) },
      { callId: 'inline-bad', description: 'bad', status: 'error' },
      // No sidecar: nothing to learn, the transcript's outcome stands.
      { callId: 'no-sidecar', description: 'lost', status: 'success' },
    ])
  })

  it('a detached run takes its outcome, finish time and result from its notification', async () => {
    const scan = extractRecoveredSuperShellRows([
      superShellCall('det-1', { description: 'Build and test' }, T0),
      toolResult('det-1', { timestamp: T1 }),
      idleNotificationTurn(notificationText('h1', 'error', 'SuperShell error: tests failed'), T2),
    ])
    const { load } = sidecars({ 'det-1': { toolName: 'SuperShell', result: handOff('h1') } })
    const { rows } = await resolveRecoveredSuperShellRows(scan, load)
    expect(rows).toEqual([
      {
        callId: 'det-1',
        description: 'Build and test',
        status: 'error',
        startedAt: Date.parse(T0),
        finishedAt: Date.parse(T2),
        taskId: 'h1',
        resultText: 'SuperShell error: tests failed',
      },
    ])
  })

  it('a detached run the model read finished with TaskOutput takes that read’s outcome (no notification follows)', async () => {
    const scan = extractRecoveredSuperShellRows([
      taskOutputCall('to-before'), // precedes the run: never its reader
      toolResult('to-before'),
      superShellCall('det-2', { description: 'Build and test' }, T0),
      toolResult('det-2'),
      taskOutputCall('to-other'),
      toolResult('to-other'),
      taskOutputCall('to-running'),
      toolResult('to-running'),
      taskOutputCall('to-done'),
      toolResult('to-done', { timestamp: T2 }),
    ])
    const { load, loaded } = sidecars({
      'det-2': { toolName: 'SuperShell', result: handOff('h2') },
      'to-other': { toolName: 'TaskOutput', args: { task_id: 'b7' }, result: await taskOutputText('b7', { taskType: 'local_bash' }) },
      'to-running': {
        toolName: 'TaskOutput',
        args: { task_id: 'h2', block: false },
        result: await taskOutputText('h2', { status: 'running', output: 'Steps:\n✓ make  exit 0' }),
      },
      'to-done': {
        toolName: 'TaskOutput',
        args: { task_id: 'h2', block: true },
        result: await taskOutputText('h2', { status: 'success', output: 'ALL_GREEN' }),
      },
    })
    const { rows } = await resolveRecoveredSuperShellRows(scan, load)
    expect(rows).toEqual([
      {
        callId: 'det-2',
        description: 'Build and test',
        status: 'success',
        startedAt: Date.parse(T0),
        finishedAt: Date.parse(T2),
        taskId: 'h2',
        resultDetailId: 'to-done',
      },
    ])
    expect(loaded).not.toContain('to-before')
  })

  it('a detached run with neither a notification nor a finished read was still running at close: stopped', async () => {
    const scan = extractRecoveredSuperShellRows([
      superShellCall('det-3', { description: 'Dev server' }, T0),
      toolResult('det-3', { timestamp: T1 }),
    ])
    const { load } = sidecars({ 'det-3': { toolName: 'SuperShell', result: handOff('h3') } })
    const { rows } = await resolveRecoveredSuperShellRows(scan, load)
    // The hand-off's time is not a finish time.
    expect(rows).toEqual([
      { callId: 'det-3', description: 'Dev server', status: 'stopped', startedAt: Date.parse(T0), taskId: 'h3' },
    ])
  })

  it('names the background steps every run started — from its result, its notification, or its TaskOutput read', async () => {
    const scan = extractRecoveredSuperShellRows([
      superShellCall('inline'),
      toolResult('inline'),
      superShellCall('notified'),
      toolResult('notified'),
      idleNotificationTurn(notificationText('h-n', 'success', 'ok\n\nSteps:\n▶ npx vite --port 5177  background task b-notified')),
      superShellCall('read'),
      toolResult('read'),
      taskOutputCall('to-read'),
      toolResult('to-read'),
    ])
    const { load } = sidecars({
      inline: { toolName: 'SuperShell', result: 'ok\n\nSteps:\n▶ tail -f log  background task b-inline  (in /other)' },
      notified: { toolName: 'SuperShell', result: handOff('h-n', 'Steps:\n▶ sleep 99  background task b-early') },
      read: { toolName: 'SuperShell', result: handOff('h-r') },
      'to-read': {
        toolName: 'TaskOutput',
        args: { task_id: 'h-r' },
        result: await taskOutputText('h-r', { status: 'stopped', output: 'Steps:\n▶ watch  background task b-read' }),
      },
    })
    const { rows, backgroundStepTaskIds } = await resolveRecoveredSuperShellRows(scan, load)
    expect([...backgroundStepTaskIds].sort()).toEqual(['b-early', 'b-inline', 'b-notified', 'b-read'])
    expect(rows.find(r => r.callId === 'read')).toMatchObject({ status: 'stopped', resultDetailId: 'to-read' })
  })

  it('stops reading TaskOutput sidecars after MAX_RECOVERY_TASK_OUTPUT_READS', async () => {
    const messages: unknown[] = [superShellCall('det-4'), toolResult('det-4')]
    const records: Record<string, ToolDetailSidecar> = {
      'det-4': { toolName: 'SuperShell', result: handOff('h4') },
    }
    for (let i = 0; i < MAX_RECOVERY_TASK_OUTPUT_READS + 10; i++) {
      messages.push(taskOutputCall(`to-${i}`), toolResult(`to-${i}`))
      records[`to-${i}`] = { toolName: 'TaskOutput', args: { task_id: `a${i}` }, result: 'Background sub-agent "x" [running] — still running.' }
    }
    const { load, loaded } = sidecars(records)
    const { rows } = await resolveRecoveredSuperShellRows(extractRecoveredSuperShellRows(messages), load)
    expect(rows[0]).toMatchObject({ status: 'stopped', taskId: 'h4' })
    expect(loaded.filter(id => id.startsWith('to-'))).toHaveLength(MAX_RECOVERY_TASK_OUTPUT_READS)
  })

  it('a sidecar that fails to load leaves the transcript’s outcome', async () => {
    const scan = extractRecoveredSuperShellRows([superShellCall('boom'), toolResult('boom')])
    const { rows } = await resolveRecoveredSuperShellRows(scan, async () => {
      throw new Error('fs down')
    })
    expect(rows).toEqual([{ callId: 'boom', status: 'success' }])
  })

  it('reads row sidecars RECOVERY_SIDECAR_READ_CONCURRENCY at a time, started in scan order', async () => {
    const cap = RECOVERY_SIDECAR_READ_CONCURRENCY
    const messages: unknown[] = []
    for (let i = 0; i < cap * 2 + 1; i++) messages.push(superShellCall(`r${i}`), toolResult(`r${i}`))
    // Each read stays open until the test releases it, so the overlap is observable.
    const started: string[] = []
    const release: Array<() => void> = []
    let inFlight = 0
    let maxInFlight = 0
    const load = (toolCallId: string) =>
      new Promise<ToolDetailSidecar | null>(resolve => {
        started.push(toolCallId)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        release.push(() => {
          inFlight -= 1
          resolve({ toolName: 'SuperShell', result: `ok ${toolCallId}` })
        })
      })
    const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
    const done = resolveRecoveredSuperShellRows(extractRecoveredSuperShellRows(messages), load)
    await settle()
    // One at a time was the restart's longest wait: the window must be open.
    expect(maxInFlight).toBe(cap)
    while (release.length > 0) {
      release.shift()!()
      await settle()
      expect(inFlight).toBeLessThanOrEqual(cap)
    }
    const { rows } = await done
    expect(started).toEqual(rows.map(r => r.callId))
    expect(maxInFlight).toBe(cap)
  })
})

describe('recoverSuperShellRows — the texts it reads, from their producers', () => {
  it('parses a TaskOutput read of a finished run, and nothing else', async () => {
    expect(
      parseSuperShellTaskOutputResult(await taskOutputText('h9', { status: 'error', output: 'SuperShell error: x\n\nSteps:' })),
    ).toEqual({ status: 'error', resultText: 'SuperShell error: x\n\nSteps:' })
    expect(parseSuperShellTaskOutputResult(await taskOutputText('h9', { status: 'stopped', output: '' }))).toEqual({
      status: 'stopped',
      resultText: '(no output)',
    })
    expect(parseSuperShellTaskOutputResult(await taskOutputText('h9', { status: 'running', output: 'Steps:' }))).toBeNull()
    expect(parseSuperShellTaskOutputResult(await taskOutputText('b9', { taskType: 'local_bash', output: 'x' }))).toBeNull()
  })

  it('reads background step ids only from step lines', () => {
    expect(
      parseSuperShellBackgroundStepTaskIds(
        [
          'returned text mentioning background task b-no',
          'Steps:',
          '✓ make  exit 0  1.0s',
          '    ▶ indented  background task b-tail',
          '▶ npx vite  background task b-1',
          '▶ echo "background task b-fake"  background task b-2  (in /x)',
          'Running now:',
          '  ▶ npx vitest run',
        ].join('\n'),
      ),
    ).toEqual(['b-1', 'b-2'])
  })
})
