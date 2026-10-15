// The session-lifecycle classic hooks — `SessionStart`, `SessionEnd`,
// `SubagentStart` — had executors and no caller: a settings hook on any of
// them was accepted and never ran (F-7, "four hook events are dead"). These
// pin the call sites: what each hook reads on stdin, what it is matched on,
// where its context lands, and that a mod sees each one as `classic.<Event>`.

import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
  UserInputPipeline,
} from '../runtime/interfaces/UserInputPipeline'
import type { PlatformCapabilities } from '../runtime/interfaces/PlatformCapabilities'
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  createEmptyAppState,
  createMemoryFileStateCache,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { MSG_TYPE_ASSISTANT, ROLE_ASSISTANT } from '../runtime/VercelModelConstants'
import { attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'
import {
  runNotificationHooks,
  runSessionEndHooks,
  runSessionStartHooks,
  runSubagentStartHooks,
} from '../lifecycleHooks/sessionLifecycleHooks'
import type { LifecycleEventName } from '../lifecycleHooks/hookTypes'
import type { ClassicMods } from '../mods/toolCallEvent'

const SID = 'sess-life'

/** A host whose Bash tool runs hook commands: each run's stdin is kept, and
 *  it prints `CTX:<event>:<source|reason|agent_id>` — plain exit-0 stdout,
 *  which `SessionStart` takes as context, and for `SubagentStart` the same
 *  text as `hookSpecificOutput.additionalContext`. */
function hookHost() {
  const stdins: Array<Record<string, unknown>> = []
  const capabilities = Object.assign(new NoopPlatformCapabilities(), {
    browser: {
      callTool: async (request: { args: { hook_stdin: string } }) => {
        const input = JSON.parse(request.args.hook_stdin) as Record<string, unknown>
        stdins.push(input)
        const subject = input.source ?? input.reason ?? input.agent_id ?? ''
        const text = `CTX:${String(input.hook_event_name)}:${String(subject)}`
        // SubagentStart reads context from the JSON field alone.
        const output = input.hook_event_name === 'SubagentStart'
          ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } })
          : `${text}\n`
        return { output, exit_code: 0 }
      },
    },
  }) as unknown as PlatformCapabilities
  return { stdins, capabilities }
}

function appStateHolder() {
  let appState: WorkingState = createEmptyAppState()
  return {
    getAppState: () => appState,
    setAppState: (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    },
  }
}

function hook(holder: ReturnType<typeof appStateHolder>, event: LifecycleEventName, matcher = '') {
  attachTransientHook(holder.setAppState, SID, event, matcher, { type: 'command', command: `log ${event}` })
}

function context(holder: ReturnType<typeof appStateHolder>, capabilities: PlatformCapabilities) {
  const toolUseContext = createNoopToolUseContext({
    tools: [],
    platformCapabilities: capabilities,
    appState: holder.getAppState(),
    setAppState: holder.setAppState,
    sessionId: SID,
  })
  toolUseContext.readAppState = holder.getAppState
  toolUseContext.writeAppState = holder.setAppState
  return toolUseContext
}

const textOf = (message: Message) =>
  (message as { message?: { content?: unknown } }).message?.content as string

describe('runSessionStartHooks', () => {
  it('runs the SessionStart hooks matched on the source; their output is one meta message', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'SessionStart', 'clear|compact')
    const ctx = context(holder, host.capabilities)

    expect(await runSessionStartHooks('startup', ctx)).toEqual([])
    expect(host.stdins).toHaveLength(0)

    const rows = await runSessionStartHooks('clear', ctx)
    expect(rows).toHaveLength(1)
    expect(textOf(rows[0]!)).toBe('CTX:SessionStart:clear')
    expect((rows[0] as { isMeta?: boolean }).isMeta).toBe(true)
    expect(host.stdins[0]).toMatchObject({ hook_event_name: 'SessionStart', session_id: SID, source: 'clear' })
  })

  it('runs nothing in a sub-agent\'s context', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'SessionStart')
    const ctx = context(holder, host.capabilities)
    ctx.agentId = 'agent_1'
    expect(await runSessionStartHooks('startup', ctx)).toEqual([])
    expect(host.stdins).toHaveLength(0)
  })

  it('is raised to the mods as classic.SessionStart with the stdin input; the settings hooks are its core', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'SessionStart')
    const ctx = context(holder, host.capabilities)
    const raised: Array<{ event: string; e: Record<string, unknown> }> = []
    const mods: Partial<ClassicMods> = {
      hasClassicHooks: event => event === 'SessionStart',
      classic: async (event, e, core) => {
        raised.push({ event, e })
        const aggregate = await core(new AbortController().signal)
        return {
          settled: true,
          aggregate: { ...aggregate, additionalContext: [...aggregate.additionalContext, 'from a mod'] },
        }
      },
    }
    ctx.options = { ...ctx.options, mods: mods as never }
    const rows = await runSessionStartHooks('resume', ctx)
    expect(raised).toEqual([{ event: 'SessionStart', e: expect.objectContaining({ hook_event_name: 'SessionStart', source: 'resume' }) }])
    expect(textOf(rows[0]!)).toBe('CTX:SessionStart:resume\n\nfrom a mod')
  })
})

