/**
 * `$.config` (F-25), plugin rows only: `userConfig` fields as `/config` rows, `$.config.list` after the
 * `config.describe` hooks, and `$.config.set` checked like `/config key=value` through the other plugins'
 * `config.set` hooks, then written. The host is a fake over in-memory `pluginConfigs`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import {
  configValueFor,
  modConfigWrite,
  pluginConfigRows,
  type ConfigPlugin,
  type ConfigRowSpec,
  type ConfigValue,
  type ModConfigHost,
} from '../mods/modConfig'
import { implementedNouns, type ModNounHost } from '../mods/modNouns'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { PluginUserConfigField } from '../pluginHost/pluginModel'

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

const FIELDS: Record<string, PluginUserConfigField> = {
  mode: { type: 'string', title: 'Mode', description: 'How fast', options: ['Fast', 'Slow'], default: 'Fast' },
  limit: { type: 'number', title: 'Limit', description: 'At most', default: 3, min: 1, max: 10 },
  loud: { type: 'boolean', title: 'Loud', description: 'Shout' },
  dir: { type: 'directory', title: 'Folder', description: 'Where' },
  tags: { type: 'string', title: 'Tags', description: 'Labels', multiple: true },
  token: { type: 'string', title: 'Token', description: 'Secret', sensitive: true },
}

/** A slot whose modules are `register` bodies, over a config host whose
 *  plugins are `plugins` and whose stored values are `stored`. */
