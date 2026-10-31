/**
 * The engine's `prompt.submit` call site: what a typed prompt becomes after
 * the session's mods have seen it, and which submissions never reach them.
 *
 * The mod runtime itself is `mod-runtime.test.ts`; here it is a fake, so what
 * is pinned is the ENGINE's half — where it calls, what it does with each
 * outcome, and that nothing a mod does can keep a prompt from entering.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import type { ModRuntime, PromptSubmitOutcome } from '../mods/ModRuntime'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
import type { UserInputPipeline } from '../runtime/interfaces/UserInputPipeline'
import type { ToolCallMods } from '../mods/toolCallEvent'
import { ROOT_DISPATCH_CONTEXT } from '../mods/modTypes'
import { ModDispatcher } from '../mods/ModDispatcher'
import {
  arrivedTurnStep,
  isTurnStepResult,
  type TurnStepChunk,
  type TurnStepInput,
  type TurnStepResult,
} from '../mods/turnStepEvent'
import type { StreamHookCall } from '../mods/streamChain'
import type { SessionUsage } from '../mods/sessionNouns'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { buildModTool } from '../mods/modRegisteredTools'
import { registerDeferrableSkills, shouldHideToolFromModel } from '../toolkit/run/deferredTools'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  NoopUserInputPipeline,
  createEmptyAppState,
  createMemoryFileStateCache,
} from '../runtime/testing/noopAdapters'
import { MSG_TYPE_ASSISTANT, ROLE_ASSISTANT } from '../runtime/VercelModelConstants'
import { contextWindowOf } from '../engine/contextWindow'
import { setTeamMessenger, type TeamMessenger } from '../team/teamMessenger'
import { setSubAgentController, type SubAgentController } from '../team/subAgentController'
import { installBuiltinCatalogFigures } from './_helpers/builtinCatalogFigures'
import { resetCatalogFigures } from '../config/nexusModelConfig/catalogFigures'

// Built-in rows read the context window / output cap / image input they
// leave unset from the model catalog: install the runtime's figures, as
// after its first catalog read (catalog/builtinCatalogFill.ts).
beforeAll(installBuiltinCatalogFigures)
afterAll(resetCatalogFigures)

type Mods = {
  ready: Promise<void>
  promptSubmit(text: string, signal?: AbortSignal): Promise<PromptSubmitOutcome>
  sessionEnd?(reason: 'clear' | 'other'): Promise<void>
  hasToolCallHooks?(): boolean
  toolCall?: ToolCallMods['toolCall']
  whileAskingPerson?: ModRuntime['whileAskingPerson']
  commandRun?: ModRuntime['commandRun']
  hasCommandRunHooks?(): boolean
  registeredCommand?: ModRuntime['registeredCommand']
  listRegisteredCommands?: ModRuntime['listRegisteredCommands']
  turnStart?: ModRuntime['turnStart']
  turnComplete?: ModRuntime['turnComplete']
  sessionMeasure?: ModRuntime['sessionMeasure']
  agentId?: string
  hasTurnStepHooks?: ModRuntime['hasTurnStepHooks']
  turnStep?: ModRuntime['turnStep']
  hasPromptHooks?: ModRuntime['hasPromptHooks']
  promptSections?: ModRuntime['promptSections']
  promptCompose?: ModRuntime['promptCompose']
  promptContext?: ModRuntime['promptContext']
  afterTurn?: ModRuntime['afterTurn']
  reload?: ModRuntime['reload']
  hasSessionAppendHooks?: ModRuntime['hasSessionAppendHooks']
  sessionAppend?: ModRuntime['sessionAppend']
  sessionCompact?: ModRuntime['sessionCompact']
  appendNote?: ModRuntime['appendNote']
  hasSessionSendHooks?: ModRuntime['hasSessionSendHooks']
  sessionSend?: ModRuntime['sessionSend']
  hasSessionReceiveHooks?: ModRuntime['hasSessionReceiveHooks']
  sessionReceive?: ModRuntime['sessionReceive']
  hasCommandDescribeHooks?: ModRuntime['hasCommandDescribeHooks']
  commandDescriptions?: ModRuntime['commandDescriptions']
}

function makeEngine(
  mods: Mods | undefined,
  shouldQuery = true,
  userInputPipeline?: UserInputPipeline,
  tools: ToolContract[] = [],
  depsOverrides: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {},
) {
  const runtimeConfig = new DefaultRuntimeConfig()
  let appState: WorkingState = createEmptyAppState()
  /** The messages each model call was sent. */
  const modelCalls: Message[][] = []
  /** The system prompt and the user context each model call was sent. */
  const prompts: Array<{ systemPrompt: unknown; userContext: unknown }> = []
  const engine = new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools,
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appState,
    writeAppState: updater => {
      appState = updater(appState)
    },
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, {
      callModel: async function* (params: { messages: Message[]; baseInstructions: unknown; userContext: unknown }) {
        modelCalls.push([...params.messages])
        prompts.push({ systemPrompt: params.baseInstructions, userContext: params.userContext })
        yield {
          type: MSG_TYPE_ASSISTANT,
          uuid: `assistant-${modelCalls.length}`,
          message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'ok' }] },
        } as Message
      } as never,
      ...(depsOverrides as object),
    }),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore('session-mods'),
    userInputPipeline: userInputPipeline ?? new NoopUserInputPipeline(runtimeConfig, shouldQuery),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    ...(mods ? { mods } : {}),
    ...configOverrides,
  })
  return { engine, modelCalls, prompts, runtimeConfig }
}

async function submit(
  engine: ConversationEngine,
  prompt: unknown,
  options: Record<string, unknown> = {},
): Promise<unknown[]> {
  const yielded: unknown[] = []
  for await (const message of engine.submitTurn(prompt as never, { uuid: 'u1', ...options } as never)) {
    yielded.push(message)
  }
  return yielded
}

/** `[role-or-type, content, isMeta]` of the user rows in a message list. */
function userRows(messages: readonly Message[]): Array<[unknown, boolean]> {
  return messages
    .filter(m => m.type === 'user')
    .map(m => {
      const row = m as unknown as { message: { content: unknown }; isMeta?: boolean }
      return [row.message.content, row.isMeta === true]
    })
}

function fakeMods(outcome: (text: string) => PromptSubmitOutcome | Promise<PromptSubmitOutcome>) {
  const seen: string[] = []
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const mods: Mods = {
    ready: gate.then(() => {
      order.push('ready')
    }),
    promptSubmit: async text => {
      order.push('promptSubmit')
      seen.push(text)
      return outcome(text)
    },
  }
  return { mods, seen, order, release }
}

describe('QueryEngine — prompt.submit', () => {
  it('without a mod runtime the prompt enters as typed', async () => {
    const { engine, modelCalls } = makeEngine(undefined)
    await submit(engine, 'hello')
    expect(userRows(modelCalls[0]!)).toEqual([['hello', false]])
  })

  it('a rewrite is what becomes the user message, and what the model reads', async () => {
    const { mods, seen, release } = fakeMods(text => ({ entered: true, text: text.toUpperCase(), context: [] }))
    release()
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(seen).toEqual(['hello'])
    expect(userRows(modelCalls[0]!)).toEqual([['HELLO', false]])
    // …and what the transcript keeps: the session never held the typed text.
    expect(userRows(engine.transcriptRows())).toEqual([['HELLO', false]])
  })

  it('context enters as ONE meta user message after the prompt, a text block per entry', async () => {
    const { mods, release } = fakeMods(text => ({
      entered: true,
      text,
      context: ['Reply in French.', 'Be brief.'],
    }))
    release()
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(userRows(modelCalls[0]!)).toEqual([
      ['hello', false],
      [
        [
          { type: 'text', text: 'Reply in French.' },
          { type: 'text', text: 'Be brief.' },
        ],
        true,
      ],
    ])
  })

  it('waits for the mods to be ready before raising the event', async () => {
    const { mods, order, release } = fakeMods(text => ({ entered: true, text, context: [] }))
    const { engine } = makeEngine(mods)
    const pending = submit(engine, 'hello')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order).toEqual([])
    release()
    await pending
    expect(order).toEqual(['ready', 'promptSubmit'])
  })

  it('a dropped prompt reaches no model and leaves no user message — only the reason', async () => {
    const { mods, release } = fakeMods(() => ({ entered: false, reason: 'That looks like a secret.' }))
    release()
    const { engine, modelCalls } = makeEngine(mods)
    const yielded = await submit(engine, 'my secret is 123')
    expect(modelCalls).toEqual([])
    expect(userRows(engine.transcriptRows())).toEqual([])
    const systems = engine.transcriptRows().filter(m => m.type === 'system')
    expect(systems).toHaveLength(1)
    expect(JSON.stringify(systems[0])).toContain('A plugin stopped this prompt: That looks like a secret.')
    // The notice is localizable: it carries its catalog key and parameter.
    expect(JSON.stringify(systems[0])).toContain('slash.out.modPromptDropped')
    expect(JSON.stringify(yielded)).toContain('A plugin stopped this prompt: That looks like a secret.')
    expect(JSON.stringify(yielded)).not.toContain('my secret is 123')
  })

  it('Stop while prompt.submit runs keeps the prompt out — it does not enter as typed', async () => {
    let engineRef: ConversationEngine | undefined
    const { mods, release } = fakeMods(async () => {
      // The person presses Stop mid-hook; the chain rethrows the abort.
      engineRef!.cancelTurn()
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    release()
    const { engine, modelCalls } = makeEngine(mods)
    engineRef = engine
    const yielded = await submit(engine, 'my secret is 123')
    expect(modelCalls).toEqual([])
    expect(userRows(engine.transcriptRows())).toEqual([])
    expect(JSON.stringify(engine.transcriptRows())).toContain('slash.out.modPromptInterrupted')
    expect(JSON.stringify(yielded)).not.toContain('my secret is 123')
  })

  it("a prompt the runtime refused because a plugin's hooks were unreachable says so, from the catalog", async () => {
    const { mods, release } = fakeMods(() => ({
      entered: false,
      reason: "guard's hook on prompt.submit could not answer (its hooks worker is restarting)",
      unreachable: 'guard',
    }))
    release()
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(modelCalls).toEqual([])
    const rows = JSON.stringify(engine.transcriptRows())
    expect(rows).toContain('slash.out.modPromptUnreachable')
    expect(rows).toContain('This prompt was not sent: guard could not check it')
    expect(rows).not.toContain('could not answer')
  })

  it('a prompt stopped without a reason says so', async () => {
    const { mods, release } = fakeMods(() => ({ entered: false }))
    release()
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(modelCalls).toEqual([])
    expect(JSON.stringify(engine.transcriptRows())).toContain('A plugin stopped this prompt.')
    expect(JSON.stringify(engine.transcriptRows())).toContain('slash.out.modPromptDroppedNoReason')
  })

  it.each([
    ['a slash command', '/status', {}],
    ['a slash command with leading space', '  /compact now', {}],
    ['a synthetic (meta) turn', 'continue', { isMeta: true }],
    ['a delivery with its own origin', 'task done', { origin: { kind: 'task-notification' } }],
    ['a content-block prompt', [{ type: 'text', text: 'hello' }], {}],
  ])('%s never reaches the mods', async (_name, prompt, options) => {
    const { mods, seen, release } = fakeMods(() => ({ entered: false, reason: 'should not be asked' }))
    release()
    const { engine } = makeEngine(mods, false)
    await submit(engine, prompt, options)
    expect(seen).toEqual([])
    expect(JSON.stringify(engine.transcriptRows())).not.toContain('A plugin stopped')
  })

  it('a broken mod runtime never blocks a prompt', async () => {
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async () => {
        throw new Error('the mod runtime fell over')
      },
    }
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(userRows(modelCalls[0]!)).toEqual([['hello', false]])
  })

  it('context is not attached to a turn that does not reach the model', async () => {
    const { mods, release } = fakeMods(text => ({ entered: true, text, context: ['ctx'] }))
    release()
    const { engine, modelCalls } = makeEngine(mods, false)
    await submit(engine, 'hello')
    expect(modelCalls).toEqual([])
    expect(userRows(engine.transcriptRows())).toEqual([['hello', false]])
  })
})

