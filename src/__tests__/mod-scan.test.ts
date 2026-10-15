/**
 * The scan (F-25): what a hooks module uses, read off its
 * source with the TypeScript parser — `PluginRegisterUses` — and the two
 * readings the runtime makes of it: the engine calls it does not implement
 * (refused at load) and the calls on plugins' nouns (held to the fold).
 */
import { describe, expect, it } from 'vitest'
import type * as TS from 'typescript'
import { compileModModule, loadTypeScript } from '../mods/modCompiler'
import { implementedNouns } from '../mods/modNouns'
import {
  ENGINE_NOUNS,
  pluginNounCalls,
  scanModuleUses,
  unsupportedEngineCalls,
  type ModUses,
} from '../mods/modScan'

let tsModule: typeof TS | undefined
const ts = async (): Promise<typeof TS> => (tsModule ??= await loadTypeScript())

const scan = async (text: string, path = '/p/hooks/register.ts'): Promise<ModUses> =>
  scanModuleUses(await ts(), [{ path, text }])

describe('scanModuleUses — events', () => {
  it('the patterns on(...) names, in registration order, each once', async () => {
    const uses = await scan(`
      export function register(on) {
        on('prompt.submit', ($, e, next) => next(e))
        on('tool.call', { tool: 'Bash' }, ($, e, next) => next(e))
        on('*', ($, e, next) => next(e))
        on('prompt.submit', ($, e, next) => next(e))
        on(\`session.end\`, ($, e, next) => next(e))
      }
    `)
    expect(uses.events).toEqual(['prompt.submit', 'tool.call', '*', 'session.end'])
  })

  it('reads `on` off register\'s first parameter, whatever it is named — a declaration or an arrow', async () => {
    expect((await scan(`export function register(hook) { hook('tool.call', ($, e, next) => next(e)) }`)).events).toEqual(['tool.call'])
    expect((await scan(`export const register = (add, options) => { add('session.start', () => {}) }`)).events).toEqual(['session.start'])
    expect((await scan(`export const register: Register = async (on) => { on('turn.start', ($, e, next) => next(e)) }`)).events).toEqual(['turn.start'])
  })

  it('a pattern built at run time is not seen', async () => {
    const uses = await scan(`
      const name = 'prompt.' + 'submit'
      export function register(on) { on(name, ($, e, next) => next(e)) }
    `)
    expect(uses.events).toEqual([])
  })
})

