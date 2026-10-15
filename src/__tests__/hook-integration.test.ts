import { afterEach, describe, expect, it } from 'vitest'
import type { WorkingState, ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import { declareTool } from '../toolkit/toolContract'
import { executeToolCall } from '../toolkit/run/executeToolCall'
import { runToolBatch } from '../toolkit/run/toolBatchRunner'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { attachInProcessHook } from '../lifecycleHooks/sessionScopedHooks'
import { ExitPlanModeTool } from '../toolkit/builtin/planExit'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'

const RUNTIME_DEPS = { uuid: () => 'test-uuid' } as QueryRuntimeDeps

function makeAssistantMessage(toolName: string, toolCallId: string): ModelReplyRow {
  return {
    type: 'assistant',
    uuid: `assistant-${toolCallId}`,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId,
          toolName,
          args: {},
        },
      ],
    },
  }
}

function makeContext(sessionId: string) {
  let appState: WorkingState = createEmptyAppState()
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const tool = declareTool({
    name: 'EchoTool',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'Echo tool',
    call: async () => ({ data: { ok: true, called: true } }),
    readsOnly: () => true,
  })
  const context = createNoopToolUseContext({
    tools: [tool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState,
    sessionId,
  })
  // Wire setAppState through so the executor's once-removal path can mutate.
  context.writeAppState = setAppState
  // Also wire a fresh getAppState that reflects the latest state.
  context.readAppState = () => appState
  return { context, setAppState, tool, getAppState: () => appState }
}

describe('PreToolUse hook integration through runToolUse', () => {
  it('blocks the tool call when a function hook returns false', async () => {
    const { context, setAppState } = makeContext('sess-block')
    attachInProcessHook(
      setAppState,
      'sess-block',
      'PreToolUse',
      'EchoTool',
      () => false,
      'EchoTool is off-limits for this skill',
    )
    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-1',
        toolName: 'EchoTool',
        args: {},
      },
      makeAssistantMessage('EchoTool', 'tc-1'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    expect(updates).toHaveLength(1)
    const result = updates[0]!.message?.toolUseResult as string
    expect(result).toContain('Hook blocked')
    expect(result).toContain('EchoTool is off-limits for this skill')
  })

  it('does not invoke tool.call when a hook blocks', async () => {
    let called = false
    let appState: WorkingState = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const tool = declareTool({
      name: 'EchoTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Echo tool',
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
      readsOnly: () => true,
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-no-call',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    attachInProcessHook(
      setAppState,
      'sess-no-call',
      'PreToolUse',
      'EchoTool',
      () => false,
      'denied',
    )
    for await (const _ of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-2',
        toolName: 'EchoTool',
        args: {},
      },
      makeAssistantMessage('EchoTool', 'tc-2'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      // drain
    }
    expect(called).toBe(false)
  })

  it('lets the tool run when the hook returns true', async () => {
    const { context, setAppState } = makeContext('sess-pass')
    attachInProcessHook(
      setAppState,
      'sess-pass',
      'PreToolUse',
      'EchoTool',
      () => true,
      'never',
    )
    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-3',
        toolName: 'EchoTool',
        args: {},
      },
      makeAssistantMessage('EchoTool', 'tc-3'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    const result = updates[0]!.message?.toolUseResult as string
    expect(result).not.toContain('Hook blocked')
    // Tool returned `{ ok: true, called: true }` which serializes to JSON.
    expect(result).toContain('"called":true')
  })

  it('skips hooks whose matcher does not apply to this tool', async () => {
    const { context, setAppState } = makeContext('sess-skip')
    attachInProcessHook(
      setAppState,
      'sess-skip',
      'PreToolUse',
      'OtherTool',
      () => false,
      'denied',
    )
    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-4',
        toolName: 'EchoTool',
        args: {},
      },
      makeAssistantMessage('EchoTool', 'tc-4'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    const result = updates[0]!.message?.toolUseResult as string
    expect(result).not.toContain('Hook blocked')
    expect(result).toContain('"called":true')
  })
})

describe('PostToolUse hook integration through runToolUse', () => {
  it('appends a hook-block follow-up after a blocked PostToolUse', async () => {
    const { context, setAppState } = makeContext('sess-post-block')
    attachInProcessHook(
      setAppState,
      'sess-post-block',
      'PostToolUse',
      'EchoTool',
      () => false,
      'Echo result failed policy check',
    )
    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-5',
        toolName: 'EchoTool',
        args: {},
      },
      makeAssistantMessage('EchoTool', 'tc-5'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    // First update: the actual tool_result. Second: the PostToolUse
    // hook-block follow-up message.
    expect(updates).toHaveLength(2)
    const toolResult = updates[0]!.message?.toolUseResult as string
    expect(toolResult).toContain('"called":true')
    expect(toolResult).not.toContain('Hook blocked')
    const followUp = updates[1]!.message
    expect(followUp?.type).toBe('user')
    const followUpText =
      typeof followUp?.message === 'object' &&
      followUp.message !== null &&
      'content' in followUp.message
        ? (followUp.message as { content: string }).content
        : ''
    expect(followUpText).toContain('PostToolUse hook blocked: EchoTool')
    expect(followUpText).toContain('Echo result failed policy check')
  })

  it('does not append a follow-up when PostToolUse hook passes', async () => {
    const { context, setAppState } = makeContext('sess-post-pass')
    attachInProcessHook(
      setAppState,
      'sess-post-pass',
      'PostToolUse',
      'EchoTool',
      () => true,
      'never',
    )
    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-6',
        toolName: 'EchoTool',
        args: {},
      },
      makeAssistantMessage('EchoTool', 'tc-6'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    expect(updates).toHaveLength(1)
  })

  it('still fires PostToolUse when the tool call succeeded', async () => {
    let postFired = false
    const { context, setAppState } = makeContext('sess-post-fired')
    attachInProcessHook(
      setAppState,
      'sess-post-fired',
      'PostToolUse',
      'EchoTool',
      () => {
        postFired = true
        return true
      },
      'never',
    )
    for await (const _ of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-7',
        toolName: 'EchoTool',
        args: {},
      },
      makeAssistantMessage('EchoTool', 'tc-7'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      // drain
    }
    expect(postFired).toBe(true)
  })
})

describe('PostToolUseFailure hook integration through runToolUse', () => {
  function makeThrowingContext(sessionId: string) {
    let appState: WorkingState = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const tool = declareTool({
      name: 'BoomTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Always throws',
      call: async () => {
        throw new Error('synthetic tool failure')
      },
      readsOnly: () => true,
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId,
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    return { context, setAppState }
  }

  it('appends a follow-up user message when a PostToolUseFailure hook blocks', async () => {
    const { context, setAppState } = makeThrowingContext('sess-fail-block')
    attachInProcessHook(
      setAppState,
      'sess-fail-block',
      'PostToolUseFailure',
      'BoomTool',
      () => false,
      'Failure flagged by hook',
    )
    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-8',
        toolName: 'BoomTool',
        args: {},
      },
      makeAssistantMessage('BoomTool', 'tc-8'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    // Update 0: the original tool execution error result. Update 1:
    // the PostToolUseFailure follow-up.
    expect(updates).toHaveLength(2)
    const errResult = updates[0]!.message?.toolUseResult as string
    expect(errResult).toContain('Tool execution error: synthetic tool failure')
    const followUp = updates[1]!.message
    expect(followUp?.type).toBe('user')
    const followUpText =
      typeof followUp?.message === 'object' &&
      followUp.message !== null &&
      'content' in followUp.message
        ? (followUp.message as { content: string }).content
        : ''
    expect(followUpText).toContain('PostToolUseFailure hook blocked: BoomTool')
    expect(followUpText).toContain('Failure flagged by hook')
  })

  it('runs PostToolUseFailure hook even when nothing blocks', async () => {
    let fired = false
    const { context, setAppState } = makeThrowingContext('sess-fail-pass')
    attachInProcessHook(
      setAppState,
      'sess-fail-pass',
      'PostToolUseFailure',
      'BoomTool',
      () => {
        fired = true
        return true
      },
      'never',
    )
    const updates = []
    for await (const update of executeToolCall(
      {
        type: 'tool-call',
        toolCallId: 'tc-9',
        toolName: 'BoomTool',
        args: {},
      },
      makeAssistantMessage('BoomTool', 'tc-9'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    expect(fired).toBe(true)
    expect(updates).toHaveLength(1)
  })
})

describe('plan-mode hard gate through runToolUse', () => {
  function makePlanModeContext(toolName: string, isReadOnly: boolean) {
    let called = false
    let appState: WorkingState = createEmptyAppState()
    // Enter plan mode.
    appState = {
      ...appState,
      permissionRules: {
        ...appState.permissionRules,
        mode: 'plan',
      },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const tool = declareTool({
      name: toolName,
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'tool',
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
      readsOnly: () => isReadOnly,
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-plan',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    return { context, wasCalled: () => called }
  }

  async function drain(context: ReturnType<typeof makePlanModeContext>['context'], toolName: string) {
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-plan', toolName, args: {} },
      makeAssistantMessage(toolName, 'tc-plan'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    return updates
  }

  it('denies a non-read-only tool in plan mode and never calls it', async () => {
    const { context, wasCalled } = makePlanModeContext('WriteyTool', false)
    const updates = await drain(context, 'WriteyTool')
    expect(wasCalled()).toBe(false)
    expect(updates).toHaveLength(1)
    const result = updates[0]!.message?.toolUseResult as string
    expect(result).toContain('Plan mode')
    expect(result).toContain('ExitPlanMode')
  })

  it('lets a read-only tool run in plan mode', async () => {
    const { context, wasCalled } = makePlanModeContext('ReadyTool', true)
    await drain(context, 'ReadyTool')
    expect(wasCalled()).toBe(true)
  })
})

describe('rule-based permission gate through runToolUse', () => {
  function makeRuleContext(
    ruleLists: { allow: string[]; deny: string[]; ask: string[] },
  ) {
    let called = false
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: { ...appState.permissionRules, ruleLists },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const tool = declareTool({
      name: 'EchoTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'echo',
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
      readsOnly: () => false,
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-rule',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    return { context, wasCalled: () => called }
  }

  async function drainEcho(context: ReturnType<typeof makeRuleContext>['context']) {
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-rule', toolName: 'EchoTool', args: {} },
      makeAssistantMessage('EchoTool', 'tc-rule'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    return updates
  }

  it('denies a tool matched by a deny rule and never calls it', async () => {
    const { context, wasCalled } = makeRuleContext({ allow: [], deny: ['EchoTool'], ask: [] })
    const updates = await drainEcho(context)
    expect(wasCalled()).toBe(false)
    expect(updates[0]!.message?.toolUseResult as string).toContain('Permission denied by rule')
  })

  it('CRITICAL: empty rule lists leave the tool running (no behavior change)', async () => {
    const { context, wasCalled } = makeRuleContext({ allow: [], deny: [], ask: [] })
    await drainEcho(context)
    expect(wasCalled()).toBe(true)
  })

  it('an ask rule halts the tool (pendingToolUse) and records a pending permission', async () => {
    const { context, wasCalled } = makeRuleContext({ allow: [], deny: [], ask: ['EchoTool'] })
    const updates = await drainEcho(context)
    // The tool never runs; the loop yields a pendingToolUse so it halts in
    // awaiting-user (the banner then resolves it).
    expect(wasCalled()).toBe(false)
    expect(updates[0]!.pendingToolUse?.toolName).toBe('EchoTool')
    // A pending-permission entry was recorded for the banner.
    const pending = context.readAppState().pendingPermissions ?? {}
    expect(Object.values(pending)[0]?.toolName).toBe('EchoTool')
    expect(Object.values(pending)[0]?.suggestedRule).toBe('EchoTool')
  })
})

describe('ExitPlanMode approval handshake through runToolUse', () => {
  afterEach(() => resetProcessFs())

  function makeMemoryFs(): RuntimeFs {
    const files = new Map<string, string>()
    return {
      ...unconfiguredFs,
      async stat(path: string): Promise<RuntimeFsStat> {
        if (!files.has(path)) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return { isFile: () => true, isDirectory: () => false } as RuntimeFsStat
      },
      async mkdir(): Promise<void> {},
      async readFile(path: string): Promise<string> {
        const content = files.get(path)
        if (content === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return content
      },
      async writeFile(path: string, data: string | Uint8Array): Promise<void> {
        files.set(
          path,
          typeof data === 'string' ? data : new TextDecoder().decode(data),
        )
      },
    } as RuntimeFs
  }

  function makeExitPlanContext(opts: { agentId?: string } = {}) {
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: {
        ...appState.permissionRules,
        mode: 'plan',
        modeBeforePlan: 'acceptEdits',
      },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const context = createNoopToolUseContext({
      tools: [ExitPlanModeTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-exit',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    if (opts.agentId) {
      context.agentId = opts.agentId
    }
    return { context, getAppState: () => appState }
  }

  async function drainExit(
    context: ReturnType<typeof makeExitPlanContext>['context'],
    args: Record<string, unknown>,
  ) {
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-exit', toolName: 'ExitPlanMode', args },
      makeAssistantMessage('ExitPlanMode', 'tc-exit'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    return updates
  }

  it('HALTS ExitPlanMode on the main thread (pendingToolUse, no call(), no auto-flip) and stages the approval', async () => {
    installProcessFs(makeMemoryFs())
    const { context, getAppState } = makeExitPlanContext()
    const updates = await drainExit(context, { plan: '# Plan\n1. step' })

    // ExitPlanMode HALTS — it yields pendingToolUse (so the model stops and can't
    // loop) and call() never runs (no tool-result message yet). This is the fix
    // for the production bug where prose "stop" did not stop the model.
    expect(updates.some(u => u.pendingToolUse?.toolName === 'ExitPlanMode')).toBe(
      true,
    )
    expect(updates.some(u => u.message)).toBe(false)

    // A plan approval was staged for the banner, carrying the plan + restore
    // mode; the mode is STILL plan (the banner flips it on approval).
    const pending = Object.values(getAppState().pendingPlanApproval ?? {})
    expect(pending[0]?.toolName).toBe('ExitPlanMode')
    expect(pending[0]?.planText).toContain('# Plan')
    expect(pending[0]?.restoreMode).toBe('acceptEdits')
    expect(
      (getAppState().permissionRules as { mode: string }).mode,
    ).toBe('plan')
  })

  it('queues ExitPlanMode and resumes the same tool call on approval', async () => {
    installProcessFs(makeMemoryFs())
    const { context, getAppState } = makeExitPlanContext()
    let queued:
      | Awaited<ReturnType<NonNullable<typeof context.requestToolUseConfirm>>>
      | undefined
    context.requestToolUseConfirm = async item => {
      queued = {
        approvalCallId: item.approvalCallId,
        behavior: 'allow',
        updatedInput: item.input,
      }
      expect(item.toolName).toBe('ExitPlanMode')
      expect(item.permissionResult.planText).toContain('# Plan')
      return queued
    }

    const updates = await drainExit(context, { plan: '# Plan\n1. step' })

    expect(queued?.behavior).toBe('allow')
    expect(updates.some(u => u.pendingToolUse)).toBe(false)
    expect(getAppState().pendingPlanApproval).toBeUndefined()
    expect(getAppState().permissionRules.mode).toBe('acceptEdits')
    const toolResult = updates.find(u => u.message)?.message?.toolUseResult
    expect(toolResult).toContain('User has approved your plan')
    expect(toolResult).toContain('# Plan')
  })

  it('runs directly in an agent context (no banner, no pending approval)', async () => {
    installProcessFs(makeMemoryFs())
    const { context, getAppState } = makeExitPlanContext({ agentId: 'agent-1' })
    const updates = await drainExit(context, {})
    // call() ran (agent acknowledgement path): a tool result, not a halt.
    expect(updates[0]!.message).toBeDefined()
    expect(getAppState().pendingPlanApproval).toBeUndefined()
  })
})

// ===========================================================================
// A tool that halts awaiting user interaction yields a `pendingToolUse` and `executeToolCalls` returns early; the
// tool's start must still be balanced by its completion (the PostToolUse hook's markToolEnd, and
// markToolUseAsComplete), or the session's submit queue stays blocked.
// ===========================================================================
describe('executeToolCalls releases an awaiting-user tool even on early finalize', () => {
  function makePendingToolContext() {
    let appState: WorkingState = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'AskTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks the user',
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
      // Not read-only → routes through the serial path (the one the
      // AskUserQuestion / permission specs exercise).
      readsOnly: () => false,
      // The halt trigger — runToolUse yields a pendingToolUse and returns
      // before ever invoking call().
      haltsForUser: () => true,
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-pending',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    // Track the in-progress set: executeToolCalls adds the tool-use id before
    // running and `markToolUseAsComplete` removes it. `markToolUseAsComplete`
    // shares the SAME finalize closure as the PostToolUse hook (markToolEnd),
    // so an empty set after the turn proves both ran.
    let inProgress = new Set<string>()
    context.markCallsInFlight = updater => {
      inProgress = updater(inProgress)
    }
    return { context, wasCalled: () => called, getInProgress: () => inProgress }
  }

  it('fires PostToolUse / clears in-progress when the tool yields pendingToolUse', async () => {
    const { context, wasCalled, getInProgress } = makePendingToolContext()
    const updates = []
    for await (const update of runToolBatch(
      [{ type: 'tool-call', toolCallId: 'tc-pending', toolName: 'AskTool', args: {} }],
      [makeAssistantMessage('AskTool', 'tc-pending')],
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    // The tool halted for user interaction: it never ran, and a pendingToolUse
    // was surfaced.
    expect(wasCalled()).toBe(false)
    expect(updates.some(u => u.pendingToolUse?.toolName === 'AskTool')).toBe(true)
    // The fix: the tool's lifecycle was finalized despite `executeToolCalls`'
    // early return. Without it, 'tc-pending' stays stuck in the set (and the
    // SharedWorker inflight pointer never clears).
    expect(getInProgress().has('tc-pending')).toBe(false)
    expect(getInProgress().size).toBe(0)
  })
})

// Spec 5-4-2 step 1e: a `requiresUserInteraction` tool halts for the user
// EVEN in bypassPermissions mode. Bypass short-circuits the permission gate to
// `allow`, but the halt at the requiresUserInteraction check still fires — the
// tool's call() never runs and a pendingToolUse is surfaced. This is the
// engine-level bypass-immunity for interactive tools (AskUserQuestion, etc.).
describe('requiresUserInteraction is bypass-immune (spec 5-4-2 #1e)', () => {
  function makeBypassContext() {
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: {
        ...appState.permissionRules,
        mode: 'bypassPermissions',
      },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'AskTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks the user',
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
      readsOnly: () => false,
      haltsForUser: () => true,
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-bypass-interactive',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    return { context, wasCalled: () => called }
  }

  it('halts for user interaction even in bypassPermissions mode', async () => {
    const { context, wasCalled } = makeBypassContext()
    const updates = []
    for await (const update of runToolBatch(
      [{ type: 'tool-call', toolCallId: 'tc-bypass-ask', toolName: 'AskTool', args: {} }],
      [makeAssistantMessage('AskTool', 'tc-bypass-ask')],
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    // Bypass did NOT let the tool run — it still halted for the user.
    expect(wasCalled()).toBe(false)
    expect(updates.some(u => u.pendingToolUse?.toolName === 'AskTool')).toBe(true)
  })
})

// A tool whose OWN checkPermissions returns `ask` (e.g. WebFetch on an
// un-granted URL) must render the PermissionBanner — stage pendingPermissions +
// halt, like the rule-engine ask — NOT dead-end with the unrenderable message.
describe('tool checkPermissions ask → permission banner (not a dead-end)', () => {
  it('stages pendingPermissions + halts (no "does not render" message)', async () => {
    let appState: WorkingState = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'AskingTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks for a permission',
      // isReadOnly (passes a plan gate); the halt comes from checkPermissions.
      readsOnly: () => true,
      selfVerdict: async () => ({
        behavior: 'ask',
        message: 'needs a grant',
      }),
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-ask-perm',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState

    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-ask', toolName: 'AskingTool', args: {} },
      makeAssistantMessage('AskingTool', 'tc-ask'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }

    expect(called).toBe(false)
    expect(
      updates.some(u => u.pendingToolUse?.toolName === 'AskingTool'),
      'must halt via pendingToolUse so the banner can render',
    ).toBe(true)
    expect(
      updates.some(u =>
        JSON.stringify(u.message ?? '').includes('does not currently render'),
      ),
      'must NOT dead-end with the unrenderable message',
    ).toBe(false)
    const pending = appState.pendingPermissions?.['tc-ask']
    expect(pending?.toolName).toBe('AskingTool')
    expect(pending?.suggestedRule).toBeDefined()
  })

  it('queues a tool permission ask and continues the same call on allow', async () => {
    let appState: WorkingState = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'AskingTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks for a permission',
      readsOnly: () => true,
      selfVerdict: async () => ({
        behavior: 'ask',
        message: 'needs a grant',
      }),
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-ask-queue',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    context.requestToolUseConfirm = async item => ({
      approvalCallId: item.approvalCallId,
      behavior: 'allow',
      updatedInput: item.input,
    })

    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-ask', toolName: 'AskingTool', args: {} },
      makeAssistantMessage('AskingTool', 'tc-ask'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }

    expect(called).toBe(true)
    expect(updates.some(u => u.pendingToolUse)).toBe(false)
    expect(appState.pendingPermissions?.['tc-ask']).toBeUndefined()
    expect(
      updates.some(u =>
        String(u.message?.toolUseResult ?? '').includes('"ok":true'),
      ),
    ).toBe(true)
  })

  // dontAsk mode: the tool-checkPermissions ask is suppressed into a DENY —
  // no banner, no halt; the model gets an error result.
  it('dontAsk: a tool checkPermissions ask becomes a deny (no prompt)', async () => {
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: { ...appState.permissionRules, mode: 'dontAsk' },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'AskingTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks for a permission',
      readsOnly: () => true,
      selfVerdict: async () => ({ behavior: 'ask', message: 'needs a grant' }),
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-dontask',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState

    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-da', toolName: 'AskingTool', args: {} },
      makeAssistantMessage('AskingTool', 'tc-da'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }

    expect(called, 'the tool must not run').toBe(false)
    expect(
      updates.some(u => u.pendingToolUse),
      'dontAsk must NOT halt/prompt',
    ).toBe(false)
    expect(appState.pendingPermissions?.['tc-da'], 'no pending permission staged').toBeUndefined()
    expect(
      updates.some(u =>
        JSON.stringify(u.message ?? '').includes("don't ask mode"),
      ),
      "the deny result names don't ask mode (dontAskRejectMessage)",
    ).toBe(true)
  })

  // `shouldAvoidPermissionPrompts`: a context with no interactive surface (async sub-agent / headless run)
  // auto-DENIES a would-be ask. Before this, the ask was staged as a pending
  // tool use on a confirm queue nothing renders, so the background task hung
  // forever waiting for an answer that could never arrive.
  it('shouldAvoidPermissionPrompts: a tool checkPermissions ask becomes a deny (no halt)', async () => {
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: {
        ...appState.permissionRules,
        suppressAsks: true,
      },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'AskingTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks for a permission',
      readsOnly: () => true,
      selfVerdict: async () => ({ behavior: 'ask', message: 'needs a grant' }),
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-headless',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState

    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-headless', toolName: 'AskingTool', args: {} },
      makeAssistantMessage('AskingTool', 'tc-headless'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }

    expect(called, 'the tool must not run').toBe(false)
    expect(
      updates.some(u => u.pendingToolUse),
      'a non-interactive context must NOT halt on a prompt nobody can answer',
    ).toBe(false)
    expect(appState.pendingPermissions?.['tc-headless']).toBeUndefined()
    expect(
      updates.some(u =>
        JSON.stringify(u.message ?? '').includes(
          'Permission to use AskingTool has been denied.',
        ),
      ),
      'the deny result is autoRejectMessage',
    ).toBe(true)
  })

  // Headless branch: an INTERACTIVE tool (requiresUserInteraction —
  // AskUserQuestion / the plan tools) in a non-interactive session must be
  // auto-DENIED, not parked on a confirm queue nobody renders. Reachable in
  // production: a background FORK keeps the parent's exact tool pool
  // (forkExactTools skips the sub-agent strip), so AskUserQuestion IS callable
  // in a `subagent-*` session — before this it suspended forever.
  it('shouldAvoidPermissionPrompts: a requiresUserInteraction tool is auto-denied, not halted', async () => {
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: {
        ...appState.permissionRules,
        suppressAsks: true,
      },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'InteractiveTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks the user something',
      readsOnly: () => true,
      haltsForUser: () => true,
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-headless-interactive',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    // A resolver IS installed (like the real worker) but must never be
    // consulted — the deny fires before the queue.
    let resolverCalled = false
    context.requestToolUseConfirm = async item => {
      resolverCalled = true
      return { approvalCallId: item.approvalCallId, behavior: 'allow' as const }
    }

    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-hl-int', toolName: 'InteractiveTool', args: {} },
      makeAssistantMessage('InteractiveTool', 'tc-hl-int'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }

    expect(called, 'the tool must not run').toBe(false)
    expect(resolverCalled, 'the confirm queue must not be consulted').toBe(false)
    expect(
      updates.some(u => u.pendingToolUse),
      'must not halt on a prompt nobody renders',
    ).toBe(false)
    expect(appState.pendingUserInteraction?.['tc-hl-int']).toBeUndefined()
    expect(
      updates.some(u =>
        JSON.stringify(u.message ?? '').includes(
          'Permission to use InteractiveTool has been denied.',
        ),
      ),
      'the deny result is autoRejectMessage',
    ).toBe(true)
  })
})

// Headless PermissionRequest hooks: in a context that
// cannot prompt, PermissionRequest hooks get ONE chance to decide before the
// auto-deny. A hook decides with `hookSpecificOutput.decision` (pinned in
// hook-permission-request.test.ts); a hook that merely passes decides
// nothing (the ask stays auto-rejected), a blocking one denies with its message,
// none matched = AUTO_REJECT.
describe('PermissionRequest hooks on the headless deny path', () => {
  function makeHeadlessAskContext(sessionId: string) {
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: {
        ...appState.permissionRules,
        suppressAsks: true,
      },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'AskingTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks for a permission',
      readsOnly: () => true,
      selfVerdict: async () => ({ behavior: 'ask', message: 'needs a grant' }),
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId,
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    return {
      context,
      setAppState,
      wasCalled: () => called,
      getAppState: () => appState,
    }
  }

  async function drive(context: ReturnType<typeof createNoopToolUseContext>, toolCallId: string) {
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId, toolName: 'AskingTool', args: {} },
      makeAssistantMessage('AskingTool', toolCallId),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    return updates
  }

  it('a matched PASSING hook with no decision decides nothing (the ask stays auto-rejected)', async () => {
    const { context, setAppState, wasCalled } = makeHeadlessAskContext('sess-pr-allow')
    attachInProcessHook(
      setAppState,
      'sess-pr-allow',
      'PermissionRequest',
      'AskingTool',
      () => true,
      'unused',
    )
    const updates = await drive(context, 'tc-pr-allow')
    expect(wasCalled(), 'a pass is not an allow').toBe(false)
    expect(updates.some(u => u.pendingToolUse)).toBe(false)
    expect(
      JSON.stringify(updates.map(u => u.message ?? '')),
    ).toContain('Permission to use AskingTool has been denied.')
  })

  it('a matched BLOCKING hook denies with the hook message (not AUTO_REJECT)', async () => {
    const { context, setAppState, wasCalled } = makeHeadlessAskContext('sess-pr-deny')
    attachInProcessHook(
      setAppState,
      'sess-pr-deny',
      'PermissionRequest',
      'AskingTool',
      () => false,
      'not for background agents',
    )
    const updates = await drive(context, 'tc-pr-deny')
    expect(wasCalled()).toBe(false)
    expect(updates.some(u => u.pendingToolUse)).toBe(false)
    const serialized = JSON.stringify(updates.map(u => u.message ?? ''))
    expect(serialized).toContain('Permission denied by PermissionRequest hook')
    expect(serialized).toContain('not for background agents')
    expect(serialized).not.toContain(
      'Permission to use AskingTool has been denied.',
    )
  })

  it('a hook whose matcher does NOT match falls through to AUTO_REJECT', async () => {
    const { context, setAppState, wasCalled } = makeHeadlessAskContext('sess-pr-nomatch')
    attachInProcessHook(
      setAppState,
      'sess-pr-nomatch',
      'PermissionRequest',
      'SomeOtherTool',
      () => true,
      'unused',
    )
    const updates = await drive(context, 'tc-pr-nomatch')
    expect(wasCalled()).toBe(false)
    expect(
      JSON.stringify(updates.map(u => u.message ?? '')),
    ).toContain('Permission to use AskingTool has been denied.')
  })

  it('the requiresUserInteraction HALT branch: a passing hook decides nothing (denied, no halt)', async () => {
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: {
        ...appState.permissionRules,
        suppressAsks: true,
      },
    }
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    let called = false
    const tool = declareTool({
      name: 'InteractiveTool',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks the user something',
      readsOnly: () => true,
      haltsForUser: () => true,
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-pr-halt-allow',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    attachInProcessHook(
      setAppState,
      'sess-pr-halt-allow',
      'PermissionRequest',
      'InteractiveTool',
      () => true,
      'unused',
    )

    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-pr-halt', toolName: 'InteractiveTool', args: {} },
      makeAssistantMessage('InteractiveTool', 'tc-pr-halt'),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }

    expect(called, 'a pass is not an allow').toBe(false)
    expect(updates.some(u => u.pendingToolUse), 'must not halt').toBe(false)
    expect(appState.pendingUserInteraction?.['tc-pr-halt']).toBeUndefined()
    expect(JSON.stringify(updates.map(u => u.message ?? ''))).toContain(
      'Permission to use InteractiveTool has been denied.',
    )
  })
})

// The filesystem-safety gate in toolExecution — a file outside the
// workspace (or a sensitive write) halts for a permission prompt, surviving
// bypass, and denies under dontAsk.
describe('filesystem safety gate (workspace boundary + sensitive paths)', () => {
  const PROJ = 'D:/work/proj'

  function buildWriteTool(onCall: () => void) {
    return declareTool({
      name: 'Write',
      argsSchema: {
        type: 'object' as const,
        properties: { file_path: { type: 'string' as const } },
      },
      description: async () => 'writes a file',
      readsOnly: () => false,
      selfVerdict: async () => ({ behavior: 'allow' }),
      call: async () => {
        onCall()
        return { data: { ok: true } }
      },
    })
  }

  async function runWrite(
    filePath: string,
    mode: string,
    toolCallId: string,
    permissionContextOverrides: Partial<
      WorkingState['permissionRules']
    > = {},
  ) {
    let appState: WorkingState = createEmptyAppState()
    appState = {
      ...appState,
      permissionRules: {
        ...appState.permissionRules,
        mode,
        ...permissionContextOverrides,
      },
    }
    let called = false
    const tool = buildWriteTool(() => {
      called = true
    })
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState: () => {},
      cwd: PROJ,
      projectRoot: PROJ,
      sessionId: 'sess-fs',
    })
    context.writeAppState = updater => {
      appState = updater(appState)
    }
    context.readAppState = () => appState
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId, toolName: 'Write', args: { file_path: filePath } },
      makeAssistantMessage('Write', toolCallId),
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    return { called, updates, appState }
  }

  it('a Write outside the workspace halts for a permission prompt', async () => {
    const { called, updates, appState } = await runWrite('D:/other/x.ts', 'default', 'tc-out')
    expect(called, 'must not write before approval').toBe(false)
    expect(updates.some(u => u.pendingToolUse?.toolName === 'Write')).toBe(true)
    const pending = appState.pendingPermissions?.['tc-out']
    expect(pending?.toolName).toBe('Write')
    // The banner needs the reason + the directory to offer "Allow this
    // folder" (addDirectories).
    expect(pending?.reason).toBe('outside-workspace')
    // dirnameRuntimePath normalizes to the host (win32) separator.
    expect(pending?.directory).toBe('D:\\other')
  })

  it('the boundary ask SURVIVES bypass (safety is bypass-immune)', async () => {
    const { called, updates } = await runWrite('D:/other/x.ts', 'bypassPermissions', 'tc-byp')
    expect(called).toBe(false)
    expect(updates.some(u => u.pendingToolUse?.toolName === 'Write')).toBe(true)
  })

  it('a Write INSIDE the workspace runs (no prompt)', async () => {
    const { called, updates } = await runWrite('src/a.ts', 'default', 'tc-in')
    expect(called, 'in-workspace write runs').toBe(true)
    expect(updates.some(u => u.pendingToolUse)).toBe(false)
  })

  it('a sensitive write (.git) halts even inside the workspace', async () => {
    const { called, updates } = await runWrite(`${PROJ}/.git/config`, 'default', 'tc-git')
    expect(called).toBe(false)
    expect(updates.some(u => u.pendingToolUse?.toolName === 'Write')).toBe(true)
  })

  it('dontAsk denies the boundary ask (no prompt)', async () => {
    const { called, updates, appState } = await runWrite('D:/other/x.ts', 'dontAsk', 'tc-da-fs')
    expect(called).toBe(false)
    expect(updates.some(u => u.pendingToolUse)).toBe(false)
    expect(appState.pendingPermissions?.['tc-da-fs']).toBeUndefined()
    // The model-facing denial is `dontAskRejectMessage` — its exact
    // workaround guidance matters (it's what stops the model from
    // brute-forcing around the denial), so assert on that text, not a mode id.
    expect(
      updates.some(u =>
        JSON.stringify(u.message ?? '').includes("don't ask mode"),
      ),
    ).toBe(true)
  })

  // `shouldAvoidPermissionPrompts`: a background sub-agent has no
  // surface that renders the ask, so the boundary prompt must become a denial
  // instead of parking the sub-agent on an unanswerable confirm queue.
  it('shouldAvoidPermissionPrompts denies the boundary ask instead of halting', async () => {
    const { called, updates, appState } = await runWrite(
      'D:/other/x.ts',
      'default',
      'tc-headless-fs',
      { suppressAsks: true },
    )
    expect(called).toBe(false)
    expect(
      updates.some(u => u.pendingToolUse),
      'a non-interactive context must not halt',
    ).toBe(false)
    expect(appState.pendingPermissions?.['tc-headless-fs']).toBeUndefined()
    expect(
      updates.some(u =>
        JSON.stringify(u.message ?? '').includes(
          'Permission to use Write has been denied.',
        ),
      ),
      'the deny result is autoRejectMessage',
    ).toBe(true)
  })

  // …but bypassPermissions still short-circuits FIRST (the bypass allow
  // comes before the headless ask-to-deny conversion), so a bypassed sub-agent
  // is not denied — only safety asks survive bypass.
  it('bypass beats shouldAvoidPermissionPrompts for a non-safety ask', async () => {
    const { called, updates } = await runWrite(
      'D:/other/x.ts',
      'bypassPermissions',
      'tc-headless-byp',
      { suppressAsks: true },
    )
    // The boundary ask IS a safetyCheck ask, so it survives bypass and — with
    // no interactive surface — becomes a denial rather than a halt.
    expect(called).toBe(false)
    expect(updates.some(u => u.pendingToolUse)).toBe(false)
  })
})

describe('UserPromptSubmit through query() — main agent only', () => {
  // UserPromptSubmit runs for user input only. A fork
  // or sub-agent re-enters the query loop with its PARENT's sessionId, and its
  // "prompt" is a skill body / hook verifier / extraction brief, not something
  // the user submitted; the user's prompt hook must not fire (or bill a model
  // call) inside it. The gate is `!toolUseContext.agentId` (engine/turnLoop.ts).
  async function runPromptHook(agentId: string | undefined): Promise<number> {
    let fired = 0
    let appState: WorkingState = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const sessionId = `sess-ups-${agentId ?? 'main'}`
    attachInProcessHook(
      setAppState,
      sessionId,
      'UserPromptSubmit',
      '',
      () => {
        fired += 1
        return true
      },
      'prompt hook',
    )
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId,
    })
    toolUseContext.writeAppState = setAppState
    toolUseContext.readAppState = () => appState
    if (agentId) toolUseContext.agentId = agentId
    const deps = assembleTurnDependencies(new DefaultRuntimeConfig(), {
      callModel: async function* () {
        yield {
          type: 'assistant',
          uuid: `assistant-${sessionId}`,
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        } as Message
      },
    })
    const generator = runTurnLoop({
      messages: [
        {
          type: 'user',
          uuid: `user-${sessionId}`,
          message: { role: 'user', content: 'hello' },
        } as Message,
      ],
      baseInstructions: 'test',
      userAmbient: {},
      systemAmbient: {},
      decidePermission: async () => ({ behavior: 'allow' }),
      callContext: toolUseContext,
      turnCaller: 'test',
      deps,
    })
    while (!(await generator.next()).done) {
      // drain
    }
    return fired
  }

  it('fires once for the main agent', async () => {
    expect(await runPromptHook(undefined)).toBe(1)
  })

  it('does NOT fire inside a fork / sub-agent query (agentId set)', async () => {
    expect(await runPromptHook('fork-1')).toBe(0)
  })
})