describe('QueryEngine — the idle unload (onSubmit / waitForMods)', () => {
  it('a message submitted while the mods are unloaded waits for their reload and passes them', async () => {
    const { mods, seen, release } = fakeMods(text => ({ entered: true, text: `${text}!`, context: [] }))
    release()
    // No mods now: the idle unload took them down.
    const { engine, modelCalls } = makeEngine(undefined)
    let submits = 0
    let arrive!: () => void
    engine.setOnSubmit(() => {
      submits += 1
      // The reload the submit set off: the mods are back once it settles.
      engine.waitForMods(
        new Promise<void>(resolve => {
          arrive = () => {
            engine.setMods(mods)
            resolve()
          }
        }),
      )
    })
    const pending = submit(engine, 'hello')
    await new Promise(resolve => setTimeout(resolve, 20))
    // Told synchronously, and nothing reached a model before the reload.
    expect(submits).toBe(1)
    expect(modelCalls).toHaveLength(0)
    arrive()
    await pending
    expect(seen).toEqual(['hello'])
    expect(JSON.stringify(modelCalls[0])).toContain('hello!')
  })

  it('a reload that fails never blocks the turn', async () => {
    const { engine, modelCalls } = makeEngine(undefined)
    engine.setOnSubmit(() => engine.waitForMods(Promise.reject(new Error('no worker'))))
    await submit(engine, 'hello')
    expect(JSON.stringify(modelCalls[0])).toContain('hello')
  })
})

describe('QueryEngine — the prompt render waits for the mods', () => {
  // A turn no one typed — a teammate's directive from its lead, a delivery —
  // skips `prompt.submit`, the wait a typed prompt has. Its render must still
  // wait, or the first prompt of a session that starts working at once (a
  // teammate) is rendered before its hooks exist.
  it('a turn that starts with a delivery renders through prompt.context once the modules have loaded', async () => {
    let loaded = false
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const contexts: string[][] = []
    const mods: Mods = {
      ready: gate.then(() => {
        loaded = true
      }),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasPromptHooks: () => loaded,
      promptSections: async sections => [...sections],
      promptCompose: async (_input, sections) => [...sections],
      promptContext: async input => {
        contexts.push(input.blocks.map(block => block.name))
        return { blocks: [...input.blocks, { name: 'slotMark', text: 'SLOT_MARK' }] }
      },
    }
    const { engine, prompts } = makeEngine(mods)
    const pending = submit(engine, 'go read it', { origin: { kind: 'task-notification' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(prompts).toEqual([])
    release()
    await pending
    expect(contexts).toHaveLength(1)
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts[0]!.userContext).toMatchObject({ slotMark: 'SLOT_MARK' })
  })
})

describe('QueryEngine — session.end on /clear', () => {
  /** What the slash pipeline answers for `/clear`: one marker message and the
   *  `clear` action. Everything else is passed through as a user message. */
  const clearing: UserInputPipeline = {
    async processUserInput(params) {
      const isClear = params.input === '/clear'
      return {
        messages: [
          {
            type: 'user',
            uuid: `u-${String(params.input)}`,
            message: { role: 'user', content: isClear ? 'Conversation cleared' : params.input },
          } as Message,
        ],
        shouldQuery: !isClear,
        ...(isClear ? { action: 'clear' as const } : {}),
      }
    },
  } as UserInputPipeline

  it('the mods see the conversation end BEFORE it is wiped, with the reason clear', async () => {
    const order: string[] = []
    let engineRef: ConversationEngine | undefined
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      sessionEnd: async reason => {
        // Slow on purpose: the wipe must wait for it.
        await new Promise(resolve => setTimeout(resolve, 20))
        order.push(`end:${reason}:${userRows(engineRef!.transcriptRows()).length}`)
      },
    }
    const { engine } = makeEngine(mods, true, clearing)
    engineRef = engine
    await submit(engine, 'hello')
    expect(userRows(engine.transcriptRows())).toEqual([['hello', false]])
    await submit(engine, '/clear')
    // The hook ran while the old conversation was still there.
    expect(order).toEqual(['end:clear:1'])
    expect(userRows(engine.transcriptRows())).toEqual([['Conversation cleared', false]])
  })

  it('is not raised by anything but a clear', async () => {
    let ended = 0
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      sessionEnd: async () => {
        ended += 1
      },
    }
    const { engine } = makeEngine(mods, true, clearing)
    await submit(engine, 'hello')
    await submit(engine, 'again')
    expect(ended).toBe(0)
  })

  it('a mod runtime without session.end (or none at all) clears as before', async () => {
    const { engine } = makeEngine(undefined, true, clearing)
    await submit(engine, 'hello')
    await submit(engine, '/clear')
    expect(userRows(engine.transcriptRows())).toEqual([['Conversation cleared', false]])
  })
})