describe('scanModuleUses — calls on $', () => {
  it('$.noun.method(...) where $ is a hook\'s first parameter, whatever it is named; sorted, each once', async () => {
    const uses = await scan(`
      export function register(on) {
        on('prompt.submit', async (eng, e, next) => {
          await eng.ui.toast('hi')
          eng.ui.toast('again')
          const cwd = await eng.session.cwd()
          return next(e)
        })
        on('tool.call', ($, e, next) => $.tool.list().then(() => next(e)))
      }
    `)
    expect(uses.calls).toEqual(['session.cwd', 'tool.list', 'ui.toast'])
  })

  it('a destructured $ — in the parameter, or `const { fs } = $` — names its nouns', async () => {
    const uses = await scan(`
      export function register(on) {
        on('prompt.submit', ({ ui, clock: timer }, e, next) => {
          ui.status('x')
          timer.sleep(10)
          return next(e)
        })
        on('session.start', ($) => {
          const { store } = $
          const { state: st } = $
          store.get('k')
          st.get({ plugin: 'p', key: 'k' })
        })
      }
    `)
    expect(uses.calls).toEqual(['clock.sleep', 'state.get', 'store.get', 'ui.status'])
  })

  it('a helper whose first parameter is literally $, and a .catch handler, are seen; a computed member is not', async () => {
    const uses = await scan(`
      async function say($, text) { await $.ui.toast(text) }
      export function register(on) {
        on('prompt.submit', ($, e, next) => say($, e.text).then(() => next(e)))
          .catch(($, e, next) => $.ui.log('failed'))
        on('tool.call', ($, e, next) => {
          const noun = 'fs'
          $[noun].write({ path: 'x' })
          $.tool['list']()
          return next(e)
        })
      }
    `)
    expect(uses.calls).toEqual(['ui.log', 'ui.toast'])
  })

  it('a name bound to $ or a noun means it only in its own scope: another variable of that name is not $', async () => {
    const uses = await scan(`
      const api = { users: { get: () => 1 } }
      function label(tool, prompt) { return tool.toLowerCase() + prompt.trim() + api.users.get() }
      export function register(on) {
        on('tool.call', (api, e, next) => { api.fs.read('/x'); return next(e) })
        on('prompt.submit', ({ tool, prompt }, e, next) => {
          tool.call('Read', {})
          const shadow = (tool) => tool.toUpperCase()
          return next({ ...e, text: shadow(e.text) + label(e.tool, e.text) })
        })
      }
    `)
    expect(uses.calls).toEqual(['fs.read', 'tool.call'])
  })

  it('$.env names and $.state names, by literal; absent when neither is called', async () => {
    const uses = await scan(`
      export function register(on) {
        on('session.start', async ($) => {
          await $.env.get('HOME')
          await $.env.get('PATH')
          await $.env.set('HOME', '/x')
          await $.env.get(process.env.NAME)
          await $.state.get({ plugin: 'p', key: 'count' })
          await $.state.set({ plugin: 'p', key: 'count' }, 1)
          await $.state.set({ plugin: 'p', key: 'other', id: 'a' }, 1)
        })
      }
    `)
    expect(uses.env).toEqual({ reads: ['HOME', 'PATH'], writes: ['HOME'] })
    expect(uses.state).toEqual({
      reads: [{ plugin: 'p', key: 'count' }],
      writes: [
        { plugin: 'p', key: 'count' },
        { plugin: 'p', key: 'other' },
      ],
    })
    const none = await scan(`export function register(on) { on('session.start', ($) => $.ui.toast('x')) }`)
    expect(none.env).toBeUndefined()
    expect(none.state).toBeUndefined()
  })

  it("claude-code's read / update reach $.state: the calls, and the atom's address", async () => {
    const uses = await scan(`
      import { atom, read, update as change } from 'claude-code'
      const count = atom({ plugin: 'p', key: 'count' }, 0)
      export function register(on) {
        on('prompt.submit', async ($, e, next) => {
          const n = await read($, count)
          await change($, count, (v) => v + 1)
          return next(e)
        })
      }
    `)
    expect(uses.calls).toEqual(['state.get', 'state.set'])
    expect(uses.state).toEqual({ reads: [{ plugin: 'p', key: 'count' }], writes: [{ plugin: 'p', key: 'count' }] })
  })

  it("$.plugin.name is a value, not a call: never listed", async () => {
    const uses = await scan(`export function register(on) { on('session.start', ($) => $.ui.log($.plugin.name)) }`)
    expect(uses.calls).toEqual(['ui.log'])
  })

  it('a file with a syntax error yields what parses, and the scan does not throw (the compiler refuses it)', async () => {
    const uses = await scan(`export function register(on) { on('prompt.submit', `)
    expect(uses).toEqual({ events: ['prompt.submit'], calls: [] })
  })

  it('JSX and TSX parse as such', async () => {
    const uses = await scan(
      `
      export const register = (on) => {
        on('ui.render', { component: 'Pane' }, ($, e) => {
          const { Box, Text } = $.ui.resolve(e)
          return <Box><Text>hi</Text></Box>
        })
      }
    `,
      '/p/hooks/register.tsx',
    )
    expect(uses.events).toEqual(['ui.render'])
    expect(uses.calls).toEqual(['ui.resolve'])
  })
})

describe('the runtime\'s two readings', () => {
  it('an engine noun this engine does not implement is unsupported; a plugin noun is not', () => {
    const uses: ModUses = { events: [], calls: ['fs.write', 'process.spawn', 'session.authorize', 'session.cwd', 'ui.resolve', 'voice.say', 'tool.register'] }
    // `fs.write`, `tool.register` and `process.spawn` are implemented;
    // `session.authorize` is not.
    expect(unsupportedEngineCalls(uses, implementedNouns())).toEqual(['session.authorize'])
    expect(pluginNounCalls(uses)).toEqual([{ noun: 'voice', call: 'voice.say' }])
    // `$.telemetry` is served (checked, never sent): a module that records
    // its use — the external diff mod does — is not refused at load.
    expect(unsupportedEngineCalls({ events: [], calls: ['telemetry.log', 'telemetry.mark'] }, implementedNouns())).toEqual([])
    for (const noun of ['plugin', 'ui', 'session', 'tool', 'fs', 'process', 'env', 'settings', 'state', 'store', 'clock']) {
      expect(ENGINE_NOUNS).toContain(noun)
    }
  })

  it('the compiler scans the whole graph, cache or no cache', async () => {
    const files: Record<string, string> = {
      '/p/hooks/register.ts': `
        import { helper } from './helper'
        export function register(on) { on('prompt.submit', ($, e, next) => helper($).then(() => next(e))) }
      `,
      '/p/hooks/helper.ts': `export async function helper($) { await $.ui.toast('x'); await $.env.get('HOME') }`,
    }
    const fs = { readFile: async (path: string) => files[path] ?? Promise.reject(new Error('ENOENT')) }
    const entries = new Map<string, string>()
    const cache = { read: async (d: string) => entries.get(d) ?? null, write: async (d: string, t: string) => void entries.set(d, t) }
    const first = await compileModModule({ entry: '/p/hooks/register.ts', root: '/p', fs, cache })
    expect(first.uses).toEqual({ events: ['prompt.submit'], calls: ['env.get', 'ui.toast'], env: { reads: ['HOME'], writes: [] } })
    const second = await compileModModule({ entry: '/p/hooks/register.ts', root: '/p', fs, cache })
    expect(second.fromCache).toBe(true)
    expect(second.uses).toEqual(first.uses)
  })
})
