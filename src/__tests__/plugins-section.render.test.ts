// @vitest-environment happy-dom
/**
 * Settings · Plugins, gated by capability: browsing is `observe`, the enable toggle `control`, and Fetch, Install
 * and Uninstall are `full`; a control whose action the connection lacks is not rendered.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { CapabilityAdvert } from '../browser/runtimeProtocol'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import { PluginsSection } from '../browser/webview/settings/sections/PluginsSection'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { queryFor } from './_helpers/capabilityQuery'
import { makeMockSettingsBridge } from './_helpers/mockSettingsBridge'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { MODS_STATE_TOPIC, type ModsStatePayload } from '../browser/runtimeProtocol'
import { summarizeModsByPlugin } from '../browser/webview/mods/modsStateView'
import { getProductName } from '../branding/productName'

// This vitest realm's `localStorage` is not a working Storage, and the page
// caches marketplace listings in it; a Map-backed stub stands in (as in
// appearance-section.render.test.ts), cleared so no case sees another's cache.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const PLUGIN_ACTS = [
  'listInstalled',
  'listMarketplaces',
  'listMarketplacePlugins',
  'setEnabled',
  'install',
  'uninstall',
  'refreshMarketplace',
]

/** The `plugins` capability as each grant is advertised it (scope-filtered). */
const FULL: CapabilityAdvert[] = [{ cap: 'plugins', acts: PLUGIN_ACTS }]
const MANAGER: CapabilityAdvert[] = [
  { cap: 'plugins', acts: ['listInstalled', 'listMarketplaces', 'listMarketplacePlugins', 'setEnabled'] },
]
const OBSERVE: CapabilityAdvert[] = [
  { cap: 'plugins', acts: ['listInstalled', 'listMarketplaces', 'listMarketplacePlugins'] },
]

const OFFICIAL = 'claude-plugins-official'
const BUILTIN = 'velloc'
/** Configured but never fetched: its local manifest is null. */
const UNFETCHED = 'team-marketplace'

function installedEntry(name: string) {
  return {
    name,
    marketplace: OFFICIAL,
    scope: 'user',
    installPath: `/plugins/${name}`,
    version: '1.0.0',
    enabled: true,
    enabledSource: 'default',
  }
}

/**
 * One installed plugin (`beta`) unless `installed` says otherwise; two
 * marketplaces — the official one with a local manifest listing `alpha`
 * (not installed) and `beta` (installed), and one never fetched. Every call
 * the page makes is recorded in `calls`.
 */
function makeBridge(
  installed: Array<ReturnType<typeof installedEntry> & { isMod?: boolean; description?: string }> = [installedEntry('beta')],
  /** More routes, each recorded too — `plugins.listLocal` has none by default. */
  extra: Record<string, (payload: unknown) => unknown> = {},
) {
  const calls: string[] = []
  const requests: Array<{ route: string; payload: unknown }> = []
  const record =
    (key: string, answer: (payload: unknown) => unknown) =>
    (payload: unknown) => {
      calls.push(key)
      requests.push({ route: key, payload })
      return answer(payload)
    }
  const bridge = makeMockSettingsBridge({
    'plugins.listInstalled': record('plugins.listInstalled', () => ({ plugins: installed })),
    'plugins.listMarketplaces': record('plugins.listMarketplaces', () => ({
      marketplaces: [
        {
          name: OFFICIAL,
          isOfficial: true,
          isBuiltin: false,
          source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
          installLocation: '/mp/official',
          lastUpdated: '2026-09-20T00:00:00.000Z',
        },
        {
          name: UNFETCHED,
          isOfficial: false,
          isBuiltin: false,
          source: { source: 'github', repo: 'example/team-marketplace' },
          installLocation: '/mp/team',
          lastUpdated: '2026-09-20T00:00:00.000Z',
        },
        {
          name: BUILTIN,
          isOfficial: false,
          isBuiltin: true,
          source: { source: 'url', url: 'https://plugins.velloc.app/marketplace.tar.gz' },
          installLocation: '/mp/velloc',
          lastUpdated: '2026-09-20T00:00:00.000Z',
        },
      ],
    })),
    'plugins.listMarketplacePlugins': record('plugins.listMarketplacePlugins', (payload) => {
      const { marketplace } = payload as { marketplace: string }
      if (marketplace !== OFFICIAL) return { marketplace, manifest: null }
      return {
        marketplace,
        manifest: {
          name: OFFICIAL,
          plugins: [
            { name: 'alpha', description: 'First.', source: './alpha', installed: false },
            { name: 'beta', description: 'Second.', source: './beta', installed: true },
          ],
        },
      }
    }),
    'plugins.setEnabled': record('plugins.setEnabled', () => ({ ok: true })),
    'plugins.install': record('plugins.install', () => ({ ok: true })),
    'plugins.uninstall': record('plugins.uninstall', () => ({ ok: true })),
    'plugins.removeLocal': record('plugins.removeLocal', () => ({ ok: true, name: 'my-mod' })),
    'plugins.setLocalEnabled': record('plugins.setLocalEnabled', () => ({ ok: true, name: 'my-mod' })),
    'plugins.refreshMarketplace': record('plugins.refreshMarketplace', () => ({ manifest: null })),
    ...Object.fromEntries(Object.entries(extra).map(([key, answer]) => [key, record(key, answer)])),
  })
  return { bridge, calls, requests }
}

/** `capabilities` omitted = no provider: the desktop tree. */
function renderPlugins(
  bridge: ReturnType<typeof makeBridge>['bridge'],
  capabilities?: CapabilityQuery,
  runtimeConnection?: () => Promise<RuntimeConnection>,
) {
  const section = createElement(
    SettingsBridgeContext.Provider,
    { value: bridge },
    createElement(PluginsSection, runtimeConnection ? { runtimeConnection } : undefined),
  )
  return render(
    capabilities
      ? createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, section)
      : section,
  )
}

/**
 * Wait for the page and the official marketplace's local listing (the
 * auto-load marks it fetched and shows its count badge), then open it.
 */
async function openOfficialListing() {
  await screen.findByTestId('installed-plugin-beta')
  await screen.findByText(/^2\s+plugins$/)
  fireEvent.click(screen.getByTestId(`mp-toggle-${OFFICIAL}`))
  await screen.findByTestId('marketplace-plugin-card-alpha')
}