describe('QueryEngine — $.tool (modTools)', () => {
  const echo = declareTool({
    name: 'Echo',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'Echoes its arguments',
    call: async (args: Record<string, unknown>) => ({ data: { echoed: args } }),
  }) as unknown as ToolContract

  /** A mod runtime with no hooks: the chain is core alone. */
  const passThrough = (): Mods => ({
    ready: Promise.resolve(),
    promptSubmit: async text => ({ entered: true, text, context: [] }),
    hasToolCallHooks: () => false,
    toolCall: async (e, core) => ({
      settled: true,
      result: await core(e, new AbortController().signal),
    }),
  })

  it('lists the session\'s tools', async () => {
    const { engine } = makeEngine(passThrough(), true, undefined, [echo])
    await expect(engine.modTools.list()).resolves.toEqual([
      { name: 'Echo', description: 'Echoes its arguments', mcp: false },
    ])
  })

  it('runs a tool as the plugin\'s own call, outside any turn, and adds nothing to the conversation', async () => {
    const { engine, modelCalls } = makeEngine(passThrough(), true, undefined, [echo])
    const answer = (await engine.modTools.call(
      { tool: 'Echo', q: 1 },
      { context: ROOT_DISPATCH_CONTEXT },
    )) as { result: unknown; ref: number }
    expect(answer.result).toEqual({ echoed: { q: 1 } })
    expect(engine.transcriptRows()).toEqual([])
    expect(modelCalls).toEqual([])
  })

  it('is abandoned when the calling hook\'s dispatch is', async () => {
    const slow = declareTool({
      name: 'Slow',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'slow',
      call: async (_args: unknown, context: { cancelSource: AbortController }) => {
        await new Promise<void>(resolve =>
          context.cancelSource.signal.addEventListener('abort', () => resolve()),
        )
        return { data: 'stopped' }
      },
    }) as unknown as ToolContract
    const { engine } = makeEngine(passThrough(), true, undefined, [slow])
    const controller = new AbortController()
    const pending = engine.modTools.call(
      { tool: 'Slow' },
      { context: ROOT_DISPATCH_CONTEXT, signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it("opens its permission dialog as a wait on the person, so the slot's wall-clock bounds stop while it is open", async () => {
    const guarded = declareTool({
      name: 'Guarded',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Needs a grant',
      selfVerdict: async () => ({ behavior: 'ask', message: 'needs a grant' }),
      call: async (args: Record<string, unknown>) => ({ data: { echoed: args } }),
    }) as unknown as ToolContract
    const waits: string[] = []
    const mods: Mods = {
      ...passThrough(),
      whileAskingPerson: async work => {
        waits.push('open')
        try {
          return await work()
        } finally {
          waits.push('closed')
        }
      },
    }
    const { engine } = makeEngine(mods, true, undefined, [guarded], {}, {
      // The person grants it while the dialog is open.
      requestToolUseConfirm: async () => {
        waits.push('dialog')
        return { behavior: 'allow' }
      },
    })
    const answer = (await engine.modTools.call({ tool: 'Guarded', q: 2 }, { context: ROOT_DISPATCH_CONTEXT })) as { result: unknown }
    expect(answer.result).toEqual({ echoed: { q: 2 } })
    expect(waits).toEqual(['open', 'dialog', 'closed'])
  })

  it('is refused by name in a session with no mod runtime', async () => {
    const { engine } = makeEngine(undefined, true, undefined, [echo])
    await expect(
      engine.modTools.call({ tool: 'Echo' }, { context: ROOT_DISPATCH_CONTEXT }),
    ).rejects.toMatchObject({ name: 'NotSupportedError' })
  })
})

describe('QueryEngine — command.run for a typed slash command', () => {
  type Run = Parameters<ModRuntime['commandRun']>
  /** Mods whose `commandRun` is scripted: `answer` decides what the chain
   *  settled on, given the input and core. */
  function commandMods(
    registered: string[],
    answer: (input: Run[0], core: Run[1]) => Promise<Awaited<ReturnType<ModRuntime['commandRun']>>>,
    hooks = true,
  ) {
    const runs: Array<{ command: string; args: string }> = []
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasCommandRunHooks: () => hooks,
      registeredCommand: name =>
        registered.includes(name) ? { name, description: `${name} by a mod` } : undefined,
      listRegisteredCommands: () => registered.map(name => ({ name, description: `${name} by a mod`, plugin: 'greeter' })),
      commandRun: async (input, core) => {
        runs.push(input)
        return answer(input, core)
      },
    }
    return { mods, runs }
  }

  /** The system messages with text — the init record carries none. */
  function systemTexts(messages: unknown[]): string[] {
    return messages
      .filter(m => (m as { type?: string }).type === 'system')
      .map(m => (m as { message?: unknown }).message)
      .filter((m): m is string => typeof m === 'string')
  }

  it('a registered command: the hook\'s text is the output, the typed line is echoed, no model call', async () => {
    const { mods, runs } = commandMods(['hello'], async () => ({
      settled: true,
      result: { text: 'hello max', context: ['the greeter ran'] },
      unanswered: false,
    }))
    const { engine, modelCalls } = makeEngine(mods)
    const yielded = await submit(engine, '/hello max')
    expect(runs).toEqual([{ command: 'hello', args: 'max' }])
    expect(systemTexts(yielded)).toEqual(['hello max'])
    expect(userRows(engine.transcriptRows())).toEqual([
      ['/hello max', false],
      [[{ type: 'text', text: 'the greeter ran' }], true],
    ])
    expect(modelCalls).toEqual([])
    expect(engine.listModCommands()).toEqual([{ name: 'hello', description: 'hello by a mod', plugin: 'greeter' }])
  })

  it('a registered command no hook answered says so, localized', async () => {
    const { mods } = commandMods(['silent'], async () => ({
      settled: true,
      result: { ref: 1, text: undefined },
      unanswered: true,
    }))
    const { engine } = makeEngine(mods)
    const yielded = await submit(engine, '/silent')
    expect(systemTexts(yielded)).toEqual(['No plugin answered /silent.'])
  })

  it('an engine command a hook does not select runs as typed, with no dispatch', async () => {
    const { mods, runs } = commandMods([], async () => ({ settled: false }), false)
    const { engine } = makeEngine(mods)
    await submit(engine, '/status')
    expect(runs).toEqual([])
  })

  it('an engine command: core runs the engine\'s command with the args that arrived; a hook\'s text replaces what it printed', async () => {
    const pipelineInputs: unknown[] = []
    const runtimeConfig = new DefaultRuntimeConfig()
    const pipeline: UserInputPipeline = {
      processUserInput: async params => {
        pipelineInputs.push(params.input)
        return {
          messages: [
            { type: 'user', uuid: 'echo', timestamp: 't', message: { role: 'user', content: params.input } } as unknown as Message,
            { type: 'system', uuid: 'out', timestamp: 't', message: 'status: idle', subtype: 'informational' } as unknown as Message,
          ],
          shouldQuery: false,
        }
      },
    }
    const { mods } = commandMods([], async (input, core) => {
      const ran = await core!(`${input.args} --verbose`, new AbortController().signal)
      return { settled: true, result: { ...ran, ref: 1, text: ran.text!.toUpperCase() }, unanswered: false }
    })
    const { engine } = makeEngine(mods, false, pipeline)
    const yielded = await submit(engine, '/status now')
    expect(pipelineInputs).toEqual(['/status now --verbose'])
    expect(systemTexts(yielded)).toEqual(['STATUS: IDLE'])
  })

  it('an engine command a hook answers for itself: the engine\'s command never runs', async () => {
    const pipelineInputs: unknown[] = []
    const pipeline: UserInputPipeline = {
      processUserInput: async params => {
        pipelineInputs.push(params.input)
        return { messages: [], shouldQuery: false }
      },
    }
    const { mods } = commandMods([], async () => ({ settled: true, result: { text: 'not today' }, unanswered: false }))
    const { engine } = makeEngine(mods, false, pipeline)
    const yielded = await submit(engine, '/clear')
    expect(pipelineInputs).toEqual([])
    expect(systemTexts(yielded)).toEqual(['not today'])
  })

  it('an abandoned or failed chain runs the command as typed', async () => {
    const pipelineInputs: unknown[] = []
    const pipeline: UserInputPipeline = {
      processUserInput: async params => {
        pipelineInputs.push(params.input)
        return { messages: [], shouldQuery: false }
      },
    }
    const { mods } = commandMods(['hello'], async () => ({ settled: false }))
    const { engine } = makeEngine(mods, false, pipeline)
    await submit(engine, '/hello')
    expect(pipelineInputs).toEqual(['/hello'])
  })

  it('a prompt that is not a typed slash command, or a meta turn, raises nothing', async () => {
    const { mods, runs } = commandMods(['hello'], async () => ({ settled: true, result: { text: 'x' }, unanswered: false }))
    const { engine } = makeEngine(mods)
    await submit(engine, 'say /hello')
    await submit(engine, '/hello', { isMeta: true })
    await submit(engine, '/hello', { origin: 'mailbox' })
    expect(runs).toEqual([])
  })
})


describe('QueryEngine — turn.start and turn.complete', () => {
  type Started = Parameters<ModRuntime['turnStart']>[0]
  type Completed = Parameters<ModRuntime['turnComplete']>[0]
  function turnMods(outcome: PromptSubmitOutcome = { entered: true, text: 'hello', context: [] }) {
    const starts: Started[] = []
    const completes: Completed[] = []
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async () => outcome,
      turnStart: async input => {
        starts.push(input)
      },
      turnComplete: async input => {
        completes.push(input)
        return {}
      },
    }
    return { mods, starts, completes }
  }

  it('raises turn.start with the settled text before the model call, and turn.complete with the answer after it', async () => {
    const { mods, starts, completes } = turnMods({ entered: true, text: 'hello [rewritten]', context: [] })
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(modelCalls.length).toBeGreaterThanOrEqual(1)
    expect(starts).toHaveLength(1)
    expect(starts[0]!.text).toBe('hello [rewritten]')
    expect(typeof starts[0]!.turnId).toBe('string')
    expect(completes).toHaveLength(1)
    expect(completes[0]).toMatchObject({ turnId: starts[0]!.turnId, answer: 'ok', reason: 'answer', isAborted: false })
    expect(typeof completes[0]!.durationMs).toBe('number')
  })

  it('a turn that never reaches the model raises neither', async () => {
    const { mods, starts, completes } = turnMods()
    const { engine, modelCalls } = makeEngine(mods, false)
    await submit(engine, '/status')
    expect(modelCalls).toHaveLength(0)
    expect(starts).toEqual([])
    expect(completes).toEqual([])
  })

  it('$.turn.abort with the running id interrupts the turn (reason aborted); another id, or none running, rejects naming both', async () => {
    const { mods, starts, completes } = turnMods()
    const { engine, modelCalls } = makeEngine(mods)
    expect(() => engine.abortTurn('nope')).toThrow(/nope is not the running turn \(none is running\)/)
    mods.turnStart = async input => {
      starts.push(input)
      expect(() => engine.abortTurn('other')).toThrow(new RegExp(`other is not the running turn \\(${input.turnId}\\)`))
      engine.abortTurn(input.turnId)
    }
    await submit(engine, 'hello')
    expect(modelCalls.length).toBeLessThanOrEqual(1)
    expect(completes).toHaveLength(1)
    expect(completes[0]).toMatchObject({ turnId: starts[0]!.turnId, reason: 'aborted', isAborted: true })
    expect(() => engine.abortTurn(starts[0]!.turnId)).toThrow(/none is running/)
  })

  it('a mod runtime without the turn events submits as before', async () => {
    const { engine, modelCalls } = makeEngine({ ready: Promise.resolve(), promptSubmit: async text => ({ entered: true, text, context: [] }) })
    await submit(engine, 'hello')
    expect(modelCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('QueryEngine — session.measure', () => {
  function measureMods(agentId?: string) {
    const order: string[] = []
    const figures: SessionUsage[] = []
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      turnComplete: async () => {
        order.push('turn.complete')
        return {}
      },
      sessionMeasure: async read => {
        order.push('session.measure')
        figures.push(read())
      },
      ...(agentId !== undefined ? { agentId } : {}),
    }
    return { mods, order, figures }
  }

  it("measures after each main-thread turn, after turn.complete, with $.session.usage()'s figures", async () => {
    const { mods, order, figures } = measureMods()
    const { engine } = makeEngine(mods)
    await submit(engine, 'hello')
    await submit(engine, 'again')
    expect(order).toEqual(['turn.complete', 'session.measure', 'turn.complete', 'session.measure'])
    expect(figures[1]).toEqual(engine.modTranscript.usage())
    expect(figures[1]!.context.window).toBeGreaterThan(0)
  })

  it('a child loop under the slot measures nothing; a turn that never reaches the model neither', async () => {
    const child = measureMods('subagent-7')
    await submit(makeEngine(child.mods).engine, 'hello')
    expect(child.order).toEqual(['turn.complete'])
    const command = measureMods()
    await submit(makeEngine(command.mods, false).engine, '/status')
    expect(command.order).toEqual([])
  })
})

describe('QueryEngine — $.session.usage({ breakdown })', () => {
  const lookup = declareTool({
    name: 'Lookup',
    argsSchema: { type: 'object' as const, properties: { term: { type: 'string' } } },
    description: async () => 'Looks a term up in the glossary',
    call: async () => ({ data: 'found' }),
  }) as unknown as ToolContract
  const plain: Mods = { ready: Promise.resolve(), promptSubmit: async text => ({ entered: true, text, context: [] }) }

  /** A model that answers once and reports what it was charged. */
  const charging = {
    callModel: async function* () {
      yield {
        type: MSG_TYPE_ASSISTANT,
        uuid: 'assistant-charged',
        message: {
          role: ROLE_ASSISTANT,
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 9_000, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 0, output_tokens: 40 },
        },
      } as Message
    },
  }

  it('splits the window into rows that add up to what the last response was charged, with the buffer and free space', async () => {
    const { engine } = makeEngine(plain, true, undefined, [lookup], charging)
    await submit(engine, 'hello')
    const breakdown = await engine.modTranscript.breakdown!({})
    const used = breakdown.categories.filter(row => row.kind === 'used')
    const byName = new Map(breakdown.categories.map(row => [row.name, row]))
    expect(byName.get('System tools')!.tokens).toBeGreaterThan(0)
    expect(byName.get('Messages')!.tokens).toBeGreaterThan(0)
    expect(breakdown.totalTokens).toBe(12_040)
    expect(used.reduce((sum, row) => sum + row.tokens, 0)).toBe(12_040)
    expect(breakdown.apiUsage).toEqual({ input_tokens: 9_000, output_tokens: 40, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 0 })

    const window = engine.modTranscript.usage().context.window
    expect(breakdown.rawMaxTokens).toBe(window)
    expect(breakdown.isAutoCompactEnabled).toBe(true)
    const buffer = byName.get('Autocompact buffer')!
    expect(buffer.tokens).toBe(window - breakdown.autoCompactThreshold!)
    expect(byName.get('Free space')!.tokens).toBe(window - 12_040 - buffer.tokens)
    expect(breakdown.categories.at(-1)!.kind).toBe('free')
  })

  it('before any response every row is an estimate and nothing is charged', async () => {
    const { engine } = makeEngine(plain, true, undefined, [lookup])
    const breakdown = await engine.modTranscript.breakdown!({ columns: 60 })
    expect(breakdown.apiUsage).toBeNull()
    expect(breakdown.categories.find(row => row.name === 'Messages')).toBeUndefined()
    expect(breakdown.totalTokens).toBe(
      breakdown.categories.filter(row => row.kind === 'used').reduce((sum, row) => sum + row.tokens, 0),
    )
    expect(breakdown.gridRows[0]).toHaveLength(5)
  })
})

describe('QueryEngine — turn.step', () => {
  /** A mod runtime whose `turn.step` is a real chain of generator hooks
   *  running beside it; `turn.start` / `turn.complete` recorded. */
  function stepMods(hook: (call: StreamHookCall) => AsyncGenerator<unknown, unknown, undefined>) {
    const dispatcher = new ModDispatcher({ budgetMs: 5_000, catchMs: 1_000 })
    dispatcher.register('m', [
      {
        id: 'm/1',
        plugin: 'm',
        tier: 'user',
        pattern: 'turn.step',
        streams: true,
        run: () => Promise.reject(new Error('generator')),
        runStream: call => {
          const gen = hook(call)
          return { next: () => gen.next(), return: async () => void (await gen.return(undefined)) }
        },
      },
    ])
    const steps: TurnStepInput[] = []
    const started: string[] = []
    const answers: string[] = []
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      turnStart: async input => {
        started.push(input.turnId)
      },
      turnComplete: async input => {
        answers.push(input.answer)
        return {}
      },
      hasTurnStepHooks: () => true,
      turnStep: (e, core, signal) => {
        steps.push(e)
        return dispatcher.dispatchStream<TurnStepChunk, TurnStepResult>(
          'turn.step',
          e,
          arrived => core(arrivedTurnStep(e, arrived)),
          { accepts: isTurnStepResult, ...(signal ? { signal } : {}) },
        )
      },
    }
    return { mods, steps, started, answers }
  }

  /** The loop's own requests: not the side query that runs after a turn
   *  over its transcript (one user row, "user: …"). */
  const loopCalls = (calls: readonly Message[][]): Message[][] =>
    calls.filter(call => !JSON.stringify(call).includes('user: hello'))

  const assistantTexts = (messages: readonly unknown[]): string[] =>
    messages
      .filter((m): m is Message => (m as Message).type === 'assistant')
      .flatMap(m => ((m as unknown as { message: { content: Array<{ type: string; text?: string }> } }).message.content))
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')

  it("raises each model request with the turn's id; what leaves the hook is shown, recorded, and the turn's answer", async () => {
    const { mods, steps, started, answers } = stepMods(async function* (call) {
      const beneath = call.next(call.e)
      for (;;) {
        const step = await beneath.next()
        if (step.done) return step.value
        const chunk = step.value as TurnStepChunk
        yield chunk.kind === 'text' ? { ...chunk, text: chunk.text.toUpperCase() } : chunk
      }
    })
    const { engine, modelCalls } = makeEngine(mods)
    const yielded = await submit(engine, 'hello')
    expect(loopCalls(modelCalls)).toHaveLength(1)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ turnId: started[0], index: 0, messageCount: loopCalls(modelCalls)[0]!.length })
    expect(typeof steps[0]!.model).toBe('string')
    expect(assistantTexts(yielded)).toEqual(['OK'])
    expect(assistantTexts(engine.transcriptRows())).toEqual(['OK'])
    expect(answers).toEqual(['OK'])
  })

  it('a hook that answers alone: no request goes out, and its answer is the turn\'s', async () => {
    const { mods, answers } = stepMods(async function* () {
      yield { kind: 'text', index: 0, text: 'from the cache' }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: 't', index: 0, answer: 'from the cache', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(loopCalls(modelCalls)).toHaveLength(0)
    expect(assistantTexts(engine.transcriptRows())).toEqual(['from the cache'])
    expect(answers).toEqual(['from the cache'])
  })
})

describe('QueryEngine — prompt.section, prompt.compose, prompt.context', () => {
  function promptMods() {
    const seen = { sections: [] as unknown[], compose: [] as unknown[], context: [] as unknown[] }
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasPromptHooks: () => true,
      promptSections: async sections => {
        seen.sections.push(sections)
        return sections.map(section => (section.id === 'line_1' ? { ...section, text: 'rewritten by a mod' } : section))
      },
      promptCompose: async (input, sections) => {
        seen.compose.push({ input, sections })
        return [...sections, { id: 'acme:policy', text: 'Never guess.', scope: 'session' }]
      },
      promptContext: async input => {
        seen.context.push(input)
        return { blocks: [...input.blocks, { name: 'acme', text: 'hello from a mod' }] }
      },
    }
    return { mods, seen }
  }

  it('the named sections go through the three events where the prompt is rendered, and what comes back is what the model is sent', async () => {
    const { mods, seen } = promptMods()
    const { engine, prompts } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(prompts.length).toBeGreaterThanOrEqual(1)
    // The provider's one unnamed part is `line_1`; the engine's own parts
    // follow it, named.
    const first = seen.sections[0] as Array<{ id: string; scope: string }>
    expect(first[0]).toMatchObject({ id: 'line_1', scope: 'shared' })
    expect(first.slice(1).every(section => section.scope === 'session')).toBe(true)
    const compose = seen.compose[0] as { input: Record<string, unknown>; sections: Array<{ id: string; text: string }> }
    expect(compose.input).toMatchObject({ surfaces: ['desktop'], outputStyle: null, tools: [] })
    expect(typeof compose.input.model).toBe('string')
    expect(compose.sections[0]).toMatchObject({ id: 'line_1', text: 'rewritten by a mod' })
    const systemPrompt = prompts[0]!.systemPrompt as string[]
    expect(systemPrompt[0]).toBe('rewritten by a mod')
    expect(systemPrompt.at(-1)).toBe('Never guess.')
    expect(seen.context[0]).toEqual({ blocks: [], instructionFiles: [] })
    expect(prompts[0]!.userContext).toEqual({ acme: 'hello from a mod' })
  })

  it('a mod runtime with no prompt hook leaves the prompt as the engine composed it, with no call', async () => {
    const { mods, seen } = promptMods()
    mods.hasPromptHooks = () => false
    const { engine, prompts } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(seen.sections).toEqual([])
    expect(seen.compose).toEqual([])
    expect(seen.context).toEqual([])
    const systemPrompt = prompts[0]!.systemPrompt as string[]
    expect(systemPrompt[0]).toBe('You are running inside the chromium-runtime sidecar project.')
    expect(prompts[0]!.userContext).toEqual({})
  })
})

describe('QueryEngine — a reload never runs under a turn', () => {
  it('the next turn waits for the dev loop\'s reload of the last one', async () => {
    const order: string[] = []
    let finishReload!: () => void
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => {
        order.push(`submit ${text}`)
        return { entered: true, text, context: [] }
      },
      afterTurn: () =>
        new Promise(resolve => {
          order.push('reload start')
          finishReload = () => {
            order.push('reload end')
            resolve({ polled: 1, reloaded: ['/p/hooks/register.js'] })
          }
        }),
    }
    const { engine } = makeEngine(mods)
    await submit(engine, 'one')
    const second = submit(engine, 'two')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order).toEqual(['submit one', 'reload start'])
    finishReload()
    await second
    expect(order.slice(0, 4)).toEqual(['submit one', 'reload start', 'reload end', 'submit two'])
  })

  it('a reload asked for while a turn runs waits for the turn to end', async () => {
    const order: string[] = []
    let engine!: ConversationEngine
    let reloading: Promise<boolean> | undefined
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      turnStart: async () => {
        order.push('turn start')
        reloading = engine.reloadMods().then(done => {
          order.push('reloaded')
          return done
        })
      },
      turnComplete: async () => {
        order.push('turn complete')
        return {}
      },
      reload: async () => {
        order.push('reload')
        return { added: [], removed: [], reloaded: [] }
      },
    }
    engine = makeEngine(mods).engine
    await submit(engine, 'go')
    await reloading
    expect(order).toEqual(['turn start', 'turn complete', 'reload', 'reloaded'])
  })
})

