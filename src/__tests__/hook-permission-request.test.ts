// `PermissionRequest` ran only where no dialog can be shown, and there a hook
// that merely passed was an allow; its stdin had no tool_name, and a hook's
// `hookSpecificOutput.decision` was never read. Now the hooks run beside the
// dialog too, a decision that arrives first settles the ask, and only an
// explicit decision decides. These pin the decision's parsing, the stdin,
// both asks (headless and interactive, through the worker's permission
// coordinator), and that a mod sees it as `classic.PermissionRequest`.

import { describe, expect, it, vi } from 'vitest'
import { declareTool } from '../toolkit/toolContract'
import { executeToolCall } from '../toolkit/run/executeToolCall'
import { AgentPermissionCoordinator } from '../browser/worker/AgentPermissionCoordinator'
import type { PlatformCapabilities } from '../runtime/interfaces/PlatformCapabilities'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { WorkingState, ModelReplyRow } from '../runtime/RuntimeTypes'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { hookJsonToDecision, permissionRequestDecisionOf } from '../lifecycleHooks/hookOutput'
import { fireLifecycleEvent } from '../lifecycleHooks/runHooks'
import { permissionSuggestionsOf, permissionUpdatesOfHook } from '../lifecycleHooks/permissionRequestHooks'
import { attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'
import type { ClassicMods } from '../mods/toolCallEvent'
import { aggregateOfClassicResult, isClassicResult } from '../mods/classicEvent'

const SID = 'sess-permission-request'
const DEPS = { uuid: () => 'test-uuid' } as QueryRuntimeDeps

const allow = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', ...extra } },
  })
const deny = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', ...extra } },
  })

/** A host whose Bash tool runs hook commands: keeps each run's stdin and
 *  prints `output()` (a promise, so a test can hold the hook back). */
function hookHost(output: () => string | Promise<string>) {
  const stdins: Array<Record<string, unknown>> = []
  const capabilities = Object.assign(new NoopPlatformCapabilities(), {
    browser: {
      callTool: async (request: { args: { hook_stdin: string } }) => {
        stdins.push(JSON.parse(request.args.hook_stdin) as Record<string, unknown>)
        return { output: await output(), exit_code: 0 }
      },
    },
  }) as unknown as PlatformCapabilities
  return { stdins, capabilities }
}

function world(output: () => string | Promise<string>, options: { headless?: boolean } = {}) {
  let appState: WorkingState = createEmptyAppState()
  if (options.headless) {
    appState = {
      ...appState,
      permissionRules: { ...appState.permissionRules, suppressAsks: true },
    }
  }
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const calls: Array<Record<string, unknown>> = []
  const tool = declareTool({
    name: 'AskingTool',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'asks for a permission',
    readsOnly: () => true,
    selfVerdict: async () => ({ behavior: 'ask', message: 'needs a grant' }),
    call: async (input: Record<string, unknown>) => {
      calls.push(input)
      return { data: { ok: true } }
    },
  })
  const host = hookHost(output)
  const context = createNoopToolUseContext({
    tools: [tool],
    platformCapabilities: host.capabilities,
    appState,
    setAppState,
    sessionId: SID,
  })
  context.readAppState = () => appState
  context.writeAppState = setAppState
  attachTransientHook(setAppState, SID, 'PermissionRequest', 'AskingTool', { type: 'command', command: 'decide' })

  // The worker's permission coordinator owns the dialog, as in production.
  const applied: unknown[] = []
  const coordinator = new AgentPermissionCoordinator({ emitState: () => {}, emitError: () => {} })
  coordinator.bindRuntime({
    setAppState,
    engine: { applyRuleChange: (update: unknown) => applied.push(update) },
    conversationStore: {},
    options: {},
  } as never)
  context.requestToolUseConfirm = coordinator.request

  const drive = async (args: Record<string, unknown> = { path: 'a' }) => {
    const updates = []
    const message = {
      type: 'assistant',
      uuid: 'assistant-tc',
      message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc', toolName: 'AskingTool', args }] },
    } as ModelReplyRow
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc', toolName: 'AskingTool', args },
      message,
      async () => ({ behavior: 'allow' }),
      context,
      DEPS,
    )) {
      updates.push(update)
    }
    return updates
  }
  const results = (updates: Array<{ message?: unknown }>) => JSON.stringify(updates.map(u => u.message ?? ''))
  return {
    context,
    coordinator,
    calls,
    applied,
    stdins: host.stdins,
    drive,
    results,
    queue: () => appState.approvalQueue ?? [],
    appState: () => appState,
  }
}

