/**
 * `theme.useLook` / `theme.clear` (F-25, F-35): a look from the built-in
 * marketplace's cached listing is applied to one session, by the plugin's own
 * command or by loading the plugin again.
 *
 * The slot tests load real module text through `ModWorkerHost` on a
 * MessageChannel; the capability tests use a memory file system.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { registerThemeCapability } from '../browser/runtimeHub/themeCapability'
import type { ConnectionInfo } from '../browser/runtimeHub/types'
import {
  THEME_ACTION_SCOPES,
  clearSessionTheme,
  isThemeClearPayload,
  isThemeUseLookPayload,
  useThemeLook,
  useThemeLookOnceLoaded,
  type ThemeLookSlot,
  type ThemeUseLookResult,
} from '../mods/modThemeLooks'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { __setPluginBlocklistForTests } from '../pluginHost/blocklist'
import { BUILTIN_MARKETPLACE_KEY } from '../pluginHost/builtinMarketplace'
import { forgetRegistryFile, saveInstalledPlugins } from '../pluginHost/installedRegistry'
import { getMarketplaceManifestPath } from '../pluginHost/pluginDirs'
import type { CatalogListing } from '../pluginHost/registryFormats'
import { listingInstalls } from '../pluginHost/themeListing'
import { makeMemFs } from './_helpers/memFs'

const MP = BUILTIN_MARKETPLACE_KEY
const PREVIEW = 'previews/pack/one.svg'

const LISTINGS: CatalogListing[] = [
  {
    name: 'pack',
    source: { source: 'github', repo: 'someone/pack', sha: 'a'.repeat(40) },
    theme: {
      looks: [
        { id: 'lagoon', preview: PREVIEW, use: { command: 'pick-look', args: 'lagoon' } },
        { id: 'picker', preview: PREVIEW, use: { command: 'pick-look' } },
        { id: 'borrowed', preview: PREVIEW, use: { command: 'other-cmd', args: 'x' } },
      ],
    },
  },
  { name: 'single', source: { source: 'github', repo: 'someone/single', sha: 'b'.repeat(40) }, theme: { looks: [{ id: 'single', preview: PREVIEW }] } },
  { name: 'tool', source: { source: 'local', path: 'plugins/tool' } },
]

type Ran = { command: string; args: string; origin: unknown }

function fakeSlot(over: Partial<ThemeLookSlot> = {}) {
  const ran: Ran[] = []
  const reloaded: string[] = []
  const slot: ThemeLookSlot = {
    commandOwner: name =>
      name === 'pick-look'
        ? { plugin: 'pack', provenance: `pack@${MP}` }
        : name === 'other-cmd'
          ? { plugin: 'other', provenance: `other@${MP}` }
          : undefined,
    commandRun: async (input, _core, _signal, _context, origin) => {
      ran.push({ ...input, origin })
      return { settled: true, unanswered: false, result: { text: `picked ${input.args}` } }
    },
    reloadPlugin: async provenance => {
      reloaded.push(provenance)
      return provenance === `single@${MP}` ? 1 : 0
    },
    clearTheme: () => true,
    ...over,
  }
  return { slot, ran, reloaded }
}

const use = (slot: ThemeLookSlot | undefined, plugin: string, lookId: string, listings: CatalogListing[] | null = LISTINGS) =>
  useThemeLook({ marketplace: MP, listings, slot }, { plugin, lookId })

describe('listingInstalls', () => {
  const pack = LISTINGS[0]!
  const code = { repo: 'github.com/someone/pack', path: '' }

  it('is the own install of the listing, then the same code installed under that name from elsewhere', () => {
    expect(listingInstalls({}, pack, MP)).toEqual([`pack@${MP}`])
    const installed = {
      'pack@their-own': [{ codeSource: code }],
      [`pack@${MP}`]: [{ codeSource: code }],
      'pack@a-fork': [{ codeSource: { repo: 'github.com/other/pack', path: '' } }],
      'pack@a-folder': [{ codeSource: { repo: 'github.com/someone/pack', path: 'sub' } }],
      'pack@unrecorded': [{}],
      'other@their-own': [{ codeSource: code }],
    }
    expect(listingInstalls(installed, pack, MP)).toEqual([`pack@${MP}`, 'pack@their-own'])
  })

  it('a listing kept inside its marketplace has its own install alone', () => {
    const tool = LISTINGS[2]!
    expect(listingInstalls({ 'tool@their-own': [{ codeSource: code }] }, tool, MP)).toEqual([`tool@${MP}`])
  })
})

describe('useThemeLook — the same plugin installed from its own marketplace', () => {
  const installsOf = (listing: CatalogListing) => [`${listing.name}@${MP}`, `${listing.name}@their-own`]
  const useWith = (slot: ThemeLookSlot, plugin: string, lookId: string) =>
    useThemeLook({ marketplace: MP, listings: LISTINGS, installsOf, slot }, { plugin, lookId })

  it('runs the command that install registered', async () => {
    const { slot, ran } = fakeSlot({
      hasLoaded: provenance => provenance === 'pack@their-own',
      commandOwner: () => ({ plugin: 'pack', provenance: 'pack@their-own' }),
    })
    expect(await useWith(slot, 'pack', 'lagoon')).toEqual({ ok: true, via: 'command', text: 'picked lagoon' })
    expect(ran).toEqual([{ command: 'pick-look', args: 'lagoon', origin: { kind: 'bridge' } }])
  })

  it('still refuses an install that is not the plugin of the listing', async () => {
    const { slot, ran } = fakeSlot({
      hasLoaded: () => true,
      commandOwner: () => ({ plugin: 'pack', provenance: 'pack@a-fork' }),
    })
    expect(await useWith(slot, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'notOwnCommand' })
    expect(ran).toEqual([])
  })

  it('a single theme is loaded again from whichever install is running', async () => {
    const reloaded: string[] = []
    const { slot } = fakeSlot({
      reloadPlugin: async provenance => {
        reloaded.push(provenance)
        return provenance === 'single@their-own' ? 1 : 0
      },
    })
    expect(await useWith(slot, 'single', 'single')).toEqual({ ok: true, via: 'reload' })
    expect(reloaded).toEqual([`single@${MP}`, 'single@their-own'])
  })
})

describe('useThemeLook', () => {
  it('runs the command the catalogue names, with its argument, when the plugin itself registered it', async () => {
    const { slot, ran, reloaded } = fakeSlot()
    expect(await use(slot, 'pack', 'lagoon')).toEqual({ ok: true, via: 'command', text: 'picked lagoon' })
    expect(await use(slot, 'pack', 'picker')).toEqual({ ok: true, via: 'command', text: 'picked ' })
    expect(ran).toEqual([
      { command: 'pick-look', args: 'lagoon', origin: { kind: 'bridge' } },
      { command: 'pick-look', args: '', origin: { kind: 'bridge' } },
    ])
    expect(reloaded).toEqual([])
  })

  it('never runs a command another plugin, another install of the name, or nobody registered', async () => {
    const { slot, ran } = fakeSlot()
    expect(await use(slot, 'pack', 'borrowed')).toEqual({ ok: false, reason: 'notOwnCommand' })
    const elsewhere = fakeSlot({ commandOwner: () => ({ plugin: 'pack', provenance: 'pack@their-own' }) })
    expect(await use(elsewhere.slot, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'notOwnCommand' })
    const unsourced = fakeSlot({ commandOwner: () => ({ plugin: 'pack' }) })
    expect(await use(unsourced.slot, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'notOwnCommand' })
    const nobody = fakeSlot({ commandOwner: () => undefined })
    expect(await use(nobody.slot, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'notOwnCommand' })
    const installedElsewhere = fakeSlot({ hasLoaded: provenance => provenance === `pack@their-own`, commandOwner: () => undefined })
    expect(await use(installedElsewhere.slot, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'notLoaded' })
    expect(installedElsewhere.ran).toEqual([])
    expect([...ran, ...elsewhere.ran, ...unsourced.ran, ...nobody.ran]).toEqual([])
  })

  it('answers unknownLook for anything the cached catalogue does not list as a look', async () => {
    const { slot, ran, reloaded } = fakeSlot()
    const unknown: ThemeUseLookResult = { ok: false, reason: 'unknownLook' }
    expect(await use(slot, 'pack', 'nope')).toEqual(unknown)
    expect(await use(slot, 'tool', 'tool')).toEqual(unknown)
    expect(await use(slot, 'absent', 'lagoon')).toEqual(unknown)
    expect(await use(slot, 'pack', 'lagoon', null)).toEqual(unknown)
    expect(ran).toEqual([])
    expect(reloaded).toEqual([])
  })

  it('a look without a command loads the plugin again, from this marketplace\'s install alone', async () => {
    const { slot, ran, reloaded } = fakeSlot()
    expect(await use(slot, 'single', 'single')).toEqual({ ok: true, via: 'reload' })
    expect(reloaded).toEqual([`single@${MP}`])
    expect(ran).toEqual([])
    const absent = fakeSlot({ reloadPlugin: async () => 0 })
    expect(await use(absent.slot, 'single', 'single')).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await use(undefined, 'single', 'single')).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await use(undefined, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'notLoaded' })
  })

  it('reports a command nobody answered, and one that answered with a failure', async () => {
    const silent = fakeSlot({ commandRun: async () => ({ settled: true, unanswered: true, result: {} }) })
    expect(await use(silent.slot, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'unanswered' })
    const abandoned = fakeSlot({ commandRun: async () => ({ settled: false }) })
    expect(await use(abandoned.slot, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'unanswered' })
    const failing = fakeSlot({
      commandRun: async () => ({ settled: true, unanswered: false, result: { text: 'no such scene', exitCode: 2 } }),
    })
    expect(await use(failing.slot, 'pack', 'lagoon')).toEqual({ ok: false, reason: 'commandFailed', text: 'no such scene' })
  })

  it('clear takes the theme away and says whether one stood', () => {
    expect(clearSessionTheme(fakeSlot().slot)).toEqual({ ok: true, cleared: true })
    expect(clearSessionTheme(fakeSlot({ clearTheme: () => false }).slot)).toEqual({ ok: true, cleared: false })
    expect(clearSessionTheme(undefined)).toEqual({ ok: true, cleared: false })
  })
})

describe('theme payload guards', () => {
  it('useLook takes a session, a plugin name and a look id, and nothing else', () => {
    expect(isThemeUseLookPayload({ sessionId: 's', plugin: 'pack', lookId: 'lagoon' })).toBe(true)
    expect(isThemeUseLookPayload({ sessionId: 's', plugin: 'pack', lookId: 'lagoon', command: 'clear' })).toBe(false)
    expect(isThemeUseLookPayload({ sessionId: 's', plugin: 'pack', lookId: 'lagoon', args: 'x' })).toBe(false)
    expect(isThemeUseLookPayload({ sessionId: '', plugin: 'pack', lookId: 'lagoon' })).toBe(false)
    expect(isThemeUseLookPayload({ sessionId: 's', plugin: 'pack@velloc', lookId: 'lagoon' })).toBe(false)
    expect(isThemeUseLookPayload({ sessionId: 's', plugin: 'pack', lookId: 'Lagoon Blue' })).toBe(false)
    expect(isThemeUseLookPayload({ sessionId: 's', plugin: 'pack' })).toBe(false)
    expect(isThemeUseLookPayload(null)).toBe(false)
  })

  it('clear takes a session alone', () => {
    expect(isThemeClearPayload({ sessionId: 's' })).toBe(true)
    expect(isThemeClearPayload({ sessionId: 's', plugin: 'pack' })).toBe(false)
    expect(isThemeClearPayload({})).toBe(false)
  })
})

describe('the theme capability', () => {
  const HOME = '/home/u'
  const conn = (sessions: 'all' | string[] = 'all') =>
    ({ connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions }, transport: 'message-port' }) as ConnectionInfo

  async function rig(
    options: {
      cached?: boolean
      home?: () => Promise<string>
      whenIdle?: (sessionId: string, signal?: AbortSignal) => Promise<void>
    } = {},
  ) {
    const fs = makeMemFs()
    if (options.cached !== false) {
      await fs.writeFile(
        getMarketplaceManifestPath({ homeDir: HOME }, MP),
        JSON.stringify({
          name: MP,
          plugins: [
            {
              name: 'pack',
              source: { source: 'github', repo: 'someone/pack', sha: 'a'.repeat(40) },
              theme: {
                looks: [
                  { id: 'lagoon', preview: PREVIEW, use: { command: 'pick-look', args: 'lagoon' } },
                  { id: 'shouting', preview: PREVIEW, use: { command: 'pick-look', args: 'LAGOON; rm' } },
                  { id: 'spaced', preview: PREVIEW, use: { command: 'pick-look now' } },
                ],
              },
            },
            { name: 'testers', betaOnly: true, source: './testers', theme: { looks: [{ id: 'testers', preview: PREVIEW }] } },
          ],
        }),
      )
    }
    const fake = fakeSlot()
    const asked: string[] = []
    const registry = new CapabilityRegistry()
    registerThemeCapability(registry, {
      fs: () => fs,
      resolveHome: options.home ?? (async () => HOME),
      channel: () => 'stable',
      slotOf: sessionId => {
        asked.push(sessionId)
        return sessionId === 's1' ? fake.slot : undefined
      },
      ...(options.whenIdle ? { whenIdle: options.whenIdle } : {}),
    })
    const ask = (act: 'useLook' | 'clear', payload: unknown, c = conn(), signal?: AbortSignal) => {
      const entry = registry.resolve('theme', act)!
      expect(entry.spec.guard?.(payload, c, {} as never) ?? true).toBe(true)
      return entry.handle({ id: '1', route: { cap: 'theme', act }, payload, conn: c, signal } as never, {} as never)
    }
    return { registry, ask, asked, ...fake }
  }

  it('declares every action at full, with its guard', async () => {
    const { registry } = await rig()
    expect(THEME_ACTION_SCOPES).toEqual({ useLook: 'full', onEnable: 'full', clear: 'full' })
    for (const act of ['useLook', 'onEnable', 'clear'] as const) {
      const entry = registry.resolve('theme', act)!
      expect(entry.spec.scope).toBe('full')
      expect(entry.spec.guard?.({ sessionId: 's1', command: 'x' }, conn(), {} as never)).toBe(false)
    }
  })

  it('reads the look from the cached listing and applies it to the named session', async () => {
    const { ask, ran } = await rig()
    expect(await ask('useLook', { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' })).toEqual({
      ok: true,
      via: 'command',
      text: 'picked lagoon',
    })
    expect(ran).toEqual([{ command: 'pick-look', args: 'lagoon', origin: { kind: 'bridge' } }])
    expect(await ask('clear', { sessionId: 's1' })).toEqual({ ok: true, cleared: true })
    expect(await ask('clear', { sessionId: 's2' })).toEqual({ ok: true, cleared: false })
  })

  it('a look asked for during a turn runs nothing until the turn ends, then applies', async () => {
    let turnEnds!: () => void
    const waitedFor: string[] = []
    const { ask, ran } = await rig({
      whenIdle: sessionId => {
        waitedFor.push(sessionId)
        return new Promise(resolve => (turnEnds = resolve))
      },
    })
    const answer = ask('useLook', { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(waitedFor).toEqual(['s1'])
    expect(ran).toEqual([])
    turnEnds()
    expect(await answer).toMatchObject({ ok: true, via: 'command' })
    expect(ran).toHaveLength(1)
  })

  it('a look cancelled while it waits for the turn runs nothing', async () => {
    const controller = new AbortController()
    const { ask, ran } = await rig({
      whenIdle: (_sessionId, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')))),
    })
    const answer = ask('useLook', { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' }, conn(), controller.signal)
    controller.abort()
    expect(await answer).toEqual({ ok: false, reason: 'notLoaded' })
    expect(ran).toEqual([])
  })

  it('a look for a session outside the scope is refused before it waits', async () => {
    const whenIdle = vi.fn(async () => {})
    const { ask } = await rig({ whenIdle })
    await expect(ask('useLook', { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' }, conn(['s2']))).rejects.toMatchObject({
      code: 'forbidden_scope',
    })
    expect(whenIdle).not.toHaveBeenCalled()
  })

  it('a look whose command or argument is not plain never reaches a session', async () => {
    const { ask, ran } = await rig()
    for (const lookId of ['shouting', 'spaced']) {
      expect(await ask('useLook', { sessionId: 's1', plugin: 'pack', lookId })).toEqual({ ok: false, reason: 'unknownLook' })
    }
    expect(ran).toEqual([])
  })

  it('a listing the channel hides, and a profile with no cached listing, have no looks', async () => {
    const hidden = await rig()
    expect(await hidden.ask('useLook', { sessionId: 's1', plugin: 'testers', lookId: 'testers' })).toEqual({
      ok: false,
      reason: 'unknownLook',
    })
    expect(hidden.reloaded).toEqual([])
    const empty = await rig({ cached: false })
    expect(await empty.ask('useLook', { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' })).toEqual({
      ok: false,
      reason: 'unknownLook',
    })
  })

  it('refuses a session outside the connection\'s scope before touching it', async () => {
    const { ask, asked, ran } = await rig()
    await expect(ask('useLook', { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' }, conn(['s9']))).rejects.toMatchObject({
      code: 'forbidden_scope',
    })
    await expect(ask('clear', { sessionId: 's1' }, conn(['s9']))).rejects.toMatchObject({ code: 'forbidden_scope' })
    expect(asked).toEqual([])
    expect(ran).toEqual([])
  })

  it('answers host_unavailable while the host names no home folder', async () => {
    const { ask } = await rig({
      home: async () => {
        throw new Error('no home yet')
      },
    })
    await expect(ask('useLook', { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' })).rejects.toMatchObject({
      code: 'host_unavailable',
    })
  })
})

describe('theme.useLook on a plugin that is installed and switched off', () => {
  const HOME = '/home/off'
  const SETTINGS = `${HOME}/.velloc/settings.json`
  const conn = { connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' } as ConnectionInfo
  const code = { repo: 'github.com/someone/pack', path: '' }
  const row = { scope: 'user' as const, installPath: '/x', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z', codeSource: code }
  type Enabled = Record<string, boolean>

  afterEach(() => forgetRegistryFile(HOME))

  async function rig(state: { installed: string[]; enabledPlugins?: Enabled; single?: boolean; neverLoads?: boolean; onReload?: () => void }) {
    const fs = makeMemFs()
    await fs.writeFile(
      getMarketplaceManifestPath({ homeDir: HOME }, MP),
      JSON.stringify({
        name: MP,
        plugins: [
          {
            name: 'pack',
            source: { source: 'github', repo: 'someone/pack', sha: 'a'.repeat(40) },
            theme: { looks: [{ id: 'lagoon', preview: PREVIEW, use: { command: 'pick-look', args: 'lagoon' } }] },
          },
          { name: 'other', source: { source: 'github', repo: 'someone/other', sha: 'c'.repeat(40) }, theme: { looks: [{ id: 'other', preview: PREVIEW }] } },
        ],
      }),
    )
    await saveInstalledPlugins({ homeDir: HOME }, fs, {
      version: 2,
      plugins: Object.fromEntries(state.installed.map(id => [id, [row]])),
    })
    await fs.writeFile(
      SETTINGS,
      JSON.stringify({ version: 1, enabledPlugins: state.enabledPlugins ?? {}, ...(state.single ? {} : { mods: { singleThemeMod: false } }) }),
    )
    const enabledNow = async () =>
      (JSON.parse(String(await fs.readFile(SETTINGS, { encoding: 'utf-8' }))) as { enabledPlugins?: Enabled }).enabledPlugins ?? {}
    // The session loads whichever install the settings have on, at each reload.
    let loaded: string | undefined
    let reloads = 0
    const fake = fakeSlot({
      hasLoaded: provenance => provenance === loaded,
      commandOwner: name => (name === 'pick-look' && loaded ? { plugin: 'pack', provenance: loaded } : undefined),
    })
    const registry = new CapabilityRegistry()
    registerThemeCapability(registry, {
      fs: () => fs,
      resolveHome: async () => HOME,
      channel: () => 'stable',
      slotOf: () => fake.slot,
      onEnableTiming: { attempts: 3, pause: async () => {} },
      reload: () => {
        reloads += 1
        state.onReload?.()
        if (state.neverLoads) return
        void enabledNow().then(on => {
          loaded = state.installed.find(id => id.startsWith('pack@') && on[id] !== false)
        })
      },
    })
    const useLagoon = (signal?: AbortSignal) =>
      registry
        .resolve('theme', 'useLook')!
        .handle(
          { id: '1', route: { cap: 'theme', act: 'useLook' }, payload: { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' }, conn, signal } as never,
          {} as never,
        )
    return { useLagoon, enabledNow, ran: fake.ran, reloads: () => reloads }
  }

  it('switches the plugin on, reloads the sessions once and applies the look once it has loaded', async () => {
    const { useLagoon, enabledNow, ran, reloads } = await rig({
      installed: [`pack@${MP}`],
      enabledPlugins: { [`pack@${MP}`]: false },
    })
    expect(await useLagoon()).toEqual({ ok: true, via: 'command', text: 'picked lagoon' })
    expect((await enabledNow())[`pack@${MP}`]).toBe(true)
    expect(reloads()).toBe(1)
    expect(ran).toEqual([{ command: 'pick-look', args: 'lagoon', origin: { kind: 'bridge' } }])
  })

  it('switches on the install the person has when the listing\'s own is not installed', async () => {
    const { useLagoon, enabledNow, ran } = await rig({
      installed: ['pack@their-own'],
      enabledPlugins: { 'pack@their-own': false },
    })
    expect(await useLagoon()).toMatchObject({ ok: true, via: 'command' })
    expect(await enabledNow()).toEqual({ 'pack@their-own': true })
    expect(ran).toHaveLength(1)
  })

  it('a cancelled request switches nothing on', async () => {
    const { useLagoon, enabledNow, reloads } = await rig({ installed: [`pack@${MP}`], enabledPlugins: { [`pack@${MP}`]: false } })
    const controller = new AbortController()
    controller.abort()
    expect(await useLagoon(controller.signal)).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await enabledNow()).toEqual({ [`pack@${MP}`]: false })
    expect(reloads()).toBe(0)
  })

  it('leaves the settings alone when the plugin is not installed, or an install of it is already on', async () => {
    const absent = await rig({ installed: [], enabledPlugins: { [`pack@${MP}`]: false } })
    expect(await absent.useLagoon()).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await absent.enabledNow()).toEqual({ [`pack@${MP}`]: false })
    expect(absent.reloads()).toBe(0)
    forgetRegistryFile(HOME)

    const on = await rig({ installed: [`pack@${MP}`, 'pack@their-own'], enabledPlugins: { [`pack@${MP}`]: false } })
    expect(await on.useLagoon()).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await on.enabledNow()).toEqual({ [`pack@${MP}`]: false })
    expect(on.reloads()).toBe(0)
    expect(on.ran).toEqual([])
  })

  it('with one theme plugin at a time, a plugin switched on is the one kept, also when its look then fails', async () => {
    const applied = await rig({
      installed: [`pack@${MP}`, `other@${MP}`],
      enabledPlugins: { [`pack@${MP}`]: false },
      single: true,
    })
    expect(await applied.useLagoon()).toMatchObject({ ok: true })
    expect(await applied.enabledNow()).toEqual({ [`pack@${MP}`]: true, [`other@${MP}`]: false })
    forgetRegistryFile(HOME)

    const failed = await rig({
      installed: [`pack@${MP}`, `other@${MP}`],
      enabledPlugins: { [`pack@${MP}`]: false },
      single: true,
      neverLoads: true,
    })
    expect(await failed.useLagoon()).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await failed.enabledNow()).toEqual({ [`pack@${MP}`]: true, [`other@${MP}`]: false })
    // Both switches land before the one reload.
    expect(failed.reloads()).toBe(1)
    expect(failed.ran).toEqual([])
  })

  it('with one theme plugin at a time, a request cancelled while it waits still keeps the plugin it switched on', async () => {
    const controller = new AbortController()
    const { useLagoon, enabledNow } = await rig({
      installed: [`pack@${MP}`, `other@${MP}`],
      enabledPlugins: { [`pack@${MP}`]: false },
      single: true,
      neverLoads: true,
      onReload: () => controller.abort(),
    })
    expect(await useLagoon(controller.signal)).toMatchObject({ ok: false })
    expect(await enabledNow()).toEqual({ [`pack@${MP}`]: true, [`other@${MP}`]: false })
  })

  it('with one theme plugin at a time, nothing is switched off when no plugin was switched on', async () => {
    const absent = await rig({ installed: [`other@${MP}`], single: true })
    expect(await absent.useLagoon()).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await absent.enabledNow()).toEqual({})
    expect(absent.reloads()).toBe(0)
    forgetRegistryFile(HOME)

    const cancelled = await rig({ installed: [`pack@${MP}`, `other@${MP}`], enabledPlugins: { [`pack@${MP}`]: false }, single: true })
    const controller = new AbortController()
    controller.abort()
    expect(await cancelled.useLagoon(controller.signal)).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await cancelled.enabledNow()).toEqual({ [`pack@${MP}`]: false })
    expect(cancelled.reloads()).toBe(0)
  })
})

describe('theme.useLook with one theme plugin at a time, two plugins serving one command', () => {
  const HOME = '/home/two'
  const SETTINGS = `${HOME}/.velloc/settings.json`
  const conn = { connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' } as ConnectionInfo
  const row = { scope: 'user' as const, installPath: '/x', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' }
  type Enabled = Record<string, boolean>
  const PACK = `pack@${MP}`
  const RIVAL = `rival@${MP}`

  afterEach(() => forgetRegistryFile(HOME))

  /**
   * `pack` and `rival` both register `/pick-look`; the one registered last
   * serves it, and a module that goes takes its registration with it.
   * `reloadLands` holds the session's reload back until it resolves.
   */
  async function rig(state: {
    enabledPlugins: Enabled
    single: boolean
    servedBy: 'pack' | 'rival'
    reloadLands?: Promise<void>
    onPause?: () => void
  }) {
    const fs = makeMemFs()
    await fs.writeFile(
      getMarketplaceManifestPath({ homeDir: HOME }, MP),
      JSON.stringify({
        name: MP,
        plugins: [
          {
            name: 'pack',
            source: { source: 'github', repo: 'someone/pack', sha: 'a'.repeat(40) },
            theme: { looks: [{ id: 'lagoon', preview: PREVIEW, use: { command: 'pick-look', args: 'lagoon' } }] },
          },
          {
            name: 'rival',
            source: { source: 'github', repo: 'someone/rival', sha: 'c'.repeat(40) },
            theme: { looks: [{ id: 'dune', preview: PREVIEW, use: { command: 'pick-look', args: 'dune' } }] },
          },
        ],
      }),
    )
    await saveInstalledPlugins({ homeDir: HOME }, fs, { version: 2, plugins: { [PACK]: [row], [RIVAL]: [row] } })
    await fs.writeFile(
      SETTINGS,
      JSON.stringify({ version: 1, enabledPlugins: state.enabledPlugins, ...(state.single ? {} : { mods: { singleThemeMod: false } }) }),
    )
    const enabledNow = async () =>
      (JSON.parse(String(await fs.readFile(SETTINGS, { encoding: 'utf-8' }))) as { enabledPlugins?: Enabled }).enabledPlugins ?? {}
    const loaded = new Set<string>(Object.entries(state.enabledPlugins).filter(([, on]) => on).map(([id]) => id))
    let servedBy: string | undefined = loaded.has(`${state.servedBy}@${MP}`) ? `${state.servedBy}@${MP}` : undefined
    const ran: { by: string; args: string }[] = []
    const registeredAgain: string[] = []
    let reloads = 0
    const slot: ThemeLookSlot = {
      hasLoaded: provenance => loaded.has(provenance),
      commandOwner: name =>
        name === 'pick-look' && servedBy ? { plugin: servedBy.split('@')[0]!, provenance: servedBy } : undefined,
      commandRun: async input => {
        ran.push({ by: servedBy!, args: input.args })
        return { settled: true, unanswered: false, result: {} }
      },
      reloadPlugin: async provenance => {
        if (!loaded.has(provenance)) return 0
        registeredAgain.push(provenance)
        servedBy = provenance
        return 1
      },
    }
    const registry = new CapabilityRegistry()
    registerThemeCapability(registry, {
      fs: () => fs,
      resolveHome: async () => HOME,
      channel: () => 'stable',
      slotOf: () => slot,
      onEnableTiming: {
        attempts: 5,
        pause: async () => {
          state.onPause?.()
          await new Promise(resolve => setTimeout(resolve, 0))
        },
      },
      reload: () => {
        reloads += 1
        void (async () => {
          await state.reloadLands
          const on = await enabledNow()
          for (const id of [PACK, RIVAL]) {
            if (on[id] === false) {
              loaded.delete(id)
              if (servedBy === id) servedBy = undefined
            } else if (!loaded.has(id)) {
              loaded.add(id)
              servedBy = id
            }
          }
        })()
      },
    })
    const useLagoon = () =>
      registry
        .resolve('theme', 'useLook')!
        .handle(
          { id: '1', route: { cap: 'theme', act: 'useLook' }, payload: { sessionId: 's1', plugin: 'pack', lookId: 'lagoon' }, conn } as never,
          {} as never,
        )
    return { useLagoon, enabledNow, ran, registeredAgain, reloads: () => reloads }
  }

  it('switches the other theme plugin off first, registers the look\'s plugin again, and runs the command as its own', async () => {
    const { useLagoon, enabledNow, ran, registeredAgain, reloads } = await rig({
      enabledPlugins: { [PACK]: true, [RIVAL]: true },
      single: true,
      servedBy: 'rival',
    })
    expect(await useLagoon()).toEqual({ ok: true, via: 'command' })
    expect(await enabledNow()).toEqual({ [PACK]: true, [RIVAL]: false })
    expect(reloads()).toBe(1)
    expect(registeredAgain).toEqual([PACK])
    expect(ran).toEqual([{ by: PACK, args: 'lagoon' }])
  })

  it('waits while the plugin switched off still serves the command, and never runs it there', async () => {
    let land!: () => void
    const reloadLands = new Promise<void>(resolve => (land = resolve))
    let pauses = 0
    let ranBeforeReload: unknown
    const rigged = await rig({
      enabledPlugins: { [PACK]: true, [RIVAL]: true },
      single: true,
      servedBy: 'rival',
      reloadLands,
      // The session reloads only after two tries found the command still served by the other.
      onPause: () => {
        pauses += 1
        if (pauses !== 2) return
        ranBeforeReload = [...rigged.ran]
        land()
      },
    })
    expect(await rigged.useLagoon()).toEqual({ ok: true, via: 'command' })
    expect(ranBeforeReload).toEqual([])
    expect(rigged.ran).toEqual([{ by: PACK, args: 'lagoon' }])
  })

  it('a look of a plugin switched off switches it on and the other off in one reload', async () => {
    const { useLagoon, enabledNow, ran, reloads } = await rig({
      enabledPlugins: { [PACK]: false, [RIVAL]: true },
      single: true,
      servedBy: 'rival',
    })
    expect(await useLagoon()).toEqual({ ok: true, via: 'command' })
    expect(await enabledNow()).toEqual({ [PACK]: true, [RIVAL]: false })
    expect(reloads()).toBe(1)
    expect(ran).toEqual([{ by: PACK, args: 'lagoon' }])
  })

  it('already the one theme plugin on: nothing is switched or reloaded', async () => {
    const { useLagoon, enabledNow, ran, registeredAgain, reloads } = await rig({
      enabledPlugins: { [PACK]: true, [RIVAL]: false },
      single: true,
      servedBy: 'pack',
    })
    expect(await useLagoon()).toEqual({ ok: true, via: 'command' })
    expect(await enabledNow()).toEqual({ [PACK]: true, [RIVAL]: false })
    expect(reloads()).toBe(0)
    expect(registeredAgain).toEqual([])
    expect(ran).toEqual([{ by: PACK, args: 'lagoon' }])
  })

  it('a look whose plugin cannot be switched on leaves the other theme plugin on', async () => {
    const restore = __setPluginBlocklistForTests([PACK])
    try {
      const { useLagoon, enabledNow, ran, reloads } = await rig({
        enabledPlugins: { [PACK]: false, [RIVAL]: true },
        single: true,
        servedBy: 'rival',
      })
      expect(await useLagoon()).toEqual({ ok: false, reason: 'notLoaded' })
      expect(await enabledNow()).toEqual({ [PACK]: false, [RIVAL]: true })
      expect(reloads()).toBe(0)
      expect(ran).toEqual([])
    } finally {
      restore()
    }
  })

  it('with the setting off, nothing is switched: the other plugin\'s command is not run', async () => {
    const { useLagoon, enabledNow, ran, reloads } = await rig({
      enabledPlugins: { [PACK]: true, [RIVAL]: true },
      single: false,
      servedBy: 'rival',
    })
    expect(await useLagoon()).toEqual({ ok: false, reason: 'notOwnCommand' })
    expect(await enabledNow()).toEqual({ [PACK]: true, [RIVAL]: true })
    expect(reloads()).toBe(0)
    expect(ran).toEqual([])
  })
})

