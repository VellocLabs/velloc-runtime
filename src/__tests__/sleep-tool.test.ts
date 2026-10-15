import { describe, expect, it } from 'vitest'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { SleepTool } from '../toolkit/builtin/sleepWait'

const PARENT_MESSAGE = {
  type: 'assistant',
  uuid: 'assistant-1',
  message: { role: 'assistant', content: [] },
} as never

const ALLOW = async () => ({ behavior: 'allow' as const })

function makeContext() {
  return createNoopToolUseContext({
    tools: [SleepTool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sleep-test',
  })
}

describe('SleepTool', () => {
  describe('metadata', () => {
    it('is named Sleep, read-only, and concurrency-safe', () => {
      expect(SleepTool.name).toBe('Sleep')
      expect(SleepTool.readsOnly({ seconds: 1 })).toBe(true)
      expect(SleepTool.parallelSafe({ seconds: 1 })).toBe(true)
    })
  })

  describe('validateInput', () => {
    it('accepts a positive finite duration', async () => {
      const result = await SleepTool.checkInput?.(
        { seconds: 1 },
        makeContext(),
      )
      expect(result).toEqual({ result: true })
    })

    it('rejects a non-number', async () => {
      const result = await SleepTool.checkInput?.(
        { seconds: 'soon' } as never,
        makeContext(),
      )
      expect(result?.result).toBe(false)
    })

    it('rejects zero / negative', async () => {
      const zero = await SleepTool.checkInput?.(
        { seconds: 0 },
        makeContext(),
      )
      expect(zero?.result).toBe(false)
      const negative = await SleepTool.checkInput?.(
        { seconds: -5 },
        makeContext(),
      )
      expect(negative?.result).toBe(false)
    })

    it('rejects durations beyond the 1-hour cap', async () => {
      const result = await SleepTool.checkInput?.(
        { seconds: 3601 },
        makeContext(),
      )
      expect(result?.result).toBe(false)
    })
  })

  describe('call', () => {
    it('resolves after the full duration when uninterrupted', async () => {
      const result = await SleepTool.call(
        { seconds: 0.02 },
        makeContext(),
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(result.data).toBe('Slept for 0.02s.')
    })

    it('returns the interrupted message when the abort signal fires', async () => {
      const context = makeContext()
      // Abort almost immediately so the 30s sleep resolves fast.
      setTimeout(() => context.cancelSource.abort(), 5)
      const result = await SleepTool.call(
        { seconds: 30 },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(result.data).toMatch(
        /^Sleep interrupted after \d+\.\d+s \(requested 30s\)\.$/,
      )
    })

    it('returns immediately when the signal is already aborted', async () => {
      const context = makeContext()
      context.cancelSource.abort()
      const result = await SleepTool.call(
        { seconds: 30 },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(result.data).toMatch(/^Sleep interrupted after /)
    })
  })

  // A message the user sends mid-turn wakes an in-progress Sleep,
  // so it lands between this tool result and the next model call instead of
  // waiting out the whole duration (or missing the turn entirely).
  describe('wakes on parked user input', () => {
    function withPendingInput(
      context: ReturnType<typeof makeContext>,
      hasPendingInjectMessages: () => boolean,
    ) {
      return {
        ...context,
        options: { ...context.options, hasPendingInjectMessages },
      }
    }

    it('ends early once the session has a parked inject message', async () => {
      let pending = false
      const context = withPendingInput(makeContext(), () => pending)
      setTimeout(() => {
        pending = true
      }, 20)
      const started = Date.now()
      const result = await SleepTool.call(
        { seconds: 30 },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(result.data).toMatch(
        /^Sleep ended after \d+\.\d+s \(requested 30s\): the user sent a new message\.$/,
      )
    })

    it('returns at once when input was parked before the Sleep began', async () => {
      const context = withPendingInput(makeContext(), () => true)
      const started = Date.now()
      const result = await SleepTool.call(
        { seconds: 30 },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(result.data).toMatch(/: the user sent a new message\.$/)
    })

    it('a fork (agentId set) sleeps its full duration — only the main agent drains user input', async () => {
      const context = {
        ...withPendingInput(makeContext(), () => true),
        agentId: 'afork-0123456789abcdef',
      }
      const result = await SleepTool.call(
        { seconds: 0.4 },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(result.data).toBe('Slept for 0.4s.')
    })

    it('without the signal (minimal contexts) it sleeps as before', async () => {
      const result = await SleepTool.call(
        { seconds: 0.3 },
        makeContext(),
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(result.data).toBe('Slept for 0.3s.')
    })
  })
})