describe('runSessionEndHooks / runSubagentStartHooks', () => {
  it('SessionEnd is matched on the reason and reads it on stdin', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'SessionEnd', 'clear')
    const ctx = context(holder, host.capabilities)
    await runSessionEndHooks('other', ctx)
    expect(host.stdins).toHaveLength(0)
    await runSessionEndHooks('clear', ctx)
    expect(host.stdins).toEqual([expect.objectContaining({ hook_event_name: 'SessionEnd', reason: 'clear' })])
  })

  it('SubagentStart reads agent_id and agent_type; its output is the fork\'s context', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'SubagentStart')
    const ctx = context(holder, host.capabilities)
    const rows = await runSubagentStartHooks('explore_abc_1', 'Explore', ctx)
    expect(host.stdins).toEqual([
      expect.objectContaining({ hook_event_name: 'SubagentStart', agent_id: 'explore_abc_1', agent_type: 'Explore' }),
    ])
    expect(rows.map(textOf)).toEqual(['CTX:SubagentStart:explore_abc_1'])
  })
})

describe('runNotificationHooks', () => {
  const notice = { message: 'Velloc is waiting for your input', title: 'Fix the build', notificationType: 'idle_prompt' }

  it('is matched on the notification type and reads message, title and type on stdin', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'Notification', 'permission_prompt')
    hook(holder, 'Notification', 'idle_prompt')
    const ctx = context(holder, host.capabilities)
    await runNotificationHooks(notice, ctx)
    expect(host.stdins).toEqual([
      expect.objectContaining({
        hook_event_name: 'Notification',
        session_id: SID,
        message: 'Velloc is waiting for your input',
        title: 'Fix the build',
        notification_type: 'idle_prompt',
      }),
    ])
  })

  it("runs nothing in a sub-agent's context; a hook that fails does not reject", async () => {
    const holder = appStateHolder()
    hook(holder, 'Notification')
    const failing = Object.assign(new NoopPlatformCapabilities(), {
      browser: { callTool: async () => { throw new Error('host gone') } },
    }) as unknown as PlatformCapabilities
    const ctx = context(holder, failing)
    await expect(runNotificationHooks(notice, ctx)).resolves.toBeUndefined()
    const host = hookHost()
    const sub = context(holder, host.capabilities)
    sub.agentId = 'agent_1'
    await runNotificationHooks(notice, sub)
    expect(host.stdins).toHaveLength(0)
  })

  it('is raised to the mods as classic.Notification', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    const ctx = context(holder, host.capabilities)
    const raised: Array<{ event: string; e: Record<string, unknown> }> = []
    const mods: Partial<ClassicMods> = {
      hasClassicHooks: event => event === 'Notification',
      classic: async (event, e, core) => {
        raised.push({ event, e })
        return { settled: true, aggregate: await core(new AbortController().signal) }
      },
    }
    ctx.options = { ...ctx.options, mods: mods as never }
    await runNotificationHooks(notice, ctx)
    expect(raised).toEqual([
      { event: 'Notification', e: expect.objectContaining({ notification_type: 'idle_prompt', message: notice.message }) },
    ])
  })
})

// ── The engine ───────────────────────────────────────────────────────────