describe('the PermissionRequest decision', () => {
  it('is read from a PermissionRequest hookSpecificOutput, and only there', () => {
    expect(hookJsonToDecision(JSON.parse(allow({ updatedInput: { path: 'b' } })))).toMatchObject({
      kind: 'pass',
      permissionRequest: { behavior: 'allow', updatedInput: { path: 'b' } },
    })
    expect(hookJsonToDecision(JSON.parse(deny({ message: 'no', interrupt: true })))).toMatchObject({
      kind: 'pass',
      permissionRequest: { behavior: 'deny', message: 'no', interrupt: true },
    })
    // Another event's output, or none named, carries no decision.
    const unnamed = { hookSpecificOutput: { decision: { behavior: 'allow' } } }
    expect(hookJsonToDecision(unnamed)).not.toHaveProperty('permissionRequest')
  })

  it('a malformed decision is none', () => {
    expect(permissionRequestDecisionOf({ behavior: 'maybe' })).toBeUndefined()
    expect(permissionRequestDecisionOf({ behavior: 'allow', updatedInput: 'x' })).toBeUndefined()
    expect(permissionRequestDecisionOf({ behavior: 'deny', interrupt: 'yes' })).toBeUndefined()
    expect(permissionRequestDecisionOf('allow')).toBeUndefined()
  })

  it("a hook's updatedPermissions become Velloc's rules; what is not one is dropped", () => {
    expect(
      permissionUpdatesOfHook([
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'allow', destination: 'session' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        { type: 'addRules', rules: [{}], behavior: 'allow', destination: 'session' },
        { type: 'addRules', rules: ['Read'], behavior: 'allow', destination: 'nowhere' },
      ]),
    ).toEqual([
      { type: 'addRules', rules: ['Bash(git status)'], behavior: 'allow', destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ])
  })

  it("an ask's suggestions reach the hook as permission_suggestions", () => {
    expect(
      permissionSuggestionsOf({
        suggestedRule: 'Bash(npm test:*)',
        suggestions: [{ type: 'setMode', mode: 'acceptEdits' }],
      }),
    ).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ])
  })

  it('the hooks fold last-write-wins, and the stdin names the tool and its input', async () => {
    let n = 0
    const host = hookHost(() => (n++ === 0 ? deny({ message: 'first' }) : allow()))
    let appState = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    attachTransientHook(setAppState, SID, 'PermissionRequest', 'Bash', { type: 'command', command: 'one' })
    attachTransientHook(setAppState, SID, 'PermissionRequest', 'Bash', { type: 'command', command: 'two' })
    const context = createNoopToolUseContext({
      tools: [],
      platformCapabilities: host.capabilities,
      appState,
      setAppState,
      sessionId: SID,
    })
    const { createBashHookCommandRunner } = await import('../lifecycleHooks/hookCommandRunner')
    const result = await fireLifecycleEvent({
      event: 'PermissionRequest',
      subject: 'Bash',
      sessionId: SID,
      appState,
      commandRunner: createBashHookCommandRunner(context),
      hookInput: { cwd: '/w', toolInput: { command: 'ls' }, alwaysAllowOffers: [{ type: 'setMode' }] },
    })
    expect(result.permissionRequest).toEqual({ behavior: 'allow' })
    expect(result.blocked).toBe(false)
    expect(host.stdins[0]).toMatchObject({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      permission_suggestions: [{ type: 'setMode' }],
    })
    expect(host.stdins[0]).not.toHaveProperty('tool_use_id')
  })
})

