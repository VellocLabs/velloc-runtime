/**
 * `$.theme.set` / `$.theme.clear` (F-25): the session's one theme, the latest
 * set whichever plugin set it; op events a hook may rewrite, deny or answer;
 * published on the ui state; a scene drawn as the `Backdrop` site; gone with
 * the plugin that set it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { ModThemeState, isThemeResult, themeClearCore, themeSetArgsOf, themeSetCore } from '../mods/modTheme'
import type { ModUiEvent, ModUiSnapshot } from '../mods/modUi'
import { isModsUiState } from '../browser/runtimeProtocol'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0
function world(modules: Record<string, string>, drawsComposer: boolean) {
  const reports: string[] = []
  const states: ModUiSnapshot[] = []
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
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
    drawsComposer,
    onUiChanged: (event: ModUiEvent) => {
      if (event.kind === 'state') states.push(event.state)
    },
  })
  runtimes.push(runtime)
  const logs = (plugin: string) =>
    reports.filter(r => r.startsWith(`${plugin}: `)).map(r => JSON.parse(r.slice(plugin.length + 2)) as Record<string, unknown>)
  return { runtime, reports, states, logs, refs }
}

const PALETTE = { v: 1, label: 'Paper', inputs: { light: { 'gray-20': '#efe6d3', 'gray-900': '#2a241d' } } }

const SETTER = `
  export function register(on) {
    on('session.start', async ($, e, next) => {
      const first = await $.theme.set({ colors: ${JSON.stringify(PALETTE)} });
      const scene = await $.theme.set({ backdrop: { scene: 'tide', glass: { blur: 8 } }, overrideColorScheme: 'dark' });
      const unknown = await $.theme.set({ font: 'serif' }).catch(err => err.name + ': ' + err.message);
      const empty = await $.theme.set({}).catch(err => err.name + ': ' + err.message);
      const unsafe = await $.theme.set({ colors: JSON.parse('{"__proto__": {"x": 1}}') }).catch(err => err.name + ': ' + err.message);
      const denied = await $.theme.set({ backdrop: { color: '#123456' } }).catch(err => 'rejected: ' + err.message);
      await $.ui.log(JSON.stringify({ first, scene, unknown, empty, unsafe, denied }));
      return next(e);
    });
    on('ui.render', { component: 'Backdrop' }, ($, e) => {
      const { Svg } = $.ui.resolve(e);
      return h(Svg, { source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', alt: e.props.plugin + '/' + e.props.scene });
    });
  }
`
const GUARD = `
  export function register(on) {
    on('theme.set', ($, e, next) => (e.backdrop && e.backdrop.color ? { deny: 'no flat grounds' } : next(e)));
  }
`

describe('$.theme', () => {
  it('sets the one theme where a page draws the session; a later set replaces it whole; a bad attribute is refused by name; a hook may deny', async () => {
    const { runtime, logs } = world({ guard: GUARD, setter: SETTER }, true)
    await runtime.ready
    const [got] = logs('setter')
    expect(got!.first).toEqual({ isDrawn: true, requestId: 'theme' })
    expect(got!.scene).toEqual({ isDrawn: true, requestId: 'backdrop' })
    expect(got!.unknown).toBe('TypeError: $.theme.set: unknown attribute "font"')
    expect(got!.empty).toBe('TypeError: $.theme.set: names no attribute')
    expect(got!.unsafe).toBe('TypeError: $.theme.set: colors has the key "__proto__"')
    expect(got!.denied).toMatch(/^rejected: .*no flat grounds/)
    const latest = runtime.uiSnapshot()
    // The scene's set replaced the palette: what a set leaves out is gone.
    expect(latest.theme).toEqual({
      plugin: 'setter',
      requestId: 'backdrop',
      backdrop: { scene: 'tide', glass: { blur: 8, opacity: 0.6 } },
      overrideColorScheme: 'dark',
    })
    expect(isModsUiState(latest)).toBe(true)
    expect(runtime.renderSites()).toContainEqual({ plugin: 'setter', component: 'Backdrop' })
  })

  it('waits, not drawn, where no page draws the session', async () => {
    const { runtime, logs } = world({ setter: SETTER }, false)
    await runtime.ready
    const [got] = logs('setter')
    expect(got!.first).toEqual({ isDrawn: false, requestId: 'theme', reason: 'no page draws this session' })
    // No guard here: the last set, a flat ground, stands for a page yet to attach.
    expect(runtime.uiSnapshot().theme).toMatchObject({ requestId: 'theme', backdrop: { color: '#123456' } })
  })

  it('draws the scene as the Backdrop site with its scene and plugin', async () => {
    const { runtime } = world({ setter: SETTER }, true)
    await runtime.ready
    const drawn = await runtime.render({
      component: 'Backdrop',
      requestId: 'backdrop',
      props: { scene: 'tide', plugin: 'setter', glass: { blur: 8, opacity: 0.6 }, overrideColorScheme: 'dark' },
    })
    expect(drawn.kind).toBe('tree')
    expect(JSON.stringify(drawn)).toContain('setter/tide')
  })

  it("a hook's rewrite of the attributes is what stands; a clear removes another plugin's theme", async () => {
    const REWRITER = `
      export function register(on) {
        on('theme.set', ($, e, next) => next({ ...e, overrideColorScheme: 'light' }));
      }
    `
    const CLEARER = `
      export function register(on) {
        on('command.run', async ($, e, next) => next(e));
        on('session.start', async ($, e, next) => {
          await $.clock.sleep(30);
          const cleared = await $.theme.clear();
          await $.ui.log(JSON.stringify({ cleared }));
          return next(e);
        });
      }
    `
    const SETS = `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.theme.set({ backdrop: { gradient: { stops: ['surface-0', '#000000'] } } });
          return next(e);
        });
      }
    `
    const rewrite = world({ rewriter: REWRITER, sets: SETS }, true)
    await rewrite.runtime.ready
    expect(rewrite.runtime.uiSnapshot().theme).toEqual({
      plugin: 'sets',
      requestId: 'theme',
      backdrop: { gradient: { stops: ['surface-0', '#000000'] } },
      overrideColorScheme: 'light',
    })
    const cleared = world({ sets: SETS, clearer: CLEARER }, true)
    await cleared.runtime.ready
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(cleared.logs('clearer')[0]!.cleared).toEqual({ isDrawn: false, reason: 'the theme was cleared' })
    expect(cleared.runtime.uiSnapshot().theme).toBeUndefined()
  })

  it('a plugin that unloads takes its theme with it', async () => {
    const { runtime, refs } = world({ setter: SETTER, other: 'export function register(on) {}' }, true)
    await runtime.ready
    expect(runtime.uiSnapshot().theme?.plugin).toBe('setter')
    await runtime.reconcile(refs.filter(ref => ref.plugin !== 'setter'))
    expect(runtime.uiSnapshot().theme).toBeUndefined()
  })

  it('loads and sets the shipped look example: a whole palette from session.start', async () => {
    const LOOK = `
      const theme = ${JSON.stringify({ ...PALETTE, id: 'mod-theme', inputs: { ...PALETTE.inputs, dark: { 'gray-900': '#1f1a15', 'gray-50': '#f0e7d7' } } })};
      const problems = [];
      const LOOK = { colors: theme };
      export const register = on => {
        on('session.start', async ($, e, next) => {
          const unpainted = problems.find(line => line.startsWith("Desktop won't paint"));
          if (unpainted !== undefined) $.ui.toast(unpainted);
          const set = await $.theme.set(LOOK);
          if (!set.isDrawn) $.ui.status(set.reason);
          return next(e);
        });
      };
    `
    const { runtime, reports } = world({ look: LOOK }, true)
    await runtime.ready
    expect(reports.filter(line => /refused|failed/.test(line))).toEqual([])
    expect(runtime.uiSnapshot().theme?.colors).toMatchObject({ v: 1, label: 'Paper' })
    expect(runtime.uiSnapshot().status).toEqual([])
  })
})

describe('theme args and state', () => {
  it('checks each backdrop kind by shape and size', () => {
    expect(themeSetArgsOf({ backdrop: false })).toEqual({ backdrop: false })
    expect(themeSetArgsOf({ backdrop: { color: 'rgb(1, 2, 3)' } })).toEqual({ backdrop: { color: 'rgb(1, 2, 3)' } })
    expect(() => themeSetArgsOf({ backdrop: { color: 'red' } })).toThrow(/backdrop.color/)
    expect(() => themeSetArgsOf({ backdrop: { scene: 'a', color: '#fff' } })).toThrow(/exactly one/)
    expect(() => themeSetArgsOf({ backdrop: { scene: 'a b' } })).toThrow(/backdrop.scene/)
    expect(() => themeSetArgsOf({ backdrop: { scene: 'a', glass: { tint: 'surface-0' } } })).toThrow(/tint/)
    expect(() => themeSetArgsOf({ backdrop: { scene: 'a', glass: { blur: 65 } } })).toThrow(/blur/)
    expect(() =>
      themeSetArgsOf({ backdrop: { gradient: { stops: [{ at: 0.5, color: '#000' }, { at: 0.2, color: '#fff' }] } } }),
    ).toThrow(/in order/)
    expect(themeSetArgsOf({ backdrop: { vector: { viewBox: 24, paths: ['M0 0L24 24Z', { d: 'M1 1h2', strokeWidth: 2 }], color: 'text-muted' } } }))
      .toEqual({ backdrop: { vector: { viewBox: 24, paths: ['M0 0L24 24Z', { d: 'M1 1h2', strokeWidth: 2 }], color: 'text-muted' } } })
    expect(() => themeSetArgsOf({ backdrop: { vector: { viewBox: 24, paths: ['M0 0 url(x)'] } } })).toThrow(/path data/)
    expect(() => themeSetArgsOf({ backdrop: { vector: { viewBox: 24, paths: ['M0 0L2000000 0'] } } })).toThrow(/path data/)
    expect(themeSetArgsOf({ backdrop: { image: { source: 'art/harbour.jpg', size: [64, 64], repeat: true } } })).toEqual({
      backdrop: { image: { source: 'art/harbour.jpg', size: [64, 64], repeat: true } },
    })
    expect(() => themeSetArgsOf({ backdrop: { image: { source: '../secret.png' } } })).toThrow(/image.source/)
    expect(() => themeSetArgsOf({ overrideColorScheme: 'sepia' })).toThrow(/overrideColorScheme/)
    expect(() => themeSetArgsOf({ colors: { list: Object.assign([1], { extra: 2 }) } })).toThrow(/named key on a list/)
    expect(() => themeSetArgsOf({ colors: { big: 'x'.repeat(300_000) } })).toThrow(/longer than/)
  })

  it('holds one theme; a clear clears any plugin\'s; an unload clears its own alone', () => {
    let changes = 0
    const state = new ModThemeState(() => void (changes += 1))
    expect(themeSetCore(state, 'a', { colors: {} }, true)).toEqual({ isDrawn: true, requestId: 'theme' })
    themeSetCore(state, 'b', { backdrop: { scene: 's', glass: false } }, true)
    expect(state.current()).toEqual({ plugin: 'b', requestId: 'backdrop', backdrop: { scene: 's', glass: false } })
    expect(state.clearPlugin('a')).toBe(false)
    expect(state.clearPlugin('b')).toBe(true)
    themeSetCore(state, 'a', { colors: {} }, true)
    expect(themeClearCore(state)).toEqual({ isDrawn: false, reason: 'the theme was cleared' })
    expect(state.current()).toBeUndefined()
    expect(changes).toBe(5)
    expect(isThemeResult({ isDrawn: false, reason: 'x' })).toBe(true)
    expect(isThemeResult({ isDrawn: true })).toBe(false)
  })
})