describe('useThemeLookOnceLoaded', () => {
  const NO_WAIT = { attempts: 4, pause: async () => {} }

  it('asks again while the plugin is loading, reading the session\'s runtime on each try', async () => {
    const { slot, ran } = fakeSlot()
    let lookups = 0
    const target = {
      marketplace: MP,
      listings: LISTINGS,
      get slot() {
        lookups += 1
        return lookups >= 3 ? slot : undefined
      },
    }
    expect(await useThemeLookOnceLoaded(target, { plugin: 'pack', lookId: 'lagoon' }, NO_WAIT)).toEqual({
      ok: true,
      via: 'command',
      text: 'picked lagoon',
    })
    expect(lookups).toBe(3)
    expect(ran).toHaveLength(1)
  })

  it('gives the last answer when the plugin never loads, and stops at an answer that waiting will not change', async () => {
    const never = fakeSlot({ hasLoaded: () => false })
    const waiting = { marketplace: MP, listings: LISTINGS, slot: never.slot }
    expect(await useThemeLookOnceLoaded(waiting, { plugin: 'pack', lookId: 'lagoon' }, NO_WAIT)).toEqual({
      ok: false,
      reason: 'notLoaded',
    })
    let asked = 0
    const silent = fakeSlot({
      commandRun: async () => {
        asked += 1
        return { settled: true, unanswered: true } as never
      },
    })
    expect(
      await useThemeLookOnceLoaded({ marketplace: MP, listings: LISTINGS, slot: silent.slot }, { plugin: 'pack', lookId: 'lagoon' }, NO_WAIT),
    ).toEqual({ ok: false, reason: 'unanswered' })
    expect(asked).toBe(1)
  })

  it('asks at once, and stops at notOwnCommand once the plugin has started', async () => {
    let pauses = 0
    const counted = { attempts: 4, pause: async () => void (pauses += 1) }
    const { slot, ran } = fakeSlot()
    expect(await useThemeLookOnceLoaded({ marketplace: MP, listings: LISTINGS, slot }, { plugin: 'pack', lookId: 'lagoon' }, counted)).toMatchObject({ ok: true })
    expect(pauses).toBe(0)
    const started = fakeSlot({ hasLoaded: provenance => provenance === `pack@${MP}`, commandOwner: () => undefined })
    expect(
      await useThemeLookOnceLoaded({ marketplace: MP, listings: LISTINGS, slot: started.slot }, { plugin: 'pack', lookId: 'lagoon' }, counted),
    ).toEqual({ ok: false, reason: 'notOwnCommand' })
    expect(pauses).toBe(0)
    expect(ran).toHaveLength(1)
  })

  it('a look applied by loading the plugin is not loaded again once the session has loaded it', async () => {
    const { slot, reloaded } = fakeSlot({ hasLoaded: () => true, themeOwner: () => 'single' })
    expect(await useThemeLookOnceLoaded({ marketplace: MP, listings: LISTINGS, slot }, { plugin: 'single', lookId: 'single' }, NO_WAIT)).toEqual({
      ok: true,
      via: 'reload',
    })
    expect(reloaded).toEqual([])
  })

  it('with others just switched off, loads the plugin again once when nobody serves its command, then stops', async () => {
    const reloaded: string[] = []
    const slot: ThemeLookSlot = {
      hasLoaded: () => true,
      commandOwner: () => undefined,
      commandRun: async () => ({ settled: true, unanswered: false, result: {} }),
      reloadPlugin: async provenance => {
        reloaded.push(provenance)
        return 1
      },
    }
    const result = await useThemeLookOnceLoaded(
      { marketplace: MP, listings: LISTINGS, slot },
      { plugin: 'pack', lookId: 'lagoon' },
      { attempts: 5, pause: async () => {} },
      undefined,
      { othersOff: ['rival'] },
    )
    expect(result).toEqual({ ok: false, reason: 'notOwnCommand' })
    expect(reloaded).toEqual([`pack@${MP}`])
  })

  it('with others just switched off, does not wait on a plugin that was not one of them', async () => {
    const reloaded: string[] = []
    let tries = 0
    const slot: ThemeLookSlot = {
      hasLoaded: () => true,
      commandOwner: () => ({ plugin: 'tools', provenance: `tools@${MP}` }),
      commandRun: async () => ({ settled: true, unanswered: false, result: {} }),
      reloadPlugin: async provenance => {
        reloaded.push(provenance)
        return 1
      },
    }
    const result = await useThemeLookOnceLoaded(
      { marketplace: MP, listings: LISTINGS, slot },
      { plugin: 'pack', lookId: 'lagoon' },
      { attempts: 5, pause: async () => void (tries += 1) },
      undefined,
      { othersOff: ['rival'] },
    )
    expect(result).toEqual({ ok: false, reason: 'notOwnCommand' })
    expect(tries).toBe(0)
    expect(reloaded).toEqual([])
  })

  it('runs nothing once the request is cancelled', async () => {
    const { slot, ran } = fakeSlot()
    const controller = new AbortController()
    controller.abort()
    expect(
      await useThemeLookOnceLoaded({ marketplace: MP, listings: LISTINGS, slot }, { plugin: 'pack', lookId: 'lagoon' }, NO_WAIT, controller.signal),
    ).toEqual({ ok: false, reason: 'notLoaded' })
    expect(ran).toEqual([])
  })
})

