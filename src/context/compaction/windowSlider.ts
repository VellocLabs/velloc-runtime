// Math for the composer's auto-compact handle (pure, UI-safe). Range: from
// MIN_AUTO_COMPACT_WINDOW to `auto` (the model's own threshold); fixed windows
// stop below it and at MAX_AUTO_COMPACT_WINDOW. Disabled when the model's
// threshold is not above the minimum.
import { contextWindowOf } from '../../engine/contextWindow.js'
import {
  MAX_AUTO_COMPACT_WINDOW,
  MIN_AUTO_COMPACT_WINDOW,
} from '../../settings/modelSettings.js'
import { foldTriggerTokens } from './triggerThreshold.js'

/** Window values the handle lands on. */
export const WINDOW_SLIDER_STEP = 5_000
/** Keyboard PageUp / PageDown step. */
export const WINDOW_SLIDER_PAGE_STEP = 50_000
/** Fraction of the bar next to `auto` that snaps to it. */
const AUTO_SNAP_FRACTION = 0.02
/** Fraction of the bar around the current usage that holds the handle just
 *  above it, so crossing into "compacts on the next message" is felt. */
const USAGE_DETENT_FRACTION = 0.015

export type WindowChoice = number | 'auto'

export type WindowSliderScale = {
  /** The bar's full width in tokens: the model's context window. */
  modelWindow: number
  /** Where `auto` compacts: the model's own threshold. */
  autoThreshold: number
  /** Narrowest window the handle offers. */
  minWindow: number
  /** Widest fixed window; anything at or beyond it is `auto`. */
  maxFixedWindow: number
  /** False when the model leaves nothing to choose. */
  usable: boolean
}

export function windowSliderScale(
  model: string | undefined,
  providerId?: string,
): WindowSliderScale {
  return windowSliderScaleFor(
    contextWindowOf(model, providerId),
    foldTriggerTokens(model, providerId),
  )
}

/** The handle's range on a bar `modelWindow` tokens wide whose `auto`
 *  compacts at `autoThreshold`. */
export function windowSliderScaleFor(
  modelWindow: number,
  autoThreshold: number,
): WindowSliderScale {
  const maxFixedWindow = Math.min(autoThreshold, MAX_AUTO_COMPACT_WINDOW)
  return {
    modelWindow,
    autoThreshold,
    minWindow: MIN_AUTO_COMPACT_WINDOW,
    maxFixedWindow,
    usable: maxFixedWindow > MIN_AUTO_COMPACT_WINDOW,
  }
}

/** The threshold a choice compacts at (`auto` = the model's own). */
export function thresholdForChoice(
  choice: WindowChoice,
  model: string | undefined,
  providerId?: string,
): number {
  return foldTriggerTokens(model, providerId, choice === 'auto' ? undefined : choice)
}

/** Clamp a window to the handle's range and its step; the widest end is `auto`. */
export function normalizeWindowChoice(
  window: number,
  scale: WindowSliderScale,
): WindowChoice {
  if (window >= scale.maxFixedWindow) return 'auto'
  const stepped = Math.round(window / WINDOW_SLIDER_STEP) * WINDOW_SLIDER_STEP
  if (stepped >= scale.maxFixedWindow) return 'auto'
  return Math.max(scale.minWindow, stepped)
}

/**
 * The choice under a pointer at `fraction` (0–1) of the bar. Snaps to `auto`
 * near its position and holds just above `usedTokens` when the pointer is
 * close to it.
 */
export function choiceAtFraction(
  fraction: number,
  scale: WindowSliderScale,
  usedTokens: number,
): WindowChoice {
  const f = Math.min(1, Math.max(0, fraction))
  const autoFraction = scale.autoThreshold / scale.modelWindow
  if (f >= autoFraction - AUTO_SNAP_FRACTION) return 'auto'
  const usedFraction = usedTokens / scale.modelWindow
  if (Math.abs(f - usedFraction) <= USAGE_DETENT_FRACTION) {
    // The first step above the usage: compacts on the message after next.
    const above = (Math.floor(usedTokens / WINDOW_SLIDER_STEP) + 1) * WINDOW_SLIDER_STEP
    return normalizeWindowChoice(above, scale)
  }
  return normalizeWindowChoice(f * scale.modelWindow, scale)
}

/** Where a choice's handle sits on the bar, 0–1. */
export function fractionForChoice(
  choice: WindowChoice,
  scale: WindowSliderScale,
): number {
  const threshold = choice === 'auto'
    ? scale.autoThreshold
    : Math.min(choice, scale.autoThreshold)
  return Math.min(1, threshold / scale.modelWindow)
}

/** The choice one keyboard step away (`delta` in tokens; End / Home are
 *  `Infinity` / `-Infinity`). */
export function stepChoice(
  choice: WindowChoice,
  delta: number,
  scale: WindowSliderScale,
): WindowChoice {
  if (delta === Infinity) return 'auto'
  if (delta === -Infinity) return scale.minWindow
  if (choice !== 'auto') return normalizeWindowChoice(choice + delta, scale)
  if (delta >= 0) return 'auto'
  // Down from `auto`: the first step is the widest fixed window.
  const widest = (Math.ceil(scale.maxFixedWindow / WINDOW_SLIDER_STEP) - 1) * WINDOW_SLIDER_STEP
  return normalizeWindowChoice(widest + delta + WINDOW_SLIDER_STEP, scale)
}
