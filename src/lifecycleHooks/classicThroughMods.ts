/**
 * The classic (settings) hooks through the mods' chain, `classic.<Event>`
 * (F-25). With no mod hooking the event the executor runs as is; with one, the
 * event carries the hook's stdin input and the executor as core. Each call site
 * wraps its own call because results mean different things per site.
 */

import type { ClassicMods } from '../mods/toolCallEvent'
import type { HookBatchVerdict } from './runHooks'

/** What a call site holds: the `mods` of its tool-use context, if any. */
export type ClassicModsHolder = Partial<ClassicMods> | undefined

export type ClassicRun = HookBatchVerdict

/**
 * Run the classic hooks for `event`: through the mods when one of them hooks
 * it, else `run` directly. `e` is built only when it is raised. Never
 * rejects for the mods' sake — a chain that fails or is abandoned falls back
 * to `run`.
 */
export async function runClassicHooks(
  mods: ClassicModsHolder,
  event: string,
  e: () => Record<string, unknown>,
  run: () => Promise<HookBatchVerdict>,
  signal?: AbortSignal,
): Promise<ClassicRun> {
  if (!mods?.classic || !mods.hasClassicHooks?.(event)) return run()
  let last: HookBatchVerdict | undefined
  // The executor's run once core starts it. A chain abandoned while that run
  // is still going (a mod's wall-clock bound) waits for it rather than
  // starting the settings hooks a second time.
  let started: Promise<HookBatchVerdict> | undefined
  const settlement = await mods.classic(
    event,
    e(),
    async () => {
      started = run()
      last = await started
      return last
    },
    signal,
  )
  if (!settlement.settled) return last ?? started ?? run()
  const { aggregate } = settlement
  return {
    ...aggregate,
    // The executor's own run when it is the one that stands; a hook's answer
    // carries no per-hook results.
    results: last && aggregate === last ? last.results : [],
  }
}