describe('QueryEngine — session.append', () => {
  function appendMods(hooked = true) {
    const seen: Array<{ type: unknown; uuid: unknown }> = []
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasSessionAppendHooks: () => hooked,
      sessionAppend: async row => {
        seen.push({ type: row.type, uuid: row.uuid })
        const message = row.message as { role: string; content: unknown } | undefined
        if (row.type === 'user' && typeof message?.content === 'string') {
          return { ...row, message: { ...message, content: `${message.content} [appended]` } }
        }
        return row
      },
    }
    return { mods, seen }
  }

  it('every row joining the conversation passes the event first — the prompt and the response — and what comes back is what is kept and sent', async () => {
    const { mods, seen } = appendMods()
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    await submit(engine, 'again')
    expect(seen.map(row => row.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(seen.every(row => typeof row.uuid === 'string')).toBe(true)
    // Each call is sent the prompt as the hook rewrote it, and the next
    // call's history (folded by the test pipeline) carries that form too.
    expect(JSON.stringify(modelCalls[0])).toContain('hello [appended]')
    const history = JSON.stringify(modelCalls[1])
    expect(history).toContain('hello [appended]')
    expect(history).not.toMatch(/"hello"|hello\\n/)
  })

  it('a tool result the hook rewrote is sent in its kept form on the SAME turn\'s next model call', async () => {
    const reader = declareTool({
      name: 'Reader',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'reads',
      call: async () => ({ data: 'SECRET=hunter2' }),
    }) as unknown as ToolContract
    const sent: string[] = []
    const callModel = async function* (params: { messages: Message[] }) {
      sent.push(JSON.stringify(params.messages))
      yield (sent.length === 1
        ? {
            type: MSG_TYPE_ASSISTANT,
            uuid: 'assistant-tool',
            message: {
              role: ROLE_ASSISTANT,
              content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'Reader', args: {} }],
            },
          }
        : {
            type: MSG_TYPE_ASSISTANT,
            uuid: 'assistant-final',
            message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'done' }] },
          }) as Message
    }
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasSessionAppendHooks: () => true,
      sessionAppend: async row => JSON.parse(JSON.stringify(row).replaceAll('hunter2', '[scrubbed]')),
    }
    const { engine } = makeEngine(mods, true, undefined, [reader], { callModel })
    const yielded = await submit(engine, 'read it')
    // What the worker receives (and persists the tool's detail sidecar from)
    // is the kept form too.
    expect(JSON.stringify(yielded)).not.toContain('hunter2')
    // [0] the prompt, [1] the tool result (a later call may name the session).
    expect(sent[1]).toContain('[scrubbed]')
    expect(sent[1]).not.toContain('hunter2')
    expect(JSON.stringify(engine.transcriptRows())).not.toContain('hunter2')
    // And the next turn's history is the kept form too.
    await submit(engine, 'again')
    const next = sent.find(body => body.includes('again')) ?? ''
    expect(next).toContain('[scrubbed]')
    expect(next).not.toContain('hunter2')
  })

  it('a mod runtime with no session.append hook stores every row as made, with no call', async () => {
    const { mods, seen } = appendMods(false)
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(seen).toEqual([])
    expect(userRows(modelCalls[0]!)).toEqual([['hello', false]])
  })
})

