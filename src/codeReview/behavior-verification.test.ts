import { describe, expect, it, vi } from 'vitest'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import type { ReviewModelRequest, ReviewModelRunner } from './runner'
import { BEHAVIOR_REPORT_TOOL, runBehaviorVerification, type BehaviorExecution, type BehaviorVerificationInput } from './behavior-verification'

function invoke(tool: ToolContract, args: Record<string, unknown>) {
  return tool.call(args, {} as Parameters<ToolContract['call']>[1], (() => ({ behavior: 'allow' })) as Parameters<ToolContract['call']>[2], {} as Parameters<ToolContract['call']>[3])
}
function report(request: ReviewModelRequest, type: string, ref: string, quote: string, description = type) {
  return invoke(request.tools.find(tool => tool.name === BEHAVIOR_REPORT_TOOL)!, { type, description, evidence: [{ ref, quote }] })
}
function setup(run: (request: ReviewModelRequest) => Promise<void>, overrides: Partial<BehaviorVerificationInput> = {}) {
  const executions = new Map<string, BehaviorExecution>()
  const record = vi.fn<BehaviorVerificationInput['record']>(async () => {})
  const runner: ReviewModelRunner = vi.fn(async request => { await run(request); return { text: 'Verification complete', interrupted: false } })
  const input: BehaviorVerificationInput = {
    runner, taskId: 'verify', scopeManifest: 'changed widget', guidance: 'npm test', diff: '+widget behavior',
    approvedTools: [], executions, record, signal: new AbortController().signal, uiChanged: false, ...overrides,
  }
  return { input, executions, record, runner }
}
function addExecution(executions: Map<string, BehaviorExecution>, ref: string, overrides: Partial<BehaviorExecution> = {}) {
  executions.set(ref, { ref, kind: 'command', succeeded: true, observation: 'PASS saves item; PASS rejects empty item', ...overrides })
}
async function mainAndBoundary(request: ReviewModelRequest) {
  await report(request, 'main-path', 'test', 'PASS saves item')
  await report(request, 'boundary', 'test', 'PASS rejects empty item')
}

