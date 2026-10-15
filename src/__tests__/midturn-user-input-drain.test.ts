import { describe, expect, it } from 'vitest'

import {
  AgentTurnController,
  type InjectLandedInfo,
  type QueuedTurn,
} from '../browser/worker/AgentTurnController'
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
  collectMidTurnQueuedCommands,
  collectQueuedAttachmentMessages,
} from '../messages/contextAttachments'
import { prepareHistoryForModel } from '../messages/prepareModelHistory'
import { renderAttachmentMessage } from '../messages/renderAttachments'

/**
 * Mid-turn user input (plain Enter while the turn runs): the drain hands the
 * parked message to the running turn as a `queued_command` attachment with
 * `commandMode:'prompt'`, ordered against background-task notifications by
 * enqueue time, rendered to the model with the "The user sent a new
 * message while you were working" wrapper (NOT isMeta).
 */

const WRAPPER_HEAD = 'The user sent a new message while you were working:'

describe('collectMidTurnQueuedCommands — ordering and gating', () => {
  const base = {
    messages: [] as Message[],
    toolUseContext: {} as never,
    runtimeConfig: new DefaultRuntimeConfig(),
    sessionId: 'S',
    querySource: 'sdk',
  }

  it('orders user input and the notification batch by enqueue time', () => {
    const out = collectMidTurnQueuedCommands({
      ...base,
      drainTaskNotifications: () => ({ prompt: '<task-notification>n</task-notification>', enqueuedAt: 200 }),
      drainInjectMessages: () => [
        { uuid: 'u-early', prompt: 'early', enqueuedAt: 100 },
        { uuid: 'u-late', prompt: 'late', enqueuedAt: 300 },
      ],
    })
    expect(out.map(a => (a as { commandMode: string }).commandMode)).toEqual([
      'prompt',
      'task-notification',
      'prompt',
    ])
    expect(out[0]).toEqual({
      type: 'queued_command',
      prompt: 'early',
      commandMode: 'prompt',
      source_uuid: 'u-early',
    })
  })

  it('a tie keeps the notification first', () => {
    const out = collectMidTurnQueuedCommands({
      ...base,
      drainTaskNotifications: () => ({ prompt: '<task-notification>n</task-notification>', enqueuedAt: 5 }),
      drainInjectMessages: () => [{ uuid: 'u', prompt: 'same ms', enqueuedAt: 5 }],
    })
    expect(out.map(a => (a as { commandMode: string }).commandMode)).toEqual([
      'task-notification',
      'prompt',
    ])
  })

  it('a non-main loop never drains user input', () => {
    let drained = false
    const out = collectMidTurnQueuedCommands({
      ...base,
      querySource: 'agent_tool',
      drainInjectMessages: () => {
        drained = true
        return [{ uuid: 'u', prompt: 'x', enqueuedAt: 1 }]
      },
    })
    expect(drained).toBe(false)
    expect(out).toEqual([])
  })

  it('team frames each become their own team-message attachment, ordered by enqueue time', () => {
    const out = collectMidTurnQueuedCommands({
      ...base,
      drainTeamMessages: () => [
        { prompt: '[message from team-lead]: first', enqueuedAt: 100 },
        { prompt: '[message from team-lead]: third', enqueuedAt: 300 },
      ],
      drainInjectMessages: () => [{ uuid: 'u', prompt: 'second', enqueuedAt: 200 }],
    })
    expect(out).toEqual([
      { type: 'queued_command', prompt: '[message from team-lead]: first', commandMode: 'team-message' },
      { type: 'queued_command', prompt: 'second', commandMode: 'prompt', source_uuid: 'u' },
      { type: 'queued_command', prompt: '[message from team-lead]: third', commandMode: 'team-message' },
    ])
  })

  it('a stopped turn takes no team frames — they stay queued (and unread)', () => {
    let drained = false
    const ctrl = new AbortController()
    ctrl.abort()
    const out = collectMidTurnQueuedCommands({
      ...base,
      toolUseContext: { cancelSource: ctrl } as never,
      drainTeamMessages: () => {
        drained = true
        return [{ prompt: '[message from team-lead]: x', enqueuedAt: 1 }]
      },
    })
    expect(drained).toBe(false)
    expect(out).toEqual([])
  })

  it('with a session.receive hook, typed input is drained only after it ran: a Stop during the hook leaves it parked', async () => {
    let appState = createEmptyAppState()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState: updater => {
        appState = updater(appState)
      },
    })
    const ctrl = toolUseContext.cancelSource
    ;(toolUseContext.options as { mods?: unknown }).mods = {
      hasSessionReceiveHooks: () => true,
      sessionReceive: async (input: { text: string }) => {
        ctrl.abort() // the person pressed Stop while the hook ran
        return { text: input.text }
      },
    }
    let typedDrained = false
    const out: Message[] = []
    for await (const message of collectQueuedAttachmentMessages({
      ...base,
      toolUseContext,
      drainTaskNotifications: () => ({ prompt: '<task-notification>n</task-notification>', enqueuedAt: 1 }),
      drainInjectMessages: () => {
        typedDrained = true
        return [{ uuid: 'u', prompt: 'typed', enqueuedAt: 2 }]
      },
    })) {
      out.push(message)
    }
    expect(typedDrained).toBe(false)
    const modes = out
      .map(m => (m as ContextRow).attachment as { commandMode?: string } | undefined)
      .filter(a => a?.commandMode !== undefined)
      .map(a => a!.commandMode)
    expect(modes).toEqual(['task-notification'])
  })

  it('a non-main loop never drains team frames', () => {
    let drained = false
    collectMidTurnQueuedCommands({
      ...base,
      querySource: 'agent_tool',
      drainTeamMessages: () => {
        drained = true
        return []
      },
    })
    expect(drained).toBe(false)
  })
})

