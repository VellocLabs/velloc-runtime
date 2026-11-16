/**
 * `$.ui.notify`'s bookings (F-25): a booked notice is held by the slot's
 * runtime and its `Notification` hooks run when it falls due; `cancelNotify`
 * drops one not yet due; `untilBack` drops it once the person runs a prompt or
 * command; a plugin that goes, or the slot, takes its bookings with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { MAX_NOTIFY_BOOKINGS_PER_PLUGIN, MAX_NOTIFY_DELAY_MS, ModNotifyBookings, type ModNotice } from '../mods/modNotify'
import { ROOT_DISPATCH_CONTEXT, type DispatchContext } from '../mods/modTypes'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  vi.useRealTimers()
})

describe('ModNotifyBookings', () => {
  function bookings(now = () => 1_000) {
    const fired: Array<{ notice: ModNotice; context: DispatchContext }> = []
    const held = new ModNotifyBookings(async (notice, context) => void fired.push({ notice, context }), () => {}, now)
    return { held, fired }
  }
  const notice = (message: string): ModNotice => ({ message, title: 'ci' })

  it('fires a delayMs booking at its due time, not before, and once', async () => {
    vi.useFakeTimers()
    const { held, fired } = bookings()
    held.book({ plugin: 'ci' }, notice('later'), { delayMs: 5_000 }, {}, ROOT_DISPATCH_CONTEXT)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fired).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fired.map(f => f.notice.message)).toEqual(['later'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).toHaveLength(1)
    expect(held.size).toBe(0)
  })

  it('fires an at booking when the clock reads at; one in the past fires at once', async () => {
    vi.useFakeTimers()
    const { held, fired } = bookings(() => 10_000)
    held.book({ plugin: 'ci' }, notice('at'), { at: 12_000 }, {}, ROOT_DISPATCH_CONTEXT)
    held.book({ plugin: 'ci' }, notice('past'), { at: 5_000 }, {}, ROOT_DISPATCH_CONTEXT)
    await vi.advanceTimersByTimeAsync(0)
    expect(fired.map(f => f.notice.message)).toEqual(['past'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fired.map(f => f.notice.message)).toEqual(['past', 'at'])
  })

  it('cancel drops a booking before it is due and reports false after it fired or for another plugin', async () => {
    vi.useFakeTimers()
    const { held, fired } = bookings()
    held.book({ plugin: 'ci' }, notice('a'), { delayMs: 1_000 }, { key: 'a' }, ROOT_DISPATCH_CONTEXT)
    held.book({ plugin: 'ci' }, notice('b'), { delayMs: 1_000 }, { key: 'b' }, ROOT_DISPATCH_CONTEXT)
    expect(held.cancel('other', 'a')).toBe(false)
    expect(held.cancel('ci', 'a')).toBe(true)
    expect(held.cancel('ci', 'a')).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fired.map(f => f.notice.message)).toEqual(['b'])
    expect(held.cancel('ci', 'b')).toBe(false)
  })

  it('a second booking under the same key replaces the first', async () => {
    vi.useFakeTimers()
    const { held, fired } = bookings()
    held.book({ plugin: 'ci' }, notice('first'), { delayMs: 1_000 }, { key: 'k' }, ROOT_DISPATCH_CONTEXT)
    held.book({ plugin: 'ci' }, notice('second'), { delayMs: 2_000 }, { key: 'k' }, ROOT_DISPATCH_CONTEXT)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fired.map(f => f.notice.message)).toEqual(['second'])
  })

  it('personBack drops untilBack bookings only', async () => {
    vi.useFakeTimers()
    const { held, fired } = bookings()
    held.book({ plugin: 'ci' }, notice('nag'), { delayMs: 1_000 }, { untilBack: true }, ROOT_DISPATCH_CONTEXT)
    held.book({ plugin: 'ci' }, notice('keep'), { delayMs: 1_000 }, {}, ROOT_DISPATCH_CONTEXT)
    const mark = held.personRunBegins()
    held.book({ plugin: 'ci' }, notice('made during the run'), { delayMs: 1_000 }, { untilBack: true }, ROOT_DISPATCH_CONTEXT)
    held.personBack(mark)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fired.map(f => f.notice.message)).toEqual(['keep', 'made during the run'])
  })

  it('dropSeat and clear leave no timer behind', async () => {
    vi.useFakeTimers()
    const { held, fired } = bookings()
    held.book({ plugin: 'ci' }, notice('ci'), { delayMs: MAX_NOTIFY_DELAY_MS }, {}, ROOT_DISPATCH_CONTEXT)
    held.book({ plugin: 'other' }, notice('other'), { delayMs: MAX_NOTIFY_DELAY_MS }, {}, ROOT_DISPATCH_CONTEXT)
    held.dropSeat('ci')
    expect(held.size).toBe(1)
    held.clear()
    expect(held.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(MAX_NOTIFY_DELAY_MS)
    expect(fired).toEqual([])
  })

  it('keeps only the caller frame of the booking context', async () => {
    vi.useFakeTimers()
    const { held, fired } = bookings()
    const context: DispatchContext = { origin: ROOT_DISPATCH_CONTEXT.origin, depth: 2, frames: ['above', 'mine'], skipPlugin: 'x' }
    held.book({ plugin: 'ci' }, notice('n'), { delayMs: 1 }, {}, context)
    await vi.advanceTimersByTimeAsync(1)
    expect(fired[0]!.context).toEqual({ origin: ROOT_DISPATCH_CONTEXT.origin, depth: 2, frames: ['mine'], skipPlugin: 'x' })
  })

  it("dropSeat takes only that module's bookings when one plugin has two modules", async () => {
    vi.useFakeTimers()
    const { held, fired } = bookings()
    held.book({ plugin: 'ci', seat: 'ci#1' }, notice('one'), { delayMs: 1_000 }, {}, ROOT_DISPATCH_CONTEXT)
    held.book({ plugin: 'ci', seat: 'ci#2' }, notice('two'), { delayMs: 1_000 }, {}, ROOT_DISPATCH_CONTEXT)
    held.dropSeat('ci#1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fired.map(f => f.notice.message)).toEqual(['two'])
  })

  it(`refuses a booking past ${MAX_NOTIFY_BOOKINGS_PER_PLUGIN} held for one plugin`, () => {
    vi.useFakeTimers()
    const { held } = bookings()
    for (let i = 0; i < MAX_NOTIFY_BOOKINGS_PER_PLUGIN; i++) held.book({ plugin: 'ci' }, notice(`n${i}`), { delayMs: 1_000 }, {}, ROOT_DISPATCH_CONTEXT)
    expect(() => held.book({ plugin: 'ci' }, notice('over'), { delayMs: 1_000 }, {}, ROOT_DISPATCH_CONTEXT)).toThrow(RangeError)
    expect(() => held.book({ plugin: 'other' }, notice('fine'), { delayMs: 1_000 }, {}, ROOT_DISPATCH_CONTEXT)).not.toThrow()
  })
})

describe('$.ui.notify bookings in the runtime', () => {
  let uniq = 0
  function world(modules: Record<string, string>) {
    const heard: string[] = []
    const reports: string[] = []
    const refs = (names: string[]): ModModuleRef[] => names.map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    const runtime = new ModRuntime({
      modules: refs(Object.keys(modules)),
      readModule: async path => `${modules[path.split('/')[2]!]!}\n// load ${++uniq}`,
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
      session: {
        id: () => 's',
        cwd: () => '/work/project',
        notifications: { runHooks: async notice => void heard.push(notice.message) },
      },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, heard, reports, refs }
  }

  const BOOKER = `
    export function register(on) {
      on('prompt.submit', async ($, e, next) => {
        if (e.text === 'book') {
          await $.ui.notify('later', { key: 'k', delayMs: 60000 });
          await $.ui.notify('nag', { delayMs: 60000, untilBack: true });
        }
        if (e.text === 'now') await $.ui.notify('now');
        return next(e);
      });
    }
  `

  it('runs the hooks when the booking falls due; an unbooked notice runs them at once', async () => {
    const { runtime, heard } = world({ ci: BOOKER })
    await runtime.ready
    vi.useFakeTimers()
    await runtime.promptSubmit('book')
    await runtime.promptSubmit('now')
    expect(heard).toEqual(['now'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard).toEqual(['now', 'later'])
  })

  it("untilBack drops the booking once the person's next prompt has run", async () => {
    const { runtime, heard } = world({ ci: BOOKER })
    await runtime.ready
    vi.useFakeTimers()
    await runtime.promptSubmit('book')
    await runtime.promptSubmit('anything')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard).toEqual(['later'])
  })

  it('a plugin that is removed takes its bookings with it', async () => {
    const { runtime, heard, refs } = world({ ci: BOOKER })
    await runtime.ready
    vi.useFakeTimers()
    await runtime.promptSubmit('book')
    await runtime.reconcile(refs([]))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard).toEqual([])
  })

  it('a module reloaded in place loses the bookings its old instance made', async () => {
    const { runtime, heard, refs } = world({ ci: BOOKER })
    await runtime.ready
    vi.useFakeTimers()
    await runtime.promptSubmit('book')
    await runtime.reconcile(refs(['ci']), { reloadChanged: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard).toEqual([])
  })

  it('a slot that closes leaves no booking to fire', async () => {
    const { runtime, heard } = world({ ci: BOOKER })
    await runtime.ready
    vi.useFakeTimers()
    await runtime.promptSubmit('book')
    await runtime.end('other')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard).toEqual([])
  })

  it('a booking that falls due during a /clear session.end runs once it has finished', async () => {
    const SLOW_END = `
      export function register(on) {
        on('session.end', async ($, e, next) => {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return next(e);
        });
        on('prompt.submit', async ($, e, next) => {
          await $.ui.notify('soon', { delayMs: 500 });
          return next(e);
        });
      }
    `
    const { runtime, heard } = world({ ci: SLOW_END })
    await runtime.ready
    vi.useFakeTimers()
    await runtime.promptSubmit('book')
    const ending = runtime.sessionEnd('clear')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(heard).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    await ending
    expect(heard).toEqual(['soon'])
  })

  it('a /clear keeps the bookings, as it keeps the modules', async () => {
    const { runtime, heard } = world({ ci: BOOKER })
    await runtime.ready
    vi.useFakeTimers()
    await runtime.promptSubmit('book')
    await runtime.sessionEnd('clear')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard).toEqual(['later', 'nag'])
  })
})