describe('QueryEngine — session.compact at /compact', () => {
  /** A pipeline that turns `/compact <instructions>` into the compact action. */
  function compactPipeline(runtimeConfig: DefaultRuntimeConfig): UserInputPipeline {
    return {
      async processUserInput(params) {
        const text = String(params.input)
        const row = {
          type: 'user',
          uuid: params.uuid ?? runtimeConfig.createUUID(),
          message: { role: 'user', content: text },
          isMeta: false,
        } as Message
        if (!text.startsWith('/compact')) return { messages: [row], shouldQuery: true, resultText: text }
        const instructions = text.slice('/compact'.length).trim()
        return {
          messages: [row],
          shouldQuery: false,
          resultText: text,
          action: 'compact',
          ...(instructions ? { compactInstructions: instructions } : {}),
        }
      },
    }
  }

  function compactWorld(sessionCompact: Mods['sessionCompact']) {
    const forced: Array<{ messages: number; customInstructions?: string }> = []
    const forceCompact = async (params: { messages: Message[]; customInstructions?: string }) => {
      forced.push({ messages: params.messages.length, customInstructions: params.customInstructions })
      return {
        boundaryMarker: { type: 'system', uuid: 'b1', subtype: 'compact_boundary', message: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 10 } } as Message,
        summaryMessages: [{ type: 'user', uuid: 'sum1', isMeta: true, message: { role: 'user', content: 'SUMMARY' } } as Message],
      }
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      sessionCompact,
    }
    const { engine } = makeEngine(mods, true, compactPipeline(runtimeConfig), [], { forceCompact })
    return { engine, forced }
  }

  function systemTexts(messages: unknown[]): string[] {
    return messages
      .filter(m => (m as { type?: string }).type === 'system')
      .map(m => (m as { message?: unknown }).message)
      .filter((m): m is string => typeof m === 'string')
  }

  it('the manual compaction goes through the event with its instructions and the transcript; core runs over what the hook hands down', async () => {
    const seen: Array<{ trigger: string; instructions?: string; rows: number }> = []
    const { engine, forced } = compactWorld(async (input, core) => {
      seen.push({ trigger: input.trigger, instructions: input.instructions, rows: input.messages.length })
      return core.run({ instructions: `${input.instructions} (and names)`, messages: [...input.messages] })
    })
    await submit(engine, 'hello')
    const yielded = await submit(engine, '/compact keep the plan', { uuid: 'u2' })
    expect(seen).toEqual([{ trigger: 'manual', instructions: 'keep the plan', rows: 2 }])
    expect(forced).toEqual([{ messages: 2, customInstructions: 'keep the plan (and names)' }])
    expect(systemTexts(yielded)).toEqual(['Conversation compacted'])
    const kept = engine.transcriptRows().map(m => m.uuid)
    expect(kept.slice(-2)).toEqual(['b1', 'sum1'])
  })

  it('a skip leaves the transcript as it is and says so, localized, with the reason', async () => {
    const { engine, forced } = compactWorld(async () => ({ skip: 'not in this project' }))
    await submit(engine, 'hello')
    const before = engine.transcriptRows().length
    const yielded = await submit(engine, '/compact', { uuid: 'u2' })
    expect(forced).toEqual([])
    expect(systemTexts(yielded)).toEqual(['Compaction skipped by a plugin — not in this project. The transcript is unchanged.'])
    // The echo and the notice, nothing compacted.
    expect(engine.transcriptRows().length).toBe(before + 2)
    expect(engine.transcriptRows().some(m => (m as { subtype?: string }).subtype === 'compact_boundary')).toBe(false)
  })

  it('a mod runtime without sessionCompact compacts as before', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const forced: unknown[] = []
    const { engine } = makeEngine(
      { ready: Promise.resolve(), promptSubmit: async text => ({ entered: true, text, context: [] }) },
      true,
      compactPipeline(runtimeConfig),
      [],
      {
        forceCompact: async (params: { customInstructions?: string }) => {
          forced.push(params.customInstructions)
          return { error: 'no summarizer here' }
        },
      },
    )
    await submit(engine, 'hello')
    const yielded = await submit(engine, '/compact focus', { uuid: 'u2' })
    expect(forced).toEqual(['focus'])
    expect(systemTexts(yielded)[0]).toContain('no summarizer here')
  })
})

describe('QueryEngine — session.receive at a delivered turn', () => {
  function receivingMods(answer: (text: string) => { text: string } | { consumed: string }) {
    const seen: Array<{ kind: string; text: string }> = []
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasSessionReceiveHooks: () => true,
      sessionReceive: async input => {
        seen.push({ kind: input.origin.kind, text: input.text })
        return answer(input.text)
      },
    }
    return { mods, seen }
  }

  it('a delivered turn passes the event with its origin and text; a rewrite is what enters', async () => {
    const { mods, seen } = receivingMods(text => ({ text: `${text} [seen]` }))
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'from a peer', { delivery: 'peer' })
    await submit(engine, '<task-notification>done</task-notification>', { uuid: 'u2', delivery: 'task-notification' })
    expect(seen).toEqual([
      { kind: 'peer', text: 'from a peer' },
      { kind: 'task-notification', text: '<task-notification>done</task-notification>' },
    ])
    expect(JSON.stringify(modelCalls[0])).toContain('from a peer [seen]')
    // The second delivery enters as rewritten too (the test pipeline folds
    // the history, so look at every call's text).
    expect(JSON.stringify(modelCalls)).toContain('[seen]')
    expect(JSON.stringify(modelCalls)).not.toContain('"<task-notification>done</task-notification>"')
  })

  it('a consumed delivery enters nothing: no row, no model call, nothing yielded', async () => {
    const { mods } = receivingMods(() => ({ consumed: 'muted' }))
    const { engine, modelCalls } = makeEngine(mods)
    const yielded = await submit(engine, 'MUTE me', { delivery: 'peer' })
    expect(yielded).toEqual([])
    expect(modelCalls).toEqual([])
    expect(engine.transcriptRows()).toEqual([])
  })

  it("a typed prompt is not a delivery: the event is not raised", async () => {
    const { mods, seen } = receivingMods(() => ({ consumed: 'never' }))
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'hello')
    expect(seen).toEqual([])
    expect(modelCalls.length).toBeGreaterThan(0)
    expect(JSON.stringify(modelCalls[0])).toContain('hello')
  })
})

describe('QueryEngine — command.describe for the picker', () => {
  it('builds the inputs only when a hook will read them (the snapshot asks on every build)', () => {
    let hooked = false
    const asked: unknown[] = []
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasCommandDescribeHooks: () => hooked,
      commandDescriptions: inputs => {
        asked.push(...inputs)
        return new Map([['help', { description: 'Help!', isHidden: false }]])
      },
    }
    const { engine } = makeEngine(mods)
    let built = 0
    const inputs = () => {
      built += 1
      return [{ command: 'help', description: 'Show help', isHidden: false, immediate: false, provider: { plugin: 'engine', tier: 'core' as const } }]
    }
    expect(engine.describeCommands(inputs).size).toBe(0)
    expect(built).toBe(0)
    hooked = true
    expect(engine.describeCommands(inputs).get('help')?.description).toBe('Help!')
    expect(built).toBe(1)
    expect(asked).toHaveLength(1)
  })
})

describe('$.model through the engine', () => {
  type Call = Record<string, unknown>
  /** A transport that records each call and answers with `rows`, usage on the first. */
  function transport(rows: Array<Record<string, unknown>>) {
    const calls: Call[] = []
    const callModel = async function* (params: Call) {
      calls.push(params)
      for (const [index, row] of rows.entries()) {
        yield {
          type: MSG_TYPE_ASSISTANT,
          uuid: `assistant-m${calls.length}-${index}`,
          message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 7, output_tokens: 2 } },
          ...row,
        } as Message
      }
    }
    return { calls, callModel }
  }
  const signal = new AbortController().signal

  it('complete: one tool-less request with the cap, the alias resolved, the text and usage answered', async () => {
    const t = transport([{ message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'the answer' }], usage: { input_tokens: 7, output_tokens: 2 } } }])
    const { engine } = makeEngine(undefined, true, undefined, [], { callModel: t.callModel })
    const result = await engine.modModel.complete({ model: 'some-model-id', prompt: 'ask', system: 'be brief', maxTokens: 9, effort: 'xhigh' }, { signal })
    expect(result).toEqual({ isAnswered: true, text: 'the answer', usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]).toMatchObject({
      modelOverride: 'some-model-id',
      outputTokenCapOverride: 9,
      thinkingTier: 'extra-high',
      forceFinalResponse: true,
      noCacheWrite: true,
      baseInstructions: ['be brief'],
      querySource: 'mod_model_complete',
    })
    expect(JSON.stringify((t.calls[0] as { messages: unknown }).messages)).toContain('ask')
    expect((t.calls[0] as { callContext: { options: { tools: unknown[] } } }).callContext.options.tools).toEqual([])
    // `inherit` is the session's own model: no override.
    await engine.modModel.complete({ model: 'inherit', prompt: 'again' }, { signal })
    expect(t.calls[1]).not.toHaveProperty('modelOverride')
    expect(t.calls[1]).toMatchObject({ outputTokenCapOverride: 1024, baseInstructions: [] })
  })

  it("complete: the prompt's blocks are the message's text parts, each mark a cache breakpoint", async () => {
    const t = transport([{}])
    const { engine } = makeEngine(undefined, true, undefined, [], { callModel: t.callModel })
    await engine.modModel.complete({ model: 'm', prompt: 'RULES diff', promptBlocks: [{ text: 'RULES ', cache: true }, { text: 'diff' }] }, { signal })
    const [message] = (t.calls[0] as { messages: Array<{ message: { content: unknown } }> }).messages
    expect(message!.message.content).toEqual([
      { type: 'text', text: 'RULES ', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'diff' },
    ])
  })

  it("complete: the transport's error turn is `api-error` with its kind; a reply with no text `empty-reply`", async () => {
    const failing = transport([{ isApiErrorMessage: true, error: 'rate_limit', message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'API Error: 429' }] } }])
    const { engine } = makeEngine(undefined, true, undefined, [], { callModel: failing.callModel })
    expect(await engine.modModel.complete({ model: 'm', prompt: 'p' }, { signal })).toMatchObject({ isAnswered: false, reason: 'api-error', error: 'rate_limit', status: null })
    const silent = transport([{ message: { role: ROLE_ASSISTANT, content: [], usage: { output_tokens: 1 } } }])
    const quiet = makeEngine(undefined, true, undefined, [], { callModel: silent.callModel }).engine
    expect(await quiet.modModel.complete({ model: 'm', prompt: 'p' }, { signal })).toEqual({
      isAnswered: false,
      reason: 'empty-reply',
      usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
  })

  it('fork: nothing-to-fork before the first response; after a turn, the transcript plus the prompt, tools dropped', async () => {
    const t = transport([{ message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'forked reply' }], usage: {} } }])
    const { engine } = makeEngine(undefined, true, undefined, [], { callModel: t.callModel })
    expect(await engine.modModel.fork({ prompt: 'what next?' }, { signal })).toEqual({ isAnswered: false, reason: 'nothing-to-fork' })
    expect(t.calls).toHaveLength(0)
    await submit(engine, 'hello there')
    const turns = t.calls.length
    const forked = await engine.modModel.fork({ prompt: 'what next?' }, { signal })
    expect(forked).toMatchObject({ isAnswered: true, text: 'forked reply' })
    const fork = t.calls[turns] as { messages: unknown[]; forceFinalResponse: unknown; querySource: unknown }
    expect(fork).toMatchObject({ forceFinalResponse: true, querySource: 'mod_model_fork' })
    const sent = JSON.stringify(fork.messages)
    expect(sent).toContain('hello there')
    expect(sent).toContain('what next?')
    expect(fork.messages.length).toBe(engine.transcriptRows().length + 1)
    // The fork added nothing to the session's own transcript.
    expect(JSON.stringify(engine.transcriptRows())).not.toContain('what next?')
  })
})

