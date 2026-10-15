import { describe, expect, it } from 'vitest'

import { TaskDeliveryQueue } from '../browser/worker/TaskDeliveryQueue'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type {
  ContextRow,
  Message,
  QueryTerminal,
  UserRow,
} from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { declareTool } from '../toolkit/toolContract'
import {
  collectQueuedAttachmentMessages,
  collectTaskNotificationAttachments,
} from '../messages/contextAttachments'
import { prepareHistoryForModel } from '../messages/prepareModelHistory'
import { renderAttachmentMessage } from '../messages/renderAttachments'

/**
 * Mid-turn `<task-notification>` delivery. A background task that finishes while
 * its parent turn is still running is injected into the NEXT model request of
 * that turn instead of waiting for the idle re-activation turn. The invariants
 * pinned here: a result is injected at most once, drained results never come
 * back as the idle turn, undrained ones still do, and only the session's main
 * loop drains (never a fork sharing its session id).
 */

type Result = { type: 'local_bash' | 'local_agent'; taskId: string }

function makeQueue(opts: { busy: boolean }) {
  const submitted: string[] = []
  let busy = opts.busy
  const queue = new TaskDeliveryQueue<Result>({
    turnSink: {
      enqueueDeliveryTurn: (_parent, prompt) => {
        submitted.push(prompt)
        return 'accepted'
      },
    },
    stateReader: { isBusy: () => busy, needsAnswer: () => false },
    formatBatch: results => results.map(r => `[${r.taskId}]`).join(''),
    taskIdOf: r => r.taskId,
  })
  return {
    queue,
    submitted,
    setBusy: (value: boolean) => {
      busy = value
    },
  }
}

describe('TaskDeliveryQueue.drain — mid-turn consumption', () => {
  it('removes what it returns, so the idle flush never re-delivers it', () => {
    const { queue, submitted, setBusy } = makeQueue({ busy: true })
    queue.enqueue('P', { type: 'local_bash', taskId: 'b1' })
    expect(submitted).toEqual([])

    expect(queue.drain('P', () => true).map(r => r.taskId)).toEqual(['b1'])
    expect(queue.hasPending('P')).toBe(false)
    // A second drain in a later round finds nothing.
    expect(queue.drain('P', () => true)).toEqual([])

    setBusy(false)
    queue.flushIfReady('P')
    expect(submitted).toEqual([])
  })

  it('leaves non-matching results for the idle flush, which delivers them exactly once', () => {
    const { queue, submitted, setBusy } = makeQueue({ busy: true })
    queue.enqueue('P', { type: 'local_bash', taskId: 'b1' })
    queue.enqueue('P', { type: 'local_agent', taskId: 'a1' })

    const drained = queue.drain('P', r => r.type === 'local_bash')
    expect(drained.map(r => r.taskId)).toEqual(['b1'])

    setBusy(false)
    queue.flushIfReady('P')
    queue.flushIfReady('P')
    expect(submitted).toEqual(['[a1]'])
    expect(queue.drain('P', () => true)).toEqual([])
  })

  it('a result already flushed as the idle turn is not drainable', () => {
    const { queue, submitted } = makeQueue({ busy: false })
    queue.enqueue('P', { type: 'local_bash', taskId: 'b1' })
    expect(submitted).toEqual(['[b1]'])
    expect(queue.drain('P', () => true)).toEqual([])
  })

  it('an acknowledged result (TaskOutput read / inline completion) is not drainable', () => {
    const { queue } = makeQueue({ busy: true })
    queue.enqueue('P', { type: 'local_bash', taskId: 'b1' })
    queue.acknowledge(r => r.taskId === 'b1')
    expect(queue.drain('P', () => true)).toEqual([])
  })

  it('a suppressed parent (user Stop) has nothing to drain', () => {
    const { queue } = makeQueue({ busy: true })
    queue.suppressParent('P')
    queue.enqueue('P', { type: 'local_bash', taskId: 'b1' })
    expect(queue.drain('P', () => true)).toEqual([])
  })

  it('drains only the named parent', () => {
    const { queue } = makeQueue({ busy: true })
    queue.enqueue('P1', { type: 'local_bash', taskId: 'b1' })
    queue.enqueue('P2', { type: 'local_bash', taskId: 'b2' })
    expect(queue.drain('P1', () => true).map(r => r.taskId)).toEqual(['b1'])
    expect(queue.hasPending('P2')).toBe(true)
  })
})