describe('PluginsSection — the built-in marketplace', () => {
  it('lists it first, named after the product, with a Built in badge', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge)
    await openOfficialListing()
    expect(screen.getByTestId(`mp-builtin-${BUILTIN}`).textContent).toBe('Built in')
    const row = screen.getByTestId(`mp-toggle-${BUILTIN}`)
    expect(row.textContent).toContain(`${getProductName()} Plugins`)
    expect(row.textContent).not.toContain('velloc:')
    const toggles = screen.getAllByTestId(/^mp-toggle-/).map(el => el.getAttribute('data-testid'))
    expect(toggles[0]).toBe(`mp-toggle-${BUILTIN}`)
    expect(toggles[1]).toBe(`mp-toggle-${OFFICIAL}`)
  })
})

describe('PluginsSection — desktop renders every control', () => {
  it.each([
    ['with no capability provider (the desktop tree)', undefined],
    ['for a full grant', queryFor(FULL)],
  ])('%s', async (_label, capabilities) => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, capabilities)

    await openOfficialListing()
    expect(screen.getByTestId('plugin-toggle-beta')).toBeTruthy()
    // The word beside the toggle spells the state — the switch is not the
    // only way to read it. The row still carries the state as data.
    const row = screen.getByTestId('installed-plugin-beta')
    expect(screen.getByTestId('plugin-state-beta').textContent).toBe('Enabled')
    expect(row.getAttribute('data-enabled')).toBe('true')
    // Uninstall sits in the card's overflow menu.
    expect(screen.queryByTestId('plugin-uninstall-beta')).toBeNull()
    fireEvent.click(screen.getByTestId('plugin-menu-beta'))
    expect(await screen.findByTestId('plugin-uninstall-beta')).toBeTruthy()
    expect(screen.getByTestId(`mp-fetch-${OFFICIAL}`)).toBeTruthy()
    expect(screen.getByTestId(`mp-fetch-${UNFETCHED}`)).toBeTruthy()
    expect(screen.getByTestId('plugin-install-alpha')).toBeTruthy()
  })

  it('spells the state beside the toggle, and reads Disabled when the plugin is off', async () => {
    const { bridge } = makeBridge([{ ...installedEntry('beta'), enabled: false }])
    renderPlugins(bridge)

    await screen.findByTestId('installed-plugin-beta')
    expect(screen.getByTestId('plugin-state-beta').textContent).toBe('Disabled')
    expect(screen.getByTestId('plugin-toggle-beta')).toBeTruthy()
    expect(
      screen.getByTestId('installed-plugin-beta').getAttribute('data-enabled'),
    ).toBe('false')
  })

  it('keeps the empty-state and never-fetched hints that point at Install and Fetch', async () => {
    const { bridge } = makeBridge([])
    renderPlugins(bridge)

    expect(await screen.findByText('No plugins or mods installed')).toBeTruthy()
    expect(screen.getByText('Install plugins from a marketplace below.')).toBeTruthy()
    fireEvent.click(await screen.findByTestId(`mp-toggle-${UNFETCHED}`))
    expect(
      await screen.findByText('Marketplace not yet fetched. Click Fetch to load.'),
    ).toBeTruthy()
  })
})

describe('PluginsSection — a scoped grant sees no disk-writing control', () => {
  it('hides Fetch, Install and Uninstall and keeps browsing and the toggle', async () => {
    const { bridge, calls } = makeBridge()
    renderPlugins(bridge, queryFor(MANAGER))

    await openOfficialListing()
    // Gone: each is `full`.
    expect(screen.queryByTestId(`mp-fetch-${OFFICIAL}`)).toBeNull()
    expect(screen.queryByTestId(`mp-fetch-${UNFETCHED}`)).toBeNull()
    expect(screen.queryByTestId('plugin-install-alpha')).toBeNull()
    expect(screen.queryByTestId('plugin-menu-beta')).toBeNull()
    // Kept: the already-fetched listing is browsable, the installed badge
    // still reads, and enabling is `control`.
    expect(screen.getByTestId('marketplace-plugin-card-beta')).toBeTruthy()
    expect(screen.getByTestId('plugin-installed-beta')).toBeTruthy()
    expect(screen.getByTestId('plugin-toggle-beta')).toBeTruthy()

    // The toggle still works end to end.
    fireEvent.click(screen.getByTestId('plugin-toggle-beta'))
    await screen.findByText('Plugin disabled')
    expect(calls).toContain('plugins.setEnabled')
    expect(calls).not.toContain('plugins.install')
    expect(calls).not.toContain('plugins.uninstall')
    expect(calls).not.toContain('plugins.refreshMarketplace')
  })

  it('does not point at Install or Fetch buttons it does not render', async () => {
    const { bridge } = makeBridge([])
    renderPlugins(bridge, queryFor(MANAGER))

    expect(await screen.findByText('No plugins or mods installed')).toBeTruthy()
    expect(screen.queryByText('Install plugins from a marketplace below.')).toBeNull()
    fireEvent.click(await screen.findByTestId(`mp-toggle-${UNFETCHED}`))
    // The panel of a never-fetched marketplace says so, without "Click Fetch".
    const panel = screen.getByTestId(`mp-toggle-${UNFETCHED}`).parentElement!.parentElement!
    await screen.findAllByText('Not fetched yet')
    expect(panel.textContent).not.toContain('Click Fetch')
  })

  it('drops the enable toggle too for a read-only grant', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, queryFor(OBSERVE))

    await screen.findByTestId('installed-plugin-beta')
    expect(screen.queryByTestId('plugin-toggle-beta')).toBeNull()
    expect(screen.queryByTestId('plugin-menu-beta')).toBeNull()
    // The state it would have toggled still reads.
    expect(screen.getByTestId('plugin-state-beta').textContent).toBe('Enabled')
  })
})

// ── Mods (F-25): what became of each plugin's hooks module ──

/** A connection whose `mods/state` subscription answers `payload` at once. */
function connectionPublishing(payload: ModsStatePayload): () => Promise<RuntimeConnection> {
  const conn = {
    subscribe: (topic: string, listener: (event: { payload: unknown }) => void) => {
      if (topic === MODS_STATE_TOPIC) queueMicrotask(() => listener({ payload, form: 'snapshot' } as never))
      return () => {}
    },
  } as unknown as RuntimeConnection
  return () => Promise.resolve(conn)
}

