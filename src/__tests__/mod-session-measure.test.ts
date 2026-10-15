/**
 * `session.measure` (F-25): `$.session.usage()`'s figures pushed after each main-thread turn. Observe; one at a
 * time, a burst folding into one more; `changed` is never empty (the first names every unit with a figure), and
 * `e` never carries `breakdown`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { measureChangedUnits, type SessionUsage } from '../mods/sessionNouns'

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

function world(modules: Record<string, string>) {
  const reports: string[] = []
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 'sess-measure', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  const logged = (plugin: string) =>
    reports.filter(line => line.startsWith(`${plugin}: {`)).map(line => JSON.parse(line.slice(plugin.length + 2)) as Record<string, unknown>)
  return { runtime, reports, logged }
}

function usage(tokens: number | undefined, usd?: number): SessionUsage {
  return {
    startedAt: 1,
    context: { ...(tokens !== undefined ? { tokens, percent: Math.round(tokens / 2000) } : {}), window: 200_000 },
    rateLimits: [],
    ...(usd !== undefined ? { cost: { usd } } : {}),
  }
}

const WATCH = `on('session.measure', async ($, e, next) => {
  const got = await next(e)
  await $.ui.log(JSON.stringify({ e, got }))
  return { changed: ['forged'] }
})`

describe('session.measure — which units moved', () => {
  it('the first measurement names every unit with a figure; later ones what moved; nothing moved is []', () => {
    expect(measureChangedUnits(undefined, usage(undefined))).toEqual([])
    expect(measureChangedUnits(undefined, usage(1000, 0.5))).toEqual(['context', 'cost'])
    expect(measureChangedUnits(usage(1000, 0.5), usage(1000, 0.5))).toEqual([])
    expect(measureChangedUnits(usage(1000, 0.5), usage(1200, 0.5))).toEqual(['context'])
    expect(measureChangedUnits(usage(1000, 0.5), usage(1000, 0.7))).toEqual(['cost'])
    // A compaction empties the live window: the fill moved.
    expect(measureChangedUnits(usage(1000), usage(undefined))).toEqual(['context'])
  })

  it('a rate-limit window counts when it moves a whole point, appears or leaves', () => {
    const at = (percentUsed: number): SessionUsage => ({ ...usage(1000), rateLimits: [{ kind: 'five_hour', percentUsed }] })
    expect(measureChangedUnits(undefined, at(3))).toEqual(['context', 'rateLimits'])
    expect(measureChangedUnits(at(3.2), at(3.9))).toEqual([])
    expect(measureChangedUnits(at(3.9), at(4.1))).toEqual(['rateLimits'])
    expect(measureChangedUnits(usage(1000), at(4))).toEqual(['rateLimits'])
    expect(measureChangedUnits(at(4), usage(1000))).toEqual(['rateLimits'])
  })
})

describe('session.measure — the event', () => {
  it('is raised by this engine', () => {
    expect(RAISED_EVENTS).toContain('session.measure')
  })

  it('hands the hooks the figures and changed; next(e) echoes changed, a different return changes nothing', async () => {
    const { runtime, logged } = world({ watch: WATCH })
    await runtime.ready
    expect(runtime.hasSessionMeasureHooks()).toBe(true)
    await runtime.sessionMeasure(() => ({ ...usage(1000, 0.25), context: { ...usage(1000).context } }))
    expect(logged('watch')).toEqual([
      {
        e: { context: { tokens: 1000, percent: 1, window: 200_000 }, rateLimits: [], cost: { usd: 0.25 }, changed: ['context', 'cost'] },
        got: { changed: ['context', 'cost'] },
      },
    ])
  })

  it('raises only when a unit moved since the last measurement a hook saw', async () => {
    const { runtime, logged } = world({ watch: WATCH })
    await runtime.ready
    await runtime.sessionMeasure(() => usage(undefined))
    await runtime.sessionMeasure(() => usage(1000, 0.25))
    await runtime.sessionMeasure(() => usage(1000, 0.25))
    await runtime.sessionMeasure(() => usage(1500, 0.25))
    expect(logged('watch').map(line => (line.e as { changed: string[] }).changed)).toEqual([['context', 'cost'], ['context']])
  })

  it('one at a time: a burst folds into one more, reading the latest figures', async () => {
    const { runtime, logged } = world({ watch: WATCH })
    await runtime.ready
    let reads = 0
    const first = runtime.sessionMeasure(() => (++reads, usage(1000)))
    const second = runtime.sessionMeasure(() => (++reads, usage(2000)))
    const third = runtime.sessionMeasure(() => (++reads, usage(3000)))
    expect(second).toBe(first)
    expect(third).toBe(first)
    await first
    expect(reads).toBe(2)
    expect(logged('watch').map(line => (line.e as { context: { tokens: number } }).context.tokens)).toEqual([1000, 3000])
  })

  it('costs nothing unhooked, and a failing hook or reader never rejects', async () => {
    const { runtime: quiet } = world({ other: `on('prompt.submit', ($, e, next) => next(e))` })
    await quiet.ready
    expect(quiet.hasSessionMeasureHooks()).toBe(false)
    let read = false
    await quiet.sessionMeasure(() => ((read = true), usage(1000)))
    expect(read).toBe(false)

    const { runtime, reports } = world({ broken: `on('session.measure', () => { throw new Error('kaboom') })` })
    await runtime.ready
    await expect(runtime.sessionMeasure(() => usage(1000))).resolves.toBeUndefined()
    await expect(
      runtime.sessionMeasure(() => {
        throw new Error('no figures')
      }),
    ).resolves.toBeUndefined()
    expect(reports.some(line => line.includes('kaboom'))).toBe(true)
    expect(reports.some(line => line.includes('session.measure could not read the figures: no figures'))).toBe(true)
  })
})
