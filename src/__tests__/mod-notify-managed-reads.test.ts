/**
 * `$.ui.notify` (F-25) — the `Notification` hooks run under the caller's
 * context, then no channel writes on the desktop: `{ isSent: false, reason:
 * 'no-surface' }`; raised as `ui.notify`, rewritable, deniable, answerable; a
 * `classic.Notification` hook that notifies is left out of its own call.
 * `$.session.identity()` and `$.prompt.media()` — answered to a managed
 * install (`prepend` / `append`) alone, `{ deny }` to any other.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import type { DispatchContext } from '../mods/modTypes'
import { ROOT_DISPATCH_CONTEXT } from '../mods/modTypes'
import { NOT_MANAGED_DENIAL } from '../mods/modManagedReads'
import { isUiNotifyResult, uiNotifyArgsOf } from '../mods/modNotify'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0
function world(
  modules: Record<string, { source: string; tier?: ModModuleRef['tier'] }>,
  host: (runtime: () => ModRuntime) => Partial<ModNounHost> = () => ({}),
) {
  const reports: string[] = []
  const refs: ModModuleRef[] = Object.entries(modules).map(([plugin, { tier }]) => ({
    plugin,
    path: `/plugins/${plugin}/hooks/register.js`,
    ...(tier ? { tier } : {}),
  }))
  let self: ModRuntime | undefined
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `${modules[path.split('/')[2]!]!.source}\n// load ${++uniq}`,
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
    session: { id: () => 's', cwd: () => '/work/project', ...host(() => self!) },
    report: line => reports.push(line),
  })
  self = runtime
  runtimes.push(runtime)
  return { runtime, reports }
}

const NO_AGGREGATE = { blocked: false, errors: [], warnings: [], additionalContext: [], systemMessages: [] }

describe('$.ui.notify', () => {
  it('checks its arguments and the answers a hook may give', () => {
    expect(uiNotifyArgsOf('done', undefined)).toEqual({ text: 'done' })
    expect(uiNotifyArgsOf('done', { title: 'CI' })).toEqual({ text: 'done', title: 'CI' })
    expect(() => uiNotifyArgsOf(3, undefined)).toThrow('$.ui.notify(text): text must be a string')
    expect(() => uiNotifyArgsOf('x', { title: 3 })).toThrow('$.ui.notify: title must be a string')
    expect(isUiNotifyResult({ isSent: false, reason: 'refused' })).toBe(true)
    expect(isUiNotifyResult({ isSent: true, channel: 'kitty' })).toBe(true)
    expect(isUiNotifyResult({ isSent: false, reason: 'muted' })).toBe(false)
    expect(isUiNotifyResult({ isSent: true })).toBe(false)
  })

  it("runs the Notification hooks with the text and title (the plugin's name when left out or empty), then resolves no-surface", async () => {
    const heard: Array<{ message: string; title: string; origin: string }> = []
    const { runtime, reports } = world(
      {
        ci: {
          source: `
            export function register(on) {
              on('prompt.submit', async ($, e, next) => {
                const a = await $.ui.notify('tests passed', { title: 'CI' });
                const b = await $.ui.notify('again');
                const c = await $.ui.notify('empty', { title: '' });
                const bad = await $.ui.notify(42).catch(err => err.name + ': ' + err.message);
                await $.ui.log(JSON.stringify({ a, b, c, bad }));
                return next(e);
              });
            }
          `,
        },
      },
      () => ({
        notifications: {
          runHooks: async (notice, context) => {
            heard.push({ ...notice, origin: context.origin.plugin })
          },
        },
      }),
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('ci: {'))!
    expect(JSON.parse(line.slice('ci: '.length))).toEqual({
      a: { isSent: false, reason: 'no-surface' },
      b: { isSent: false, reason: 'no-surface' },
      c: { isSent: false, reason: 'no-surface' },
      bad: 'TypeError: $.ui.notify(text): text must be a string',
    })
    expect(heard).toEqual([
      { message: 'tests passed', title: 'CI', origin: 'ci' },
      { message: 'again', title: 'ci', origin: 'ci' },
      { message: 'empty', title: 'ci', origin: 'ci' },
    ])
  })

  it('is raised as ui.notify: a hook above rewrites it, answers it without the hooks, or denies it and the call rejects', async () => {
    const heard: string[] = []
    const { runtime, reports } = world(
      {
        guard: {
          source: `
            export function register(on) {
              on('ui.notify', ($, e, next) => {
                if (e.text === 'secret') return { deny: 'not that' };
                if (e.text === 'quiet') return { value: { isSent: false, reason: 'refused' } };
                return next({ ...e, text: e.text + '!' });
              });
            }
          `,
        },
        ci: {
          source: `
            export function register(on) {
              on('prompt.submit', async ($, e, next) => {
                const loud = await $.ui.notify('loud');
                const quiet = await $.ui.notify('quiet');
                const secret = await $.ui.notify('secret').catch(err => 'rejected: ' + err.message);
                await $.ui.log(JSON.stringify({ loud, quiet, secret }));
                return next(e);
              });
            }
          `,
        },
      },
      () => ({ notifications: { runHooks: async notice => void heard.push(notice.message) } }),
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('ci: {'))!
    const answered = JSON.parse(line.slice('ci: '.length)) as Record<string, unknown>
    expect(answered.loud).toEqual({ isSent: false, reason: 'no-surface' })
    expect(answered.quiet).toEqual({ isSent: false, reason: 'refused' })
    expect(answered.secret).toMatch(/^rejected: .*not that/)
    expect(heard).toEqual(['loud!'])
  })

  it('resolves with no host to run hooks, as an unbound session', async () => {
    const { runtime, reports } = world({
      ci: {
        source: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              await $.ui.log(JSON.stringify(await $.ui.notify('x')));
              return next(e);
            });
          }
        `,
      },
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['ci: {"isSent":false,"reason":"no-surface"}'])
  })

  it("a classic.Notification hook that notifies is left out of its own call's hooks; the other plugins' run again", async () => {
    const { runtime, reports } = world(
      {
        echo: {
          source: `
            export function register(on) {
              on('classic.Notification', async ($, e, next) => {
                await $.ui.log('echo heard ' + e.message);
                if (e.message === 'turn over') await $.ui.notify('echoed');
                return next(e);
              });
            }
          `,
        },
        listener: {
          source: `
            export function register(on) {
              on('classic.Notification', async ($, e, next) => {
                await $.ui.log('listener heard ' + e.message);
                return next(e);
              });
            }
          `,
        },
      },
      self => ({
        notifications: {
          runHooks: async (notice: { message: string; title: string }, context: DispatchContext) => {
            await self().classic('Notification', { message: notice.message, title: notice.title }, async () => NO_AGGREGATE, undefined, context)
          },
        },
      }),
    )
    await runtime.ready
    await runtime.classic('Notification', { message: 'turn over' }, async () => NO_AGGREGATE, undefined, ROOT_DISPATCH_CONTEXT)
    expect(reports.filter(r => r.includes('heard')).sort()).toEqual([
      'echo heard turn over',
      'listener heard echoed',
      'listener heard turn over',
    ].map(line => (line.startsWith('echo') ? `echo: ${line}` : `listener: ${line}`)).sort())
  })
})

describe('reads for a managed install alone', () => {
  const probe = `
    export function register(on) {
      on('prompt.submit', async ($, e, next) => {
        const identity = await $.session.identity();
        const media = await $.prompt.media({ id: 'img-1' });
        const bad = await $.prompt.media({ id: '' }).catch(err => err.name + ': ' + err.message);
        await $.ui.log(JSON.stringify({ identity, media, bad }));
        return next(e);
      });
    }
  `

  it('a user or built-in plugin is answered { deny }', async () => {
    const { runtime, reports } = world({ installed: { source: probe }, bundled: { source: probe, tier: 'builtin' } })
    await runtime.ready
    await runtime.promptSubmit('go')
    for (const plugin of ['installed', 'bundled']) {
      const line = reports.find(r => r.startsWith(`${plugin}: {`))!
      expect(JSON.parse(line.slice(`${plugin}: `.length))).toEqual({
        identity: { deny: NOT_MANAGED_DENIAL },
        media: { deny: NOT_MANAGED_DENIAL },
        bad: 'TypeError: $.prompt.media: id must be a non-empty string',
      })
    }
  })

  it('a managed plugin learns how the session is signed in; its prompt carries no item to read', async () => {
    const { runtime, reports } = world({ first: { source: probe, tier: 'prepend' }, last: { source: probe, tier: 'append' } })
    await runtime.ready
    await runtime.promptSubmit('go')
    for (const plugin of ['first', 'last']) {
      const line = reports.find(r => r.startsWith(`${plugin}: {`))!
      expect(JSON.parse(line.slice(`${plugin}: `.length))).toEqual({
        identity: { kind: 'none', isVerified: false },
        media: { deny: 'no submission in flight carries img-1' },
        bad: 'TypeError: $.prompt.media: id must be a non-empty string',
      })
    }
  })

  it('a hook above may answer session.identity for core', async () => {
    const { runtime, reports } = world({
      guard: {
        source: `
          export function register(on) {
            on('session.identity', () => ({ value: { kind: 'api-key', isVerified: false } }));
          }
        `,
      },
      installed: { source: probe },
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('installed: {'))!
    expect(JSON.parse(line.slice('installed: '.length)).identity).toEqual({ kind: 'api-key', isVerified: false })
  })
})
