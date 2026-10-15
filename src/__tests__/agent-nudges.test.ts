import { describe, it, expect } from 'vitest'
import { renderNudge } from '../engine/loop/nudges'

describe('renderNudge', () => {
  it('LOOP_5 mentions repetition count and window size', () => {
    const text = renderNudge('LOOP_5', { repetitionCount: 5, windowSize: 12 })
    expect(text).toMatch(/5 times/)
    expect(text).toMatch(/last 12 actions/)
  })

  it('LOOP_8 escalates wording', () => {
    const text = renderNudge('LOOP_8', { repetitionCount: 8, windowSize: 15 })
    expect(text).toMatch(/8 times/)
    expect(text).toMatch(/different approach/i)
  })

  it('LOOP_12 carries the strongest framing', () => {
    const text = renderNudge('LOOP_12', { repetitionCount: 12, windowSize: 20 })
    expect(text).toMatch(/12 times/)
    expect(text).toMatch(/different approach/i)
  })

  it('STAGNATION_5 mentions consecutive identical pages', () => {
    const text = renderNudge('STAGNATION_5', { stagnantPages: 6 })
    expect(text).toMatch(/6 consecutive actions/)
  })

  it('BUDGET_75 includes used / total / percent / remaining', () => {
    const text = renderNudge('BUDGET_75', { turnCount: 75, maxTurns: 100 })
    expect(text).toMatch(/75\/100/)
    expect(text).toMatch(/75%/)
    expect(text).toMatch(/25 steps remaining/)
  })

  it('LAST_STEP_FORCE_DONE makes clear no tools are available', () => {
    const text = renderNudge('LAST_STEP_FORCE_DONE')
    expect(text).toMatch(/last step/i)
    expect(text).toMatch(/no tools/i)
  })

  it('MAX_FAILURES includes failure count when supplied', () => {
    const text = renderNudge('MAX_FAILURES', { failureCount: 5 })
    expect(text).toMatch(/5 times consecutively/)
  })
})