const MODS_STATE: ModsStatePayload = {
  sessions: [
    {
      sessionId: 's1',
      mods: [
        { plugin: 'beta', path: '/plugins/beta/hooks/register.js', state: 'loaded', generation: 1, events: ['prompt.submit'] },
        {
          plugin: 'typed',
          path: '/plugins/typed/hooks/register.ts',
          state: 'refused',
          reason: 'only .js and .mjs hooks modules load yet',
          generation: 1,
        },
      ],
    },
    { sessionId: 's2', mods: [{ plugin: 'beta', path: '/plugins/beta/hooks/register.js', state: 'loaded', generation: 2 }] },
  ],
}

const WITH_MODS: CapabilityAdvert[] = [...FULL, { cap: 'mods', acts: ['list'] }]

describe('PluginsSection — the mods\' state', () => {
  it('shows each installed plugin\'s hooks module state, and lists every mod with its reason', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, queryFor(WITH_MODS), connectionPublishing(MODS_STATE))
    await screen.findByTestId('installed-plugin-beta')
    const betaState = await screen.findByTestId('plugin-mod-state-beta')
    expect(betaState.getAttribute('data-mod-state')).toBe('loaded')
    // Loaded is the quiet secondary status — a dot and the count, no badge.
    expect(betaState.textContent).toBe('Active in 2 session(s)')
    // The refused one is not an installed row: it is in the mods list, with why.
    const typed = await screen.findByTestId('mod-row-typed')
    expect(typed.textContent).toContain('Refused')
    expect(typed.textContent).toContain('only .js and .mjs hooks modules load yet')
    expect(typed.textContent).toContain('/plugins/typed/hooks/register.ts')
  })

  it('shows nothing about mods without the capability or a connection', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, queryFor(FULL), connectionPublishing(MODS_STATE))
    await screen.findByTestId('installed-plugin-beta')
    expect(screen.queryByTestId('plugin-mod-state-beta')).toBeNull()
    expect(screen.queryByTestId('mod-row-typed')).toBeNull()
  })

  it('summarizeModsByPlugin folds the sessions per plugin, worst state first', () => {
    const summaries = summarizeModsByPlugin(MODS_STATE)
    expect(summaries.map(s => [s.plugin, s.worst, s.loadedSessions])).toEqual([
      ['beta', 'loaded', 2],
      ['typed', 'refused', 0],
    ])
    expect(summaries[1]!.reason).toBe('only .js and .mjs hooks modules load yet')
    expect(summarizeModsByPlugin(null)).toEqual([])
    const mixed = summarizeModsByPlugin({
      sessions: [
        { sessionId: 'a', mods: [{ plugin: 'p', path: '/x', state: 'loaded' }] },
        { sessionId: 'b', mods: [{ plugin: 'p', path: '/x', state: 'dead', reason: 'restarted 3 times' }] },
      ],
    })
    expect(mixed[0]).toMatchObject({ worst: 'dead', reason: 'restarted 3 times', loadedSessions: 1 })
  })
})

// ── One list: installed plugins and mods (Plugins & Mods) ──

const LOCAL_ROOT = '/home/u/.velloc/plugins/my-mod'

/** `beta` installed with a hooks module, a directory plugin `my-mod`, a mod
 *  whose plugin is a marketplace one the registry does not list, and a
 *  bundled mod. */
const MIXED_STATE: ModsStatePayload = {
  sessions: [
    {
      sessionId: 's1',
      mods: [
        {
          plugin: 'beta',
          path: '/plugins/beta/hooks/register.js',
          state: 'loaded',
          provenance: `beta@${OFFICIAL}`,
          version: '1.0.0',
          description: 'Beta rewrites prompts.',
          events: ['prompt.submit'],
        },
        {
          plugin: 'my-mod',
          path: `${LOCAL_ROOT}/hooks/register.js`,
          state: 'loaded',
          events: ['prompt.submit', 'tool.call'],
          version: '0.1.0',
          description: 'Tags every prompt.',
          provenance: 'my-mod@inline',
          root: LOCAL_ROOT,
          tier: 'user',
        },
        {
          plugin: 'shadowed',
          path: '/cache/team/shadowed/hooks/register.js',
          state: 'loaded',
          provenance: 'shadowed@team-marketplace',
          root: '/cache/team/shadowed',
          tier: 'user',
        },
        {
          plugin: 'velloc-core',
          path: 'builtin:velloc-core/register.js',
          state: 'loaded',
          provenance: 'velloc-core@builtin',
          root: 'builtin:velloc-core',
          tier: 'builtin',
          version: '1.0.0',
          description: 'The core mod, bundled with the product.',
        },
      ],
    },
  ],
}

const WITH_MODS_AND_REMOVE: CapabilityAdvert[] = [
  { cap: 'plugins', acts: [...PLUGIN_ACTS, 'removeLocal'] },
  { cap: 'mods', acts: ['list'] },
]