function toolCallMessage(toolName: string): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `${toolName}-1`, toolName, args: {} }],
    },
  } as unknown as Message
}

describe('collectTaskNotificationAttachments — who drains, and with which priority', () => {
  const base = {
    messages: [] as Message[],
    toolUseContext: {} as never,
    runtimeConfig: new DefaultRuntimeConfig(),
    sessionId: 'S',
  }

  it('a per-round reminder that throws does not drain (and so lose) the queued completions', async () => {
    let drained = 0
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'S',
    })
    toolUseContext.readAppState = () => {
      throw new Error('app state unavailable')
    }
    const generator = collectQueuedAttachmentMessages({
      ...base,
      toolUseContext,
      querySource: 'sdk',
      assistantMessages: [],
      drainTaskNotifications: () => {
        drained++
        return { prompt: '<task-notification>x</task-notification>', enqueuedAt: 0 }
      },
    })
    await expect(generator.next()).rejects.toThrow(/app state unavailable/)
    expect(drained).toBe(0)
  })

  it('the main loop drains shells only (includeLater false) when the round did not Sleep', () => {
    const calls: Array<{ sessionId: string; includeLater: boolean }> = []
    const out = collectTaskNotificationAttachments({
      ...base,
      querySource: 'sdk',
      assistantMessages: [toolCallMessage('Bash')],
      drainTaskNotifications: (sessionId, opts) => {
        calls.push({ sessionId, ...opts })
        return { prompt: '<task-notification>x</task-notification>', enqueuedAt: 0 }
      },
    })
    expect(calls).toEqual([{ sessionId: 'S', includeLater: false }])
    expect(out).toEqual([
      {
        type: 'queued_command',
        prompt: '<task-notification>x</task-notification>',
        commandMode: 'task-notification',
      },
    ])
  })

  it('a round that ran Sleep also admits later-priority (sub-agent) results', () => {
    const calls: boolean[] = []
    collectTaskNotificationAttachments({
      ...base,
      querySource: 'sdk',
      assistantMessages: [toolCallMessage('Sleep')],
      drainTaskNotifications: (_s, opts) => {
        calls.push(opts.includeLater)
        return null
      },
    })
    expect(calls).toEqual([true])
  })

  it('a fork / hook agent / fast call sharing the session id never drains', () => {
    for (const querySource of ['agent_tool', 'skill_fork', 'hook_agent', 'fast_model_call', undefined]) {
      let called = false
      const out = collectTaskNotificationAttachments({
        ...base,
        querySource,
        assistantMessages: [toolCallMessage('Bash')],
        drainTaskNotifications: () => {
          called = true
          return { prompt: '<task-notification>x</task-notification>', enqueuedAt: 0 }
        },
      })
      expect(called).toBe(false)
      expect(out).toEqual([])
    }
  })

  it('nothing pending → no attachment; no drain wired → no attachment', () => {
    expect(
      collectTaskNotificationAttachments({
        ...base,
        querySource: 'sdk',
        drainTaskNotifications: () => null,
      }),
    ).toEqual([])
    expect(
      collectTaskNotificationAttachments({ ...base, querySource: 'sdk' }),
    ).toEqual([])
  })
})

