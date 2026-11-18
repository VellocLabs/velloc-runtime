/**
 * Theme mods (F-25): the list of plugins that have set a theme and the
 * backdrop's reach — their shapes, their place in settings.json, and the
 * `themeMods` capability over them.
 */
import { describe, expect, it } from 'vitest'
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

function rig(initial: Record<string, unknown>) {
  const disk = memoryFs(initial)
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  registerThemeModsCapability(registry, broker, {
    context: () => ({ fs: disk.fs }),
    resolveHome: async () => HOME,
    report: () => {},
  })
  const events: ThemeModsState[] = []
  const subscribe = () =>
    broker.subscribe(
      { conn: conn(), send: evt => events.push((evt as unknown as { payload: ThemeModsState }).payload), bufferedBytes: () => 0 },
      THEME_MODS_TOPIC,
    )
  const ask = (act: 'read' | 'setBackdropScope', payload: unknown = {}) =>
    registry
      .resolve('themeMods', act)!
      .handle({ id: '1', route: { cap: 'themeMods', act }, payload, conn: conn() } as never, {} as never)
  return { ...disk, registry, events, subscribe, ask }
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
  })

  it('declares an observe read and a control write, and guards both payloads', () => {
    expect(THEME_MODS_ACTION_SCOPES).toEqual({ read: 'observe', setBackdropScope: 'control' })
    expect(isThemeModsReadPayload(undefined)).toBe(true)
    expect(isThemeModsReadPayload({ mods: [] })).toBe(false)
    expect(isThemeModsScopePayload({ scope: 'conversation' })).toBe(true)
    expect(isThemeModsScopePayload({ scope: 'sidebar' })).toBe(false)
    expect(isThemeModsScopePayload({ scope: 'window', mods: [] })).toBe(false)
    expect(readThemeModsState({ mods: [AURORA] })).toEqual({ mods: [AURORA], backdropScope: 'window' })
    expect(readThemeModsState({ backdropScope: 'window' })).toBeNull()
  })

  it('snapshots the stored state, defaults the reach to the window, and shows a later read to every reader', async () => {
    const r = rig({ version: 1, mods: { themeMods: [AURORA] } })
    r.subscribe()
    await expect.poll(() => r.events.length).toBe(1)
    expect(r.events[0]).toEqual({ mods: [AURORA], backdropScope: 'window' })
    // A session recorded another plugin since.
    r.replace({ version: 1, mods: { themeMods: [AURORA, LOCAL] } })
    expect(await r.ask('read')).toEqual({ mods: [AURORA, LOCAL], backdropScope: 'window' })
    expect(r.events.at(-1)).toEqual({ mods: [AURORA, LOCAL], backdropScope: 'window' })
  })

  it('stores a reach other than the default, keeps the rest of the section, and publishes it', async () => {
    const r = rig({ version: 1, mods: { headless: true, themeMods: [AURORA] } })
    r.subscribe()
    await expect.poll(() => r.events.length).toBe(1)
    expect(await r.ask('setBackdropScope', { scope: 'conversation' })).toEqual({
      mods: [AURORA],
      backdropScope: 'conversation',
    })
    expect(r.current().mods).toEqual({ headless: true, themeMods: [AURORA], backdropScope: 'conversation' })
    expect(r.events.at(-1)!.backdropScope).toBe('conversation')
    await r.ask('setBackdropScope', { scope: 'window' })
    expect(r.current().mods).toEqual({ headless: true, themeMods: [AURORA] })
    expect(r.registry.resolve('themeMods', 'setBackdropScope')!.spec.scope).toBe('control')
  })
})
