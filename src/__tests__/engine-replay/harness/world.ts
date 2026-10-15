import { ConversationEngine, type ConversationEngineConfig } from '../../../engine/conversationEngine'
import { runTurnLoop } from '../../../engine/turnInterpreter'
import { assembleTurnDependencies } from '../../../engine/turn/turnDependencies'
import type { QueryRuntimeDeps } from '../../../runtime/interfaces/QueryRuntimeDeps'
import type { UserInputPipeline } from '../../../runtime/interfaces/UserInputPipeline'
import type { WorkingState, Message, QueryTerminal } from '../../../runtime/RuntimeTypes'
import {
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  createEmptyAppState,
  createMemoryFileStateCache,
  createNoopToolUseContext,
} from '../../../runtime/testing/noopAdapters'
import { attachTransientHook } from '../../../lifecycleHooks/sessionScopedHooks'
import type { LifecycleEventName } from '../../../lifecycleHooks/hookTypes'
import type { ToolContract } from '../../../toolkit/toolContract'
import type { ToolCallContext } from '../../../toolkit/toolCallContext'
import { FakeModelBridge, type ScriptedReply } from './modelBridge'
import { fakeHost, type HookAnswer } from './host'
import { fakeMods, type FakeMods, type ModScript } from './mods'
import { ReplayRuntimeConfig } from './runtime'
import { RecordingStore } from './store'
import { SlashPipeline } from './pipeline'
import { RetryClock } from './timers'
import { memoryFs } from './fs'
import { collectQueuedAttachmentMessages } from '../../../messages/contextAttachments'
import { createBrowserAutoCompact, performCompaction } from '../../../context/compaction/autoTrigger'
import { installProcessFs, resetProcessFs } from '../../../utils/fs/runtimeFs'
import { ToolActivity, fakeTool, type FakeToolSpec } from './tools'
import { TraceRecorder, summarizeMessage, toJson, type Trace } from './trace'

export const SESSION_ID = 'session-replay'

/** The permission decider: what the queued confirmation dialog answers. */
export type ConfirmAnswer = 'allow' | 'reject' | 'abort'

export type WorldOptions = {
  replies: ScriptedReply[]
  tools?: FakeToolSpec[]
  /** Real tools offered beside the fakes (e.g. the plan-mode exit). */
  extraTools?: ToolContract[]
  /** Lifecycle hook commands registered for the session, by event. */
  hooks?: Array<{ event: LifecycleEventName; matcher?: string }>
  hookAnswers?: Partial<Record<string, HookAnswer>>
  /** An extension runtime with these scripted answers (absent: none). */
  mods?: ModScript
  /** The queued confirmation dialog; absent, an ask halts on a pending entry. */
  confirm?: (toolName: string, input: Record<string, unknown>) => ConfirmAnswer
  /** Permission mode and settings rule lists. */
  permissionMode?: string
  ruleLists?: { allow: string[]; deny: string[]; ask: string[] }
  /** No prompt may be shown (a headless session). */
  headless?: boolean
  env?: Record<string, string>
  maxTurns?: number
  /** Overrides for the loop's deps (compaction, queued input, stop hooks…). */
  deps?: Partial<QueryRuntimeDeps>
  /** The user input layer; default: typed prompts enter, built-in commands run. */
  pipeline?: (runtimeConfig: ReplayRuntimeConfig, recorder: TraceRecorder) => UserInputPipeline
  config?: Partial<ConversationEngineConfig>
  /** The production compaction over the scripted model: automatic once the
   *  live context reaches `threshold` tokens, and `/compact`. The summarizer
   *  requests carry no query source. */
  compaction?: { threshold: number; enabled?: boolean }
  /** What arrives while a turn runs, drained between rounds as the runtime
   *  drains it: background-task notifications, teammate messages and typed
   *  input. Each drain sees the round number it is called in. */
  queued?: {
    taskNotifications?: (round: number, includeLater: boolean) => { prompt: string; enqueuedAt: number } | null
    teamMessages?: (round: number) => Array<{ prompt: string; enqueuedAt: number }>
    typed?: (round: number) => Array<{ uuid: string; prompt: string; enqueuedAt: number }>
  }
  /** Install an in-memory process fs for the run (tools that save files). */
  memoryFs?: boolean
  /** Runs when the retry ladder decides a retry, before the backoff. */
  onRetry?: () => void
}