describe('renderAttachmentMessage — queued_command (task-notification)', () => {
  it('renders as a meta <system-reminder> user message with the completion line', () => {
    const message = {
      type: 'attachment',
      uuid: 'att-1',
      timestamp: '2026-09-13T00:00:00.000Z',
      attachment: {
        type: 'queued_command',
        prompt: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>',
        commandMode: 'task-notification',
      },
    } as ContextRow
    const [rendered] = renderAttachmentMessage(message) as UserRow[]
    expect(rendered.isMeta).toBe(true)
    expect(rendered.message.content).toBe(
      '<system-reminder>\nA background agent completed a task:\n' +
        '<task-notification>\n<task-id>b1</task-id>\n</task-notification>\n</system-reminder>',
    )
  })
})

async function drainQuery(
  generator: AsyncGenerator<unknown, QueryTerminal, unknown>,
): Promise<unknown[]> {
  const values: unknown[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return values
    values.push(next.value)
  }
}

const EchoTool = declareTool({
  name: 'Echo',
  argsSchema: { type: 'object' as const, properties: {} },
  description: async () => 'Echo.',
  call: async () => ({ data: 'echoed' }),
  readsOnly: () => true,
})

describe('query loop — mid-turn injection happens between tool rounds, exactly once', () => {
  it('injects a completion that landed during round 1 into request 2, carries it once into request 3, and never drains after the final text round', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const NOTE = '<task-notification>\n<task-id>bmid0001</task-id>\n<task-type>local_bash</task-type>\n<status>completed</status>\n<summary>Background command "x" completed</summary>\n</task-notification>'
    // The queue: one result becomes pending while round 1's tool runs.
    let pending: string | null = null
    const drainCalls: boolean[] = []
    const requests: string[] = []
    let modelCalls = 0

    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* (params) {
        modelCalls += 1
        // The model-facing form: what the transport sends after rendering
        // attachments (prepareHistoryForModel → renderAttachmentMessage).
        requests.push(JSON.stringify(prepareHistoryForModel(params.messages)))
        const turn = modelCalls
        if (turn === 1 || turn === 2) {
          yield {
            type: 'assistant',
            uuid: `assistant-${turn}`,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool-call', toolCallId: `echo-${turn}`, toolName: 'Echo', args: {} },
              ],
            },
          } as Message
          if (turn === 1) pending = NOTE
          return
        }
        yield {
          type: 'assistant',
          uuid: 'assistant-final',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        } as Message
      },
    }, {
      runtimeConfig,
      queuedAttachmentProvider: params =>
        collectQueuedAttachmentMessages({
          messages: params.messages,
          toolUseContext: params.toolUseContext,
          runtimeConfig,
          assistantMessages: params.assistantMessages,
          querySource: params.querySource,
          sessionId: 'S-mid',
          drainTaskNotifications: (_sessionId, opts) => {
            drainCalls.push(opts.includeLater)
            const out = pending
            pending = null
            return out ? { prompt: out, enqueuedAt: Date.now() } : null
          },
        }),
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [EchoTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'S-mid',
    })

    const yielded = await drainQuery(
      runTurnLoop({
        messages: [
          { type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } } as Message,
        ],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'sdk',
        deps,
      }),
    )

    expect(modelCalls).toBe(3)
    // One drain per tool round — none after the final text-only response.
    expect(drainCalls).toEqual([false, false])
    const count = (s: string) => s.split('bmid0001').length - 1
    expect(count(requests[0])).toBe(0)
    // Request 2 carries the injected completion, exactly once …
    expect(requests[1]).toContain('A background agent completed a task:')
    expect(count(requests[1])).toBe(1)
    // … and request 3 still carries it once (history), never a second copy.
    expect(count(requests[2])).toBe(count(requests[1]))
    // Exactly one queued_command attachment was yielded (persisted) by the loop.
    const attachments = yielded.filter(
      (m): m is ContextRow =>
        (m as { type?: string }).type === 'attachment' &&
        (m as ContextRow).attachment.type === 'queued_command',
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0].attachment).toMatchObject({ prompt: NOTE })
  })
})