describe('$.tool.register through the engine', () => {
  const passThrough = (): Mods => ({
    ready: Promise.resolve(),
    promptSubmit: async text => ({ entered: true, text, context: [] }),
    hasToolCallHooks: () => false,
    toolCall: async (e, core) => ({ settled: true, result: await core(e, new AbortController().signal) }),
  })

  it('a registered tool joins the session\'s list from now on, replaced by name, gone with its plugin; with no hook answering, its core fails', async () => {
    const { engine } = makeEngine(passThrough(), true, undefined, [])
    expect(engine.modTools.register!({ name: 'weather', description: 'Weather.', inputSchema: { type: 'object' } }, 'mod-weather')).toBe(
      'mcp__mod-weather__weather',
    )
    expect(await engine.modTools.list()).toEqual([{ name: 'mcp__mod-weather__weather', description: 'Weather.', mcp: true }])
    engine.modTools.register!({ name: 'weather', description: 'Weather, again.', inputSchema: { type: 'object' } }, 'mod-weather')
    engine.modTools.register!({ name: 'tide', description: 'Tides.', inputSchema: { type: 'object' } }, 'mod-sea')
    expect((await engine.modTools.list()).map(t => `${t.name}: ${t.description}`)).toEqual([
      'mcp__mod-weather__weather: Weather, again.',
      'mcp__mod-sea__tide: Tides.',
    ])
    // The model's call goes the tool path; with no hook above, core answers
    // the failure the plugin left: an error result naming the plugin.
    const answer = (await engine.modTools.call({ tool: 'mcp__mod-sea__tide' }, { context: ROOT_DISPATCH_CONTEXT })) as {
      result: { error?: string; isError?: boolean }
    }
    expect(answer.result.isError).toBe(true)
    expect(answer.result.error).toContain('no tool.call hook of mod-sea answered')
    engine.modTools.forget!('mod-weather')
    expect((await engine.modTools.list()).map(t => t.name)).toEqual(['mcp__mod-sea__tide'])
    expect(engine.transcriptRows()).toEqual([])
  })
  const toolSearch = declareTool({
    name: 'ToolSearch',
    argsSchema: { type: 'object' } as never,
    description: async () => 'Loads tools.',
    async call() {
      return { data: 'ok' }
    },
  }) as unknown as ToolContract

  it("a registered tool waits behind ToolSearch under the session's own deferral key unless it said isDeferred: false", async () => {
    const { engine, runtimeConfig } = makeEngine(passThrough(), true, undefined, [toolSearch])
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], runtimeConfig)
    engine.modTools.register!({ name: 'tide', description: 'Tides.', inputSchema: { type: 'object' } }, 'mod-sea')
    engine.modTools.register!({ name: 'wave', description: 'Waves.', inputSchema: { type: 'object' }, isDeferred: false }, 'mod-sea')
    // `$.tool.list` lists the tools offered now: the waiting one is not.
    expect((await engine.modTools.list()).map(t => t.name)).toEqual(['ToolSearch', 'mcp__mod-sea__wave'])
    const none = { activeSkills: [] } as unknown as WorkingState
    expect(shouldHideToolFromModel({ name: 'mcp__mod-sea__tide' }, none, runtimeConfig)).toBe(true)
    expect(shouldHideToolFromModel({ name: 'mcp__mod-sea__wave' }, none, runtimeConfig)).toBe(false)
    // Forgotten with its plugin, the unit goes too.
    engine.modTools.forget!('mod-sea')
    expect(shouldHideToolFromModel({ name: 'mcp__mod-sea__tide' }, none, runtimeConfig)).toBe(false)
  })

  it('an inherited tool stays in front in a loop whose tools hold no ToolSearch', async () => {
    const { engine, runtimeConfig } = makeEngine(passThrough(), true, undefined, [])
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], runtimeConfig)
    engine.inheritModTools([buildModTool('mod-sea', { name: 'tide', description: 'Tides.', inputSchema: { type: 'object' } })])
    const none = { activeSkills: [] } as unknown as WorkingState
    expect(shouldHideToolFromModel({ name: 'mcp__mod-sea__tide' }, none, runtimeConfig)).toBe(false)
    expect((await engine.modTools.list()).map(t => t.name)).toEqual(['mcp__mod-sea__tide'])
  })

  it('each change of the registered tools is told to onModToolsChanged, for the loops under the session', () => {
    const told: string[][] = []
    const { engine } = makeEngine(passThrough(), true, undefined, [], {}, {
      onModToolsChanged: (tools: readonly ToolContract[]) => told.push(tools.map(tool => tool.name)),
    })
    engine.modTools.register!({ name: 'tide', description: 'Tides.', inputSchema: { type: 'object' } }, 'mod-sea')
    engine.modTools.forget!('mod-sea')
    expect(told).toEqual([['mcp__mod-sea__tide'], []])
  })

  it('a loop under a slot lists the inherited tools in place of those inherited before, beside its own', async () => {
    const own = declareTool({
      name: 'Read',
      argsSchema: { type: 'object' } as never,
      description: async () => 'Read.',
      async call() {
        return { data: 'ok' }
      },
    }) as unknown as ToolContract
    const { engine } = makeEngine(passThrough(), true, undefined, [own])
    engine.inheritModTools([buildModTool('mod-sea', { name: 'tide', description: 'Tides.', inputSchema: { type: 'object' } })])
    expect((await engine.modTools.list()).map(t => t.name)).toEqual(['Read', 'mcp__mod-sea__tide'])
    engine.inheritModTools([buildModTool('mod-sea', { name: 'wave', description: 'Waves.', inputSchema: { type: 'object' } })])
    expect((await engine.modTools.list()).map(t => t.name)).toEqual(['Read', 'mcp__mod-sea__wave'])
    engine.inheritModTools([])
    expect((await engine.modTools.list()).map(t => t.name)).toEqual(['Read'])
  })
})