describe('model-driven behavior verification', () => {
  it('uses only approved tools, composes verification material, and persists observed main paths and boundaries', async () => {
    const fixture = setup(async request => {
      expect(request.maxTurns).toBe(16)
      expect(request.tools.map(tool => tool.name)).toEqual(['ApprovedTest', BEHAVIOR_REPORT_TOOL])
      expect(request.blocks.some(block => block.source === 'verify-handoff')).toBe(true)
      expect(request.blocks.find(block => block.source === 'review-material')).toMatchObject({ text: '+widget behavior', provenance: 'repository-material' })
      expect(request.blocks.find(block => block.source === 'applicable-guidance')?.text).toBe('npm test')
      expect(request.tools[1]?.argsSchema?.required).toEqual(['type', 'description', 'evidence'])
      await invoke(request.tools[0]!, {})
      await mainAndBoundary(request)
    })
    fixture.input.approvedTools = [declareTool({ name: 'ApprovedTest', description: async () => 'Approved fixed test', call: async () => {
      addExecution(fixture.executions, 'test')
      return { data: { ref: 'test', observation: fixture.executions.get('test')!.observation } }
    } })]
    const result = await runBehaviorVerification(fixture.input)
    expect(result).toMatchObject({ state: 'completed', behaviorVerified: true, uncovered: [], covered: { mainPaths: ['main-path'], boundaries: ['boundary'], ui: false } })
    expect(fixture.record).toHaveBeenCalledTimes(2)
    expect(result.receipts).toEqual(fixture.record.mock.calls.map(call => call[0]))
  })

  it.each([
    ['forged reference', undefined, 'forged', 'PASS saves item', 'unknown-execution-reference'],
    ['mismatched ledger key', { ref: 'other' }, 'test', 'PASS saves item', 'unknown-execution-reference'],
    ['failed execution', { succeeded: false }, 'test', 'PASS saves item', 'execution-not-successful'],
    ['fabricated assertion', {}, 'test', 'PASS fabricated assertion', 'assertion-not-observed'],
  ] as const)('rejects %s', async (_label, execution, ref, quote, reason) => {
    const fixture = setup(async request => {
      expect(await report(request, 'main-path', ref, quote)).toMatchObject({ isError: true, data: { accepted: false, reason } })
    })
    if (execution) addExecution(fixture.executions, 'test', execution)
    const result = await runBehaviorVerification(fixture.input)
    expect(result.behaviorVerified).toBe(false)
    expect(result.uncovered).toContain(reason)
    expect(fixture.record).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { type: 'main-path', description: 'claim', evidence: [] },
    { type: 'main-path', description: 'claim', evidence: [{ ref: 'test', quote: ' ' }] },
    { type: 'other', description: 'claim', evidence: [{ ref: 'test', quote: 'PASS saves item' }] },
    { type: 'main-path', description: 'claim', evidence: [{ ref: 'test', quote: 'PASS saves item', interaction: true }] },
    { type: 'main-path', description: 'claim', evidence: [{ ref: 'test', quote: 'PASS saves item' }], succeeded: true },
  ])('rejects malformed check %# even when the runner returns successfully', async args => {
    const fixture = setup(async request => {
      expect((await invoke(request.tools.find(tool => tool.name === BEHAVIOR_REPORT_TOOL)!, args)).isError).toBe(true)
    })
    addExecution(fixture.executions, 'test')
    expect((await runBehaviorVerification(fixture.input)).behaviorVerified).toBe(false)
    expect(fixture.record).not.toHaveBeenCalled()
  })

  it('validates every evidence reference rather than accepting one good reference', async () => {
    const fixture = setup(async request => {
      await invoke(request.tools[0]!, { type: 'main-path', description: 'mixed', evidence: [{ ref: 'test', quote: 'PASS saves item' }, { ref: 'forged', quote: 'PASS saves item' }] })
    })
    addExecution(fixture.executions, 'test')
    const result = await runBehaviorVerification(fixture.input)
    expect(result.uncovered).toContain('unknown-execution-reference')
    expect(result.receipts).toEqual([])
  })

  it('does not turn final prose or a command exit alone into coverage', async () => {
    const fixture = setup(async () => {})
    addExecution(fixture.executions, 'test')
    const result = await runBehaviorVerification(fixture.input)
    expect(result).toMatchObject({ behaviorVerified: false, receipts: [], uncovered: ['main-path-not-verified', 'boundary-not-verified'] })
  })

  it('requires a boundary even with a valid main path', async () => {
    const fixture = setup(async request => { await report(request, 'main-path', 'test', 'PASS saves item') })
    addExecution(fixture.executions, 'test')
    expect((await runBehaviorVerification(fixture.input)).uncovered).toEqual(['boundary-not-verified'])
  })

  it.each([false, undefined])('does not count navigation or page reading as main-path interaction (%s)', async interaction => {
    const fixture = setup(async request => {
      await report(request, 'main-path', 'page', 'Saved item')
      await report(request, 'boundary', 'test', 'PASS rejects empty item')
    }, { uiChanged: true })
    addExecution(fixture.executions, 'page', { kind: 'browser', interaction, observation: 'Saved item' })
    addExecution(fixture.executions, 'test')
    const result = await runBehaviorVerification(fixture.input)
    expect(result.covered.mainPaths).toEqual([])
    expect(result.uncovered).toContain('main-path-not-exercised')
    expect(result.uncovered).toContain('ui-interaction-not-verified')
    expect(result.behaviorVerified).toBe(false)
  })

  it('requires browser interaction for UI even when command assertions cover runtime', async () => {
    const fixture = setup(mainAndBoundary, { uiChanged: true })
    addExecution(fixture.executions, 'test', { interaction: true })
    const result = await runBehaviorVerification(fixture.input)
    expect(result.covered.mainPaths).toEqual(['main-path'])
    expect(result.uncovered).toEqual(['ui-interaction-not-verified'])
    expect(result.behaviorVerified).toBe(false)
  })

  it('covers UI with an observed successful interaction and boundary assertion', async () => {
    const fixture = setup(async request => {
      await report(request, 'main-path', 'click', 'Saved item')
      await report(request, 'boundary', 'test', 'PASS rejects empty item')
    }, { uiChanged: true })
    addExecution(fixture.executions, 'click', { kind: 'browser', interaction: true, observation: 'Click save: Saved item' })
    addExecution(fixture.executions, 'test')
    expect(await runBehaviorVerification(fixture.input)).toMatchObject({ covered: { ui: true }, behaviorVerified: true, uncovered: [] })
  })

  it('retains honest receipts but never completes an interrupted model run', async () => {
    const fixture = setup(async () => {}, { runner: async request => { await mainAndBoundary(request); return { text: 'All done', interrupted: true } } })
    addExecution(fixture.executions, 'test')
    const result = await runBehaviorVerification(fixture.input)
    expect(result).toMatchObject({ state: 'interrupted', behaviorVerified: false, uncovered: ['verification-interrupted'] })
    expect(result.receipts).toHaveLength(2)
  })

  it('reports runner failure without leaking the error or claiming completion', async () => {
    const fixture = setup(async () => { throw new Error('sensitive host detail') })
    const result = await runBehaviorVerification(fixture.input)
    expect(result.state).toBe('failed')
    expect(result.behaviorVerified).toBe(false)
    expect(JSON.stringify(result)).not.toContain('sensitive host detail')
  })

  it('does not count receipts that the host failed to persist', async () => {
    const fixture = setup(mainAndBoundary, { record: async () => { throw new Error('unavailable') } })
    addExecution(fixture.executions, 'test')
    const result = await runBehaviorVerification(fixture.input)
    expect(result.receipts).toEqual([])
    expect(result.uncovered).toContain('check-record-failed')
  })

  it('does not complete a malformed model result even after valid reports', async () => {
    const fixture = setup(async () => {}, { runner: async request => {
      await mainAndBoundary(request)
      return {} as Awaited<ReturnType<ReviewModelRunner>>
    } })
    addExecution(fixture.executions, 'test')
    expect(await runBehaviorVerification(fixture.input)).toMatchObject({ state: 'failed', behaviorVerified: false, uncovered: ['verification-failed'] })
  })

  it('does not change returned coverage when receipt persistence finishes after cancellation', async () => {
    const controller = new AbortController()
    let release!: () => void
    let submitted!: Promise<unknown>
    const fixture = setup(async request => {
      submitted = report(request, 'main-path', 'test', 'PASS saves item')
      await submitted
    }, { signal: controller.signal, record: async () => {
      controller.abort()
      await new Promise<void>(resolve => { release = resolve })
    } })
    addExecution(fixture.executions, 'test')
    const result = await runBehaviorVerification(fixture.input)
    release()
    await submitted
    expect(result).toMatchObject({ state: 'cancelled', receipts: [], behaviorVerified: false, covered: { mainPaths: [] } })
  })

  it('never starts a runner after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const fixture = setup(async () => {}, { signal: controller.signal })
    expect((await runBehaviorVerification(fixture.input)).state).toBe('cancelled')
    expect(fixture.runner).not.toHaveBeenCalled()
  })

  it('bounds an uncooperative runner and refuses late reports and host tool calls after cancellation', async () => {
    const controller = new AbortController()
    let request!: ReviewModelRequest
    const hostCall = vi.fn(async () => ({ data: {} }))
    const fixture = setup(async received => {
      request = received
      controller.abort()
      await new Promise<void>(() => {})
    }, { signal: controller.signal, approvedTools: [declareTool({ name: 'ApprovedRead', description: async () => 'read', call: hostCall })] })
    addExecution(fixture.executions, 'test')
    const result = await runBehaviorVerification(fixture.input)
    expect(result).toMatchObject({ state: 'cancelled', behaviorVerified: false })
    expect(request.signal.aborted).toBe(true)
    expect((await report(request, 'main-path', 'test', 'PASS saves item')).isError).toBe(true)
    await expect(invoke(request.tools[0]!, {})).rejects.toThrow('verification-closed')
    expect(hostCall).not.toHaveBeenCalled()
    expect(fixture.record).not.toHaveBeenCalled()
  })

  it('times out even if the runner ignores its abort signal', async () => {
    vi.useFakeTimers()
    try {
      let signal!: AbortSignal
      const fixture = setup(async request => { signal = request.signal; await new Promise<void>(() => {}) }, { timeoutMs: 10 })
      const pending = runBehaviorVerification(fixture.input)
      await vi.advanceTimersByTimeAsync(10)
      expect(await pending).toMatchObject({ state: 'timed-out', behaviorVerified: false })
      expect(signal.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('bounds check submissions and cannot recover fake completion after malformed reports', async () => {
    const fixture = setup(async request => { await mainAndBoundary(request); await report(request, 'boundary', 'test', 'PASS rejects empty item') }, { maxChecks: 2 })
    addExecution(fixture.executions, 'test')
    const result = await runBehaviorVerification(fixture.input)
    expect(result.receipts).toHaveLength(2)
    expect(result.behaviorVerified).toBe(false)
    expect(result.uncovered).toEqual(['check-budget-exhausted'])
  })

  it.each([{ maxTurns: 0 }, { maxTurns: 33 }, { maxChecks: 65 }, { timeoutMs: Infinity }])('rejects unbounded configuration %j', async limits => {
    const fixture = setup(async () => {}, limits)
    await expect(runBehaviorVerification(fixture.input)).rejects.toThrow('invalid-behavior-verification-budget')
    expect(fixture.runner).not.toHaveBeenCalled()
  })
})
