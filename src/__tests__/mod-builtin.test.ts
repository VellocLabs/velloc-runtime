/**
 * The built-in tier (F-25): a hooks module
 * bundled in nexus_web loads in every slot beneath the installed plugins,
 * with `builtin` as its tier on `next.origin`, `plugin.register` and the
 * trace; the registry's paths serve its text; the slot selection appends the
 * built-ins after the installed modules; a built-in hooks the same events.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  builtinModPath,
  builtinModRefs,
  isBuiltinModPath,
  listBuiltinMods,
  readBuiltinMod,
  registerBuiltinMod,
  unregisterBuiltinMod,
} from '../mods/builtinMods'
import { selectModModules } from '../mods/modSlot'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  for (const mod of listBuiltinMods()) unregisterBuiltinMod(mod.name)
})

const TAGGER = `
export function register(on) {
  on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' [builtin]' }));
  on('plugin.register', ($, e, next) => next(e));
}
`

describe('the registry', () => {
  it('registers, lists, serves by path, and makes refs in the builtin tier', () => {
    registerBuiltinMod({ name: 'velloc-tagger', version: '1.2.0', description: 'Tags prompts.', source: TAGGER })
    expect(listBuiltinMods().map(m => m.name)).toEqual(['velloc-tagger'])
    expect(builtinModPath('velloc-tagger')).toBe('builtin:velloc-tagger/hooks/register.js')
    expect(isBuiltinModPath('builtin:velloc-tagger/hooks/register.js')).toBe(true)
    expect(isBuiltinModPath('/plugins/x/hooks/register.js')).toBe(false)
    expect(readBuiltinMod('builtin:velloc-tagger/hooks/register.js')).toBe(TAGGER)
    expect(readBuiltinMod('builtin:other/hooks/register.js')).toBeUndefined()
    expect(builtinModRefs()).toEqual([
      {
        plugin: 'velloc-tagger',
        path: 'builtin:velloc-tagger/hooks/register.js',
        root: 'builtin:velloc-tagger',
        tier: 'builtin',
        provenance: 'velloc-tagger@builtin',
        version: '1.2.0',
        description: 'Tags prompts.',
      },
    ])
    expect(() => registerBuiltinMod({ name: '', source: '' })).toThrow(TypeError)
  })

  it('the slot selection appends the built-ins after the installed modules, and only for a slot', () => {
    registerBuiltinMod({ name: 'velloc-tagger', source: TAGGER })
    const installed = [{ name: 'a', hookModules: ['/p/a/hooks/one.js'] }]
    expect(selectModModules({}, installed).map(ref => [ref.plugin, ref.tier ?? 'user'])).toEqual([
      ['a', 'user'],
      ['velloc-tagger', 'builtin'],
    ])
    expect(selectModModules({ isSubAgent: true }, installed)).toEqual([])
    // With nothing installed a slot still loads its built-ins.
    expect(selectModModules({}, []).map(ref => ref.plugin)).toEqual(['velloc-tagger'])
  })

  it('a built-in loads by its default unless settings.json enabledPlugins names it', () => {
    registerBuiltinMod({ name: 'velloc-tagger', source: TAGGER })
    registerBuiltinMod({ name: 'velloc-off', source: TAGGER, onByDefault: false })
    expect(builtinModRefs().map(ref => ref.plugin)).toEqual(['velloc-tagger'])
    // An explicit entry wins over the default, either way.
    expect(builtinModRefs({ 'velloc-off@builtin': true, 'velloc-tagger@builtin': false }).map(ref => ref.plugin))
      .toEqual(['velloc-off'])
    // Another plugin's entry under the same name is not the built-in's.
    expect(builtinModRefs({ 'velloc-off@mkt': true }).map(ref => ref.plugin)).toEqual(['velloc-tagger'])
    expect(selectModModules({}, [], {}, { 'velloc-off@builtin': true }).map(ref => ref.plugin))
      .toEqual(['velloc-tagger', 'velloc-off'])
  })
})

describe('a built-in in the slot', () => {
  let uniq = 0
  function world(refs: ModModuleRef[], sources: Record<string, string>) {
    const reports: string[] = []
    const runtime = new ModRuntime({
      modules: refs,
      readModule: async path => {
        const builtin = readBuiltinMod(path)
        return `${builtin ?? sources[path]!}\n// load ${++uniq}`
      },
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
      session: { id: () => 's', cwd: () => '/work/project' },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, reports }
  }

  it("runs beneath the user's plugins whatever its place in the list, is judged with tier builtin, and reports its provenance", async () => {
    registerBuiltinMod({ name: 'velloc-tagger', source: TAGGER })
    const judge = `
      export function register(on) {
        on('plugin.register', async ($, e, next) => { await $.ui.log('judged ' + e.name + ' ' + e.tier + ' ' + e.provenance); return next(e) });
        on('prompt.submit', async ($, e, next) => {
          const result = await next({ ...e, text: e.text + ' [user]' });
          await $.ui.log('trace ' + next.trace.map(t => t.plugin + ':' + t.tier).join(','));
          return result;
        });
      }
    `
    // The built-in is listed FIRST: the dispatcher still seats it beneath.
    const { runtime, reports } = world(
      [...builtinModRefs(), { plugin: 'judge', path: '/plugins/judge/hooks/register.js' }],
      { '/plugins/judge/hooks/register.js': judge },
    )
    await runtime.ready
    expect(runtime.status().map(row => [row.plugin, row.state])).toEqual([
      ['velloc-tagger', 'loaded'],
      ['judge', 'loaded'],
    ])
    const outcome = await runtime.promptSubmit('hi')
    // The user hook ran first (outer), the built-in beneath it.
    expect(outcome).toMatchObject({ entered: true, text: 'hi [user] [builtin]' })
    // The trace beneath the user hook: the built-in, then the engine's core.
    // The trace beneath the user hook: the built-in, then the engine's core.
    expect(reports.find(line => line.startsWith('judge: trace '))).toMatch(/^judge: trace velloc-tagger:builtin(,|$)/)
    // The judge loaded after the built-in, so it did not judge it; a later
    // load of the built-in alone is judged with its tier and provenance.
    await runtime.reconcile([...builtinModRefs(), { plugin: 'judge', path: '/plugins/judge/hooks/register.js' }], { reloadChanged: true })
    expect(reports.some(line => line === 'judge: judged velloc-tagger builtin velloc-tagger@builtin')).toBe(true)
  })
  it('its status says who each module is — Settings → Plugins & Mods reads it', async () => {
    registerBuiltinMod({ name: 'velloc-tagger', version: '2.0.0', description: 'Tags prompts.', source: TAGGER })
    const refs = selectModModules({}, [
      {
        name: 'my-mod',
        path: '/home/u/.velloc/plugins/my-mod',
        hookModules: ['/home/u/.velloc/plugins/my-mod/hooks/register.js'],
        manifest: { version: '0.1.0', description: 'Tags every prompt.' },
      },
    ])
    const { runtime } = world(refs, { '/home/u/.velloc/plugins/my-mod/hooks/register.js': 'export function register() {}' })
    await runtime.ready
    expect(runtime.status()).toMatchObject([
      {
        plugin: 'my-mod',
        version: '0.1.0',
        description: 'Tags every prompt.',
        provenance: 'my-mod@inline',
        root: '/home/u/.velloc/plugins/my-mod',
      },
      {
        plugin: 'velloc-tagger',
        version: '2.0.0',
        description: 'Tags prompts.',
        provenance: 'velloc-tagger@builtin',
        tier: 'builtin',
      },
    ])
    expect(runtime.status()[0]).not.toHaveProperty('tier')
  })
})