/** Queries for a prompt; `/clear` reports the `clear` action and answers
 *  locally, the way the real pipeline does. */
class Pipeline implements UserInputPipeline {
  constructor(private readonly runtimeConfig: DefaultRuntimeConfig) {}
  async processUserInput(params: ProcessUserInputParams): Promise<ProcessUserInputResult> {
    const text = String(params.input)
    const isCommand = text.startsWith('/')
    return {
      ...(text === '/clear' ? { action: 'clear' as const } : {}),
      messages: [
        {
          type: 'user',
          uuid: params.uuid ?? this.runtimeConfig.createUUID(),
          timestamp: this.runtimeConfig.createTimestamp(),
          message: { role: 'user', content: text },
          isMeta: false,
        },
      ],
      shouldQuery: !isCommand,
      resultText: text,
    }
  }
}

function makeEngine(holder: ReturnType<typeof appStateHolder>, capabilities: PlatformCapabilities, initialMessages?: Message[]) {
  const runtimeConfig = new DefaultRuntimeConfig()
  const requests: Message[][] = []
  const engine = new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: holder.getAppState,
    writeAppState: holder.setAppState,
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: capabilities,
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, {
      callModel: async function* (params: { messages: Message[] }) {
        requests.push([...params.messages])
        yield {
          type: MSG_TYPE_ASSISTANT,
          uuid: runtimeConfig.createUUID(),
          message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'ok' }] },
        } as Message
      },
    } as never),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore(SID),
    userInputPipeline: new Pipeline(runtimeConfig),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    ...(initialMessages ? { seedTranscript: initialMessages } : {}),
  })
  return { engine, requests }
}

async function turn(engine: ConversationEngine, input: string): Promise<Message[]> {
  const out: Message[] = []
  for await (const message of engine.submitTurn(input)) out.push(message as Message)
  return out
}

const sources = (stdins: Array<Record<string, unknown>>) =>
  stdins.filter(input => input.hook_event_name === 'SessionStart').map(input => input.source)

describe('QueryEngine — SessionStart and SessionEnd', () => {
  it("runNotificationHooks runs the session's Notification hooks between turns", async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'Notification', 'idle_prompt')
    const { engine } = makeEngine(holder, host.capabilities)
    await engine.runNotificationHooks({ message: 'waiting', notificationType: 'idle_prompt' })
    expect(host.stdins).toEqual([
      expect.objectContaining({ hook_event_name: 'Notification', session_id: SID, notification_type: 'idle_prompt' }),
    ])
  })


  it('SessionStart runs once, on the first turn that reaches the model, its context ahead of the prompt', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'SessionStart')
    const { engine, requests } = makeEngine(holder, host.capabilities)

    await turn(engine, '/help')
    expect(sources(host.stdins)).toEqual([])

    const yielded = await turn(engine, 'first prompt')
    expect(sources(host.stdins)).toEqual(['startup'])
    expect(yielded.map(textOf)).toContain('CTX:SessionStart:startup')
    const sent = requests[0]!.map(textOf)
    expect(sent.indexOf('CTX:SessionStart:startup')).toBeLessThan(sent.indexOf('first prompt'))

    await turn(engine, 'second prompt')
    expect(sources(host.stdins)).toEqual(['startup'])
  })

  it('a session opened on a saved conversation starts with source resume', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'SessionStart')
    const saved = {
      type: 'user', uuid: 'old', timestamp: '2026-10-05T00:00:00.000Z', message: { role: 'user', content: 'earlier' },
    } as unknown as Message
    const { engine } = makeEngine(holder, host.capabilities, [saved])
    await turn(engine, 'back again')
    expect(sources(host.stdins)).toEqual(['resume'])
  })

  it('/clear runs SessionEnd (reason clear) before the wipe; the next model turn starts with source clear', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'SessionStart')
    hook(holder, 'SessionEnd')
    const { engine } = makeEngine(holder, host.capabilities)
    await turn(engine, 'first prompt')
    await turn(engine, '/clear')
    expect(host.stdins.filter(input => input.hook_event_name === 'SessionEnd')).toEqual([
      expect.objectContaining({ reason: 'clear' }),
    ])
    await turn(engine, 'after clear')
    expect(sources(host.stdins)).toEqual(['startup', 'clear'])
  })
})