describe('$.agent through the engine', () => {
  const passThrough = (): Mods => ({
    ready: Promise.resolve(),
    promptSubmit: async text => ({ entered: true, text, context: [] }),
    hasToolCallHooks: () => false,
    toolCall: async (e, core) => ({ settled: true, result: await core(e, new AbortController().signal) }),
  })
  /** An Agent tool stand-in: reports the launched id through the call
   *  context, answers a refusal for `nope`, and for `mute` answers an ack
   *  whose text names an id it never reports. */
  const agentTool = declareTool({
    name: 'Agent',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'Spawns',
    call: async (args: Record<string, unknown>, context: { onSubAgentLaunched?: (taskId: string) => void }) => {
      if (args.subagent_type === 'nope') {
        return { data: 'Agent could not start: the agent type "nope" is not offered in this session.' }
      }
      if (args.subagent_type !== 'mute') context.onSubAgentLaunched?.('a00000042')
      return { data: `Launched background sub-agent "${String(args.description)}" (task id a99999999). It runs in its own isolated context.` }
    },
  }) as unknown as ToolContract

  it('a spawn is the plugin\'s own background Agent call: the id the launch reports, a refusal as deny; the list is empty without a controller; a type registered rides over a plugin reload', async () => {
    const { engine } = makeEngine(passThrough(), true, undefined, [agentTool])
    expect(await engine.modAgents.spawn({ prompt: 'Read README.md.', subagentType: 'Explore' }, { context: ROOT_DISPATCH_CONTEXT })).toEqual({
      model: 'inherit',
      agentId: 'a00000042',
    })
    // An id only in the tool's text is not taken: the launch did not report one.
    expect(await engine.modAgents.spawn({ prompt: 'x', subagentType: 'mute' }, { context: ROOT_DISPATCH_CONTEXT })).toEqual({
      deny: 'Launched background sub-agent "x" (task id a99999999). It runs in its own isolated context.',
    })
    expect(await engine.modAgents.spawn({ prompt: 'x', subagentType: 'nope' }, { context: ROOT_DISPATCH_CONTEXT })).toEqual({
      deny: 'the agent type "nope" is not offered in this session.',
    })
    expect(engine.modAgents.list()).toEqual([])
    expect(engine.transcriptRows()).toEqual([])
    expect(engine.modAgents.register({ name: 'runner', description: 'Runs', prompt: 'P' }, 'lab')).toBe('lab:runner')
    engine.modAgents.register({ name: 'runner', description: 'Runs again', prompt: 'P' }, 'lab')
    engine.modAgents.forget('nobody')
    engine.modAgents.forget('lab')
    expect(engine.modAgents.register({ name: 'runner', description: 'Runs', prompt: 'P' }, 'lab')).toBe('lab:runner')
  })

  /** A controller whose one subagent `a1` ends when `finish` is called. */
  function oneSubagent(own: string) {
    const calls: string[] = []
    let status: 'running' | 'success' | 'error' | 'stopped' = 'running'
    const waiters: Array<() => void> = []
    const snapshot = () => ({ sessionId: 'a1', status, description: 'scan', agentType: 'Explore', output: status === 'running' ? '' : 'found 3', startedAt: 0 })
    const controller = {
      list: (spawner: string) => (spawner === own ? [snapshot()] : []),
      holdResult: (id: string) => {
        calls.push(`hold ${id}`)
        return status === 'running' ? (consumed: boolean) => calls.push(`release ${consumed}`) : undefined
      },
      waitForCompletion: (_id: string, _ms: number, signal?: AbortSignal) => {
        if (signal) calls.push('signal passed on')
        return status === 'running' ? new Promise(resolve => waiters.push(() => resolve(snapshot()))) : Promise.resolve(snapshot())
      },
      acknowledgeResult: (id: string) => calls.push(`ack ${id}`),
    }
    setSubAgentController(controller as unknown as SubAgentController)
    return {
      calls,
      finish(to: 'success' | 'error' | 'stopped') {
        status = to
        for (const wake of waiters.splice(0)) wake()
      },
    }
  }

  it('$.agent.wait: holds the result first, resolves with the outcome when the run ends, and acknowledges it', async () => {
    const { engine } = makeEngine(passThrough())
    const run = oneSubagent(engine.boundSessionId())
    try {
      const waiting = engine.modAgents.wait!('a1', {})
      await new Promise(resolve => setTimeout(resolve, 0))
      run.finish('success')
      expect(await waiting).toEqual({ agentId: 'a1', status: 'completed', text: 'found 3', description: 'scan', type: 'Explore' })
      expect(run.calls).toEqual(['hold a1', 'ack a1', 'release true'])
    } finally {
      setSubAgentController(null)
    }
  })

  it('$.agent.wait: an abandoned wait rejects AbortError, releases unconsumed, and never passes its signal to the controller', async () => {
    const { engine } = makeEngine(passThrough())
    const run = oneSubagent(engine.boundSessionId())
    try {
      const abort = new AbortController()
      const waiting = engine.modAgents.wait!('a1', { signal: abort.signal })
      await new Promise(resolve => setTimeout(resolve, 0))
      abort.abort()
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
      expect(run.calls).toEqual(['hold a1', 'release false'])
    } finally {
      setSubAgentController(null)
    }
  })

  it("$.agent.wait: an id that is not one of this session's agents is NotFoundError", async () => {
    const { engine } = makeEngine(passThrough())
    oneSubagent('someone-else')
    try {
      await expect(engine.modAgents.wait!('a1', {})).rejects.toMatchObject({ name: 'NotFoundError' })
    } finally {
      setSubAgentController(null)
    }
  })

  it("$.ui.view's lookup: a subagent of this session by its task id or its loop id, a teammate by its session, anything else undefined", () => {
    const { engine } = makeEngine(passThrough())
    expect(engine.modAgents.viewTarget?.('a1')).toBeUndefined()
    const own = engine.boundSessionId()
    setSubAgentController({
      list: (spawner: string) =>
        spawner === own
          ? [{ sessionId: 'a1', loopId: 'Explore_1a2b_x', status: 'running', description: 'scan', agentType: 'Explore', startedAt: 0 }]
          : [{ sessionId: 'a7', status: 'running', description: 'other', startedAt: 0 }],
    } as unknown as SubAgentController)
    setTeamMessenger({
      listMembers: (lead: string) =>
        lead === own ? [{ sessionId: 'teammate-1', name: 'alice', status: 'idle', startedAt: 0 }] : [{ sessionId: 'teammate-9', name: 'zed', status: 'idle', startedAt: 0 }],
    } as unknown as TeamMessenger)
    try {
      expect(engine.modAgents.viewTarget?.('a1')).toEqual({ kind: 'subagent', sessionId: 'a1' })
      expect(engine.modAgents.viewTarget?.('Explore_1a2b_x')).toEqual({ kind: 'subagent', sessionId: 'a1' })
      expect(engine.modAgents.viewTarget?.('teammate-1')).toEqual({ kind: 'teammate', sessionId: 'teammate-1' })
      expect(engine.modAgents.viewTarget?.('a2')).toBeUndefined()
      expect(engine.modAgents.viewTarget?.('a7')).toBeUndefined()
      expect(engine.modAgents.viewTarget?.('teammate-9')).toBeUndefined()
    } finally {
      setSubAgentController(null)
      setTeamMessenger(null)
    }
  })
})

describe('$.tool.register through the engine', () => {
  const spec = { name: 'create_issue', description: 'Files an issue.', inputSchema: { type: 'object' } }
  const realTool = declareTool({
    name: 'mcp__github__create_issue',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'the real server tool',
    call: async () => ({ data: 'real' }),
  }) as unknown as ToolContract

  it('a plugin named for an MCP server of the session cannot register in its namespace — its tools stay, its rules are not lent', async () => {
    const mcpClients: Array<{ name?: string }> = []
    const { engine } = makeEngine(undefined, true, undefined, [realTool], {}, { mcpClients })
    const names = async () => (await engine.modTools.list()).map(tool => tool.name)
    expect(() => engine.modTools.register!(spec, 'github')).toThrow(/names an MCP server of this session/)
    expect(await names()).toEqual(['mcp__github__create_issue'])
    // A configured server with no tool listed yet is refused the same way.
    mcpClients.push({ name: 'linear' })
    expect(() => engine.modTools.register!(spec, 'linear')).toThrow(/names an MCP server/)
    // Any other plugin name registers.
    expect(engine.modTools.register!(spec, 'tracker')).toBe('mcp__tracker__create_issue')
    expect(await names()).toEqual(['mcp__github__create_issue', 'mcp__tracker__create_issue'])
  })
})

describe('a tool registered at session.start is the first turn\'s', () => {
  it('the turn made before the mods settled takes the registered tool — listed to the model and run', async () => {
    let engine!: ConversationEngine
    const seenTools: string[][] = []
    const mods: Mods = {
      // `session.start` registering a tool while the first prompt waits for it.
      // It settles after the turn built its context, as a real one does.
      ready: new Promise<void>(resolve =>
        setTimeout(() => {
          engine.modTools.register!({ name: 'weather', description: 'Weather.', inputSchema: { type: 'object' } }, 'mod-weather')
          resolve()
        }, 30),
      ),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
    }
    const callModel = async function* (params: { callContext: { options: { tools: ToolContract[] } } }) {
      seenTools.push(params.callContext.options.tools.map(tool => tool.name))
      yield {
        type: MSG_TYPE_ASSISTANT,
        uuid: `assistant-${seenTools.length}`,
        message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'ok' }] },
      } as Message
    }
    engine = makeEngine(mods, true, undefined, [], { callModel }).engine
    await submit(engine, 'hello')
    expect(seenTools[0]).toContain('mcp__mod-weather__weather')
  })
})

describe('QueryEngine — $.session.messages / usage (modTranscript)', () => {
  const answered = async function* () {
    yield {
      type: MSG_TYPE_ASSISTANT,
      uuid: 'assistant-usage',
      timestamp: new Date().toISOString(),
      message: {
        role: ROLE_ASSISTANT,
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 40_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 1_000_000 },
      },
    } as Message
  }

  it('after a turn: the live rows, the input side of the last response over the window of the model it names, the priced cost', async () => {
    const { engine } = makeEngine(undefined, true, undefined, [], { callModel: answered })
    const before = engine.modTranscript.usage()
    expect(before.context.tokens).toBeUndefined()
    expect(before.cost).toBeUndefined()
    await submit(engine, 'hello')
    expect(engine.modTranscript.rows().map(row => row.type)).toEqual(engine.transcriptRows().map(m => m.type))
    const usage = engine.modTranscript.usage()
    // No model pinned: the window is the one of the model the response names.
    expect(usage.context).toEqual({ tokens: 50_000, window: contextWindowOf('claude-sonnet-5'), percent: 5 })
    expect(usage.rateLimits).toEqual([])
    // Sonnet at $3 in / $15 out / $0.30 cache read per million.
    expect(usage.cost?.usd).toBeCloseTo(0.12 + 15 + 0.003, 6)
    expect(usage.startedAt).toBeLessThanOrEqual(Date.now())
  })

  it("an agent id the session did not spawn is denied, naming it", async () => {
    const { engine } = makeEngine(undefined)
    await expect(engine.modTranscript.agentRows('subagent-x')).resolves.toEqual({
      deny: "agent subagent-x: not one of this session's agents",
    })
  })
})

