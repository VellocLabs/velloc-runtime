/**
 * `theme.onEnable` (F-25, F-35): after a person turns a theme plugin on, the
 * command the catalogue names for it runs in one session, and only when that
 * plugin registered it; a look with no command of its own runs it too.
 */
import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { registerThemeCapability } from '../browser/runtimeHub/themeCapability'
import type { ConnectionInfo } from '../browser/runtimeHub/types'
import {
  isThemeOnEnablePayload,
  runThemeOnEnable,
  useThemeLook,
  type ThemeLookSlot,
  type ThemeLookTarget,
} from '../mods/modThemeLooks'
import { BUILTIN_MARKETPLACE_KEY } from '../pluginHost/builtinMarketplace'
import { getMarketplaceManifestPath } from '../pluginHost/pluginDirs'
import type { CatalogListing } from '../pluginHost/registryFormats'
import { normalizeListingTheme } from '../pluginHost/themeListing'
import { makeMemFs } from './_helpers/memFs'

const MP = BUILTIN_MARKETPLACE_KEY
const PREVIEW = 'previews/one.svg'

const LISTINGS: CatalogListing[] = [
  {
    name: 'rain',
    source: { source: 'github', repo: 'someone/rain', sha: 'a'.repeat(40) },
    theme: { looks: [{ id: 'rain', preview: PREVIEW }], onEnable: { command: 'rain', args: 'on' } },
  },
  {
    name: 'pack',
    source: { source: 'github', repo: 'someone/pack', sha: 'b'.repeat(40) },
    theme: { looks: [{ id: 'one', preview: PREVIEW, use: { command: 'pick', args: 'one' } }], onEnable: { command: 'pick' } },
  },
  {
    name: 'borrow',
    source: { source: 'github', repo: 'someone/borrow', sha: 'c'.repeat(40) },
    theme: { looks: [{ id: 'borrow', preview: PREVIEW }], onEnable: { command: 'pick' } },
  },
  {
    name: 'plain',
    source: { source: 'github', repo: 'someone/plain', sha: 'd'.repeat(40) },
    theme: { looks: [{ id: 'plain', preview: PREVIEW }] },
  },
]

const OWNERS: Record<string, { plugin: string; provenance: string }> = {
  rain: { plugin: 'rain', provenance: `rain@${MP}` },
  pick: { plugin: 'pack', provenance: `pack@${MP}` },
}

function fakeSlot(over: Partial<ThemeLookSlot> = {}) {
  const ran: string[] = []
  const reloaded: string[] = []
  const slot: ThemeLookSlot = {
    commandOwner: name => OWNERS[name],
    commandRun: async input => {
      ran.push(`/${input.command} ${input.args}`.trim())
      return { settled: true, unanswered: false, result: { text: 'done' } }
    },
    hasLoaded: () => true,
    reloadPlugin: async provenance => {
      reloaded.push(provenance)
      return 1
    },
    ...over,
  }
  return { slot, ran, reloaded }
}

const target = (slot: ThemeLookSlot | undefined, listings: CatalogListing[] | null = LISTINGS): ThemeLookTarget => ({
  marketplace: MP,
  listings,
  slot,
})
const NO_WAIT = { attempts: 3, pause: async () => {} }

describe('the listing field onEnable', () => {
  it('is kept with a plain command word and a plain argument, and dropped otherwise', () => {
    expect(normalizeListingTheme({ looks: [], onEnable: { command: 'rainy-window', args: 'on' } })?.onEnable).toEqual({
      command: 'rainy-window',
      args: 'on',
    })
    expect(normalizeListingTheme({ looks: [], onEnable: { command: 'custom-theme' } })?.onEnable).toEqual({
      command: 'custom-theme',
    })
    for (const bad of [{ command: '/custom-theme' }, { command: 'x y' }, { command: 'x', args: 'ON; rm' }, 'custom-theme', null]) {
      const theme = normalizeListingTheme({ looks: [], onEnable: bad })
      expect(theme).toBeDefined()
      expect(theme?.onEnable).toBeUndefined()
    }
  })
})

