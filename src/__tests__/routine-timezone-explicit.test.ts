/**
 * Every cron routine carries an explicit IANA zone and is matched in it, so
 * its wall-clock meaning survives a change of host zone, and DST is handled
 * by the matcher's zone mode.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { computeNextFireAt, validateCronExpression } from '../routines/cronExpression'
import { RoutineRegistry, setRoutineRegistry } from '../routines/RoutineRegistry'
import { getRoutinesLogPath } from '../routines/routinePaths'
import { resolveHostTimeZone } from '../routines/routineTimezone'
import type { CronRoutine } from '../routines/routineTypes'
import { ScheduleAddTool } from '../toolkit/builtin/cronCreate'
import type { ToolCallContext } from '../toolkit/toolCallContext'

const originalTz = process.env.TZ

const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions

/**
 * Sets the host zone. `process.env.TZ` moves `Date`; ICU may cache the zone
 * `Intl` reports, so the reported zone is pinned to match.
 */
function setHostZone(zone: string): void {
  process.env.TZ = zone
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(
    function (this: Intl.DateTimeFormat) {
      return { ...realResolvedOptions.call(this), timeZone: zone }
    },
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
  setRoutineRegistry(null)
})

function makeFs(files = new Map<string, string>()): {
  fs: RuntimeFs
  files: Map<string, string>
} {
  const fs = {
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
  return { fs, files }
}

function cronRoutine(extra: Partial<CronRoutine> = {}): CronRoutine {
  return {
    kind: 'cron',
    id: 'r1',
    name: 'morning',
    schedule: '0 9 * * *',
    prompt: 'ping',
    notifyOn: 'silent',
    createdAt: 0,
    createdBySessionId: 's',
    enabled: true,
    ...extra,
  }
}

describe('a routine stamped with a zone fires in that zone on any host', () => {
  for (const host of ['Asia/Shanghai', 'America/New_York', 'UTC', 'Europe/Berlin']) {
    it(`0 9 * * * in Asia/Shanghai fires at 01:00Z on a ${host} host`, () => {
      setHostZone(host)
      const from = Date.UTC(2026, 9, 8, 12, 0, 0)
      expect(computeNextFireAt('0 9 * * *', 'Asia/Shanghai', from)).toBe(
        Date.UTC(2026, 9, 9, 1, 0, 0),
      )
    })
  }

  it('CronCreate with no timezone stamps the host zone', async () => {
    setHostZone('Asia/Shanghai')
    const created: CronRoutine[] = []
    setRoutineRegistry({
      list: () => [],
      create: async (routine: CronRoutine) => {
        created.push(routine)
      },
    } as unknown as RoutineRegistry)
    const context = { options: { sessionId: 'sess' } } as unknown as ToolCallContext
    await ScheduleAddTool.call(
      { name: 'morning', schedule: '0 9 * * *', prompt: 'ping' } as never,
      context,
      async () => ({ behavior: 'allow' }) as never,
      undefined as never,
    )
    expect(created).toHaveLength(1)
    expect(created[0]!.timezone).toBe('Asia/Shanghai')
    // Moved to another host, it still fires at 09:00 Shanghai.
    setHostZone('America/Los_Angeles')
    expect(
      computeNextFireAt(created[0]!.schedule, created[0]!.timezone, Date.UTC(2026, 9, 8, 12)),
    ).toBe(Date.UTC(2026, 9, 9, 1, 0, 0))
  })
})

describe('DST through the zone mode', () => {
  it('a time skipped by spring-forward resolves to the next valid instant', () => {
    setHostZone('UTC')
    // 2026-03-08 02:30 does not exist in America/New_York (02:00 -> 03:00).
    const from = Date.UTC(2026, 2, 8, 5, 0, 0) // 00:00 EST
    expect(validateCronExpression('30 2 8 3 *', 'America/New_York')).toEqual({ ok: true })
    const next = computeNextFireAt('30 2 8 3 *', 'America/New_York', from)
    expect(next).not.toBeNull()
    // Not earlier than the shift (07:00Z = 03:00 EDT), and on the same day.
    expect(next!).toBeGreaterThanOrEqual(Date.UTC(2026, 2, 8, 7, 0, 0))
    expect(next!).toBeLessThan(Date.UTC(2026, 2, 9, 0, 0, 0))
  })

  it('a daily time keeps its wall clock across the shift', () => {
    setHostZone('UTC')
    const before = computeNextFireAt('0 9 * * *', 'America/New_York', Date.UTC(2026, 2, 7, 0))
    const after = computeNextFireAt('0 9 * * *', 'America/New_York', Date.UTC(2026, 2, 9, 0))
    expect(before).toBe(Date.UTC(2026, 2, 7, 14, 0, 0)) // 09:00 EST
    expect(after).toBe(Date.UTC(2026, 2, 9, 13, 0, 0)) // 09:00 EDT
  })
})

describe('older records without a zone', () => {
  it('evaluate in the host zone', () => {
    setHostZone('Asia/Shanghai')
    expect(computeNextFireAt('0 9 * * *', undefined, Date.UTC(2026, 9, 8, 12))).toBe(
      Date.UTC(2026, 9, 9, 1, 0, 0),
    )
  })

  it('are stamped with the host zone on load and persisted with the next write', async () => {
    setHostZone('Asia/Shanghai')
    const { fs, files } = makeFs()
    const logPath = getRoutinesLogPath('/base')
    files.set(logPath, `${JSON.stringify({ type: 'routine', routine: cronRoutine() })}\n`)

    const reg = await RoutineRegistry.load(fs, '/base')
    const loaded = reg.get('r1') as CronRoutine
    expect(loaded.timezone).toBe('Asia/Shanghai')

    await reg.update('r1', { lastRunAt: 5 })
    const lines = files.get(logPath)!.trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]!)
    expect(last).toEqual({ type: 'update', id: 'r1', patch: { lastRunAt: 5, timezone: 'Asia/Shanghai' } })

    // A later host zone does not move it once persisted.
    setHostZone('America/New_York')
    const reloaded = await RoutineRegistry.load(fs, '/base')
    expect((reloaded.get('r1') as CronRoutine).timezone).toBe('Asia/Shanghai')
  })

  it('create stamps a cron routine given without a zone', async () => {
    setHostZone('Europe/Berlin')
    const { fs } = makeFs()
    const reg = await RoutineRegistry.load(fs, '/base')
    await reg.create(cronRoutine())
    expect((reg.get('r1') as CronRoutine).timezone).toBe('Europe/Berlin')
  })
})

describe('host zone resolution', () => {
  it('reports the host IANA zone', () => {
    setHostZone('Asia/Tokyo')
    expect(resolveHostTimeZone()).toEqual({ zone: 'Asia/Tokyo' })
  })

  it('falls back to UTC with a diagnostic when the host reports no usable zone', () => {
    setHostZone('Not/AZone')
    const resolved = resolveHostTimeZone()
    expect(resolved.zone).toBe('UTC')
    expect(resolved.diagnostic).toMatch(/UTC/)
  })
})
