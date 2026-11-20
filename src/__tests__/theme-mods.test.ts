/**
 * Theme mods (F-25): the list of plugins that have set a theme and the
 * backdrop's reach — their shapes, their place in settings.json, and the
 * `themeMods` capability over them.
 */
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { registerThemeModsCapability } from '../browser/runtimeHub/themeModsCapability'
import type { ConnectionInfo } from '../browser/runtimeHub/types'
import {
  THEME_MODS_ACTION_SCOPES,
  THEME_MODS_LIMIT,
  THEME_MODS_TOPIC,
  isThemeModsReadPayload,
  isThemeModsScopePayload,
  isThemeModsSinglePayload,
  isThemeModsTurnOffPayload,
  readThemeMods,
  readThemeModsState,
  withThemeMod,
  type ThemeModsState,
} from '../mods/themeMods'
import { normalizeSettings } from '../settings/settingsNormalize'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/u'
const PATH = `${HOME}/.velloc/settings.json`

function memoryFs(initial: Record<string, unknown>) {
  let content = JSON.stringify(initial)
  const fs = {
    async readFile(path: string) {
      if (path !== PATH) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return content
    },
    async mkdir() {},
    async writeFile(_path: string, text: string) {
      content = text
    },
    async stat() {
      throw new Error('ENOENT')
    },
    async rm() {},
  } as unknown as RuntimeFs
  return {
    fs,
    current: () => JSON.parse(content) as Record<string, unknown>,
    replace: (next: Record<string, unknown>) => {
      content = JSON.stringify(next)
    },
  }
}

const conn = (mode: 'observe' | 'control' | 'full' = 'full') =>
  ({ connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode, sessions: 'all' }, transport: 'message-port' }) as ConnectionInfo

function rig(initial: Record<string, unknown>, beforeTurnOffAll?: () => void) {
  const disk = memoryFs(initial)
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  let reloads = 0
  const reports: string[] = []
  const handle = registerThemeModsCapability(registry, broker, {
    context: () => ({ fs: disk.fs }),
    resolveHome: async () => HOME,
    reload: () => {
      reloads += 1
    },
    report: line => reports.push(line),
    ...(beforeTurnOffAll ? { beforeTurnOffAll } : {}),
  })
  const events: ThemeModsState[] = []
  const subscribe = () =>
    broker.subscribe(
      { conn: conn(), send: evt => events.push((evt as unknown as { payload: ThemeModsState }).payload), bufferedBytes: () => 0 },
      THEME_MODS_TOPIC,
    )
  const ask = (act: 'read' | 'setBackdropScope' | 'setSingle' | 'turnOffAll', payload: unknown = {}) =>
    registry
      .resolve('themeMods', act)!
      .handle({ id: '1', route: { cap: 'themeMods', act }, payload, conn: conn() } as never, {} as never)
  return { ...disk, registry, events, subscribe, ask, reloads: () => reloads, publish: handle.publish, reports }
}

const AURORA = { plugin: 'aurora', id: 'aurora@market' }
const LOCAL = { plugin: 'mine', id: 'mine@inline', root: '/home/u/.velloc/plugins/mine' }