describe('TaskDeliveryQueue.enqueuedAtOf', () => {
  it('records when each accepted result arrived', () => {
    const queue = new TaskDeliveryQueue<{ taskId: string }>({
      turnSink: { enqueueDeliveryTurn: () => 'accepted' },
      stateReader: { isBusy: () => true, needsAnswer: () => false },
      formatBatch: () => '',
      taskIdOf: r => r.taskId,
    })
    const before = Date.now()
    const result = { taskId: 'b1' }
    queue.enqueue('P', result)
    const at = queue.enqueuedAtOf(result)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(queue.enqueuedAtOf({ taskId: 'other' })).toBeUndefined()
  })
})

function attachmentMessage(attachment: ContextRow['attachment']): ContextRow {
  return {
    type: 'attachment',
    uuid: 'att',
    timestamp: '2026-09-13T00:00:00.000Z',
    attachment,
  } as ContextRow
}

describe('renderAttachmentMessage — queued_command team-message', () => {
  it('reaches the model as a NON-meta message carrying the frame verbatim', () => {
    const frame = '[message from Reviewer (worker-a)]: rebase done'
    const [rendered] = renderAttachmentMessage(
      attachmentMessage({ type: 'queued_command', prompt: frame, commandMode: 'team-message' }),
    ) as UserRow[]
    expect(rendered.isMeta).toBe(false)
    expect(String(rendered.message.content)).toContain(frame)
    expect(String(rendered.message.content)).toContain('A team message arrived while you were working')
  })
})

