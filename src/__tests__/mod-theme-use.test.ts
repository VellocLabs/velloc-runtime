/**
 * `theme.useLook` / `theme.clear` (F-25, F-35): a look from the built-in
 * marketplace's cached listing is applied to one session, by the plugin's own
 * command or by loading the plugin again.
 *
 * The slot tests load real module text through `ModWorkerHost` on a
 * MessageChannel; the capability tests use a memory file system.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { registerThemeCapability } from '../browser/runtimeHub/themeCapability'
import type { ConnectionInfo } from '../browser/runtimeHub/types'
import {
  THEME_ACTION_SCOPES,
  clearSessionTheme,
  isThemeClearPayload,
  isThemeUseLookPayload,
  useThemeLook,
  type ThemeLookSlot,
  type ThemeUseLookResult,
} from '../mods/modThemeLooks'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { BUILTIN_MARKETPLACE_KEY } from '../pluginHost/builtinMarketplace'
import { getMarketplaceManifestPath } from '../pluginHost/pluginDirs'
import type { CatalogListing } from '../pluginHost/registryFormats'
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

  async function rig(options: { cached?: boolean; home?: () => Promise<string> } = {}) {
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
    })
    const ask = (act: 'useLook' | 'clear', payload: unknown, c = conn()) => {
      const entry = registry.resolve('theme', act)!
      expect(entry.spec.guard?.(payload, c, {} as never) ?? true).toBe(true)
      return entry.handle({ id: '1', route: { cap: 'theme', act }, payload, conn: c } as never, {} as never)
    }
    return { registry, ask, asked, ...fake }
  }

  it('declares both actions at full, with their guards', async () => {
    const { registry } = await rig()
    expect(THEME_ACTION_SCOPES).toEqual({ useLook: 'full', clear: 'full' })
    for (const act of ['useLook', 'clear'] as const) {
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
