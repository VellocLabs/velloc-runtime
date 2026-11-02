import { describe, it, expect, vi } from 'vitest'
import { ReviewWorkerPool, createReviewModelRunner } from './runner'
import { runTurnLoop } from '../engine/turnInterpreter'
import type { ToolCallContext } from '../toolkit/toolCallContext'
vi.mock('../engine/turnInterpreter', () => ({ runTurnLoop: vi.fn(async function* (input) { await input.commitTerminal({ kind: 'outcome', phase: 'completed', outcome: { reason: 'completed' } }); yield { type: 'assistant', message: { content: [{ type: 'text', text: '{}' }] } } }) }))

describe('review worker admission', () => {
  it('never starts more than four workers and does not fake queued starts', async () => {
    const pool = new ReviewWorkerPool(4)
    const signal = new AbortController().signal
    let active = 0, peak = 0, started = 0
    const releases: Array<() => void> = []
    const work = Array.from({ length: 12 }, () => pool.run(signal, async () => {
      started++; active++; peak = Math.max(peak, active)
      await new Promise<void>(resolve => releases.push(resolve))
      active--
    }))
    await Promise.resolve()
    expect(started).toBe(4)
    for (let i = 0; i < 12; i++) { releases.shift()!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
    await Promise.all(work)
    expect(peak).toBe(4); expect(started).toBe(12)
  })
  it('never launches queued work after cancellation', async () => {
    const pool = new ReviewWorkerPool(1)
    const controller = new AbortController()
    let release!: () => void, queuedStarted = false
    const first = pool.run(controller.signal, () => new Promise<void>(resolve => { release = resolve }))
    const queued = pool.run(controller.signal, async () => { queuedStarted = true }).catch(error => error.message)
    controller.abort(); release(); await first
    expect(await queued).toBe('review-cancelled'); expect(queuedStarted).toBe(false)
  })
})

describe('isolated review model transport', () => {
  it('assembles first-turn system safety and guidance without parent history', async () => {
    const parent = { options: { mainLoopModel: 'test', tools: [{ name: 'Bash' }], commands: [], cwd: '/repo', projectRoot: '/repo', sessionId: 's' },
      cancelSource: new AbortController(), fileReadLedger: new Map(), messages: [{ type: 'user', message: { content: 'unrelated secret parent chat' } }],
      requestToolUseConfirm: vi.fn(), toolRunSeams: {},
      readAppState: () => ({ permissionRules: { mode: 'default' } }) } as unknown as ToolCallContext
    const gather = vi.fn(async () => ({ defaultSystemPrompt: ['generic safety'], userContext: { instructions: 'trusted user guidance' }, systemContext: { locale: 'en' } }))
    const runner = createReviewModelRunner({ context: parent, promptContextProvider: { gatherSystemPromptSources: gather }, decidePermission: () => ({ behavior: 'allow' }) })
    const result = await runner({ blocks: [{ type: 'text', text: 'untrusted diff', source: 'scope', provenance: 'repository-material' }], tools: [], signal: new AbortController().signal, taskId: 'task' })
    expect(result.interrupted).toBe(false)
    const input = vi.mocked(runTurnLoop).mock.calls.at(-1)![0]
    expect(input.baseInstructions).toEqual(['generic safety'])
    expect(input.userAmbient.instructions).toBe('trusted user guidance')
    expect(JSON.stringify(input.messages)).not.toContain('unrelated secret parent chat')
    expect(JSON.stringify(input.messages)).toContain('repository-material')
    expect(input.callContext.options.tools).toEqual([])
    expect(input.callContext.requestToolUseConfirm).toBe(parent.requestToolUseConfirm)
    expect(input.callContext.toolRunSeams).toBe(parent.toolRunSeams)
    expect(input.stepLimit).toBe(32)
    expect(gather).toHaveBeenCalledTimes(1)
  })
})


it('runs an inline report with the current task identity and a restricted tool list', async () => {
  const parent = { options: { mainLoopModel: 'test', tools: [{ name: 'Bash' }], commands: [], cwd: '/repo', projectRoot: '/repo', sessionId: 's' }, agentId: 'coordinator', turnChain: { depth: 1, chainId: 'chain' }, cancelSource: new AbortController(), fileReadLedger: new Map(), messages: [], readAppState: () => ({ permissionRules: { mode: 'default' } }) } as unknown as ToolCallContext
  const runner = createReviewModelRunner({ context: parent, promptContextProvider: { gatherSystemPromptSources: async () => ({ defaultSystemPrompt: ['safety'], userContext: {}, systemContext: {} }) }, decidePermission: () => ({ behavior: 'allow' }) })
  await runner({ execution: 'inline', blocks: [], tools: [], signal: new AbortController().signal, taskId: 'review' })
  const input = vi.mocked(runTurnLoop).mock.calls.at(-1)![0]
  expect(input.callContext.agentId).toBe('coordinator')
  expect(input.callContext.turnChain).toEqual(parent.turnChain)
  expect(input.callContext.options.tools).toEqual([])
})