function world(
  modules: Record<string, string>,
  plugins: ConfigPlugin[] = [{ name: 'cfg', manifest: { userConfig: FIELDS } }],
  stored: Record<string, { options?: Record<string, unknown> }> = {},
  host: Partial<ModNounHost> | null = {},
) {
  const reports: string[] = []
  const writes: Array<[string, string, ConfigValue]> = []
  const config: ModConfigHost = {
    rows: async () => pluginConfigRows(plugins, stored),
    write: async (row, value) => {
      writes.push([row.pluginId, row.field, value])
      stored[row.pluginId] = { options: { ...(stored[row.pluginId]?.options ?? {}), [row.field]: value } }
    },
  }
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path =>
      `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
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
    session: { id: () => 'sess-config', cwd: () => '/work', ...(host === null ? {} : { config, ...host }) },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return { runtime, reports, writes, stored }
}

/** A `prompt.submit` hook that logs what `expr` evaluates to. */
const logging = (expr: string): string => `
  on('prompt.submit', async ($, e, next) => {
    try {
      await $.ui.log(JSON.stringify(await (${expr})))
    } catch (error) {
      await $.ui.log('ERR ' + error.name + ': ' + error.message)
    }
    return next(e)
  })
`

describe('the config nouns are listed as raised events', () => {
  it('config.list and config.set are served; config.describe is raised', () => {
    expect(implementedNouns()).toEqual(expect.arrayContaining(['config.list', 'config.set']))
    expect(RAISED_EVENTS).toEqual(expect.arrayContaining(['config.list', 'config.set', 'config.describe']))
  })
})

describe('pluginConfigRows — /config rows for plugin fields', () => {
  it('one row per field, a sensitive or multiple one left out, each field type mapped to a row kind', () => {
    const rows = pluginConfigRows([{ name: 'cfg', manifest: { userConfig: FIELDS } }], {})
    expect(rows.map(row => [row.key, row.kind, row.value, row.label, row.description])).toEqual([
      ['cfg.mode', 'choice', 'Fast', 'Mode', 'How fast'],
      ['cfg.limit', 'number', 3, 'Limit', 'At most'],
      ['cfg.loud', 'boolean', false, 'Loud', 'Shout'],
      ['cfg.dir', 'text', '', 'Folder', 'Where'],
    ])
    expect(rows[0]).toMatchObject({ options: ['Fast', 'Slow'], provider: { plugin: 'cfg', tier: 'user' }, isLocked: false, pluginId: 'cfg@inline' })
  })

  it('reads values stored under the plugin id; a disabled plugin has no rows', () => {
    const plugins: ConfigPlugin[] = [
      { name: 'cfg', installIdentifier: 'cfg@market', manifest: { userConfig: FIELDS } },
      { name: 'off', enabled: false, manifest: { userConfig: FIELDS } },
    ]
    const rows = pluginConfigRows(plugins, { 'cfg@market': { options: { mode: 'Slow', loud: 'true', limit: 7 } }, cfg: { options: { mode: 'x' } } })
    expect(rows.map(row => [row.key, row.value])).toEqual([
      ['cfg.mode', 'Slow'],
      ['cfg.limit', 7],
      ['cfg.loud', true],
      ['cfg.dir', ''],
    ])
  })

  it('two enabled plugins whose names match in any letter case are keyed by plugin id', () => {
    const one = { mode: FIELDS.mode! }
    const rows = pluginConfigRows(
      [
        { name: 'Cfg', installIdentifier: 'Cfg@a', manifest: { userConfig: one } },
        { name: 'cfg', manifest: { userConfig: one } },
        { name: 'other', manifest: { userConfig: one } },
      ],
      {},
    )
    expect(rows.map(row => row.key)).toEqual(['Cfg@a.mode', 'cfg@inline.mode', 'other.mode'])
  })

  it('a value is checked against its field, and a refusal says what the field takes', () => {
    const [mode, limit, loud, dir] = pluginConfigRows([{ name: 'cfg', manifest: { userConfig: FIELDS } }], {}) as ConfigRowSpec[]
    expect(configValueFor(mode!, 'slow')).toEqual({ value: 'Slow' })
    expect(configValueFor(mode!, 'medium')).toEqual({ deny: 'Mode takes one of: Fast, Slow.' })
    expect(configValueFor(limit!, ' 4 ')).toEqual({ value: 4 })
    expect(configValueFor(limit!, 11)).toEqual({ deny: 'Limit doesn\'t accept "11". It takes a number between 1 and 10.' })
    expect(configValueFor(loud!, 'yes')).toEqual({ deny: 'Loud takes true or false.' })
    expect(configValueFor(dir!, 5)).toEqual({ value: '5' })
    expect(configValueFor(dir!, true)).toEqual({ deny: 'Folder: a text row cannot hold that value' })
  })
})

describe('$.config.list', () => {
  it('lists the rows as the menu would, without what they were built from', async () => {
    const { runtime, reports } = world({ caller: logging('$.config.list()') }, undefined, { 'cfg@inline': { options: { limit: 5 } } })
    await runtime.ready
    await runtime.promptSubmit('hi')
    const rows = JSON.parse(reports[0]!.slice('caller: '.length))
    expect(rows.map((row: { key: string; value: unknown }) => [row.key, row.value])).toEqual([
      ['cfg.mode', 'Fast'],
      ['cfg.limit', 5],
      ['cfg.loud', false],
      ['cfg.dir', ''],
    ])
    expect(rows[0]).toEqual({
      key: 'cfg.mode',
      label: 'Mode',
      description: 'How fast',
      kind: 'choice',
      value: 'Fast',
      options: ['Fast', 'Slow'],
      provider: { plugin: 'cfg', tier: 'user' },
      isLocked: false,
    })
  })

  it('is refused by name in a session without plugin settings', async () => {
    const { runtime, reports } = world({ caller: logging('$.config.list()') }, undefined, {}, null)
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['caller: ERR NotSupportedError: $.config.list is not available: this session has no plugin settings'])
  })
})

describe('$.config.set', () => {
  it('writes a fitting value as the option is spelled and answers { value }', async () => {
    const { runtime, reports, writes, stored } = world({ caller: logging(`$.config.set({ key: 'cfg.mode', value: 'slow' })`) })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['caller: {"value":"Slow"}'])
    expect(writes).toEqual([['cfg@inline', 'mode', 'Slow']])
    expect(stored).toEqual({ 'cfg@inline': { options: { mode: 'Slow' } } })
  })

  it('a value that does not fit is { deny } and nothing is written', async () => {
    const { runtime, reports, writes } = world({
      caller: logging(`Promise.all([$.config.set({ key: 'cfg.limit', value: 0 }), $.config.set({ key: 'cfg.loud', value: 'on' })])`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'caller: [{"deny":"Limit doesn\'t accept \\"0\\". It takes a number between 1 and 10."},{"deny":"Loud takes true or false."}]',
    ])
    expect(writes).toEqual([])
  })

  it('rejects a key no row has — a sensitive field has none', async () => {
    const { runtime, reports } = world({ caller: logging(`$.config.set({ key: 'cfg.token', value: 'x' })`) })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['caller: ERR NotFoundError: $.config.set: no /config row has the key "cfg.token"'])
  })

  it('another plugin\'s config.set hook sees the input with origin and may deny it', async () => {
    const { runtime, reports, writes } = world({
      guard: `on('config.set', async ($, e, next) => {
        await $.ui.log(JSON.stringify(e))
        return e.key === 'cfg.loud' ? { deny: 'not today' } : next(e)
      })`,
      caller: logging(`$.config.set({ key: 'cfg.loud', value: true })`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'guard: {"key":"cfg.loud","value":true,"previous":false,"provider":{"plugin":"cfg","tier":"user"},"origin":{"kind":"plugin","name":"caller"}}',
      'caller: {"deny":"not today"}',
    ])
    expect(writes).toEqual([])
  })

  it('a hook may clamp the value; the rewrite is checked again', async () => {
    const { runtime, reports, writes } = world({
      clamp: `on('config.set', ($, e, next) => next({ ...e, value: e.key === 'cfg.limit' ? '10' : 'Medium' }))`,
      caller: logging(`Promise.all([$.config.set({ key: 'cfg.limit', value: 9 }), $.config.set({ key: 'cfg.mode', value: 'Fast' })])`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['caller: [{"value":10},{"deny":"Mode doesn\'t accept \\"Medium\\"."}]'])
    expect(writes).toEqual([['cfg@inline', 'limit', 10]])
  })

  it('a rewrite of a pinned field is refused and nothing is written', async () => {
    const { runtime, reports, writes } = world({
      spoof: `on('config.set', ($, e, next) => next({ ...e, origin: { kind: 'composer' } }))`,
      caller: logging(`$.config.set({ key: 'cfg.loud', value: true })`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports.at(-1)).toMatch(/^caller: ERR .*the rewritten event is refused: origin is pinned/)
    expect(writes).toEqual([])
  })

  it('the calling plugin\'s own config.set hook does not see it — another plugin\'s does', async () => {
    const hook = `on('config.set', async ($, e, next) => { await $.ui.log('saw ' + e.key); return next(e) })`
    const self = world({ caller: `${hook}\n${logging(`$.config.set({ key: 'cfg.loud', value: true })`)}` })
    await self.runtime.ready
    await self.runtime.promptSubmit('hi')
    expect(self.reports).toEqual(['caller: {"value":true}'])
    // Negative control: the same hook in another plugin runs.
    const other = world({ watcher: hook, caller: logging(`$.config.set({ key: 'cfg.loud', value: true })`) })
    await other.runtime.ready
    await other.runtime.promptSubmit('hi')
    expect(other.reports).toEqual(['watcher: saw cfg.loud', 'caller: {"value":true}'])
  })
})

describe('config.describe', () => {
  const describer = `on('config.describe', async ($, e, next) => {
    await $.ui.log('describe ' + e.key)
    if (e.key === 'cfg.dir') return next({ ...e, isHidden: true })
    if (e.key === 'cfg.mode') return next({ ...e, label: 'Speed', description: undefined })
    return next(e)
  })`

  it('relabels and hides rows in the list; a hidden row still answers $.config.set', async () => {
    const { runtime, reports, writes } = world({
      describer,
      caller: logging(`(async () => ({
        rows: (await $.config.list()).map(row => [row.key, row.label, row.description ?? null]),
        set: await $.config.set({ key: 'cfg.dir', value: '/tmp' }),
      }))()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports.at(-1)).toBe(
      'caller: {"rows":[["cfg.mode","Speed",null],["cfg.limit","Limit","At most"],["cfg.loud","Loud","Shout"]],"set":{"value":"/tmp"}}',
    )
    expect(writes).toEqual([['cfg@inline', 'dir', '/tmp']])
  })

  it('answers are cached until $.ui.invalidate(\'config.describe\')', async () => {
    const { runtime, reports } = world({
      describer,
      caller: logging(`(async () => {
        await $.config.list()
        await $.config.list()
        await $.ui.invalidate('config.describe')
        return (await $.config.list()).length
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    const asked = reports.filter(line => line === 'describer: describe cfg.mode')
    expect(asked).toHaveLength(2)
    expect(reports.at(-1)).toBe('caller: 3')
  })

  it('a hook whose rewrite is refused leaves the row as built and is reported', async () => {
    const { runtime, reports } = world({
      bad: `on('config.describe', ($, e, next) => next({ ...e, key: 'other' }))`,
      caller: logging(`$.config.list().then(rows => rows.map(row => row.label))`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports.at(-1)).toBe('caller: ["Mode","Limit","Loud","Folder"]')
    expect(reports.some(line => line.includes('config.describe (cfg.mode) failed') && line.includes('key is pinned'))).toBe(true)
  })
})

describe('modConfigWrite — the host writer', () => {
  const row = { pluginId: 'cfg@inline', field: 'mode' } as unknown as ConfigRowSpec

  it('returns once the value is stored, without waiting for the plugin reload (which waits for the turn)', async () => {
    let turnEnds!: () => void
    const turn = new Promise<void>(resolve => { turnEnds = resolve })
    let reloaded = false
    const write = modConfigWrite({
      store: async () => true,
      // The reload waits for the running turn — the turn the calling hook is in.
      reload: async () => {
        await turn
        reloaded = true
      },
      report: () => {},
    })
    await write(row, 'fast')
    expect(reloaded).toBe(false)
    turnEnds()
    await turn
    await Promise.resolve()
    expect(reloaded).toBe(true)
  })

  it('nothing stored, nothing reloaded; a reload that fails is reported, not thrown', async () => {
    let reloads = 0
    const reports: string[] = []
    const unchanged = modConfigWrite({ store: async () => false, reload: () => { reloads += 1 }, report: line => reports.push(line) })
    await unchanged(row, 'same')
    const failing = modConfigWrite({ store: async () => true, reload: async () => { throw new Error('boom') }, report: line => reports.push(line) })
    await failing(row, 'x')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reloads).toBe(0)
    expect(reports).toEqual(['mods: the plugins did not reload after $.config.write (boom)'])
  })
})
