/**
 * The daily-log nightly `/tidy-memory` cron: registers or removes one `cron`
 * routine named `nightly-memory-tidy` (keyed by name). Manager scope only (the
 * engine worker has no registry); called on a settings flip and at boot.
 */

import type { MemoryMaintenanceMode } from '../memory/memoryPaths'
import { newRoutineId } from './routineId'
import { RoutineNameTakenError, type RoutineRegistry } from './RoutineRegistry'
import type { CronRoutine } from './routineTypes'
import { resolveHostTimeZone } from './routineTimezone'

/** Stable, NAME_PATTERN-valid handle — the idempotency key. */
export const NIGHTLY_TIDY_ROUTINE_NAME = 'nightly-memory-tidy'

/** Nightly at 03:00. */
const NIGHTLY_TIDY_SCHEDULE = '0 3 * * *'

/**
 * Headless directive. `/tidy-memory` is the self-contained consolidation skill — it
 * resolves its own memory + transcript dirs — sent as the first user message of
 * the headless run. Tools restricted to memory-dir reads/writes.
 */
const NIGHTLY_TIDY_PROMPT = '/tidy-memory'

const NIGHTLY_TIDY_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']

export type EnsureNightlyTidyCronArgs = {
  registry: RoutineRegistry
  timezone?: string
  createdBySessionId?: string
}

/**
 * Ensure the nightly daily-log consolidation cron exists and is enabled.
 * Idempotent by NAME: creates it if absent, re-enables it if present-disabled,
 * no-ops if already present-enabled. Swallows a cross-tab create race.
 */
export async function ensureNightlyTidyCron({
  registry,
  timezone,
  createdBySessionId,
}: EnsureNightlyTidyCronArgs): Promise<void> {
  const existing = registry.getByName(NIGHTLY_TIDY_ROUTINE_NAME)
  if (existing) {
    if (!existing.enabled) {
      await registry.update(existing.id, { enabled: true })
    }
    return
  }

  const routine: CronRoutine = {
    kind: 'cron',
    id: newRoutineId(),
    name: NIGHTLY_TIDY_ROUTINE_NAME,
    schedule: NIGHTLY_TIDY_SCHEDULE,
    timezone: timezone || resolveHostTimeZone().zone,
    prompt: NIGHTLY_TIDY_PROMPT,
    permittedTools: NIGHTLY_TIDY_TOOLS,
    notifyOn: 'silent',
    createdAt: Date.now(),
    createdBySessionId: createdBySessionId ?? 'daily-log-memory',
    enabled: true,
  }

  try {
    await registry.create(routine)
  } catch (err) {
    // A concurrent tab may have created it first — the name-index surfaces that
    // as RoutineNameTakenError; treat as success (the routine now exists).
    if (!(err instanceof RoutineNameTakenError)) throw err
  }
}

/**
 * Remove the daily-log consolidation cron (when the mode leaves `'dailyLog'`).
 * No-op if absent. Deletes rather than disables so a stale schedule can't
 * silently reactivate.
 */
export async function removeNightlyTidyCron(
  registry: RoutineRegistry,
): Promise<void> {
  const existing = registry.getByName(NIGHTLY_TIDY_ROUTINE_NAME)
  if (existing) {
    await registry.delete(existing.id)
  }
}

/**
 * Reconcile the cron against the resolved mode: ensure it under `'dailyLog'`,
 * remove it otherwise. Single entry point for the settings-flip and boot
 * reconcile call sites.
 */
export async function reconcileNightlyTidyCron(args: {
  registry: RoutineRegistry
  mode: MemoryMaintenanceMode | undefined
  timezone?: string
  createdBySessionId?: string
}): Promise<void> {
  if (args.mode === 'dailyLog') {
    await ensureNightlyTidyCron(args)
  } else {
    await removeNightlyTidyCron(args.registry)
  }
}
