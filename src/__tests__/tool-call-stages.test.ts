/**
 * The staged tool-call pipeline (F-26): the pure permission verdict's
 * order and its path-safety rule, and the stage driver's failure path.
 * Everything is injected — the stage list and the hook executors — no
 * module is replaced.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkingState, ModelReplyRow } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps, QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  admittedStage,
  executeToolCallStages,
  type DeferredMessageUpdate,
  type ToolCallStage,
} from '../toolkit/run/executeToolCall'
import { admitStage } from '../toolkit/run/toolCallAdmission'
import {
  assertSafetyAskStands,
  decideToolPermission,
  type ToolPermissionVerdict,
} from '../toolkit/run/toolPermissionGate'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

const PROJ = '/work/project'
const DEPS = { uuid: () => 'u' } as QueryRuntimeDeps

function makeTool(
  selfVerdict: ReturnType<typeof vi.fn<() => Promise<{ behavior: 'allow' | 'deny'; message?: string }>>> = vi.fn(
    async () => ({ behavior: 'allow' as const }),
  ),
) {
  return {
    selfVerdict,
    tool: declareTool({
      name: 'Shell',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'runs',
      call: async () => ({ data: 'ran' }),
      selfVerdict,
    }) as unknown as ToolContract,
  }
}

function makeContext(
  tools: ToolContract[],
  ruleLists?: { allow: string[]; deny: string[]; ask: string[] },
  extra: Partial<ToolCallContext> = {},
): ToolCallContext {
  let appState: WorkingState = createEmptyAppState()
  if (ruleLists) {
    appState = { ...appState, permissionRules: { ...appState.permissionRules, ruleLists } }
  }
  const context = createNoopToolUseContext({
    tools,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState: () => {},
    cwd: PROJ,
    projectRoot: PROJ,
    sessionId: 'sess-stages',
  })
  context.readAppState = () => appState
  return Object.assign(context, extra)
}

describe('decideToolPermission', () => {
  it('a deny rule wins before the tool is asked', async () => {
    const { tool, selfVerdict } = makeTool()
    const ctx = makeContext([tool], { allow: [], deny: ['Shell'], ask: [] })
    const verdict = await decideToolPermission(tool, {}, ctx)
    expect(verdict.decision).toBe('deny')
    expect(selfVerdict).not.toHaveBeenCalled()
  })

  it('an explicit allow rule stands in for the tool’s own check', async () => {
    const { tool, selfVerdict } = makeTool(vi.fn(async () => ({ behavior: 'deny' as const, message: 'no' })))
    const ctx = makeContext([tool], { allow: ['Shell'], deny: [], ask: [] })
    const verdict = await decideToolPermission(tool, {}, ctx)
    expect(verdict.decision).toBe('allow')
    expect(selfVerdict).not.toHaveBeenCalled()
  })

  it('with no rule the tool’s own answer decides', async () => {
    const { tool, selfVerdict } = makeTool(vi.fn(async () => ({ behavior: 'deny' as const, message: 'no' })))
    const verdict = await decideToolPermission(tool, {}, makeContext([tool]))
    expect(verdict).toMatchObject({ decision: 'deny', message: 'Permission denied: no' })
    expect(selfVerdict).toHaveBeenCalledTimes(1)
  })

  it('an ask rule asks and resumes to an allow', async () => {
    const { tool } = makeTool()
    const ctx = makeContext([tool], { allow: [], deny: [], ask: ['Shell'] })
    const verdict = await decideToolPermission(tool, { a: 1 }, ctx)
    expect(verdict).toMatchObject({ decision: 'ask', safety: false, resume: { stage: 'rule' } })
    if (verdict.decision !== 'ask') return
    const resumed = await decideToolPermission(tool, { a: 1 }, ctx, { ...verdict.resume, askedInput: { a: 2 } })
    expect(resumed).toMatchObject({ decision: 'allow', updatedInput: { a: 2 } })
  })
})

describe('assertSafetyAskStands', () => {
  const allow: ToolPermissionVerdict = { decision: 'allow', updatedInput: {}, permissionResult: undefined }
  const ask = (safety: boolean): ToolPermissionVerdict => ({
    decision: 'ask',
    requestedInput: {},
    safety,
    resume: { stage: safety ? 'fsSafety' : 'rule', ruleSet: {} as never },
  })

  it('a path-safety ask cannot be lifted to an allow', () => {
    const safetyAsk = ask(true)
    expect(assertSafetyAskStands(safetyAsk, allow)).toBe(safetyAsk)
  })

  it('any other verdict may be changed', () => {
    expect(assertSafetyAskStands(ask(false), allow)).toBe(allow)
    const deny: ToolPermissionVerdict = { decision: 'deny', message: 'x' }
    expect(assertSafetyAskStands(ask(true), deny)).toBe(deny)
  })
})

describe('executeToolCallStages', () => {
  const block = { type: 'tool-call', toolCallId: 'c1', toolName: 'Shell', args: {} } as unknown as QueryToolUseBlock
  const reply = { type: 'assistant', uuid: 'a', message: { content: [] } } as unknown as ModelReplyRow

  async function drain(gen: AsyncGenerator<DeferredMessageUpdate, void>) {
    const out: DeferredMessageUpdate[] = []
    for await (const u of gen) out.push(u)
    return out
  }

  it('a stage that throws after admission runs the failure hooks once', async () => {
    const { tool } = makeTool()
    const failure = vi.fn(async () => ({ blocked: false, errors: [], additionalContext: [], systemMessages: [] }))
    const later = vi.fn()
    const ctx = makeContext([tool], undefined, { toolRunSeams: { hooks: { failure: failure as never } } })
    const stages: ToolCallStage[] = [
      { name: 'admit', run: admitStage },
      admittedStage('boom', async function* () {
        throw new Error('kaput')
      }),
      admittedStage('later', async function* () {
        later()
        return 'continue'
      }),
    ]
    const updates = await drain(executeToolCallStages(block, reply, vi.fn(), ctx, DEPS, stages))
    expect(failure).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
    expect(JSON.stringify(updates)).toContain('Tool execution error: kaput')
  })

  it('a stage that stops ends the call without the rest', async () => {
    const { tool } = makeTool()
    const later = vi.fn()
    const stages: ToolCallStage[] = [
      { name: 'admit', run: admitStage },
      admittedStage('stop', async function* () {
        return 'stop'
      }),
      admittedStage('later', async function* () {
        later()
        return 'continue'
      }),
    ]
    await drain(executeToolCallStages(block, reply, vi.fn(), makeContext([tool]), DEPS, stages))
    expect(later).not.toHaveBeenCalled()
  })

  it('a throw before admission is not a tool failure', async () => {
    const failure = vi.fn()
    const ctx = makeContext([], undefined, { toolRunSeams: { hooks: { failure: failure as never } } })
    const stages: ToolCallStage[] = [
      {
        name: 'admit',
        run: async function* () {
          throw new Error('early')
        },
      },
    ]
    await expect(drain(executeToolCallStages(block, reply, vi.fn(), ctx, DEPS, stages))).rejects.toThrow('early')
    expect(failure).not.toHaveBeenCalled()
  })
})