describe('the headless ask', () => {
  it("a hook's allow runs the tool with its updatedInput, and its rules apply to the session", async () => {
    const w = world(
      () =>
        allow({
          updatedInput: { path: 'rewritten' },
          updatedPermissions: [
            { type: 'addRules', rules: [{ toolName: 'AskingTool' }], behavior: 'allow', destination: 'session' },
          ],
        }),
      { headless: true },
    )
    await w.drive()
    expect(w.calls).toEqual([{ path: 'rewritten' }])
    expect(JSON.stringify(w.appState().permissionRules)).toContain('AskingTool')
    expect(w.stdins[0]).toMatchObject({ tool_name: 'AskingTool', tool_input: { path: 'a' } })
  })

  it("a hook's deny refuses with its message; interrupt aborts the turn", async () => {
    const w = world(() => deny({ message: 'not in the background', interrupt: true }), { headless: true })
    const updates = await w.drive()
    expect(w.calls).toEqual([])
    expect(w.results(updates)).toContain('not in the background')
    expect(w.context.cancelSource.signal.aborted).toBe(true)
  })
})

describe('the interactive ask', () => {
  it("a hook's allow that comes first settles the dialog: the card comes down and the tool runs", async () => {
    const w = world(() =>
      allow({
        updatedPermissions: [
          { type: 'addRules', rules: [{ toolName: 'AskingTool' }], behavior: 'allow', destination: 'localSettings' },
        ],
      }),
    )
    await w.drive()
    expect(w.calls).toEqual([{ path: 'a' }])
    expect(w.queue()).toEqual([])
    // Applied as the person's "always allow" would be, through the coordinator.
    expect(w.applied).toEqual([
      { type: 'addRules', rules: ['AskingTool'], behavior: 'allow', destination: 'localSettings' },
    ])
  })

  it("a hook's deny refuses with its message (no message: the default), not aborting without interrupt", async () => {
    const w = world(() => deny())
    const updates = await w.drive()
    expect(w.calls).toEqual([])
    expect(w.results(updates)).toContain('Permission denied by PermissionRequest hook.')
    expect(w.queue()).toEqual([])
    expect(w.context.cancelSource.signal.aborted).toBe(false)
  })

  it('a hook that gives no decision leaves the dialog to the person', async () => {
    const w = world(() => '')
    const run = w.drive()
    await vi.waitFor(() => expect(w.queue()).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(w.queue()).toHaveLength(1)
    await w.coordinator.resolveConfirm({ approvalCallId: 'tc', behavior: 'allow' })
    await run
    expect(w.calls).toEqual([{ path: 'a' }])
  })

  it("the person answering first wins: a hook's later deny is ignored", async () => {
    let release: (out: string) => void = () => {}
    const w = world(() => new Promise<string>(resolve => (release = resolve)))
    const run = w.drive()
    await vi.waitFor(() => expect(w.stdins).toHaveLength(1))
    await w.coordinator.resolveConfirm({ approvalCallId: 'tc', behavior: 'allow' })
    release(deny({ interrupt: true }))
    await run
    expect(w.calls).toEqual([{ path: 'a' }])
    expect(w.context.cancelSource.signal.aborted).toBe(false)
  })
})

describe('classic.PermissionRequest', () => {
  it("a mod's decision is a classic result, and the aggregate carries it", () => {
    expect(isClassicResult({ decision: { behavior: 'allow' } })).toBe(true)
    expect(isClassicResult({ decision: { behavior: 'sometimes' } })).toBe(false)
    expect(aggregateOfClassicResult({ decision: { behavior: 'deny', message: 'mod says no' } }, new Map())).toMatchObject({
      blocked: false,
      permissionRequest: { behavior: 'deny', message: 'mod says no' },
    })
  })

  it("is raised with the stdin as e, and a mod's answer decides the ask", async () => {
    const w = world(() => '')
    const seen: Array<Record<string, unknown>> = []
    const mods: ClassicMods = {
      hasClassicHooks: (event: string) => event === 'PermissionRequest',
      classic: async (event: string, e: Record<string, unknown>) => {
        seen.push({ event, ...e })
        return {
          settled: true,
          aggregate: aggregateOfClassicResult({ decision: { behavior: 'allow', updatedInput: { path: 'mod' } } }, new Map()),
        }
      },
    } as unknown as ClassicMods
    ;(w.context.options as { mods?: unknown }).mods = mods
    await w.drive()
    expect(seen[0]).toMatchObject({ event: 'PermissionRequest', hook_event_name: 'PermissionRequest', tool_name: 'AskingTool' })
    expect(w.calls).toEqual([{ path: 'mod' }])
    expect(w.stdins).toEqual([])
  })
})
