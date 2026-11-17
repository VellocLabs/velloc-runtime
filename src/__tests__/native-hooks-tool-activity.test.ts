import { beforeEach, describe, expect, it, vi } from 'vitest'

const manager = {
  markToolStart: vi.fn(),
  markToolEnd: vi.fn(async () => {}),
  markStreamStart: vi.fn(),
  markStreamEnd: vi.fn(),
}
import * as sessionManagerModule from '../browser/worker/SharedWorkerSessionManager'
import { defaultAgentLoopSettings } from '../config/agentLoopConfig'
import { createAgentLoopState } from '../engine/loop/agentLoopState'
import { recordSettledToolMeta } from '../engine/loop/actionLoopDetector'
import { sessionActivityHooks } from '../browser/worker/sessionActivityHooks'
import { createNativeHooks } from '../toolkit/nativeHooks'
import { NATIVE_EVENTS } from '../toolkit/nativeHookEvents'
import { defaultToolBatchRunner } from '../toolkit/run/toolBatchRunner'
import type { ToolCallContext } from '../toolkit/toolCallContext'

beforeEach(() => {
  for (const fn of Object.values(manager)) fn.mockClear()
  vi.spyOn(sessionManagerModule, 'getActiveSessionManager').mockReturnValue(
    manager as unknown as ReturnType<typeof sessionManagerModule.getActiveSessionManager>,
  )
})

function context(extra: Partial<ToolCallContext> = {}): ToolCallContext {
  return { options: { sessionId: 's-1' }, ...extra } as unknown as ToolCallContext
}

describe('the batch bracket raises outer events', () => {
  it('raises tool.started and tool.settled at the outer position with their payloads', async () => {
    const seen: Array<{ event: string; e: unknown; live: unknown }> = []
    const record = (event: string) => ({
      module: 'rec',
      event,
      position: 'outer' as const,
      scope: 'all' as const,
      observe: (e: unknown, live: unknown) => {
        seen.push({ event, e, live })
      },
    })
    const hooks = createNativeHooks(
      { [NATIVE_EVENTS.toolStarted]: ['rec'], [NATIVE_EVENTS.toolSettled]: ['rec'] },
      [record(NATIVE_EVENTS.toolStarted), record(NATIVE_EVENTS.toolSettled)],
    )
    const ctx = context({ nativeHooks: hooks, agentId: 'sub-1' })
    const meta = { actionHashes: ['h'] }
    await defaultToolBatchRunner.before(ctx, 'Read', { path: 'a' })
    await defaultToolBatchRunner.after(ctx, 'Read', meta, false)
    expect(seen).toEqual([
      { event: NATIVE_EVENTS.toolStarted, e: { toolName: 'Read', input: { path: 'a' } }, live: ctx },
      { event: NATIVE_EVENTS.toolSettled, e: { toolName: 'Read', agentMeta: meta, succeeded: false }, live: ctx },
    ])
  })
})

describe('session activity', () => {
  const hooks = createNativeHooks(
    {
      [NATIVE_EVENTS.toolStarted]: ['sessionActivity'],
      [NATIVE_EVENTS.toolSettled]: ['sessionActivity'],
      [NATIVE_EVENTS.turnStreamStart]: ['sessionActivity'],
      [NATIVE_EVENTS.turnStreamEnd]: ['sessionActivity'],
    },
    sessionActivityHooks(),
  )

  it('marks the tool kind and the browser action type', async () => {
    await hooks.observe(NATIVE_EVENTS.toolStarted, { toolName: 'mcp__x__y', input: {} }, context(), { position: 'outer' })
    await hooks.observe(
      NATIVE_EVENTS.toolStarted,
      { toolName: 'browser_actions', input: { actions: [{ type: 'click' }] } },
      context(),
      { position: 'outer' },
    )
    await hooks.observe(NATIVE_EVENTS.toolStarted, { toolName: 'BrowserClick', input: {} }, context(), { position: 'outer' })
    expect(manager.markToolStart.mock.calls).toEqual([
      ['s-1', 'mcp__x__y', 'mcp', undefined],
      ['s-1', 'browser_actions', 'local', 'click'],
      ['s-1', 'BrowserClick', 'browser', undefined],
    ])
  })

  it('marks nothing without a session', async () => {
    await hooks.observe(NATIVE_EVENTS.toolStarted, { toolName: 'Read', input: {} }, { options: {} }, { position: 'outer' })
    await hooks.observe(
      NATIVE_EVENTS.toolSettled,
      { toolName: 'Read', agentMeta: undefined, succeeded: true },
      { options: {} },
      { position: 'outer' },
    )
    hooks.observeSync(NATIVE_EVENTS.turnStreamStart, { sessionId: '' }, undefined)
    expect(manager.markToolStart).not.toHaveBeenCalled()
    expect(manager.markToolEnd).not.toHaveBeenCalled()
    expect(manager.markStreamStart).not.toHaveBeenCalled()
  })

  it('marks the end with its success, and the stream edges synchronously', async () => {
    await hooks.observe(
      NATIVE_EVENTS.toolSettled,
      { toolName: 'Read', agentMeta: undefined, succeeded: false },
      context(),
      { position: 'outer' },
    )
    expect(manager.markToolEnd).toHaveBeenCalledWith('s-1', false)
    hooks.observeSync(NATIVE_EVENTS.turnStreamStart, { sessionId: 's-1' }, undefined)
    expect(manager.markStreamStart).toHaveBeenCalledWith('s-1')
    hooks.observeSync(NATIVE_EVENTS.turnStreamEnd, { sessionId: 's-1' }, undefined)
    expect(manager.markStreamEnd).toHaveBeenCalledWith('s-1')
  })

  it('is not raised at the inner position', async () => {
    await hooks.observe(NATIVE_EVENTS.toolStarted, { toolName: 'Read', input: {} }, context())
    expect(manager.markToolStart).not.toHaveBeenCalled()
  })
})

describe('agent loop bookkeeping', () => {
  it('records action hashes and stashes the page fingerprint', () => {
    const state = createAgentLoopState(defaultAgentLoopSettings())
    const fingerprint = { url: 'u', interactiveCount: 1, domHash: 'd' }
    recordSettledToolMeta(state, { actionHashes: ['a', 'b'], pageFingerprint: fingerprint })
    expect(state.actionHashes).toEqual(['a', 'b'])
    expect(state.pendingFingerprint).toBe(fingerprint)
  })

  it('does nothing without a loop state or metadata', () => {
    const state = createAgentLoopState(defaultAgentLoopSettings())
    recordSettledToolMeta(undefined, { actionHashes: ['a'] })
    recordSettledToolMeta(state, undefined)
    expect(state.actionHashes).toEqual([])
  })
})
