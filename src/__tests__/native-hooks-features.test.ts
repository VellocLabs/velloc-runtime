import { afterEach, describe, expect, it, vi } from 'vitest'

import * as extractionModule from '../memory/extract/extractionRunner'
import * as consolidationModule from '../memory/consolidate/consolidationRunner'
import { memoryHooks } from '../memory/memoryHooks'
import { PlanOnTool } from '../toolkit/builtin/planEnter'
import { ExitPlanModeTool } from '../toolkit/builtin/planExit'
import { createNativeHooks } from '../toolkit/nativeHooks'
import { NATIVE_EVENTS } from '../toolkit/nativeHookEvents'
import { haltForUserStage } from '../toolkit/run/interactiveHalt'
import type { AdmittedRun, DeferredMessageUpdate, StageStep } from '../toolkit/run/executeToolCall'
import type { ToolContract } from '../toolkit/toolContract'

afterEach(() => {
  vi.restoreAllMocks()
})

async function drain(gen: AsyncGenerator<DeferredMessageUpdate, StageStep>) {
  const updates: DeferredMessageUpdate[] = []
  let step = await gen.next()
  while (!step.done) {
    updates.push(step.value)
    step = await gen.next()
  }
  return { updates, step: step.value }
}

describe('memory', () => {
  const hooks = createNativeHooks(
    {
      [NATIVE_EVENTS.rowsGather]: ['memory'],
      [NATIVE_EVENTS.turnEnd]: ['memory'],
      [NATIVE_EVENTS.turnBackground]: ['memory'],
    },
    memoryHooks(),
  )

  it('adds nothing without a runtime config (a fork)', async () => {
    const env = { input: {}, ctx: { nestedMemoryCues: new Set(['a.ts']) }, prefetch: undefined }
    for (const stage of ['turnStart', 'afterTools', 'afterCompaction'] as const) {
      const rows = await hooks.around(NATIVE_EVENTS.rowsGather, { stage }, env, async () => ['core'])
      expect(rows).toEqual(['core'])
    }
    await hooks.observe(NATIVE_EVENTS.turnBackground, { background: 'memoryPrefetch', input: { messages: [] } }, env)
    expect(env.prefetch).toBeUndefined()
  })

  it('appends a settled recall after the tool step, once', async () => {
    const prefetch = { settledAt: 1, consumed: false, promise: Promise.resolve('recalled') }
    const env = { input: { runtimeConfig: {} }, ctx: {}, prefetch }
    const rows = (await hooks.around(NATIVE_EVENTS.rowsGather, { stage: 'afterTools' }, env, async () => ['core'])) as unknown[]
    expect(rows[0]).toBe('core')
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows[1])).toContain('recalled')
    expect(prefetch.consumed).toBe(true)
    const again = await hooks.around(NATIVE_EVENTS.rowsGather, { stage: 'afterTools' }, env, async () => [])
    expect(again).toEqual([])
  })

  function turnEnd(agentId?: string) {
    const params = {
      messages: [],
      systemPrompt: [],
      userContext: {},
      systemContext: {},
      toolUseContext: { agentId, options: { sessionId: 's-1' } },
    }
    return { params, logEvent: vi.fn() }
  }

  it('starts upkeep after the core, for the main agent only', async () => {
    const order: string[] = []
    vi.spyOn(extractionModule, 'runMemoryExtraction').mockImplementation(async () => {
      order.push('extract')
    })
    vi.spyOn(consolidationModule, 'runMemoryConsolidation').mockImplementation(async () => {
      order.push('consolidate')
    })
    const core = async () => {
      order.push('core')
      return { preventContinuation: false, blockerRows: [] }
    }
    const verdict = await hooks.around(NATIVE_EVENTS.turnEnd, turnEnd(), undefined, core)
    expect(verdict).toEqual({ preventContinuation: false, blockerRows: [] })
    expect(order).toEqual(['core', 'extract', 'consolidate'])

    order.length = 0
    await hooks.around(NATIVE_EVENTS.turnEnd, turnEnd('sub-1'), undefined, core, { agentId: 'sub-1' })
    expect(order).toEqual(['core'])
  })
})

describe('halting tools', () => {
  function run(tool: Partial<ToolContract>, agentId?: string): AdmittedRun {
    return {
      tool: { name: 'T', haltsForUser: () => true, ...tool },
      block: { type: 'tool-call', toolCallId: 'c-1', toolName: 'T', args: {} },
      rawInput: {},
      callContext: {
        agentId,
        readAppState: () => ({ permissionRules: {} }),
        writeAppState: () => {},
      },
    } as unknown as AdmittedRun
  }

  it('asks through the tool own halt when it has one', async () => {
    const haltForUser = vi.fn(async function* (): AsyncGenerator<DeferredMessageUpdate, StageStep> {
      return 'continue'
    })
    const { step, updates } = await drain(haltForUserStage(run({ haltForUser })))
    expect(haltForUser).toHaveBeenCalledOnce()
    expect(step).toBe('continue')
    expect(updates).toEqual([])
  })

  it('suspends the loop for a tool without its own halt', async () => {
    const { step, updates } = await drain(haltForUserStage(run({})))
    expect(step).toBe('stop')
    expect(updates).toEqual([{ pendingToolUse: { toolUseId: 'c-1', toolName: 'T' } }])
  })

  it('runs unasked under the session when the tool says so', async () => {
    const haltForUser = vi.fn()
    const { step } = await drain(
      haltForUserStage(run({ haltForUser, runsWithoutHaltUnderSession: true } as Partial<ToolContract>, 'sub-1')),
    )
    expect(step).toBe('continue')
    expect(haltForUser).not.toHaveBeenCalled()
  })

  it('declares the plan tools halts on their contracts', () => {
    expect(PlanOnTool.haltForUser).toBeTypeOf('function')
    expect(PlanOnTool.runsWithoutHaltUnderSession).toBeUndefined()
    expect(ExitPlanModeTool.haltForUser).toBeTypeOf('function')
    expect(ExitPlanModeTool.runsWithoutHaltUnderSession).toBe(true)
  })
})
