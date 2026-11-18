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
function world(modules: Record<string, string>, drawsComposer: boolean, onThemeSet?: (ref: ModModuleRef) => void) {
  const reports: string[] = []
  const states: ModUiSnapshot[] = []
  const events: ModUiEvent[] = []
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
    ...(onThemeSet ? { onThemeSet } : {}),
    onUiChanged: (event: ModUiEvent) => {
      events.push(event)
      if (event.kind === 'state') states.push(event.state)
    },
  })
  runtimes.push(runtime)
  const logs = (plugin: string) =>
    reports.filter(r => r.startsWith(`${plugin}: `)).map(r => JSON.parse(r.slice(plugin.length + 2)) as Record<string, unknown>)
  return { runtime, reports, states, events, logs, refs }
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
    // The guard refuses the flat ground, so the scene is what stands.
    const { runtime } = world({ guard: GUARD, setter: SETTER }, true)
    await runtime.ready
    const drawn = await runtime.render({
      component: 'Backdrop',
      requestId: 'backdrop',
      props: { scene: 'tide', plugin: 'setter', glass: { blur: 8, opacity: 0.6 }, overrideColorScheme: 'dark' },
    })
    expect(drawn.kind).toBe('tree')
    expect(JSON.stringify(drawn)).toContain('setter/tide')
  })

  it("a scene is drawn by its theme's plugin alone: another plugin's Backdrop hook is not asked unless it names every plugin, and none is asked with no scene", async () => {
    // Draws whatever Backdrop it hears and never passes it on.
    const GRABBER = `
      export function register(on) {
        on('ui.render', { component: 'Backdrop' }, ($, e) => {
          const { Svg } = $.ui.resolve(e);
          return h(Svg, { source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', alt: 'grabbed' });
        });
      }
    `
    const OWNER = `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.theme.set({ backdrop: { scene: 'tide' } });
          return next(e);
        });
        on('command.run', async ($, e, next) => next(e));
        on('ui.render', { component: 'Backdrop' }, ($, e) => {
          const { Svg } = $.ui.resolve(e);
          return h(Svg, { source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', alt: 'owned by ' + e.plugin });
        });
      }
    `
    const ask = { component: 'Backdrop' as const, requestId: 'backdrop', props: { scene: 'tide', plugin: 'owner', glass: false as const } }
    // The grabber is first in the chain: unowned, it would answer.
    const { runtime } = world({ grabber: GRABBER, owner: OWNER }, true)
    await runtime.ready
    const drawn = JSON.stringify(await runtime.render(ask))
    expect(drawn).toContain('owned by owner')
    expect(drawn).not.toContain('grabbed')

    const EVERY = GRABBER.replace("{ component: 'Backdrop' }", "{ component: 'Backdrop', plugin: '*' }")
    const every = world({ grabber: EVERY, owner: OWNER }, true)
    await every.runtime.ready
    expect(JSON.stringify(await every.runtime.render(ask))).toContain('grabbed')

    const none = world({ grabber: GRABBER }, true)
    await none.runtime.ready
    expect(await none.runtime.render(ask)).toEqual({ kind: 'engine' })
  })

  it("a set over another plugin's theme is reported by name; a plugin's own later set is not", async () => {
    const FIRST = `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.theme.set({ backdrop: { color: '#102030' } });
          await $.theme.set({ backdrop: { color: '#203040' } });
          return next(e);
        });
      }
    `
    const SECOND = `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.theme.set({ backdrop: { color: '#304050' } });
          return next(e);
        });
      }
    `
    const { runtime, reports } = world({ first: FIRST, second: SECOND }, true)
    await runtime.ready
    expect(runtime.uiSnapshot().theme?.plugin).toBe('second')
    expect(reports.filter(line => line.includes('replaced the theme'))).toEqual(['second: $.theme.set replaced the theme first had set'])
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

  it('a scene that goes drops its drawing\'s handles: on a clear, and on a set that replaces it', async () => {
    for (const next of ['$.theme.set({ colors: ' + JSON.stringify(PALETTE) + ' })', '$.theme.clear()']) {
      const SCENE = `
        export function register(on) {
          on('session.start', async ($, e, next) => {
            await $.theme.set({ backdrop: { scene: 'tide' } });
            return next(e);
          });
          on('ui.render', { component: 'Backdrop' }, ($, e) => {
            const { Box, Button } = $.ui.resolve(e);
            return Box({ children: [
              Button({ key: 'wave', label: 'Wave', onPress: async () => { await $.ui.log('waved') } }),
              Button({ key: 'go', label: 'Go', onPress: async () => { await ${next}; await $.ui.log('went') } }),
            ] });
          });
        }
      `
      const { runtime, reports } = world({ scene: SCENE }, true)
      await runtime.ready
      const drawn = await runtime.render({
        component: 'Backdrop',
        requestId: 'backdrop',
        props: { scene: 'tide', plugin: 'scene', glass: { blur: 16, opacity: 0.6 } },
      })
      if (drawn.kind !== 'tree') throw new Error('expected a tree')
      const handles: Record<string, number> = {}
      const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return
        const element = node as { props?: { key?: string }; press?: { handle: number }; children?: unknown[] }
        if (element.props?.key && element.press) handles[element.props.key] = element.press.handle
        for (const child of element.children ?? []) visit(child)
      }
      visit(drawn.tree)
      const press = (element: string) =>
        runtime.uiInput({ kind: 'press', plugin: 'scene', element, component: 'Backdrop', requestId: 'backdrop', handle: handles[element]! })
      expect(await press('go')).toEqual({ ok: true })
      const deadline = Date.now() + 2_000
      while (!reports.includes('scene: "went"') && !reports.some(line => line.includes('went'))) {
        if (Date.now() > deadline) throw new Error('timed out waiting')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(JSON.stringify(runtime.uiSnapshot().theme ?? {})).not.toContain('tide')
      expect(await press('wave')).toEqual({ ok: false, reason: 'the drawing is gone' })
    }
  })

  it("a scene that passes to another plugin drops the former owner's drawing's handles", async () => {
    const FIRST = `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.theme.set({ backdrop: { scene: 'tide' } });
          return next(e);
        });
        on('ui.render', { component: 'Backdrop' }, ($, e) => {
          const { Button } = $.ui.resolve(e);
          return Button({ key: 'wave', label: 'Wave', onPress: async () => {} });
        });
      }
    `
    const SECOND = `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'dunes', description: 'Sets the dunes scene.', immediate: true });
          return next(e);
        });
        on('command.run', { command: 'dunes' }, async ($, e) => {
          await $.theme.set({ backdrop: { scene: 'dunes' } });
          return { text: 'dunes' };
        });
      }
    `
    const { runtime } = world({ first: FIRST, second: SECOND }, true)
    const ask = { component: 'Backdrop' as const, requestId: 'backdrop', props: { scene: 'tide', plugin: 'first', glass: false as const } }
    await runtime.ready
    expect(runtime.uiSnapshot().theme?.plugin).toBe('first')
    const drawn = await runtime.render(ask)
    if (drawn.kind !== 'tree') throw new Error('expected a tree')
    const handle = (drawn.tree as { press?: { handle: number } }).press!.handle
    await runtime.commandRunImmediate({ command: 'dunes', args: '' })
    expect(runtime.uiSnapshot().theme?.plugin).toBe('second')
    expect(
      await runtime.uiInput({ kind: 'press', plugin: 'first', element: 'wave', component: 'Backdrop', requestId: 'backdrop', handle }),
    ).toEqual({ ok: false, reason: 'the drawing is gone' })
  })

  it('a scene drawing still in flight when the scene goes keeps none of its handles or reads', async () => {
    const CLEARS_WHILE_DRAWING = `
      const mood = { plugin: 'scene', key: 'mood' }
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.theme.set({ backdrop: { scene: 'tide' } });
          await $.command.register({ name: 'mood', description: 'Changes the mood.', immediate: true });
          return next(e);
        });
        on('command.run', { command: 'mood' }, async ($, e) => {
          await $.state.set(mood, 'calm');
          return { text: 'mood' };
        });
        on('ui.render', { component: 'Backdrop' }, async ($, e) => {
          await $.state.get(mood);
          await $.theme.clear();
          const { Button } = $.ui.resolve(e);
          return Button({ key: 'wave', label: 'Wave', onPress: async () => {} });
        });
      }
    `
    const { runtime, events } = world({ scene: CLEARS_WHILE_DRAWING }, true)
    await runtime.ready
    const drawn = await runtime.render({ component: 'Backdrop', requestId: 'backdrop', props: { scene: 'tide', plugin: 'scene', glass: false } })
    expect(runtime.uiSnapshot().theme).toBeUndefined()
    expect(drawn).toEqual({ kind: 'engine' })
    const before = events.length
    await runtime.commandRunImmediate({ command: 'mood', args: '' })
    expect(events.slice(before).filter(e => e.kind === 'stale')).toEqual([])
  })

  it('tells its host which plugin set a theme', async () => {
    const setters: string[] = []
    const { runtime } = world({ guard: GUARD, setter: SETTER }, true, ref => setters.push(ref.plugin))
    await runtime.ready
    expect(setters.length).toBeGreaterThan(0)
    expect(new Set(setters)).toEqual(new Set(['setter']))
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
    expect(themeSetArgsOf({ backdrop: { scene: 'a', id: 'a', glass: { blur: 8 } } })).toEqual({ backdrop: { scene: 'a', glass: { blur: 8 } } })
    expect(() => themeSetArgsOf({ backdrop: { scene: 'a', other: 1 } })).toThrow(/no key named "other"/)
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

  it('when the standing theme\'s plugin unloads, the latest theme another loaded plugin set stands again; a clear leaves none behind', () => {
    const state = new ModThemeState(() => {})
    themeSetCore(state, 'a', { overrideColorScheme: 'dark' }, true)
    themeSetCore(state, 'b', { overrideColorScheme: 'light' }, true)
    themeSetCore(state, 'c', { backdrop: { scene: 's', glass: false } }, true)
    // b unloads while c stands: nothing shown changes, and b is no longer behind.
    expect(state.clearPlugin('b')).toBe(false)
    expect(state.clearPlugin('c')).toBe(true)
    expect(state.current()).toEqual({ plugin: 'a', requestId: 'theme', overrideColorScheme: 'dark' })
    expect(state.hasScene()).toBe(false)
    expect(state.clearPlugin('a')).toBe(true)
    expect(state.current()).toBeUndefined()
    // A plugin's own later set replaces its earlier one behind the standing theme.
    themeSetCore(state, 'a', { overrideColorScheme: 'dark' }, true)
    themeSetCore(state, 'b', { overrideColorScheme: 'light' }, true)
    themeSetCore(state, 'a', { overrideColorScheme: 'light' }, true)
    expect(state.clearPlugin('a')).toBe(true)
    expect(state.current()?.plugin).toBe('b')
    themeSetCore(state, 'a', { overrideColorScheme: 'dark' }, true)
    themeClearCore(state)
    expect(state.clearPlugin('a')).toBe(false)
    expect(state.current()).toBeUndefined()
  })
})