type Parts = {
  recorder: TraceRecorder
  bridge: FakeModelBridge
  runtimeConfig: ReplayRuntimeConfig
  activity: ToolActivity
  tools: ToolContract[]
  host: ReturnType<typeof fakeHost>
  clock: RetryClock
  appState: { get: () => WorkingState; set: (f: (prev: WorkingState) => WorkingState) => void }
  deps: QueryRuntimeDeps
}

function parts(options: WorldOptions): Parts {
  const recorder = new TraceRecorder()
  const runtimeConfig = new ReplayRuntimeConfig(options.env)
  const bridge = new FakeModelBridge(options.replies, recorder)
  const activity = new ToolActivity(recorder)
  const tools = [...(options.tools ?? []).map(spec => fakeTool(spec, activity, recorder)), ...(options.extraTools ?? [])]
  const host = fakeHost(recorder, options.hookAnswers)
  const clock = new RetryClock(recorder, options.onRetry)
  let drainRound = 0
  if (options.memoryFs) installProcessFs(memoryFs(recorder))
  let state: WorkingState = createEmptyAppState()
  state = {
    ...state,
    permissionRules: {
      ...state.permissionRules,
      mode: options.permissionMode ?? 'default',
      ...(options.ruleLists ? { ruleLists: options.ruleLists } : {}),
      ...(options.headless ? { suppressAsks: true } : {}),
    } as WorkingState['permissionRules'],
  }
  const appState = {
    get: () => state,
    set: (f: (prev: WorkingState) => WorkingState) => {
      state = f(state)
    },
  }
  for (const hook of options.hooks ?? []) {
    attachTransientHook(appState.set, SESSION_ID, hook.event, hook.matcher ?? '', {
      type: 'command',
      command: `hook ${hook.event}`,
    })
  }
  const deps = assembleTurnDependencies(
    runtimeConfig,
    {
      ...(options.compaction
        ? {
            autocompact: createBrowserAutoCompact(bridge as never, runtimeConfig, {
              autoCompactTokenThreshold: options.compaction.threshold,
              ...(options.compaction.enabled === false ? { enabled: false } : {}),
            }),
            forceCompact: ({ messages, mainLoopModel, customInstructions, providerId }) =>
              performCompaction({
                messages,
                bridgeTransport: bridge as never,
                runtimeConfig,
                mainLoopModel,
                providerId,
                trigger: 'manual',
                customInstructions,
                // Who compacts, as createAgentRuntime wires it.
                requester: { sessionId: SESSION_ID },
              }),
          }
        : {}),
      ...(options.deps ?? {}),
    },
    {
      bridgeTransport: bridge as never,
      runtimeConfig,
      traceLogger: clock.traceLogger,
      // The between-round drain, as the runtime wires it.
      queuedAttachmentProvider: params => {
        drainRound += 1
        const round = drainRound
        const queued = options.queued
        recorder.note({ drain: round, querySource: params.querySource })
        return collectQueuedAttachmentMessages({
          messages: params.messages,
          toolUseContext: params.toolUseContext,
          runtimeConfig,
          assistantMessages: params.assistantMessages,
          querySource: params.querySource,
          sessionId: SESSION_ID,
          ...(queued?.taskNotifications
            ? { drainTaskNotifications: (_id: string, opts: { includeLater: boolean }) => queued.taskNotifications!(round, opts.includeLater) }
            : {}),
          ...(queued?.teamMessages ? { drainTeamMessages: () => queued.teamMessages!(round) } : {}),
          ...(queued?.typed ? { drainInjectMessages: () => queued.typed!(round) } : {}),
        })
      },
    },
  )
  return { recorder, bridge, runtimeConfig, activity, tools, host, clock, appState, deps }
}

function recordConfirm(p: Parts, options: WorldOptions) {
  if (!options.confirm) return undefined
  const confirm = options.confirm
  return (async (item: { toolName: string; input: Record<string, unknown>; approvalCallId: string; permissionResult?: { message?: string } }) => {
    const behavior = confirm(item.toolName, item.input)
    p.recorder.trace.permissions.push({
      step: 'confirm',
      tool: item.toolName,
      toolUseID: item.approvalCallId,
      message: item.permissionResult?.message,
      behavior,
    })
    return { approvalCallId: item.approvalCallId, behavior }
  }) as never
}

function finishTrace(p: Parts): Trace {
  const problems = [...p.bridge.exhausted, ...p.bridge.leftover().map(l => `reply "${l}" was never requested`)]
  if (problems.length > 0) throw new Error(`model script mismatch:\n${problems.join('\n')}`)
  return p.recorder.trace
}

