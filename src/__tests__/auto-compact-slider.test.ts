// The context popover's auto-compact handle: its range, snapping and where
// it sits (context/compaction/windowSlider), and the snapshot view that
// decides whether it may move (pickAutoCompactView). The window it sets is
// the token count to compact at, as is, capped at the model's own threshold.
// Behaviour spec: F-3.
import { describe, expect, it } from 'vitest'
import {
  choiceAtFraction,
  fractionForChoice,
  normalizeWindowChoice,
  stepChoice,
  thresholdForChoice,
  windowSliderScale,
  windowSliderScaleFor,
} from '../context/compaction/windowSlider'
import { foldTriggerTokens } from '../context/compaction/triggerThreshold'
import { pickAutoCompactView } from '../browser/worker/workerSnapshot'

const ONE_M = 'claude-opus[1m]' // 1M window, 20K reserve: auto fires at 967K
const FALLBACK = undefined // no model → the 200K fallback window: auto at 167K

describe('auto-compact window as the compaction point', () => {
  it('compacts at the window itself', () => {
    expect(foldTriggerTokens(ONE_M, undefined, 500_000)).toBe(500_000)
    expect(foldTriggerTokens(ONE_M, undefined, 100_000)).toBe(100_000)
    expect(thresholdForChoice(400_000, ONE_M)).toBe(400_000)
  })

  it("is capped at the model's own threshold, which auto uses", () => {
    expect(foldTriggerTokens(ONE_M)).toBe(967_000)
    expect(foldTriggerTokens(ONE_M, undefined, 1_000_000)).toBe(967_000)
    expect(foldTriggerTokens(FALLBACK, undefined, 500_000)).toBe(167_000)
    expect(thresholdForChoice('auto', FALLBACK)).toBe(167_000)
  })
})

describe('auto-compact handle range', () => {
  it("runs from the 100K window to auto at the model's threshold", () => {
    expect(windowSliderScale(ONE_M)).toEqual({
      modelWindow: 1_000_000,
      autoThreshold: 967_000,
      minWindow: 100_000,
      maxFixedWindow: 967_000,
      usable: true,
    })
    expect(windowSliderScale(FALLBACK).maxFixedWindow).toBe(167_000)
  })

  it('is unusable when the model threshold leaves nothing to choose', () => {
    expect(windowSliderScaleFor(32_000, 19_000).usable).toBe(false)
    expect(windowSliderScaleFor(128_000, 95_000).usable).toBe(false)
    expect(windowSliderScaleFor(200_000, 167_000).usable).toBe(true)
  })

  it('stops fixed windows at 1M on a wider model; past that is auto', () => {
    const scale = windowSliderScaleFor(2_000_000, 1_967_000)
    expect(scale.maxFixedWindow).toBe(1_000_000)
    expect(normalizeWindowChoice(995_000, scale)).toBe(995_000)
    expect(normalizeWindowChoice(1_400_000, scale)).toBe('auto')
    expect(stepChoice('auto', -5_000, scale)).toBe(995_000)
  })

  it('clamps to the minimum, steps by 5K, and turns the widest end into auto', () => {
    const scale = windowSliderScale(ONE_M)
    expect(normalizeWindowChoice(40_000, scale)).toBe(100_000)
    expect(normalizeWindowChoice(301_234, scale)).toBe(300_000)
    expect(normalizeWindowChoice(960_000, scale)).toBe(960_000)
    expect(normalizeWindowChoice(966_000, scale)).toBe(965_000)
    expect(normalizeWindowChoice(967_000, scale)).toBe('auto')
  })

  it('sits at the window on the bar and reads it back', () => {
    const scale = windowSliderScale(ONE_M)
    expect(fractionForChoice(400_000, scale)).toBeCloseTo(0.4)
    expect(fractionForChoice('auto', scale)).toBeCloseTo(0.967)
    expect(choiceAtFraction(0.4, scale, 0)).toBe(400_000)
    expect(choiceAtFraction(0.272, scale, 0)).toBe(270_000)
    // Off the left end → the minimum; near the auto position → auto.
    expect(choiceAtFraction(0, scale, 0)).toBe(100_000)
    expect(choiceAtFraction(0.95, scale, 0)).toBe('auto')
  })

  it('holds just above the current usage when the pointer is near it', () => {
    const scale = windowSliderScale(ONE_M)
    expect(choiceAtFraction(0.305, scale, 302_000)).toBe(305_000)
    expect(choiceAtFraction(0.29, scale, 300_000)).toBe(305_000)
    // Clear of the detent the pointer goes below usage freely.
    expect(choiceAtFraction(0.2, scale, 300_000)).toBe(200_000)
  })

  it('steps by keyboard from auto, and Home / End jump to the ends', () => {
    const scale = windowSliderScale(FALLBACK)
    expect(stepChoice('auto', -5_000, scale)).toBe(165_000)
    expect(stepChoice('auto', -50_000, scale)).toBe(120_000)
    expect(stepChoice(165_000, 5_000, scale)).toBe('auto')
    expect(stepChoice('auto', 5_000, scale)).toBe('auto')
    expect(stepChoice(150_000, -Infinity, scale)).toBe(100_000)
    expect(stepChoice(150_000, Infinity, scale)).toBe('auto')
    expect(stepChoice(100_000, -5_000, scale)).toBe(100_000)
  })
})

describe('auto-compact snapshot view', () => {
  it('is editable when the window comes from the user file or nowhere', () => {
    expect(pickAutoCompactView({ enabled: true }, true, undefined)).toEqual({
      enabled: true,
      canSave: true,
    })
    expect(
      pickAutoCompactView(
        { enabled: true, windowTokens: 300_000, windowSource: 'userSettings', windowScope: 'model' },
        true,
        undefined,
      ),
    ).toEqual({ enabled: true, windowTokens: 300_000, canSave: true })
  })

  it('is locked by a project, local, policy or flag file', () => {
    for (const source of ['projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const) {
      const view = pickAutoCompactView(
        { enabled: true, windowTokens: 300_000, windowSource: source, windowScope: 'allModels' },
        true,
        undefined,
      )
      expect(view.lockedBy).toBe(source)
    }
  })

  it('carries a failed save and the host without a settings file', () => {
    expect(pickAutoCompactView({ enabled: true }, false, 'EACCES')).toEqual({
      enabled: true,
      canSave: false,
      saveError: 'EACCES',
    })
  })
})