describe('renderAttachmentMessage — queued_command prompt (user input)', () => {
  it('renders a text prompt as a NON-meta user message with the new-message wrapper', () => {
    const [rendered] = renderAttachmentMessage(
      attachmentMessage({
        type: 'queued_command',
        prompt: 'use the staging db instead',
        commandMode: 'prompt',
        source_uuid: 'u-1',
      }),
    ) as UserRow[]
    expect(rendered.isMeta).toBe(false)
    expect(rendered.message.content).toBe(
      '<system-reminder>\nThe user sent a new message while you were working:\n' +
        'use the staging db instead\n\nIMPORTANT: After completing your current task, ' +
        "you MUST address the user's message above. Do not ignore it.\n</system-reminder>",
    )
  })

  it('a content-array prompt keeps its image block after one wrapped text block', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const [rendered] = renderAttachmentMessage(
      attachmentMessage({
        type: 'queued_command',
        prompt: [{ type: 'text', text: 'look at this' }, image] as never,
        commandMode: 'prompt',
        source_uuid: 'u-2',
      }),
    ) as UserRow[]
    const content = rendered.message.content as Array<Record<string, unknown>>
    expect(rendered.isMeta).toBe(false)
    expect(content).toHaveLength(2)
    expect(content[0]).toMatchObject({ type: 'text' })
    expect(content[0]!.text).toContain(WRAPPER_HEAD)
    expect(content[0]!.text).toContain('look at this')
    expect(content[1]).toEqual(image)
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

describe('query loop + AgentTurnController — typed mid-turn, landed exactly once', () => {
  it('input typed during round 1 reaches request 2 once, is reported landed once, and is not resubmitted at turn end', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const dispatched: QueuedTurn[] = []
    const landed: InjectLandedInfo[] = []
    const controller = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: turn => dispatched.push(turn),
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
      onInjectMessagesLanded: info => landed.push(info),
    })
    // The session is running a turn.
    controller.submitUserMessage({ type: 'worker.submitMessage', payload: { prompt: 'go', promptUuid: 'u-go' } })
    controller.markStreamStart()
    dispatched.length = 0

    const requests: string[] = []
    let modelCalls = 0
    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* (params) {
        modelCalls += 1
        requests.push(JSON.stringify(prepareHistoryForModel(params.messages)))
        if (modelCalls === 1 || modelCalls === 2) {
          yield {
            type: 'assistant',
            uuid: `assistant-${modelCalls}`,
            message: {
              role: 'assistant',
              content: [{ type: 'tool-call', toolCallId: `echo-${modelCalls}`, toolName: 'Echo', args: {} }],
            },
          } as Message
          if (modelCalls === 1) {
            // The user presses Enter while round 1 is running.
            controller.submitUserMessage({
              type: 'worker.submitMessage',
              payload: { prompt: 'switch to plan B', promptUuid: 'u-typed', delivery: 'inject' },
            })
          }
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
          sessionId: 'S-typed',
          drainInjectMessages: () => controller.drainInjectEntries(),
        }),
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [EchoTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'S-typed',
    })

    const yielded = await drainQuery(
      runTurnLoop({
        messages: [{ type: 'user', uuid: 'u-go', message: { role: 'user', content: 'go' } } as Message],
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
    const count = (s: string) => s.split('switch to plan B').length - 1
    expect(count(requests[0]!)).toBe(0)
    expect(requests[1]).toContain(WRAPPER_HEAD)
    expect(count(requests[1]!)).toBe(1)
    expect(count(requests[2]!)).toBe(1)

    const attachments = yielded.filter(
      (m): m is ContextRow =>
        (m as { type?: string }).type === 'attachment' &&
        (m as ContextRow).attachment.type === 'queued_command',
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.attachment).toEqual({
      type: 'queued_command',
      prompt: 'switch to plan B',
      commandMode: 'prompt',
      source_uuid: 'u-typed',
    })
    expect(landed).toEqual([{ uuids: ['u-typed'], via: 'midturn' }])

    // Turn end: nothing left to resubmit.
    controller.markStreamEnd()
    controller.markExecutionFinished()
    expect(dispatched).toHaveLength(0)
    expect(landed).toHaveLength(1)
  })
})

describe('mid-turn drain never feeds a turn that cannot answer', () => {
  const base = {
    messages: [] as Message[],
    runtimeConfig: new DefaultRuntimeConfig(),
    sessionId: 'S',
    querySource: 'sdk',
  }

  it('an aborted turn does not take typed input (the entry stays parked)', () => {
    const abortController = new AbortController()
    abortController.abort()
    let drained = false
    const out = collectMidTurnQueuedCommands({
      ...base,
      toolUseContext: { cancelSource: abortController } as never,
      drainInjectMessages: () => {
        drained = true
        return [{ uuid: 'u', prompt: 'x', enqueuedAt: 1 }]
      },
    })
    expect(drained).toBe(false)
    expect(out).toEqual([])
  })

  type Harness = {
    controller: AgentTurnController
    dispatched: QueuedTurn[]
    landed: InjectLandedInfo[]
    requests: string[]
    yielded: unknown[]
  }

  /** One real `query()` run: round 1 calls Echo, and the user presses Enter
   *  while it runs. `onEcho` runs inside the tool call. */
  async function runTypedDuringRound1(opts: {
    onEcho?: (context: { cancelSource: AbortController }) => void
    maxTurns?: number
  }): Promise<Harness> {
    const runtimeConfig = new DefaultRuntimeConfig()
    const dispatched: QueuedTurn[] = []
    const landed: InjectLandedInfo[] = []
    const controller = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: turn => dispatched.push(turn),
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
      onInjectMessagesLanded: info => landed.push(info),
    })
    controller.submitUserMessage({ type: 'worker.submitMessage', payload: { prompt: 'go', promptUuid: 'u-go' } })
    controller.markStreamStart()
    dispatched.length = 0

    const Tool = declareTool({
      name: 'Echo',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Echo.',
      call: async (_args, context) => {
        controller.submitUserMessage({
          type: 'worker.submitMessage',
          payload: { prompt: 'late words', promptUuid: 'u-late', delivery: 'inject' },
        })
        opts.onEcho?.(context)
        return { data: 'echoed' }
      },
      readsOnly: () => true,
    })

    const requests: string[] = []
    let modelCalls = 0
    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* (params) {
        modelCalls += 1
        requests.push(JSON.stringify(prepareHistoryForModel(params.messages)))
        if (modelCalls === 1) {
          yield {
            type: 'assistant',
            uuid: 'assistant-1',
            message: {
              role: 'assistant',
              content: [{ type: 'tool-call', toolCallId: 'echo-1', toolName: 'Echo', args: {} }],
            },
          } as Message
          return
        }
        yield {
          type: 'assistant',
          uuid: `assistant-${modelCalls}`,
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
          sessionId: 'S-late',
          drainInjectMessages: () => controller.drainInjectEntries(),
        }),
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [Tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'S-late',
    })

    const yielded = await drainQuery(
      runTurnLoop({
        messages: [{ type: 'user', uuid: 'u-go', message: { role: 'user', content: 'go' } } as Message],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'sdk',
        deps,
        ...(opts.maxTurns !== undefined ? { stepLimit: opts.maxTurns } : {}),
      }),
    )
    return { controller, dispatched, landed, requests, yielded }
  }

  const promptAttachments = (yielded: unknown[]) =>
    yielded.filter(
      m =>
        (m as { type?: string }).type === 'attachment' &&
        (m as ContextRow).attachment.type === 'queued_command',
    )

  it('input typed while the round is being stopped is not drained; it is sent once as the next turn', async () => {
    const h = await runTypedDuringRound1({
      onEcho: context => context.cancelSource.abort(),
    })
    expect(promptAttachments(h.yielded)).toEqual([])
    expect(h.landed).toEqual([])
    for (const request of h.requests) expect(request).not.toContain('late words')
    expect(h.controller.getInjectMessageViews().map(v => v.uuid)).toEqual(['u-late'])

    h.controller.markStreamEnd()
    h.controller.markExecutionFinished()
    expect(h.dispatched.map(t => t.message.payload.prompt)).toEqual(['late words'])
    expect(h.landed).toEqual([
      { uuids: ['u-late'], via: 'nextturn', turnUuid: 'u-late', text: 'late words' },
    ])
  })

  it('the maxTurns terminal round does not drain typed input', async () => {
    const h = await runTypedDuringRound1({ maxTurns: 1 })
    expect(h.requests).toHaveLength(1)
    expect(promptAttachments(h.yielded)).toEqual([])
    expect(h.landed).toEqual([])
    expect(h.controller.getInjectMessageViews().map(v => v.uuid)).toEqual(['u-late'])
  })
})
