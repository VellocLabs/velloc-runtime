import { describe, it, expect } from 'vitest'
import {
  defaultAgentLoopSettings,
  type AgentLoopSettings,
} from '../config/agentLoopConfig'
import {
  createAgentLoopState,
  type PageFingerprint,
} from '../engine/loop/agentLoopState'
import {
  getNudge,
  recordAction,
  recordPageFingerprint,
  reset,
} from '../engine/loop/actionLoopDetector'

function settings(overrides: Partial<AgentLoopSettings> = {}): AgentLoopSettings {
  return { ...defaultAgentLoopSettings(), ...overrides }
}

function fp(url: string, count: number, hash: string): PageFingerprint {
  return { url, interactiveCount: count, domHash: hash }
}

describe('actionLoopDetector', () => {
  describe('recordAction', () => {
    it('skips empty hashes (exempt tools)', () => {
      const state = createAgentLoopState(settings())
      recordAction(state, '')
      expect(state.actionHashes).toHaveLength(0)
      expect(state.maxRepetitionCount).toBe(0)
    })

    it('respects loopDetectionEnabled=false', () => {
      const state = createAgentLoopState(settings({ loopDetectionEnabled: false }))
      recordAction(state, 'abc')
      expect(state.actionHashes).toHaveLength(0)
    })

    it('caps the rolling window at loopDetectionWindow', () => {
      const state = createAgentLoopState(settings({ loopDetectionWindow: 3 }))
      recordAction(state, 'a')
      recordAction(state, 'b')
      recordAction(state, 'c')
      recordAction(state, 'd')
      expect(state.actionHashes).toEqual(['b', 'c', 'd'])
    })

    it('tracks the most-repeated hash + its count', () => {
      const state = createAgentLoopState(settings())
      recordAction(state, 'a')
      recordAction(state, 'b')
      recordAction(state, 'a')
      recordAction(state, 'a')
      expect(state.mostRepeatedHash).toBe('a')
      expect(state.maxRepetitionCount).toBe(3)
    })
  })

  describe('recordPageFingerprint', () => {
    it('increments stagnation counter on identical fingerprints', () => {
      const state = createAgentLoopState(settings())
      recordPageFingerprint(state, fp('/x', 10, 'h1'))
      expect(state.consecutiveStagnantPages).toBe(0)
      recordPageFingerprint(state, fp('/x', 10, 'h1'))
      expect(state.consecutiveStagnantPages).toBe(1)
      recordPageFingerprint(state, fp('/x', 10, 'h1'))
      expect(state.consecutiveStagnantPages).toBe(2)
    })

    it('resets stagnation counter when URL changes', () => {
      const state = createAgentLoopState(settings())
      recordPageFingerprint(state, fp('/x', 10, 'h1'))
      recordPageFingerprint(state, fp('/x', 10, 'h1'))
      expect(state.consecutiveStagnantPages).toBe(1)
      recordPageFingerprint(state, fp('/y', 10, 'h1'))
      expect(state.consecutiveStagnantPages).toBe(0)
    })

    it('resets stagnation counter when domHash changes (same URL)', () => {
      const state = createAgentLoopState(settings())
      recordPageFingerprint(state, fp('/x', 10, 'h1'))
      recordPageFingerprint(state, fp('/x', 10, 'h1'))
      expect(state.consecutiveStagnantPages).toBe(1)
      recordPageFingerprint(state, fp('/x', 10, 'h2'))
      expect(state.consecutiveStagnantPages).toBe(0)
    })
  })

  describe('getNudge', () => {
    it('returns null when nothing has tripped', () => {
      const state = createAgentLoopState(settings())
      expect(getNudge(state)).toBe(null)
    })

    it('fires LOOP_5 at exactly 5 repeats', () => {
      const state = createAgentLoopState(settings())
      for (let i = 0; i < 4; i++) recordAction(state, 'a')
      expect(getNudge(state)).toBe(null)
      recordAction(state, 'a')
      const nudge = getNudge(state)
      expect(nudge?.kind).toBe('LOOP_5')
      expect(nudge?.context.repetitionCount).toBe(5)
    })

    it('does not re-fire LOOP_5 on subsequent calls until threshold is escalated', () => {
      const state = createAgentLoopState(settings())
      for (let i = 0; i < 5; i++) recordAction(state, 'a')
      expect(getNudge(state)?.kind).toBe('LOOP_5')
      // Same threshold — nothing new to say.
      expect(getNudge(state)).toBe(null)
    })

    it('escalates to LOOP_8 then LOOP_12', () => {
      const state = createAgentLoopState(settings())
      for (let i = 0; i < 5; i++) recordAction(state, 'a')
      expect(getNudge(state)?.kind).toBe('LOOP_5')
      for (let i = 0; i < 3; i++) recordAction(state, 'a')
      expect(getNudge(state)?.kind).toBe('LOOP_8')
      for (let i = 0; i < 4; i++) recordAction(state, 'a')
      expect(getNudge(state)?.kind).toBe('LOOP_12')
    })

    it('fires STAGNATION_5 after 5 consecutive identical fingerprints', () => {
      const state = createAgentLoopState(settings())
      // First call sets the baseline; consecutive identical calls increment.
      // Threshold is `>= 5` consecutive identical fingerprints, so we need
      // 6 total identical pushes to reach a counter of 5.
      for (let i = 0; i < 6; i++) {
        recordPageFingerprint(state, fp('/x', 10, 'h1'))
      }
      const nudge = getNudge(state)
      expect(nudge?.kind).toBe('STAGNATION_5')
      expect(nudge?.context.stagnantPages).toBeGreaterThanOrEqual(5)
    })

    it('reset clears all latches', () => {
      const state = createAgentLoopState(settings())
      for (let i = 0; i < 5; i++) recordAction(state, 'a')
      getNudge(state) // latches LOOP_5
      reset(state)
      expect(state.actionHashes).toHaveLength(0)
      expect(state.lastNudgeKind).toBe(null)
      expect(state.failureStreak).toBe(0)
      expect(state.budgetWarnFired).toBe(false)
      // After reset, the same loop should fire LOOP_5 again next time it crosses.
      for (let i = 0; i < 5; i++) recordAction(state, 'b')
      expect(getNudge(state)?.kind).toBe('LOOP_5')
    })
  })
})