describe('runThemeOnEnable', () => {
  it('runs the command the catalogue names, with its argument, when the plugin registered it', async () => {
    const { slot, ran } = fakeSlot()
    expect(await runThemeOnEnable(target(slot), 'rain', NO_WAIT)).toEqual({ ok: true, via: 'command', text: 'done' })
    expect(await runThemeOnEnable(target(slot), 'pack', NO_WAIT)).toEqual({ ok: true, via: 'command', text: 'done' })
    expect(ran).toEqual(['/rain on', '/pick'])
  })

  it('waits for the plugin to start, and runs nothing when its own theme then stands', async () => {
    let owner: string | undefined
    const order: string[] = []
    const { slot, ran } = fakeSlot({
      settled: async () => {
        order.push('settled')
        owner = 'rain'
      },
      themeOwner: () => owner,
    })
    expect(await runThemeOnEnable(target(slot), 'rain', NO_WAIT)).toEqual({ ok: true, via: 'self' })
    expect(order).toEqual(['settled'])
    expect(ran).toEqual([])
    // Another plugin's theme standing is no reason to hold back.
    owner = 'other'
    const other = fakeSlot({ themeOwner: () => 'other' })
    expect(await runThemeOnEnable(target(other.slot), 'rain', NO_WAIT)).toEqual({ ok: true, via: 'command', text: 'done' })
    expect(other.ran).toEqual(['/rain on'])
  })

  it('never runs a command another plugin registered', async () => {
    const { slot, ran } = fakeSlot()
    expect(await runThemeOnEnable(target(slot), 'borrow', NO_WAIT)).toEqual({ ok: false, reason: 'notOwnCommand' })
    expect(ran).toEqual([])
  })

  it('answers none, and runs nothing, for a plugin with no onEnable or no listing', async () => {
    const { slot, ran } = fakeSlot()
    for (const plugin of ['plain', 'unknown']) {
      expect(await runThemeOnEnable(target(slot), plugin, NO_WAIT)).toEqual({ ok: false, reason: 'none' })
    }
    expect(await runThemeOnEnable(target(slot, null), 'rain', NO_WAIT)).toEqual({ ok: false, reason: 'none' })
    expect(ran).toEqual([])
  })

  it('asks again while the plugin is still loading, and gives up after the last try', async () => {
    let loaded = false
    let pauses = 0
    const { slot, ran } = fakeSlot({ hasLoaded: () => loaded })
    const timing = {
      attempts: 4,
      pause: async () => {
        pauses += 1
        if (pauses === 2) loaded = true
      },
    }
    expect(await runThemeOnEnable(target(slot), 'rain', timing)).toEqual({ ok: true, via: 'command', text: 'done' })
    expect(pauses).toBe(2)
    expect(ran).toEqual(['/rain on'])

    const never = fakeSlot({ hasLoaded: () => false })
    expect(await runThemeOnEnable(target(never.slot), 'rain', NO_WAIT)).toEqual({ ok: false, reason: 'notLoaded' })
    expect(await runThemeOnEnable(target(undefined), 'rain', NO_WAIT)).toEqual({ ok: false, reason: 'notLoaded' })
  })

  it('reports a failed command with what it said, and does not ask again', async () => {
    let calls = 0
    const { slot } = fakeSlot({
      commandRun: async () => {
        calls += 1
        return { settled: true, unanswered: false, result: { text: 'no such look', exitCode: 1 } }
      },
    })
    expect(await runThemeOnEnable(target(slot), 'rain', NO_WAIT)).toEqual({
      ok: false,
      reason: 'commandFailed',
      text: 'no such look',
    })
    expect(calls).toBe(1)
  })
})

describe('useThemeLook with onEnable', () => {
  it('a look with no command of its own runs the plugin onEnable instead of loading it again', async () => {
    const { slot, ran, reloaded } = fakeSlot()
    expect(await useThemeLook(target(slot), { plugin: 'rain', lookId: 'rain' })).toEqual({ ok: true, via: 'command', text: 'done' })
    expect(ran).toEqual(['/rain on'])
    expect(reloaded).toEqual([])
    expect(await useThemeLook(target(slot), { plugin: 'plain', lookId: 'plain' })).toEqual({ ok: true, via: 'reload' })
    expect(reloaded).toEqual([`plain@${MP}`])
  })
})

describe('the theme capability: onEnable', () => {
  const HOME = '/home/u'
  const conn = (sessions: 'all' | string[] = 'all') =>
    ({ connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions }, transport: 'message-port' }) as ConnectionInfo

  async function rig() {
    const fs = makeMemFs()
    await fs.writeFile(
      getMarketplaceManifestPath({ homeDir: HOME }, MP),
      JSON.stringify({
        name: MP,
        plugins: [
          {
            name: 'rain',
            source: { source: 'github', repo: 'someone/rain', sha: 'a'.repeat(40) },
            theme: { looks: [{ id: 'rain', preview: PREVIEW }], onEnable: { command: 'rain', args: 'on' } },
          },
        ],
      }),
    )
    const fake = fakeSlot()
    let lookups = 0
    const registry = new CapabilityRegistry()
    registerThemeCapability(registry, {
      fs: () => fs,
      resolveHome: async () => HOME,
      channel: () => 'stable',
      slotOf: sessionId => {
        if (sessionId !== 's1') return undefined
        lookups += 1
        // The session's mod runtime is there from the third look on.
        return lookups >= 3 ? fake.slot : undefined
      },
      onEnableTiming: { attempts: 4, pause: async () => {} },
    })
    const ask = (payload: unknown, c = conn()) => {
      const entry = registry.resolve('theme', 'onEnable')!
      expect(entry.spec.guard?.(payload, c, {} as never) ?? true).toBe(true)
      return entry.handle({ id: '1', route: { cap: 'theme', act: 'onEnable' }, payload, conn: c } as never, {} as never)
    }
    return { ask, ran: fake.ran }
  }

  it('reads onEnable from the cached listing and runs it in the named session, looked up on each try', async () => {
    const { ask, ran } = await rig()
    expect(await ask({ sessionId: 's1', plugin: 'rain' })).toEqual({ ok: true, via: 'command', text: 'done' })
    expect(ran).toEqual(['/rain on'])
  })

  it('refuses a session outside the connection scope', async () => {
    const { ask, ran } = await rig()
    await expect(ask({ sessionId: 's1', plugin: 'rain' }, conn(['s2']))).rejects.toMatchObject({ code: 'forbidden_scope' })
    expect(ran).toEqual([])
  })

  it('takes a session and a plugin name, and nothing else', () => {
    expect(isThemeOnEnablePayload({ sessionId: 's1', plugin: 'rain' })).toBe(true)
    expect(isThemeOnEnablePayload({ sessionId: 's1', plugin: 'rain', command: 'x' })).toBe(false)
    expect(isThemeOnEnablePayload({ sessionId: 's1', plugin: '../x' })).toBe(false)
    expect(isThemeOnEnablePayload({ plugin: 'rain' })).toBe(false)
  })
})
