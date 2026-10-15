/**
 * P4 — daily-log nightly /tidy-memory cron register/remove (`routines/nightlyTidyCron`).
 *
 * Pins the idempotent-by-NAME lifecycle against a fresh `RoutineRegistry` on a
 * mock FS: ensure creates exactly one enabled cron, is idempotent, re-enables a
 * disabled one without duplicating; remove tombstones it; reconcile ensures
 * under `'dailyLog'` and removes otherwise.
 */

import { describe, expect, it } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RoutineRegistry } from '../routines/RoutineRegistry'
import {
  NIGHTLY_TIDY_ROUTINE_NAME,
  ensureNightlyTidyCron,
  reconcileNightlyTidyCron,
  removeNightlyTidyCron,
} from '../routines/nightlyTidyCron'

function makeFs(): RuntimeFs {
  const files = new Map<string, string>()
  return {
    readFile: async (path: string) => {
      const c = files.get(path)
      if (c === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return c
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content)
    },
    mkdir: async () => {},
  } as unknown as RuntimeFs
}

async function freshRegistry(): Promise<RoutineRegistry> {
  return RoutineRegistry.load(makeFs(), '/base')
}

describe('nightlyTidyCron — nightly /tidy-memory cron lifecycle', () => {
  it('ensure creates exactly one enabled cron named nightly-memory-tidy', async () => {
    const reg = await freshRegistry()
    await ensureNightlyTidyCron({ registry: reg })

    const crons = reg.list({ kind: 'cron' })
    expect(crons).toHaveLength(1)
    const cron = reg.getByName(NIGHTLY_TIDY_ROUTINE_NAME)
    expect(cron).toBeDefined()
    expect(cron!.kind).toBe('cron')
    expect(cron!.enabled).toBe(true)
  })

  it('ensure is idempotent — a second call does not duplicate', async () => {
    const reg = await freshRegistry()
    await ensureNightlyTidyCron({ registry: reg })
    await ensureNightlyTidyCron({ registry: reg })
    expect(reg.list({ kind: 'cron' })).toHaveLength(1)
  })

  it('ensure re-enables a disabled cron without creating a second', async () => {
    const reg = await freshRegistry()
    await ensureNightlyTidyCron({ registry: reg })
    const id = reg.getByName(NIGHTLY_TIDY_ROUTINE_NAME)!.id
    await reg.update(id, { enabled: false })

    await ensureNightlyTidyCron({ registry: reg })
    expect(reg.list({ kind: 'cron' })).toHaveLength(1)
    expect(reg.getByName(NIGHTLY_TIDY_ROUTINE_NAME)!.enabled).toBe(true)
  })

  it('remove tombstones the cron; no-op when absent', async () => {
    const reg = await freshRegistry()
    await removeNightlyTidyCron(reg) // absent → no throw
    await ensureNightlyTidyCron({ registry: reg })
    await removeNightlyTidyCron(reg)
    expect(reg.getByName(NIGHTLY_TIDY_ROUTINE_NAME)).toBeUndefined()
    expect(reg.list({ kind: 'cron' })).toHaveLength(0)
  })

  it('reconcile ensures under "dailyLog" and removes otherwise', async () => {
    const reg = await freshRegistry()
    await reconcileNightlyTidyCron({ registry: reg, mode: 'dailyLog' })
    expect(reg.getByName(NIGHTLY_TIDY_ROUTINE_NAME)).toBeDefined()

    for (const mode of ['periodic', 'off', undefined] as const) {
      await reconcileNightlyTidyCron({ registry: reg, mode })
      expect(
        reg.getByName(NIGHTLY_TIDY_ROUTINE_NAME),
        `mode=${mode}`,
      ).toBeUndefined()
      // re-add so the next iteration exercises removal from a present state.
      await reconcileNightlyTidyCron({ registry: reg, mode: 'dailyLog' })
    }
  })
})