describe('QueryEngine — $.session.compact / send / append (modConversation)', () => {
  const raise = { context: { ...ROOT_DISPATCH_CONTEXT, origin: { plugin: 'lab', tier: 'user' as const } } }

  function compactDeps(forced: Array<string | undefined>, answer: 'ok' | 'error' = 'ok') {
    return {
      forceCompact: async (params: { messages: Message[]; customInstructions?: string }) => {
        forced.push(params.customInstructions)
        if (answer === 'error') return { error: 'the summarizer came back empty' }
        return {
          boundaryMarker: { type: 'system', uuid: 'b1', subtype: 'compact_boundary', message: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 10 } } as Message,
          summaryMessages: [{ type: 'user', uuid: 'sum1', isMeta: true, message: { role: 'user', content: 'SUMMARY' } } as Message],
        }
      },
    }
  }

  function baseMods(extra: Partial<Mods> = {}): Mods {
    return { ready: Promise.resolve(), promptSubmit: async text => ({ entered: true, text, context: [] }), ...extra }
  }

  it("compact between turns: the event with trigger plugin and the caller's context, then the conversation replaced and republished", async () => {
    const forced: Array<string | undefined> = []
    const seen: unknown[] = []
    const mods = baseMods({
      sessionCompact: async (input, core, _signal, context) => {
        seen.push({ trigger: input.trigger, instructions: input.instructions, rows: input.messages.length, plugin: context?.origin.plugin })
        return core.run({ instructions: input.instructions, messages: [...input.messages] })
      },
    })
    const { engine } = makeEngine(mods, true, undefined, [], compactDeps(forced))
    let rewritten = 0
    engine.setConversationRewrittenListener(() => {
      rewritten += 1
    })
    await submit(engine, 'hello')
    const answer = await engine.modConversation.compact({ instructions: 'the plan' }, raise)
    expect(seen).toEqual([{ trigger: 'plugin', instructions: 'the plan', rows: 2, plugin: 'lab' }])
    expect(forced).toEqual(['the plan'])
    expect(answer).toEqual({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }], tokensBefore: 10 })
    // Appended after the history, never in its place: the page keeps every row.
    expect(engine.transcriptRows().map(m => m.uuid).slice(-2)).toEqual(['b1', 'sum1'])
    expect(engine.transcriptRows().map(m => m.uuid)).toContain('u1')
    expect(rewritten).toBe(1)
  })

  it("compact: nothing to compact is a skip; a hook's skip is the answer and its notice is kept; a failed summary rejects with the reason", async () => {
    const forced: Array<string | undefined> = []
    const { engine } = makeEngine(baseMods({ sessionCompact: async () => ({ skip: 'not now' }) }), true, undefined, [], compactDeps(forced))
    await expect(engine.modConversation.compact({}, raise)).resolves.toEqual({ skip: 'the conversation has no messages to compact' })
    await submit(engine, 'hello')
    const before = engine.transcriptRows().length
    await expect(engine.modConversation.compact({}, raise)).resolves.toEqual({ skip: 'not now' })
    expect(engine.transcriptRows().length).toBe(before + 1)
    expect(forced).toEqual([])

    const failing = makeEngine(undefined, true, undefined, [], compactDeps(forced, 'error')).engine
    await submit(failing, 'hello')
    await expect(failing.modConversation.compact({}, raise)).rejects.toThrow('$.session.compact: the summarizer came back empty')
    expect(String((failing.transcriptRows().at(-1) as { message?: unknown }).message)).toContain('the summarizer came back empty')
  })

  it('compact and append reject while a model turn runs, naming it', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let calls = 0
    const callModel = async function* () {
      calls += 1
      await gate
      yield { type: MSG_TYPE_ASSISTANT, uuid: 'a-gated', message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'ok' }] } } as Message
    }
    const { engine } = makeEngine(baseMods(), true, undefined, [], { callModel, ...compactDeps([]) })
    const running = submit(engine, 'hello')
    while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1))
    const note = { message: { type: 'user' as const, content: [{ type: 'text', text: 'n' }] } }
    await expect(engine.modConversation.compact({}, raise)).rejects.toThrow(/cannot run while a model turn runs/)
    await expect(engine.modConversation.append(note, raise)).rejects.toMatchObject({ name: 'InvalidStateError' })
    release()
    await running
    await expect(engine.modConversation.append(note, raise)).resolves.toMatchObject({ uuid: expect.any(String) })
  })

  it('append: a meta user row or a notice through appendNote, kept and republished; a deny stores nothing; other blocks and an agentId are refused', async () => {
    const notes: unknown[] = []
    const mods = baseMods({
      appendNote: async (row, r) => {
        notes.push({ type: row.type, plugin: r.context.origin.plugin })
        return JSON.stringify(row).includes('secret') ? { deny: 'no secrets' } : { row }
      },
    })
    const { engine } = makeEngine(mods)
    let rewritten = 0
    engine.setConversationRewrittenListener(() => {
      rewritten += 1
    })
    const kept = await engine.modConversation.append({ message: { type: 'user', content: [{ type: 'text', text: 'remember' }] } }, raise)
    expect(kept).toMatchObject({ message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'remember' }] } })
    const notice = await engine.modConversation.append({ message: { type: 'system', content: [{ type: 'text', text: 'a notice' }] } }, raise)
    expect(notice).toMatchObject({ message: { type: 'system', content: [{ type: 'text', text: 'a notice' }] } })
    await expect(
      engine.modConversation.append({ message: { type: 'user', content: [{ type: 'text', text: 'secret' }] } }, raise),
    ).resolves.toEqual({ deny: 'no secrets' })
    expect(engine.transcriptRows().map(m => [m.type, (m as { isMeta?: boolean }).isMeta === true])).toEqual([
      ['user', true],
      ['system', false],
    ])
    expect(notes).toEqual([
      { type: 'user', plugin: 'lab' },
      { type: 'system', plugin: 'lab' },
      { type: 'user', plugin: 'lab' },
    ])
    expect(rewritten).toBe(2)
    await expect(
      engine.modConversation.append({ message: { type: 'user', content: [{ type: 'image', source: {} }] } }, raise),
    ).rejects.toThrow('$.session.append: message.content holds a image block: text blocks alone')
    await expect(
      engine.modConversation.append({ message: { type: 'user', content: [{ type: 'text', text: 'x' }] }, agentId: 'subagent-1' }, raise),
    ).rejects.toMatchObject({ name: 'NotSupportedError' })
  })

  it("send: the SendMessage delivery, origin the plugin, an { agentId } spelled as the teammate's name; no messenger is not delivered", async () => {
    const { engine: lone } = makeEngine(undefined)
    await expect(lone.modConversation.send({ to: 'alice', text: 'hi' }, raise)).resolves.toEqual({
      isDelivered: false,
      reason: 'messaging is unavailable: not running inside the team runtime',
    })

    const delivered: unknown[] = []
    const messenger: TeamMessenger = {
      deliver: args => {
        delivered.push({ to: args.to, from: args.from, body: args.body })
        return args.to === 'alice' ? { ok: true } : { ok: false, reason: `no member ${args.to}` }
      },
      shutdownMember: () => ({ ok: true }),
      listMembers: () => [{ sessionId: 'teammate-1', name: 'alice', status: 'idle', startedAt: 0 }],
    }
    const sends: unknown[] = []
    const mods = baseMods({
      hasSessionSendHooks: () => true,
      sessionSend: async (input, core, _signal, context) => {
        sends.push({ to: input.to, origin: input.origin, plugin: context?.origin.plugin })
        return core({ to: input.to, text: input.text })
      },
    })
    const { engine } = makeEngine(mods)
    setTeamMessenger(messenger)
    try {
      await expect(
        engine.modConversation.send({ to: { agentId: 'teammate-1' }, text: 'stop after this file' }, raise),
      ).resolves.toEqual({ isDelivered: true })
      await expect(engine.modConversation.send({ to: { sessionId: 'teammate-9' }, text: 'hi' }, raise)).resolves.toEqual({
        isDelivered: false,
        reason: 'no member teammate-9',
      })
    } finally {
      setTeamMessenger(null)
    }
    expect(sends).toEqual([
      { to: 'alice', origin: { kind: 'plugin', name: 'lab' }, plugin: 'lab' },
      { to: 'teammate-9', origin: { kind: 'plugin', name: 'lab' }, plugin: 'lab' },
    ])
    expect(delivered[0]).toEqual({ to: 'alice', from: 'team-lead', body: 'stop after this file' })
  })
})

describe('QueryEngine — $.prompt.submit / compose (modPrompt)', () => {
  const raise = { context: { ...ROOT_DISPATCH_CONTEXT, origin: { plugin: 'lab', tier: 'user' as const } } }

  it('a plugin turn enters framed with the context the chain attached, stamped with the plugin, and is not raised again', async () => {
    const { mods, seen } = fakeMods(text => ({ entered: true, text, context: [] }))
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'run the tests', { uuid: 'p1', plugin: { text: 'run the tests', context: ['PLUGIN_CONTEXT'], plugin: 'lab' } })
    expect(seen).toEqual([])
    expect(userRows(modelCalls[0]!)).toEqual([
      ['The lab plugin sent a message: run the tests', false],
      [[{ type: 'text', text: 'PLUGIN_CONTEXT' }], true],
    ])
    const row = engine.transcriptRows().find(m => m.uuid === 'p1') as { pluginPrompt?: unknown }
    expect(row.pluginPrompt).toEqual({ plugin: 'lab' })
  })

  it('asUser: the model reads the text bare; the row still names the plugin', async () => {
    const { mods } = fakeMods(text => ({ entered: true, text, context: [] }))
    const { engine, modelCalls } = makeEngine(mods)
    await submit(engine, 'as typed', { uuid: 'p2', plugin: { text: 'as typed', context: [], plugin: 'lab', asUser: true } })
    expect(userRows(modelCalls[0]!)).toEqual([['as typed', false]])
    const row = engine.transcriptRows().find(m => m.uuid === 'p2') as { pluginPrompt?: unknown }
    expect(row.pluginPrompt).toEqual({ plugin: 'lab', asUser: true })
  })

  it("compose: the engine's sections, the session's prompt hooks not run, prompt.compose with the caller's context; nothing is stored", async () => {
    const calls: string[] = []
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasPromptHooks: () => true,
      promptSections: async sections => {
        calls.push('sections')
        return [...sections]
      },
      promptContext: async input => {
        calls.push('context')
        return { blocks: [...input.blocks] }
      },
      promptCompose: async (input, sections, _signal, context) => {
        calls.push(`compose ${input.model} ${context?.origin.plugin}`)
        return [...sections, { id: 'lab:note', text: 'A note.', scope: 'session' as const }]
      },
    }
    const { engine } = makeEngine(mods)
    const before = engine.transcriptRows().length
    const { sections } = await engine.modPrompt.compose({ model: 'compose-test' }, raise)
    expect(calls).toEqual(['compose compose-test lab'])
    expect(sections.at(-1)).toEqual({ id: 'lab:note', text: 'A note.', scope: 'session' })
    expect(sections.length).toBeGreaterThan(1)
    expect(engine.transcriptRows().length).toBe(before)

    const { engine: plain } = makeEngine(undefined)
    const own = await plain.modPrompt.compose({}, raise)
    expect(own.sections.length).toBeGreaterThan(0)
    expect(own.sections.every(section => typeof section.id === 'string' && section.id !== '')).toBe(true)
  })
})

describe('QueryEngine — a slash command\'s output rows name it (CommandOutput)', () => {
  /** A pipeline answering every input with an echo and one informational row. */
  function printing(text: string): UserInputPipeline {
    return {
      processUserInput: async params => ({
        messages: [
          { type: 'user', uuid: 'echo', timestamp: 't', message: { role: 'user', content: params.input } } as unknown as Message,
          { type: 'system', uuid: 'out', timestamp: 't', message: text, subtype: 'informational' } as unknown as Message,
          { type: 'system', uuid: 'note', timestamp: 't', message: 'x', subtype: 'api_error' } as unknown as Message,
        ],
        shouldQuery: false,
      }),
    }
  }
  function stamps(messages: readonly Message[]): unknown[] {
    return messages
      .filter(m => m.type === 'system')
      .map(m => (m as { slashCommand?: unknown }).slashCommand)
  }

  it('a typed /command stamps its informational rows with the name and the args as typed', async () => {
    const { engine } = makeEngine(undefined, false, printing('status: idle'))
    await submit(engine, '/status  now please ')
    expect(stamps(engine.transcriptRows())).toEqual([{ name: 'status', args: 'now please' }, undefined])
  })

  it('a hook\'s rewritten args run the command, and the row still names the args as typed', async () => {
    const mods: Mods = {
      ready: Promise.resolve(),
      promptSubmit: async text => ({ entered: true, text, context: [] }),
      hasCommandRunHooks: () => true,
      registeredCommand: () => undefined,
      commandRun: async (input, core) => {
        const ran = await core!(`${input.args} --verbose`, new AbortController().signal)
        return { settled: true, result: { ...ran, ref: 1, text: 'REPLACED' }, unanswered: false }
      },
    }
    const { engine } = makeEngine(mods, false, printing('status: idle'))
    await submit(engine, '/status now')
    const rows = engine.transcriptRows().filter(m => m.type === 'system' && (m as { message?: unknown }).message === 'REPLACED')
    expect(rows.map(m => (m as { slashCommand?: unknown }).slashCommand)).toEqual([{ name: 'status', args: 'now' }])
  })

  it('a plain prompt stamps nothing', async () => {
    const { engine } = makeEngine(undefined, false, printing('a note'))
    await submit(engine, 'hello there')
    expect(stamps(engine.transcriptRows()).every(stamp => stamp === undefined)).toBe(true)
  })
})
