/**
 * `session.attach` / `session.detach` (F-25): a client joining or leaving the session's roster. Attach observes
 * (`next(e)` resolves to `{ clientId }`); detach carries `e.reason`, and with reason `end` runs inside
 * `session.end`'s bound. The hub's side is `runtime-session-surface.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  modRoster,
  modRosterAttach,
  modRosterDetach,
  registerModSlot,
  resetModSlotRegistryForTests,
} from '../mods/modSlotRegistry'

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  resetModSlotRegistryForTests()
})

const SESSION = 'sess-attach'

function world(body: string, options: { endTimeoutMs?: number } = {}) {
  const reports: string[] = []
  const refs: ModModuleRef[] = [{ plugin: 'roster', path: '/plugins/roster/hooks/register.js' }]
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async () => `export function register(on) {\n${body}\n}\n// load ${++uniqueLoad}`,
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
    session: { id: () => SESSION, cwd: () => '/work/project' },
    report: line => reports.push(line),
    ...(options.endTimeoutMs !== undefined ? { endTimeoutMs: options.endTimeoutMs } : {}),
  })
  runtimes.push(runtime)
  const logged = () =>
    reports
      .filter(line => line.startsWith('roster: {'))
      .map(line => JSON.parse(line.slice('roster: '.length)) as Record<string, unknown>)
  return { runtime, reports, logged }
}

/** Logs every roster event and what `next` resolved to; `session.start`
 *  logs too, so the order shows. */
const WATCH = `
on('session.start', async ($, e, next) => {
  await $.ui.log(JSON.stringify({ event: 'session.start' }))
  return next(e)
})
on('session.attach', async ($, e, next) => {
  const got = await next(e)
  await $.ui.log(JSON.stringify({ event: 'session.attach', e, got }))
  return { clientId: 'forged' }
})
on('session.detach', async ($, e, next) => {
  const got = await next(e)
  await $.ui.log(JSON.stringify({ event: 'session.detach', e, got, budget: next.budget.remainingMs }))
  return got
})
`

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('session.attach / session.detach', () => {
  it('are raised by this engine', () => {
    expect(RAISED_EVENTS).toContain('session.attach')
    expect(RAISED_EVENTS).toContain('session.detach')
  })

  it('a client attached before session.start is raised after it; e is the surface and the id, next resolves to { clientId }', async () => {
    const { runtime, logged } = world(WATCH)
    runtime.clientAttached({ clientId: 'conn-1', surface: 'desktop' })
    await runtime.ready
    await until(() => logged().some(entry => entry.event === 'session.attach'), 'the attach')
    expect(logged().map(entry => entry.event)).toEqual(['session.start', 'session.attach'])
    expect(logged()[1]).toMatchObject({
      e: { surface: 'desktop', clientId: 'conn-1' },
      got: { clientId: 'conn-1' },
    })
  })

  it('a client leaving raises detach with reason detach, after its attach; one that left before session.start raises nothing', async () => {
    const { runtime, logged } = world(WATCH)
    runtime.clientAttached({ clientId: 'early', surface: 'desktop' })
    runtime.clientDetached('early')
    await runtime.ready
    runtime.clientAttached({ clientId: 'conn-2', surface: 'desktop' })
    runtime.clientDetached('conn-2')
    await until(() => logged().some(entry => entry.event === 'session.detach'), 'the detach')
    const roster = logged().filter(entry => entry.event !== 'session.start')
    expect(roster.map(entry => [entry.event, (entry.e as { clientId: string }).clientId])).toEqual([
      ['session.attach', 'conn-2'],
      ['session.detach', 'conn-2'],
    ])
    expect(roster[1]).toMatchObject({ e: { surface: 'desktop', reason: 'detach' }, got: { clientId: 'conn-2' } })
  })

  it('a runtime registered after its clients came is handed the roster', async () => {
    modRosterAttach(SESSION, { clientId: 'conn-a', surface: 'desktop' })
    modRosterAttach(SESSION, { clientId: 'conn-b', surface: 'desktop' })
    const { runtime, logged } = world(WATCH)
    registerModSlot(SESSION, runtime)
    await runtime.ready
    await until(() => logged().filter(entry => entry.event === 'session.attach').length === 2, 'both attaches')
    modRosterDetach(SESSION, 'conn-a')
    await until(() => logged().some(entry => entry.event === 'session.detach'), 'the detach')
    expect(modRoster(SESSION).map(client => client.clientId)).toEqual(['conn-b'])
    expect(
      logged()
        .filter(entry => entry.event !== 'session.start')
        .map(entry => [entry.event, (entry.e as { clientId: string }).clientId]),
    ).toEqual([
      ['session.attach', 'conn-a'],
      ['session.attach', 'conn-b'],
      ['session.detach', 'conn-a'],
    ])
  })

  it('the session ending raises detach with reason end for each attached client, inside session.end\'s bound', async () => {
    const { runtime, logged } = world(WATCH, { endTimeoutMs: 1500 })
    runtime.clientAttached({ clientId: 'conn-x', surface: 'desktop' })
    runtime.clientAttached({ clientId: 'conn-y', surface: 'desktop' })
    await runtime.ready
    await until(() => logged().filter(entry => entry.event === 'session.attach').length === 2, 'both attaches')
    await runtime.end('other')
    const ends = logged().filter(entry => entry.event === 'session.detach')
    expect(ends.map(entry => entry.e)).toEqual([
      { surface: 'desktop', clientId: 'conn-x', reason: 'end' },
      { surface: 'desktop', clientId: 'conn-y', reason: 'end' },
    ])
    for (const entry of ends) expect(entry.budget as number).toBeLessThanOrEqual(1500)
  })

  it('a /clear ends the conversation, not the clients\' session: no detach', async () => {
    const { runtime, logged } = world(WATCH)
    runtime.clientAttached({ clientId: 'conn-c', surface: 'desktop' })
    await runtime.ready
    await until(() => logged().some(entry => entry.event === 'session.attach'), 'the attach')
    await runtime.sessionEnd('clear')
    runtime.clientDetached('conn-c')
    await until(() => logged().some(entry => entry.event === 'session.detach'), 'the later detach')
    expect(logged().filter(entry => entry.event === 'session.detach')).toEqual([
      expect.objectContaining({ e: { surface: 'desktop', clientId: 'conn-c', reason: 'detach' } }),
    ])
  })

  it('a hook matching another surface is never reached: every Velloc client draws desktop', async () => {
    const { runtime, logged } = world(`
      on('session.attach', { surface: 'mobile' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ event: 'mobile' }))
        return next(e)
      })
      on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ event: 'desktop' }))
        return next(e)
      })
    `)
    runtime.clientAttached({ clientId: 'conn-d', surface: 'desktop' })
    await runtime.ready
    await until(() => logged().length > 0, 'the desktop hook')
    expect(logged()).toEqual([{ event: 'desktop' }])
  })
})