describe('PluginsSection — installed plugins and mods are one list', () => {
  it('lists every mod under the one Installed header, with no separate mods section', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, queryFor(WITH_MODS_AND_REMOVE), connectionPublishing(MIXED_STATE))
    const local = await screen.findByTestId('mod-row-my-mod')
    expect(screen.getByText('Plugins & Mods')).toBeTruthy()
    expect(screen.getByText('Installed plugins & mods')).toBeTruthy()
    expect(screen.queryByText('Hooks modules (mods)')).toBeNull()
    // The installed plugin's mod is on its own row — not listed twice.
    expect(screen.getByTestId('plugin-mod-state-beta')).toBeTruthy()
    expect(screen.queryByTestId('mod-row-beta')).toBeNull()
    // A person's own mods first, the bundled one last.
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="installed-plugin-"], [data-testid^="mod-row-"]:not([data-testid^="mod-row-state-"])',
      ),
    ].map(el => el.dataset.testid)
    expect(rows).toEqual([
      'installed-plugin-beta',
      'mod-row-my-mod',
      'mod-row-shadowed',
      'mod-row-velloc-core',
    ])
    // A directory plugin's row: version, Mod + Local, description, folder, hooks.
    expect(screen.getByTestId('mod-version-my-mod').textContent).toBe('v0.1.0')
    expect(local.textContent).toContain('Mod')
    expect(local.textContent).toContain('Local')
    expect(local.textContent).toContain('Tags every prompt.')
    expect(screen.getByTestId('mod-source-my-mod').textContent).toBe(LOCAL_ROOT)
    expect(screen.getByTestId('mod-hooks-my-mod').textContent).toBe('Hooks: prompt.submit · tool.call')
    // A bundled mod sits under the Built-in heading, which carries no hint.
    const builtin = screen.getByTestId('plugins-group-builtin')
    expect(builtin.contains(screen.getByTestId('mod-row-velloc-core'))).toBe(true)
    expect(builtin.textContent).not.toContain('Ships with')
  })

  it('uninstalls a directory plugin by deleting its folder, after a modal that names it', async () => {
    const { bridge, calls, requests } = makeBridge()
    renderPlugins(bridge, queryFor(WITH_MODS_AND_REMOVE), connectionPublishing(MIXED_STATE))
    fireEvent.click(await screen.findByTestId('mod-menu-my-mod'))
    fireEvent.click(await screen.findByTestId('mod-uninstall-my-mod'))
    await screen.findByText(`This deletes the folder ${LOCAL_ROOT} and everything in it. Open sessions reload without it.`)
    fireEvent.click(screen.getByTestId('confirm-uninstall'))
    await screen.findByText('Plugin uninstalled')
    expect(requests).toContainEqual({ route: 'plugins.removeLocal', payload: { path: LOCAL_ROOT } })
    expect(calls).not.toContain('plugins.uninstall')
  })

  it('uninstalls a marketplace mod with no registry row by its identifier', async () => {
    const { bridge, requests } = makeBridge()
    renderPlugins(bridge, queryFor(WITH_MODS_AND_REMOVE), connectionPublishing(MIXED_STATE))
    fireEvent.click(await screen.findByTestId('mod-menu-shadowed'))
    fireEvent.click(await screen.findByTestId('mod-uninstall-shadowed'))
    fireEvent.click(await screen.findByTestId('confirm-uninstall'))
    await screen.findByText('Plugin uninstalled')
    expect(requests).toContainEqual({
      route: 'plugins.uninstall',
      payload: { identifier: 'shadowed@team-marketplace' },
    })
  })

  it('offers no uninstall for a bundled mod, nor for a folder without removeLocal', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, queryFor(WITH_MODS), connectionPublishing(MIXED_STATE))
    await screen.findByTestId('mod-row-velloc-core')
    // No action left → no overflow menu at all.
    expect(screen.queryByTestId('mod-menu-velloc-core')).toBeNull()
    // `uninstall` alone: the marketplace one keeps its action, the folder not.
    expect(screen.queryByTestId('mod-menu-my-mod')).toBeNull()
    fireEvent.click(screen.getByTestId('mod-menu-shadowed'))
    expect(await screen.findByTestId('mod-uninstall-shadowed')).toBeTruthy()
  })

  it('names an installed mod a mod, with its description, before any session has loaded it', async () => {
    // Just installed: no session state for it yet — what its files say
    // (`isMod`, `description`) carries the card until a session loads it.
    const { bridge } = makeBridge([
      { ...installedEntry('queue'), isMod: true, description: 'Holds a prompt until the turn ends.' },
      { ...installedEntry('beta'), description: 'Plain plugin.' },
    ])
    renderPlugins(bridge)
    const queue = await screen.findByTestId('installed-plugin-queue')
    // The marketplace on its own line; Mod is a chip on the name's line.
    expect(queue.textContent).toContain('Claude Plugins Official')
    expect(queue.textContent).not.toContain('· Mod')
    expect(screen.getByTestId('mod-badge-queue').textContent).toBe('Mod')
    expect(screen.getByTestId('plugin-description-queue').textContent).toBe(
      'Holds a prompt until the turn ends.',
    )
    // Not a mod: the source line names the marketplace alone.
    expect(screen.queryByTestId('mod-badge-beta')).toBeNull()
    expect(screen.getByTestId('plugin-description-beta').textContent).toBe('Plain plugin.')
  })

  // A built-in ships with the product: it is never offered for uninstall,
  // even from a runtime that names no tier (which reads as `user`) — the
  // `@builtin` provenance alone decides.
  it('offers no uninstall for a built-in whose row names no tier', async () => {
    const { bridge } = makeBridge()
    const untiered: ModsStatePayload = {
      sessions: [
        {
          sessionId: 's1',
          mods: [
            {
              plugin: 'agents-md',
              path: 'builtin:agents-md/hooks/register.js',
              state: 'loaded',
              provenance: 'agents-md@builtin',
              root: 'builtin:agents-md',
            },
          ],
        },
      ],
    }
    renderPlugins(bridge, queryFor(WITH_MODS_AND_REMOVE), connectionPublishing(untiered))
    const row = await screen.findByTestId('mod-row-agents-md')
    expect(screen.getByTestId('plugins-group-builtin').contains(row)).toBe(true)
    expect(screen.queryByTestId('mod-menu-agents-md')).toBeNull()
    expect(screen.queryByTestId('mod-uninstall-agents-md')).toBeNull()
  })

  it('puts what a mod does above its hooks, for an installed plugin and a bundled mod alike', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, queryFor(WITH_MODS), connectionPublishing(MIXED_STATE))
    const core = await screen.findByTestId('mod-row-velloc-core')
    const coreDescription = screen.getByTestId('plugin-description-velloc-core')
    expect(coreDescription.textContent).toBe('The core mod, bundled with the product.')
    // At most two lines, the full text on hover.
    expect(coreDescription.className).toContain('line-clamp-2')
    expect(coreDescription.getAttribute('title')).toBe('The core mod, bundled with the product.')
    // Its group says Built-in; the card carries only the Mod chip.
    expect(core.textContent).not.toContain('Built-in')
    expect(screen.getByTestId('mod-badge-velloc-core').textContent).toBe('Mod')
    expect(screen.getByTestId('plugin-description-beta').textContent).toBe('Beta rewrites prompts.')
    // The description precedes the hooks line — the decision first, the
    // developer metadata last.
    const description = screen.getByTestId('plugin-description-my-mod')
    const hooks = screen.getByTestId('mod-hooks-my-mod')
    expect(description.compareDocumentPosition(hooks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('names a mod that did not load in the card body, with its reason', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, queryFor(WITH_MODS), connectionPublishing(MODS_STATE))
    const state = await screen.findByTestId('mod-row-state-typed')
    expect(state.getAttribute('data-mod-state')).toBe('refused')
    expect(state.textContent).toBe('Refusedonly .js and .mjs hooks modules load yet')
  })

  it('puts the toggle on the name\'s line and the session count between description and hooks', async () => {
    const { bridge } = makeBridge()
    renderPlugins(bridge, queryFor(WITH_MODS), connectionPublishing(MIXED_STATE))
    await screen.findByTestId('installed-plugin-beta')
    // The state word is plain: the Mod chip already says what it is.
    expect(screen.getByTestId('plugin-state-beta').textContent).toBe('Enabled')
    // One header line: name, chips, then the state word and the switch.
    const badge = screen.getByTestId('mod-badge-beta')
    const toggle = screen.getByTestId('plugin-toggle-beta')
    expect(badge.parentElement?.parentElement).toBe(toggle.parentElement?.parentElement)
    // No divided-off right column.
    expect(screen.getByTestId('installed-plugin-beta').innerHTML).not.toContain('border-l')
    // The loaded count sits below the description, above the hooks.
    const description = screen.getByTestId('plugin-description-beta')
    const state = screen.getByTestId('plugin-mod-state-beta')
    const hooks = screen.getByTestId('mod-hooks-beta')
    expect(description.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(state.compareDocumentPosition(hooks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('folds a long hooks list into +N, keeping the line a glance', async () => {
    const { bridge } = makeBridge()
    const busy: ModsStatePayload = {
      sessions: [
        {
          sessionId: 's1',
          mods: [
            {
              plugin: 'busy',
              path: '/cache/team/busy/hooks/register.js',
              state: 'loaded',
              provenance: 'busy@team-marketplace',
              events: ['session.start', 'turn.complete', 'tool.call', 'prompt.submit', 'session.end', 'message.receive'],
            },
          ],
        },
      ],
    }
    renderPlugins(bridge, queryFor(WITH_MODS), connectionPublishing(busy))
    await screen.findByTestId('mod-row-busy')
    // The first four are named; the rest fold into +N.
    expect(screen.getByTestId('mod-hooks-busy').textContent).toBe(
      'Hooks: session.start · turn.complete · tool.call · prompt.submit · +2',
    )
  })

  it('summarizeModsByPlugin carries who the plugin is and every hooked event once', () => {
    const [, local] = summarizeModsByPlugin({
      sessions: [
        ...MIXED_STATE.sessions,
        {
          sessionId: 's2',
          mods: [{ plugin: 'my-mod', path: `${LOCAL_ROOT}/hooks/register.js`, state: 'loaded', events: ['tool.call', 'turn.complete'] }],
        },
      ],
    })
    expect(local).toMatchObject({
      plugin: 'my-mod',
      version: '0.1.0',
      description: 'Tags every prompt.',
      provenance: 'my-mod@inline',
      root: LOCAL_ROOT,
      tier: 'user',
      events: ['prompt.submit', 'tool.call', 'turn.complete'],
      loadedSessions: 2,
    })
  })
})

// ── userConfig options (F-25) ──

describe('PluginsSection — a mod\'s userConfig options', () => {
  const WITH_OPTIONS: ModsStatePayload = {
    sessions: [
      {
        sessionId: 's1',
        mods: [
          {
            plugin: 'cfg',
            path: '/plugins/cfg/hooks/register.js',
            state: 'loaded',
            generation: 1,
            provenance: 'cfg@market',
            config: {
              fields: {
                greeting: { type: 'string', title: 'Greeting', default: 'hi', options: ['hi', 'yo'], description: 'How to greet' },
                limit: { type: 'number', title: 'Limit', description: 'At most', default: 3, min: 1, max: 10 },
                loud: { type: 'boolean', title: 'Loud', description: 'Shout' },
                token: { type: 'string', title: 'API token', description: 'Secret', sensitive: true, required: true },
              },
              values: { greeting: 'yo', limit: 3, token: '••••' },
            },
          },
        ],
      },
    ],
  }

  function connectionWithRequests(payload: ModsStatePayload) {
    const requests: Array<{ route: string; payload: unknown }> = []
    const conn = {
      subscribe: (topic: string, listener: (event: { payload: unknown }) => void) => {
        if (topic === MODS_STATE_TOPIC) queueMicrotask(() => listener({ payload, form: 'snapshot' } as never))
        return () => {}
      },
      request: async (route: string, body: unknown) => {
        requests.push({ route, payload: body })
        return {}
      },
    } as unknown as RuntimeConnection
    return { connection: () => Promise.resolve(conn), requests }
  }

  it('draws a form from the fields, with the stored values and a masked secret; Save writes mods.setOptions', async () => {
    const { bridge } = makeBridge()
    const { connection, requests } = connectionWithRequests(WITH_OPTIONS)
    renderPlugins(bridge, queryFor([...FULL, { cap: 'mods', acts: ['list', 'setOptions'] }]), connection)
    const form = await screen.findByTestId('mod-options-cfg')
    // Each field is labelled with its title, its description beneath.
    expect(form.textContent).toContain('Greeting')
    expect(form.textContent).toContain('How to greet')
    expect(form.textContent).toContain('API token')
    // The form says whose settings these are, so a business `Enabled` field
    // reads as the mod's own config, not the lifecycle toggle.
    expect(form.textContent).toContain("This mod's own settings")
    const greeting = screen.getByTestId('mod-option-cfg-greeting') as HTMLSelectElement
    expect(greeting.value).toBe('yo')
    // A picker is as wide as its choices, never stretched across the row.
    expect(greeting.className).toContain('max-w-[14rem]')
    expect(greeting.className).not.toContain('w-full')
    const limit = screen.getByTestId('mod-option-cfg-limit') as HTMLInputElement
    expect(limit.value).toBe('3')
    // A numeric field is a short right-aligned figure, not a row-wide box.
    expect(limit.className).toContain('w-24')
    expect(limit.className).toContain('text-right')
    // Each field is one row: the words left, the control right.
    expect(screen.getByTestId('mod-option-cfg-limit-row').className).toContain('justify-between')
    const token = screen.getByTestId('mod-option-cfg-token') as HTMLInputElement
    expect(token.getAttribute('type')).toBe('password')
    expect(token.value).toBe('')
    // Nothing to write yet: Save is inert until a field changes.
    const saveButton = screen.getByTestId('mod-options-save-cfg') as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
    fireEvent.change(greeting, { target: { value: 'hi' } })
    fireEvent.change(limit, { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('mod-option-cfg-loud'))
    expect(saveButton.disabled).toBe(false)
    // Save sits at the right end of the form, its outcome just before it.
    const actions = screen.getByTestId('mod-options-actions-cfg')
    expect(actions.className).toContain('justify-end')
    expect(actions.lastElementChild).toBe(screen.getByTestId('mod-options-save-cfg'))
    // The button says only what it does: Save.
    expect(saveButton.textContent).toBe('Save')
    fireEvent.click(screen.getByTestId('mod-options-save-cfg'))
    // The outcome is a short tip naming the mod, not a line in the form.
    const tip = await screen.findByTestId('mod-options-saved-tip-cfg')
    expect(tip.textContent).toMatch(/^Saved\. cfg /)
    // A screen reader hears it from the form's live region, mounted all along.
    const announce = screen.getByTestId('mod-options-announce-cfg')
    expect(announce.getAttribute('role')).toBe('status')
    expect(announce.textContent).toBe(tip.textContent)
    expect(screen.getByTestId('mod-options-status-cfg').textContent).toBe('')
    // What is stored is now the draft: Save is inert again until the next edit.
    expect((screen.getByTestId('mod-options-save-cfg') as HTMLButtonElement).disabled).toBe(true)
    // The kept secret is named, never sent: the form holds only its mask,
    // and the hub carries the stored value over. Stored under the plugin id.
    expect(requests).toEqual([
      { route: 'mods.setOptions', payload: { plugin: 'cfg@market', options: { greeting: 'hi', limit: 7, loud: true }, keep: ['token'] } },
    ])
  })

  it("a number outside the field's min / max is refused by its title, and nothing is sent", async () => {
    const { bridge } = makeBridge()
    const { connection, requests } = connectionWithRequests(WITH_OPTIONS)
    renderPlugins(bridge, queryFor([...FULL, { cap: 'mods', acts: ['list', 'setOptions'] }]), connection)
    await screen.findByTestId('mod-options-cfg')
    const limit = screen.getByTestId('mod-option-cfg-limit') as HTMLInputElement
    expect(limit.getAttribute('min')).toBe('1')
    expect(limit.getAttribute('max')).toBe('10')
    fireEvent.change(limit, { target: { value: '11' } })
    fireEvent.click(screen.getByTestId('mod-options-save-cfg'))
    await waitFor(() => expect(screen.getByTestId('mod-options-status-cfg').textContent).toContain('Not a number within its bounds: Limit'))
    expect(requests).toEqual([])
  })

  it('without mods.setOptions the form is read-only, with no Save', async () => {
    const { bridge } = makeBridge()
    const { connection, requests } = connectionWithRequests(WITH_OPTIONS)
    renderPlugins(bridge, queryFor(WITH_MODS), connection)
    await screen.findByTestId('mod-options-cfg')
    expect(screen.queryByTestId('mod-options-save-cfg')).toBeNull()
    expect((screen.getByTestId('mod-option-cfg-limit') as HTMLInputElement).disabled).toBe(true)
    expect(requests).toEqual([])
  })
})

// ── A mod's icon above the prompt jumps here (F-25) ──

describe('PluginsSection — revealPluginRequest scrolls to a plugin and flashes it', () => {
  function renderRevealing(request: { plugin: string; seq: number } | null) {
    const { bridge } = makeBridge()
    const connection = connectionPublishing(MODS_STATE)
    const tree = (req: typeof request) =>
      createElement(
        RuntimeCapabilitiesContext.Provider,
        { value: queryFor(WITH_MODS) },
        createElement(
          SettingsBridgeContext.Provider,
          { value: bridge },
          createElement(PluginsSection, { runtimeConnection: connection, revealPluginRequest: req }),
        ),
      )
    const view = render(tree(request))
    return { rerender: (req: typeof request) => view.rerender(tree(req)) }
  }

  it('waits for the row (the mods list lands late), scrolls to it, flashes it three times, and clears on animation end', async () => {
    const scrolled: string[] = []
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset.testid ?? '')
    }
    try {
      const { rerender } = renderRevealing({ plugin: 'typed', seq: 1 })
      const row = await screen.findByTestId('mod-row-typed')
      await vi.waitFor(() => expect(row.getAttribute('data-flashing')).toBe('true'))
      expect(row.classList).toContain('nexus-plugin-flash')
      expect(scrolled).toEqual(['mod-row-typed'])
      // Only the named row flashes.
      expect(screen.getByTestId('installed-plugin-beta').getAttribute('data-flashing')).toBeNull()
      fireEvent.animationEnd(row)
      await vi.waitFor(() => expect(row.getAttribute('data-flashing')).toBeNull())
      // The same request again is not replayed…
      rerender({ plugin: 'typed', seq: 1 })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(row.getAttribute('data-flashing')).toBeNull()
      // …a new click (next seq) on an installed plugin's row lands.
      rerender({ plugin: 'beta', seq: 2 })
      const beta = screen.getByTestId('installed-plugin-beta')
      await vi.waitFor(() => expect(beta.getAttribute('data-flashing')).toBe('true'))
      expect(beta.classList).toContain('nexus-plugin-flash')
      expect(scrolled).toEqual(['mod-row-typed', 'installed-plugin-beta'])
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })
})

// A directory plugin (a folder in `.velloc/plugins/`, not in the install
// registry) had no switch at all: only an installed plugin's row drew one,
// and a switched-off one vanished — its rows came from the sessions' state
// alone. `plugins/listLocal` now reads them off the disk, on or off, and the
// installed list is grouped by where a plugin takes effect.
describe('PluginsSection — installed plugins grouped by where they take effect', () => {
  const PROJECT = '/work/velloc'
  const IDLE = `${PROJECT}/.velloc/plugins/compact-on-idle`
  /** A session's project that is not in the sidebar: only its mods state names it. */
  const OTHER_ROOT = '/work/other/.velloc/plugins/other-mod'

  const WITH_LOCAL: CapabilityAdvert[] = [
    { cap: 'plugins', acts: [...PLUGIN_ACTS, 'removeLocal', 'setLocalEnabled', 'listLocal'] },
    { cap: 'mods', acts: ['list'] },
  ]

  const STATE: ModsStatePayload = {
    sessions: [
      ...MIXED_STATE.sessions,
      {
        sessionId: 's2',
        mods: [
          {
            plugin: 'other-mod',
            path: `${OTHER_ROOT}/hooks/register.js`,
            state: 'loaded',
            provenance: 'other-mod@inline',
            root: OTHER_ROOT,
            tier: 'user',
          },
        ],
      },
    ],
  }

  /** The user root holds `my-mod` (on); the `velloc` project holds the
   *  folder `compact-on-idle/` whose manifest names `idle-compact` (off);
   *  `/work/empty` holds nothing. A `setLocalEnabled` flips the folder, as
   *  the disk would, so the re-list after it reads the new state. */
  function localListing() {
    const enabled: Record<string, boolean> = { [LOCAL_ROOT]: true, [IDLE]: false }
    return {
      'plugins.listLocal': () => ({
        roots: [
          {
            plugins: [
              { folder: 'my-mod', path: LOCAL_ROOT, name: 'my-mod', version: '0.1.0', isMod: true, enabled: enabled[LOCAL_ROOT] },
            ],
          },
          {
            project: PROJECT,
            plugins: [
              {
                folder: 'compact-on-idle',
                path: IDLE,
                name: 'idle-compact',
                description: 'Compacts an idle session.',
                isMod: true,
                enabled: enabled[IDLE],
              },
            ],
          },
          { project: '/work/empty', plugins: [] },
        ],
      }),
      'plugins.setLocalEnabled': (payload: unknown) => {
        const { path, enabled: next } = payload as { path: string; enabled: boolean }
        enabled[path] = next
        return { ok: true, name: path.split('/').pop() }
      },
    }
  }

  const groupOf = (testId: string) => screen.getByTestId(testId).closest('[data-testid^="plugins-group-"]')

  // A folder copied into the plugins folder while the page is open: the page
  // lists the folders again when the window comes back, and names the plugins
  // nobody has switched on or off yet.
  it('names the never-switched folder plugins, rescanning when the window regains focus', async () => {
    let dropped = false
    const { bridge, requests } = makeBridge([installedEntry('beta')], {
      'plugins.listLocal': () => ({
        roots: [
          {
            plugins: [
              { folder: 'my-mod', path: LOCAL_ROOT, name: 'my-mod', isMod: true, enabled: true, isNew: false },
              ...(dropped
                ? [{ folder: 'opencode', path: `${LOCAL_ROOT}-opencode`, name: 'opencode', isMod: false, enabled: false, isNew: true }]
                : []),
            ],
          },
        ],
      }),
    })
    renderPlugins(bridge, queryFor(WITH_LOCAL), connectionPublishing(STATE))
    await screen.findByTestId('mod-row-my-mod')
    expect(screen.queryByTestId('plugins-new-local')).toBeNull()

    dropped = true
    const listed = requests.filter((r) => r.route === 'plugins.listLocal').length
    fireEvent.focus(window)
    const notice = await screen.findByTestId('plugins-new-local')
    expect(notice.textContent).toBe('New plugins found: opencode. They stay off until you turn them on below.')
    expect(requests.filter((r) => r.route === 'plugins.listLocal').length).toBe(listed + 1)
  })

  it('Global, then each project by name with its folder, then built-in — an empty project shows no group', async () => {
    const { bridge } = makeBridge([installedEntry('beta')], localListing())
    renderPlugins(bridge, queryFor(WITH_LOCAL), connectionPublishing(STATE))
    await screen.findByTestId('mod-row-idle-compact')
    await screen.findByTestId('mod-row-other-mod')

    const groups = screen.getAllByTestId(/^plugins-group-/)
    expect(groups.map((g) => [g.getAttribute('data-testid'), g.getAttribute('data-project')])).toEqual([
      ['plugins-group-global', null],
      ['plugins-group-project', PROJECT],
      ['plugins-group-project', '/work/other'],
      ['plugins-group-builtin', null],
    ])
    const [global, project, other, builtin] = groups
    expect(global.textContent).toContain('Global')
    expect(global.textContent).toContain('~/.velloc/plugins')
    expect(global.textContent).toContain('Every session')
    expect(project.textContent).toContain('velloc')
    expect(project.textContent).toContain(PROJECT)
    expect(project.textContent).toContain('Only sessions in this workspace')

    expect(groupOf('installed-plugin-beta')).toBe(global)
    expect(groupOf('mod-row-my-mod')).toBe(global)
    expect(groupOf('mod-row-shadowed')).toBe(global)
    expect(groupOf('mod-row-idle-compact')).toBe(project)
    expect(groupOf('mod-row-other-mod')).toBe(other)
    expect(groupOf('mod-row-velloc-core')).toBe(builtin)
  })

  it('a switched-off folder keeps its card and switch, with no stale mod state; the switch writes its folder', async () => {
    const { bridge, requests } = makeBridge([installedEntry('beta')], localListing())
    renderPlugins(bridge, queryFor(WITH_LOCAL), connectionPublishing(STATE))

    const row = await screen.findByTestId('mod-row-idle-compact')
    expect(row.getAttribute('data-enabled')).toBe('false')
    expect(screen.getByTestId('mod-enabled-idle-compact').textContent).toBe('Disabled')
    expect(screen.getByTestId('mod-source-idle-compact').textContent).toBe(IDLE)
    expect(screen.getByTestId('mod-toggle-idle-compact').getAttribute('aria-checked')).toBe('false')
    // The enabled one shows its sessions' state; the listing claims the mod's row.
    expect(screen.getByTestId('mod-toggle-my-mod').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('mod-hooks-my-mod')).toBeTruthy()
    expect(screen.getAllByTestId('mod-row-my-mod')).toHaveLength(1)

    const listed = requests.filter((r) => r.route === 'plugins.listLocal').length
    fireEvent.click(screen.getByTestId('mod-toggle-idle-compact'))
    await screen.findByText('Plugin enabled')
    expect(requests).toContainEqual({ route: 'plugins.setLocalEnabled', payload: { path: IDLE, enabled: true } })
    await waitFor(() =>
      expect(screen.getByTestId('mod-toggle-idle-compact').getAttribute('aria-checked')).toBe('true'),
    )
    expect(requests.filter((r) => r.route === 'plugins.listLocal').length).toBeGreaterThan(listed)
    expect(screen.getByTestId('mod-enabled-idle-compact').textContent).toBe('Enabled')

    fireEvent.click(screen.getByTestId('mod-toggle-my-mod'))
    await screen.findByText('Plugin disabled')
    expect(requests).toContainEqual({ route: 'plugins.setLocalEnabled', payload: { path: LOCAL_ROOT, enabled: false } })
    await waitFor(() => expect(screen.getByTestId('mod-row-my-mod').getAttribute('data-enabled')).toBe('false'))
    // Off: the sessions' `loaded` is no longer this card's to show.
    expect(screen.queryByTestId('mod-hooks-my-mod')).toBeNull()
  })

  it('no switch without setLocalEnabled', async () => {
    const { bridge } = makeBridge([installedEntry('beta')], localListing())
    renderPlugins(
      bridge,
      queryFor([{ cap: 'plugins', acts: [...PLUGIN_ACTS, 'listLocal'] }, { cap: 'mods', acts: ['list'] }]),
      connectionPublishing(STATE),
    )
    await screen.findByTestId('mod-row-idle-compact')
    expect(screen.getByTestId('mod-enabled-idle-compact').textContent).toBe('Disabled')
    expect(screen.queryByTestId('mod-toggle-idle-compact')).toBeNull()
    expect(screen.queryByTestId('mod-toggle-my-mod')).toBeNull()
  })

  it('a listing that fails leaves the page: mods from the sessions\' state, in Global and Built-in', async () => {
    const { bridge } = makeBridge([installedEntry('beta')], {
      'plugins.listLocal': () => {
        throw new Error('boom')
      },
    })
    renderPlugins(bridge, queryFor(WITH_LOCAL), connectionPublishing(MIXED_STATE))
    await screen.findByTestId('mod-row-my-mod')
    expect(groupOf('mod-row-my-mod')).toBe(screen.getByTestId('plugins-group-global'))
    expect(groupOf('mod-row-velloc-core')).toBe(screen.getByTestId('plugins-group-builtin'))
    expect(screen.queryByTestId('plugins-group-project')).toBeNull()
  })

  it('nothing anywhere keeps the one empty state, with no group headings', async () => {
    const { bridge } = makeBridge([], {
      'plugins.listLocal': () => ({ roots: [{ plugins: [] }, { project: PROJECT, plugins: [] }] }),
    })
    renderPlugins(bridge, queryFor(WITH_LOCAL))
    expect(await screen.findByText('No plugins or mods installed')).toBeTruthy()
    expect(screen.queryAllByTestId(/^plugins-group-/)).toHaveLength(0)
  })
})

describe('PluginsSection — a built-in mod has a switch over its default', () => {
  const groupOf = (testId: string) => screen.getByTestId(testId).closest('[data-testid^="plugins-group-"]')

  it('lists a built-in that is off (loaded nowhere) with its switch; turning it on writes <name>@builtin', async () => {
    let diffEnabled = false
    const { bridge, requests } = makeBridge([installedEntry('beta')], {
      'plugins.listBuiltin': () => ({
        mods: [{
          name: 'diff',
          identifier: 'diff@builtin',
          version: '0.1.0',
          description: 'The diff pane as a plugin.',
          enabled: diffEnabled,
          enabledSource: diffEnabled ? 'explicit' : 'default',
          onByDefault: false,
        }],
      }),
      'plugins.setEnabled': (payload) => {
        diffEnabled = (payload as { enabled: boolean }).enabled
        return { ok: true, effectiveEnabled: diffEnabled }
      },
    })
    renderPlugins(bridge, queryFor([{ cap: 'plugins', acts: [...PLUGIN_ACTS, 'listBuiltin'] }]))
    const row = await screen.findByTestId('mod-row-diff')
    expect(groupOf('mod-row-diff')).toBe(screen.getByTestId('plugins-group-builtin'))
    expect(row.getAttribute('data-enabled-source')).toBe('default')
    expect(screen.getByTestId('mod-enabled-diff').textContent).toBe('Disabled')
    expect(screen.getByTestId('mod-toggle-diff').getAttribute('aria-checked')).toBe('false')
    // Bundled: nothing to uninstall.
    expect(screen.queryByTestId('mod-menu-diff')).toBeNull()

    fireEvent.click(screen.getByTestId('mod-toggle-diff'))
    await screen.findByText('Plugin enabled')
    expect(requests).toContainEqual({ route: 'plugins.setEnabled', payload: { identifier: 'diff@builtin', enabled: true } })
    await waitFor(() => expect(screen.getByTestId('mod-toggle-diff').getAttribute('aria-checked')).toBe('true'))
    expect(screen.getByTestId('mod-row-diff').getAttribute('data-enabled-source')).toBe('explicit')
  })

  it('no switch without setEnabled', async () => {
    const { bridge } = makeBridge([installedEntry('beta')], {
      'plugins.listBuiltin': () => ({
        mods: [{ name: 'diff', identifier: 'diff@builtin', enabled: false, enabledSource: 'default', onByDefault: false }],
      }),
    })
    renderPlugins(bridge, queryFor([{ cap: 'plugins', acts: ['listInstalled', 'listMarketplaces', 'listBuiltin'] }]))
    await screen.findByTestId('mod-row-diff')
    expect(screen.queryByTestId('mod-toggle-diff')).toBeNull()
  })
})

describe('PluginsSection — browsing a large marketplace listing', () => {
  /** The official marketplace lists 25 plugins: p00 … p24, one of them a shopping plugin. */
  function largeListing() {
    const plugins = Array.from({ length: 25 }, (_, i) => {
      const name = i === 10 ? 'p10-shopping' : `p${String(i).padStart(2, '0')}`
      return { name, description: `Plugin ${i}.`, source: `./${name}`, installed: false }
    })
    return makeBridge([], {
      'plugins.listMarketplacePlugins': (payload) => {
        const { marketplace } = payload as { marketplace: string }
        if (marketplace !== OFFICIAL) return { marketplace, manifest: null }
        return { marketplace, manifest: { name: OFFICIAL, plugins } }
      },
    })
  }
  const cards = () => screen.queryAllByTestId(/^marketplace-plugin-card-/)

  it('pages 20 at a time, collapses and expands, filters by name and clears the filter', async () => {
    const { bridge } = largeListing()
    renderPlugins(bridge)
    await screen.findByText(/^25\s+plugins$/)
    fireEvent.click(screen.getByTestId(`mp-toggle-${OFFICIAL}`))
    await screen.findByTestId('marketplace-plugin-card-p00')
    expect(cards()).toHaveLength(20)

    fireEvent.click(screen.getByTestId(`plugin-page-next-${OFFICIAL}`))
    await waitFor(() => expect(cards()).toHaveLength(5))
    fireEvent.click(screen.getByTestId(`plugin-page-prev-${OFFICIAL}`))
    await waitFor(() => expect(cards()).toHaveLength(20))

    fireEvent.click(screen.getByTestId(`mp-toggle-${OFFICIAL}`))
    await waitFor(() => expect(cards()).toHaveLength(0))
    fireEvent.click(screen.getByTestId(`mp-toggle-${OFFICIAL}`))
    await screen.findByTestId('marketplace-plugin-card-p00')

    const search = screen.getByTestId(`plugin-search-input-${OFFICIAL}`)
    fireEvent.change(search, { target: { value: 'shopping' } })
    await waitFor(() => expect(cards().map(c => c.getAttribute('data-testid'))).toEqual([
      'marketplace-plugin-card-p10-shopping',
    ]))

    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() => expect(cards()).toHaveLength(20))

    fireEvent.change(search, { target: { value: 'zzznoplugin' } })
    await waitFor(() => expect(cards()).toHaveLength(0))
  })
})
