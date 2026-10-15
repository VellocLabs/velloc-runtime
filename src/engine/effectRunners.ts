/**
 * The effect table: one runner per effect kind. Runners do IO only; every
 * choice about what happens next is made by `advanceTurn`.
 */
import type { TurnEffect, TurnEffectKind } from './turnEffects'
import type { EffectRunner } from './turnEnvironment'
import { runPromptSubmitHooks } from './effectPromptHooks'
import { fitContext } from './effectContextFit'
import { requestModel } from './effectModelRequest'
import { runToolBatchEffect } from './effectToolBatch'
import { drainQueuedInput } from './effectQueuedInput'
import { runStopHooks } from './effectStopHooks'
import { gatherRows } from './effectGatherRows'
import { refreshPromptContext } from './effectPromptRefresh'
import { awaitBackground, startBackground } from './effectBackground'
import { acknowledge, delay, pushHostSettings } from './effectHost'
import { raiseTurnContinue } from './effectTurnContinue'

type RunnerTable = { readonly [K in TurnEffectKind]: EffectRunner<Extract<TurnEffect, { kind: K }>> }

export const effectRunners: RunnerTable = {
  runPromptSubmitHooks,
  summarizeForCompaction: fitContext,
  requestModel,
  runToolBatch: runToolBatchEffect,
  drainQueuedInput,
  runStopHooks,
  persistRows: acknowledge,
  pushHostSettings,
  delay,
  startBackground,
  commitTerminal: acknowledge,
  gatherRows,
  refreshPromptContext,
  awaitBackground,
  raiseTurnContinue,
}

export function runnerFor(effect: TurnEffect): EffectRunner {
  return effectRunners[effect.kind] as EffectRunner
}
