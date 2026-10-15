import { describe, it, expect } from 'vitest'
import {
  isLastStep,
  isMaxFailures,
  shouldFireBudgetWarning,
} from '../engine/loop/stepBudget'
import {
  defaultAgentLoopSettings,
} from '../config/agentLoopConfig'
import { createAgentLoopState } from '../engine/loop/agentLoopState'

describe('isLastStep', () => {
  it('returns false when maxTurns is undefined', () => {
    expect(isLastStep(50, undefined)).toBe(false)
  })

  it('returns false below the limit', () => {
    expect(isLastStep(9, 10)).toBe(false)
  })

  it('returns true at the limit', () => {
    expect(isLastStep(10, 10)).toBe(true)
  })

  it('returns true past the limit', () => {
    expect(isLastStep(11, 10)).toBe(true)
  })
})

describe('isMaxFailures', () => {
  const baseSettings = defaultAgentLoopSettings()
  it('false until threshold', () => {
    const state = createAgentLoopState(baseSettings)
    state.failureStreak = 4
    expect(isMaxFailures(state, baseSettings)).toBe(false)
  })

  it('true at threshold', () => {
    const state = createAgentLoopState(baseSettings)
    state.failureStreak = 5
    expect(isMaxFailures(state, baseSettings)).toBe(true)
  })
})

describe('shouldFireBudgetWarning', () => {
  it('false when maxTurns is undefined', () => {
    const state = createAgentLoopState(defaultAgentLoopSettings())
    expect(shouldFireBudgetWarning(state, 100, undefined)).toBe(false)
  })

  it('false below the 75% threshold', () => {
    const state = createAgentLoopState(defaultAgentLoopSettings())
    expect(shouldFireBudgetWarning(state, 7, 10)).toBe(false)
  })

  it('true at exactly the 75% threshold', () => {
    const state = createAgentLoopState(defaultAgentLoopSettings())
    expect(shouldFireBudgetWarning(state, 75, 100)).toBe(true)
  })

  it('false once budgetWarnFired latch is set', () => {
    const state = createAgentLoopState(defaultAgentLoopSettings())
    state.budgetWarnFired = true
    expect(shouldFireBudgetWarning(state, 90, 100)).toBe(false)
  })
})