function release(p: Parts): void {
  p.clock.uninstall()
  resetProcessFs()
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

// ── The engine (Loop 1 and below) ───────────────────────────────────────

export type EngineWorld = {
  engine: ConversationEngine
  store: RecordingStore
  mods?: FakeMods
  recorder: TraceRecorder
  appState: Parts['appState']
  /** Submits one prompt and records every yielded message. */
  submit(prompt: unknown, options?: Record<string, unknown>): Promise<void>
  /** Lets fire-and-forget work settle, then returns the trace. */
  finish(): Promise<Trace>
  dispose(): void
}

export function engineWorld(options: WorldOptions): EngineWorld {
  const p = parts(options)
  const store = new RecordingStore(SESSION_ID, p.recorder)
  const mods = options.mods ? fakeMods(p.recorder, options.mods) : undefined
  const pipeline = options.pipeline?.(p.runtimeConfig, p.recorder) ?? new SlashPipeline(p.runtimeConfig, p.recorder)
  const engine = new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: p.tools,
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: p.appState.get,
    writeAppState: p.appState.set,
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: p.host,
    queryRuntimeDeps: p.deps,
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: store,
    userInputPipeline: pipeline,
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig: p.runtimeConfig,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.confirm ? { requestToolUseConfirm: recordConfirm(p, options) } : {}),
    ...(mods ? { mods: mods as unknown as ConversationEngineConfig['mods'] } : {}),
    ...(options.config ?? {}),
  })
  p.clock.install()
  return {
    engine,
    store,
    mods,
    recorder: p.recorder,
    appState: p.appState,
    async submit(prompt, submitOptions) {
      const turn: unknown[] = []
      p.recorder.trace.emitted.push({ submit: toJson(prompt) })
      for await (const message of engine.submitTurn(prompt as never, { uuid: `prompt-${p.recorder.trace.emitted.length}`, ...submitOptions } as never)) {
        const summary = summarizeMessage(message)
        turn.push(summary)
        p.recorder.trace.emitted.push(summary)
        const m = message as { type?: string; subtype?: string }
        if (m.type === 'result') p.recorder.trace.terminal = { result: m.subtype, terminal: toJson((message as { terminal?: unknown }).terminal) }
      }
    },
    async finish() {
      await settle()
      release(p)
      return finishTrace(p)
    },
    dispose() {
      release(p)
    },
  }
}

// ── The request loop alone (Loop 2 and below) ───────────────────────────

export type LoopWorld = {
  recorder: TraceRecorder
  context: ToolCallContext
  appState: Parts['appState']
  run(params?: {
    messages?: Message[]
    maxTurns?: number
    querySource?: string
    refreshPromptContext?: Parameters<typeof runTurnLoop>[0]['refreshPromptContext']
  }): Promise<Trace>
  dispose(): void
}

export function loopWorld(options: WorldOptions): LoopWorld {
  const p = parts(options)
  const context = createNoopToolUseContext({
    tools: p.tools,
    platformCapabilities: p.host,
    appState: p.appState.get(),
    setAppState: p.appState.set,
    sessionId: SESSION_ID,
    cwd: '/workspace',
    projectRoot: '/workspace',
  })
  context.readAppState = p.appState.get
  context.writeAppState = p.appState.set
  const confirm = recordConfirm(p, options)
  if (confirm) context.requestToolUseConfirm = confirm
  p.clock.install()
  return {
    recorder: p.recorder,
    context,
    appState: p.appState,
    async run(params = {}) {
      const generator = runTurnLoop({
        messages: params.messages ?? [
          { type: 'user', uuid: 'prompt-1', message: { role: 'user', content: 'start' } } as Message,
        ],
        baseInstructions: ['You are a test agent.'] as never,
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: context,
        turnCaller: params.querySource ?? 'sdk',
        ...(params.maxTurns ?? options.maxTurns ? { stepLimit: params.maxTurns ?? options.maxTurns } : {}),
        ...(params.refreshPromptContext ? { refreshPromptContext: params.refreshPromptContext } : {}),
        runtimeConfig: p.runtimeConfig,
        deps: p.deps,
      })
      try {
        while (true) {
          const next = await generator.next()
          if (next.done) {
            p.recorder.trace.terminal = toJson(next.value as QueryTerminal)
            break
          }
          p.recorder.trace.emitted.push(summarizeMessage(next.value))
        }
      } finally {
        await settle(3)
        release(p)
      }
      return finishTrace(p)
    },
    dispose() {
      release(p)
    },
  }
}
