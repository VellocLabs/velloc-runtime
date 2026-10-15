/**
 * The window's language for a mod: `$.plugin.locale` and `session.start`'s
 * `locale`. Real module text loaded by `ModWorkerHost` on a MessageChannel,
 * as in `mod-cheap-nouns.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MOD_DEFAULT_LOCALE, normalizeModLocale } from '../mods/modLocale'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

function world(body: string, locale?: string) {
  const reports: string[] = []
  const refs: ModModuleRef[] = [{ plugin: 'lang', path: '/plugins/lang/hooks/register.js' }]
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
    session: { id: () => 'sess-locale', cwd: () => '/work/project' },
    report: line => reports.push(line),
    ...(locale !== undefined ? { locale } : {}),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

const READ_LOCALE = `
  on('session.start', async ($, e, next) => {
    await $.ui.log('start ' + JSON.stringify({ plugin: $.plugin.locale, event: e.locale }))
    return next(e)
  })
`

describe('normalizeModLocale', () => {
  it('trims, turns _ into -, and falls back to en', () => {
    expect(normalizeModLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeModLocale('  pt_BR ')).toBe('pt-BR')
    expect(normalizeModLocale('')).toBe('en')
    expect(normalizeModLocale('   ')).toBe('en')
    expect(normalizeModLocale(undefined)).toBe('en')
    expect(normalizeModLocale(42)).toBe('en')
    expect(MOD_DEFAULT_LOCALE).toBe('en')
  })
})

describe('$.plugin.locale and session.start', () => {
  it('reaches a real mod worker, and the session.start event carries the same value', async () => {
    const { runtime, reports } = world(READ_LOCALE, 'zh_CN')
    await runtime.ready
    expect(reports).toEqual(['lang: start {"plugin":"zh-CN","event":"zh-CN"}'])
  })

  it('reads en when the runtime was given no locale, or a blank one', async () => {
    for (const locale of [undefined, '', '  ']) {
      const { runtime, reports } = world(READ_LOCALE, locale)
      await runtime.ready
      expect(reports).toEqual(['lang: start {"plugin":"en","event":"en"}'])
    }
  })

  it('is a value on the frozen $.plugin, readable in any hook', async () => {
    const { runtime, reports } = world(
      `on('prompt.submit', async ($, e, next) => {
         await $.ui.log(typeof $.plugin.locale + ' ' + $.plugin.locale)
         return next(e)
       })`,
      'fr-CA',
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['lang: string fr-CA'])
  })

  it('a module that ignores it is unaffected, and a hook answer to session.start is still accepted', async () => {
    const { runtime, reports } = world(
      `on('session.start', async ($, e, next) => { await $.ui.log('cwd ' + e.cwd); return { ...e, extra: 1 } })
       on('prompt.submit', async ($, e, next) => next({ ...e, text: e.text + '!' }))`,
      'ja',
    )
    await runtime.ready
    expect(reports).toEqual(['lang: cwd /work/project'])
    expect(await runtime.promptSubmit('hi')).toMatchObject({ text: 'hi!' })
  })
})