describe('a session\'s mod runtime, as a look uses it', () => {
  const open: MessagePort[] = []
  const runtimes: ModRuntime[] = []
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose()
    for (const port of open.splice(0)) port.close()
  })

  const PAPER = { v: 1, label: 'Paper', inputs: { light: { 'gray-20': '#efe6d3', 'gray-900': '#2a241d' } } }
  const INK = { v: 1, label: 'Ink', inputs: { dark: { 'gray-20': '#10141c', 'gray-900': '#e8ecf4' } } }
  const single = (palette: unknown) => `
    on('session.start', async ($, e, next) => {
      await $.theme.set({ colors: ${JSON.stringify(palette)} })
      return next(e)
    })
  `
  const PACK = `
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'pick-look', description: 'Picks a look.' })
      return next(e)
    })
    on('command.run', { command: 'pick-look' }, async ($, e) => {
      await $.theme.set({ colors: ${JSON.stringify(INK)} })
      return { text: 'picked ' + e.args }
    })
  `

  function world(modules: Record<string, { text: string; provenance?: string }>) {
    const reads: Record<string, number> = {}
    const refs: ModModuleRef[] = Object.entries(modules).map(([plugin, module]) => ({
      plugin,
      path: `/plugins/${plugin}/hooks/register.js`,
      ...(module.provenance ? { provenance: module.provenance } : {}),
    }))
    const runtime = new ModRuntime({
      modules: refs,
      // The same text on every read: only a forced reload loads it again.
      readModule: async path => {
        const plugin = path.split('/')[2]!
        reads[plugin] = (reads[plugin] ?? 0) + 1
        return `export function register(on) {\n${modules[plugin]!.text}\n}`
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
      report: () => {},
    })
    runtimes.push(runtime)
    return { runtime, reads }
  }

  it('names who registered a command, and where that plugin was loaded from', async () => {
    const { runtime } = world({
      pack: { text: PACK, provenance: `pack@${MP}` },
      loose: { text: PACK.replaceAll('pick-look', 'loose-look') },
    })
    await runtime.ready
    expect(runtime.commandOwner('pick-look')).toEqual({ plugin: 'pack', provenance: `pack@${MP}` })
    expect(runtime.commandOwner('loose-look')).toEqual({ plugin: 'loose' })
    expect(runtime.commandOwner('help')).toBeUndefined()
  })

  it('a pack look runs the plugin\'s command and its theme stands; clear takes it away', async () => {
    const { runtime } = world({ pack: { text: PACK, provenance: `pack@${MP}` } })
    await runtime.ready
    expect(runtime.theme.current()).toBeUndefined()
    const result = await useThemeLook({ marketplace: MP, listings: LISTINGS, slot: runtime }, { plugin: 'pack', lookId: 'lagoon' })
    expect(result).toEqual({ ok: true, via: 'command', text: 'picked lagoon' })
    expect(runtime.theme.current()).toMatchObject({ plugin: 'pack', colors: INK })
    expect(clearSessionTheme(runtime)).toEqual({ ok: true, cleared: true })
    expect(runtime.theme.current()).toBeUndefined()
    expect(clearSessionTheme(runtime)).toEqual({ ok: true, cleared: false })
  })

  it('a single look loads that plugin again, unchanged as it is, so its theme is the latest set', async () => {
    const { runtime, reads } = world({
      single: { text: single(PAPER), provenance: `single@${MP}` },
      later: { text: single(INK), provenance: `later@${MP}` },
    })
    await runtime.ready
    expect(runtime.theme.current()).toMatchObject({ plugin: 'later' })
    const before = { ...reads }
    const result = await useThemeLook({ marketplace: MP, listings: LISTINGS, slot: runtime }, { plugin: 'single', lookId: 'single' })
    expect(result).toEqual({ ok: true, via: 'reload' })
    expect(runtime.theme.current()).toMatchObject({ plugin: 'single', colors: PAPER })
    expect(reads.single).toBeGreaterThan(before.single!)
    expect(reads.later).toBe(before.later)
    expect(await runtime.reloadPlugin(`single@elsewhere`)).toBe(0)
  })

  it('a pack look whose plugin is not loaded in the session is notLoaded, not notOwnCommand', async () => {
    const { runtime } = world({ other: { text: single(PAPER), provenance: `other@${MP}` } })
    await runtime.ready
    expect(runtime.hasLoaded(`pack@${MP}`)).toBe(false)
    expect(runtime.hasLoaded(`other@${MP}`)).toBe(true)
    const result = await useThemeLook({ marketplace: MP, listings: LISTINGS, slot: runtime }, { plugin: 'pack', lookId: 'lagoon' })
    expect(result).toEqual({ ok: false, reason: 'notLoaded' })
  })

  it('a single look whose module no longer loads is notLoaded, and the theme it had set is gone', async () => {
    const modules = { single: { text: single(PAPER), provenance: `single@${MP}` } }
    const { runtime } = world(modules)
    await runtime.ready
    expect(runtime.theme.current()).toMatchObject({ plugin: 'single' })
    modules.single.text = 'this is not ( valid javascript'
    const result = await useThemeLook({ marketplace: MP, listings: LISTINGS, slot: runtime }, { plugin: 'single', lookId: 'single' })
    expect(result).toEqual({ ok: false, reason: 'notLoaded' })
    expect(runtime.hasLoaded(`single@${MP}`)).toBe(false)
    expect(runtime.theme.current()).toBeUndefined()
  })
})