describe('theme mods', () => {
  it('reads only well-formed entries, one per plugin, up to the limit', () => {
    expect(readThemeMods('no')).toEqual([])
    expect(
      readThemeMods([AURORA, { plugin: 'aurora', id: 'other@x' }, { plugin: '', id: 'x@y' }, { plugin: 'p' }, null, { ...LOCAL, extra: 1 }]),
    ).toEqual([AURORA, LOCAL])
    const many = Array.from({ length: THEME_MODS_LIMIT + 5 }, (_, n) => ({ plugin: `p${n}`, id: `p${n}@m` }))
    expect(readThemeMods(many)).toHaveLength(THEME_MODS_LIMIT)
  })

  it('adds a plugin once, replaces an entry whose source moved, and drops the oldest of a full list', () => {
    const one = withThemeMod([], AURORA)
    expect(one).toEqual([AURORA])
    expect(withThemeMod(one, { ...AURORA })).toBe(one)
    expect(withThemeMod(one, { plugin: 'aurora', id: 'aurora@inline', root: '/x' })).toEqual([
      { plugin: 'aurora', id: 'aurora@inline', root: '/x' },
    ])
    const full = Array.from({ length: THEME_MODS_LIMIT }, (_, n) => ({ plugin: `p${n}`, id: `p${n}@m` }))
    const next = withThemeMod(full, AURORA)
    expect(next).toHaveLength(THEME_MODS_LIMIT)
    expect(next[0]!.plugin).toBe('p1')
    expect(next.at(-1)).toEqual(AURORA)
  })

  it('keeps the list and the reach through a settings read and drops what is malformed', () => {
    const kept = normalizeSettings({
      version: 1,
      mods: { headless: true, themeMods: [AURORA, 7], backdropScope: 'conversation' },
    } as never)
    expect(kept.mods).toEqual({ headless: true, themeMods: [AURORA], backdropScope: 'conversation' })
    const dropped = normalizeSettings({ version: 1, mods: { themeMods: 'x', backdropScope: 'sidebar' } } as never)
    expect(dropped.mods).toBeUndefined()
    // One at a time is on by default: only its off survives.
    expect(normalizeSettings({ version: 1, mods: { singleThemeMod: false } } as never).mods).toEqual({ singleThemeMod: false })
    expect(normalizeSettings({ version: 1, mods: { singleThemeMod: true } } as never).mods).toBeUndefined()
  })

  it('declares an observe read and a control write, and guards both payloads', () => {
    expect(THEME_MODS_ACTION_SCOPES).toEqual({
      read: 'observe',
      setBackdropScope: 'control',
      setSingle: 'control',
      turnOffAll: 'manager',
    })
    expect(isThemeModsReadPayload(undefined)).toBe(true)
    expect(isThemeModsReadPayload({ mods: [] })).toBe(false)
    expect(isThemeModsScopePayload({ scope: 'conversation' })).toBe(true)
    expect(isThemeModsScopePayload({ scope: 'sidebar' })).toBe(false)
    expect(isThemeModsScopePayload({ scope: 'window', mods: [] })).toBe(false)
    expect(readThemeModsState({ mods: [AURORA] })).toEqual({ mods: [AURORA], plugins: [], backdropScope: 'conversation', single: true, on: 0 })
    expect(readThemeModsState({ backdropScope: 'window', single: false })).toBeNull()
  })

  it('snapshots the stored state, defaults the reach to the conversation, and shows a later read to every reader', async () => {
    const r = rig({ version: 1, mods: { themeMods: [AURORA] } })
    r.subscribe()
    await expect.poll(() => r.events.length).toBe(1)
    expect(r.events[0]).toEqual({ mods: [AURORA], plugins: [], backdropScope: 'conversation', single: true, on: 0 })
    // A session recorded another plugin since.
    r.replace({ version: 1, mods: { themeMods: [AURORA, LOCAL] } })
    expect(await r.ask('read')).toEqual({ mods: [AURORA, LOCAL], plugins: [{ ...LOCAL, enabled: false }], backdropScope: 'conversation', single: true, on: 0 })
    expect(r.events.at(-1)).toEqual({ mods: [AURORA, LOCAL], plugins: [{ ...LOCAL, enabled: false }], backdropScope: 'conversation', single: true, on: 0 })
  })

  it('stores a reach other than the default, keeps the rest of the section, and publishes it', async () => {
    const r = rig({ version: 1, mods: { headless: true, themeMods: [AURORA] } })
    r.subscribe()
    await expect.poll(() => r.events.length).toBe(1)
    expect(await r.ask('setBackdropScope', { scope: 'window' })).toEqual({
      mods: [AURORA],
      plugins: [],
      backdropScope: 'window',
      single: true,
      on: 0,
    })
    expect(r.current().mods).toEqual({ headless: true, themeMods: [AURORA], backdropScope: 'window' })
    expect(r.events.at(-1)!.backdropScope).toBe('window')
    await r.ask('setBackdropScope', { scope: 'conversation' })
    expect(r.current().mods).toEqual({ headless: true, themeMods: [AURORA] })
    expect(r.registry.resolve('themeMods', 'setBackdropScope')!.spec.scope).toBe('control')
  })

  it('one at a time is on unless stored off, and is stored only while it is off', async () => {
    const r = rig({ version: 1, mods: { themeMods: [AURORA] } })
    expect(isThemeModsSinglePayload({ on: true })).toBe(true)
    expect(isThemeModsSinglePayload({ on: 'yes' })).toBe(false)
    expect(await r.ask('read')).toMatchObject({ single: true })
    expect(await r.ask('setSingle', { on: false })).toEqual({ mods: [AURORA], plugins: [], backdropScope: 'conversation', single: false, on: 0 })
    expect(r.current().mods).toEqual({ themeMods: [AURORA], singleThemeMod: false })
    expect(await r.ask('setSingle', { on: true })).toEqual({ mods: [AURORA], plugins: [], backdropScope: 'conversation', single: true, on: 0 })
    expect(r.current().mods).toEqual({ themeMods: [AURORA] })
  })

  it('turns every theme plugin off at once, as a manager, and reloads the sessions once', async () => {
    const one = { plugin: 'one', id: 'one@builtin' }
    const two = { plugin: 'two', id: 'two@builtin' }
    const cancelled: number[] = []
    let r: ReturnType<typeof rig> | undefined
    r = rig(
      { version: 1, mods: { themeMods: [one, two] }, enabledPlugins: { 'two@builtin': false, 'other@builtin': true } },
      () => cancelled.push(r!.reloads()),
    )
    expect(r.registry.resolve('themeMods', 'turnOffAll')!.spec.scope).toBe('manager')
    expect(((await r.ask('read')) as { on: number }).on).toBe(1)
    expect(await r.ask('turnOffAll')).toEqual({ ok: true, turnedOff: 1 })
    expect(((await r.ask('read')) as { on: number }).on).toBe(0)
    expect(r.current().enabledPlugins).toEqual({ 'one@builtin': false, 'two@builtin': false, 'other@builtin': true })
    expect(r.reloads()).toBe(1)
    // The looks waiting for a turn were stopped before any plugin went off.
    expect(cancelled).toEqual([0])
    expect(await r.ask('turnOffAll')).toEqual({ ok: true, turnedOff: 0 })
    expect(r.reloads()).toBe(1)
  })

  it('publishes the count again when asked, once the topic has a reader', async () => {
    const one = { plugin: 'one', id: 'one@builtin' }
    const r = rig({ version: 1, mods: { themeMods: [one] }, enabledPlugins: { 'one@builtin': false } })
    await r.publish()
    expect(r.events).toEqual([])
    r.subscribe()
    await expect.poll(() => r.events.length).toBe(1)
    expect(r.events[0]!.on).toBe(0)
    r.replace({ version: 1, mods: { themeMods: [one] } })
    await r.publish()
    expect(r.events.at(-1)!.on).toBe(1)
  })

  it('a count that cannot be read is reported and published as none on', async () => {
    vi.resetModules()
    vi.doMock('../mods/themePlugins', async importOriginal => ({
      ...(await importOriginal<typeof import('../mods/themePlugins')>()),
      themePluginRows: async () => {
        throw new Error('disk gone')
      },
    }))
    try {
      const { registerThemeModsCapability: register } = await import('../browser/runtimeHub/themeModsCapability')
      const disk = memoryFs({ version: 1, mods: { themeMods: [{ plugin: 'one', id: 'one@builtin' }] } })
      const registry = new CapabilityRegistry()
      const reports: string[] = []
      register(registry, new TopicBroker(), {
        context: () => ({ fs: disk.fs }),
        resolveHome: async () => HOME,
        report: line => reports.push(line),
      })
      const state = (await registry
        .resolve('themeMods', 'read')!
        .handle({ id: '1', route: { cap: 'themeMods', act: 'read' }, payload: {}, conn: conn() } as never, {} as never)) as ThemeModsState
      expect(state.on).toBe(0)
      expect(state.mods).toEqual([{ plugin: 'one', id: 'one@builtin' }])
      expect(reports).toEqual(['the theme plugins could not be read: disk gone'])
    } finally {
      vi.doUnmock('../mods/themePlugins')
      vi.resetModules()
    }
  })

  it('lists every known theme plugin with its state, and turns the others off around a kept one', async () => {
    const one = { plugin: 'one', id: 'one@builtin' }
    const two = { plugin: 'two', id: 'two@builtin' }
    const r = rig({ version: 1, mods: { themeMods: [one, two] }, enabledPlugins: { 'two@builtin': false } })
    expect(((await r.ask('read')) as ThemeModsState).plugins).toEqual([
      { ...one, enabled: true },
      { ...two, enabled: false },
    ])
    expect(isThemeModsTurnOffPayload({ keep: 'two' })).toBe(true)
    expect(isThemeModsTurnOffPayload({ keep: '' })).toBe(false)
    expect(isThemeModsTurnOffPayload({ keep: 'two', other: 1 })).toBe(false)
    expect(await r.ask('turnOffAll', { keep: 'one' })).toEqual({ ok: true, turnedOff: 0 })
    r.replace({ version: 1, mods: { themeMods: [one, two] }, enabledPlugins: {} })
    expect(await r.ask('turnOffAll', { keep: 'two' })).toEqual({ ok: true, turnedOff: 1 })
    expect(r.current().enabledPlugins).toEqual({ 'one@builtin': false })
    expect(readThemeModsState({ mods: [], plugins: [{ ...one, enabled: true }, { plugin: 'x' }] })!.plugins).toEqual([
      { ...one, enabled: true },
    ])
  })

  it('keeps every install of a theme plugin that shares its name with another', () => {
    const own = { plugin: 'lagoon', id: 'lagoon@velloc', enabled: false }
    const other = { plugin: 'lagoon', id: 'lagoon@mymarket', enabled: true }
    const folder = { plugin: 'lagoon', id: 'lagoon@inline', root: '/home/u/.velloc/plugins/lagoon', enabled: false }
    const state = readThemeModsState({ mods: [], plugins: [own, other, folder, { ...other }] })!
    expect(state.plugins).toEqual([own, other, folder])
  })
})
