import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadLocalCatalogIfRequested,
  loadLocalTypeFilesOrFallBack,
  nextLocalTemplateRequestId,
  LOCAL_TEMPLATE_ROOT,
} from '../browser/boot/loadLocalTemplates'
import {
  getLauncherCatalog,
  getTemplate,
  hasTemplate,
  __resetLocalOverlayForTest,
  __setTemplateChannelForTest,
} from '../prompting/templateRegistry'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'

// A fake bridge transport whose `request` returns a canned fs.readFile response.
// Only `request` is exercised; cast through `unknown` for the rest of the
// interface. `vi.fn` lets us assert WHETHER a request was issued (the invariant).
function fakeTransport(
  onRequest: (payload: { path: string }) => { ok: boolean; result?: Uint8Array },
) {
  const request = vi.fn(async (req: { payload: { path: string } }) =>
    onRequest(req.payload),
  )
  return { transport: { request } as unknown as BrowserBridgeTransport, request }
}

const utf8 = (s: string) => new TextEncoder().encode(s)

const LOCAL_INDEX = `---
types:
  - type: researcher
    title: Researcher
    icon_lucide: bot
---
`

describe('loadLocalTemplates — gate + launcher-catalog overlay', () => {
  afterEach(() => __resetLocalOverlayForTest())

  it('HARD INVARIANT: without ?template=local, issues NO fs request (purely bundled)', async () => {
    for (const search of ['', '?foo=bar', '?template=', '?template=other', '?template=Local']) {
      const { transport, request } = fakeTransport(() => ({ ok: true }))
      await loadLocalCatalogIfRequested(transport, search)
      expect(request, `search=${search}`).not.toHaveBeenCalled()
    }
    // The catalog is untouched — the bundled types, in index.md order.
    expect(getLauncherCatalog().map(m => m.type)).toEqual([
      'code',
      'agent',
      'chat',
      'safe_code',
    ])
  })

  it('?template=local reads index.md (conventional path) and REPLACES the catalog', async () => {
    const { transport, request } = fakeTransport(p =>
      p.path.endsWith('/index.md') ? { ok: true, result: utf8(LOCAL_INDEX) } : { ok: true },
    )
    await loadLocalCatalogIfRequested(transport, '?template=local')
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { path: `${LOCAL_TEMPLATE_ROOT}/index.md` } }),
    )
    // The bundled catalog is fully REPLACED by the local one.
    expect(getLauncherCatalog().map(m => m.type)).toEqual(['researcher'])
    const meta = getLauncherCatalog()[0]
    expect(meta?.title).toBe('Researcher')
    expect(meta?.iconLucide).toBe('bot')
  })

  it('a local index.md whose YAML does not parse keeps the bundled catalog (boot survives)', async () => {
    // A local catalog is hand-written. Whatever is wrong with it must not
    // escape to `nexusBootAndRender` — the guest would never answer
    // `nexus-init` and the user would get a blank panel.
    const bundled = getLauncherCatalog().map(m => m.type)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { transport } = fakeTransport(p =>
        p.path.endsWith('/index.md')
          ? { ok: true, result: utf8('---\ntypes: [\n  - type: {researcher\n---\n') }
          : { ok: true },
      )
      await expect(
        loadLocalCatalogIfRequested(transport, '?template=local'),
      ).resolves.toBeUndefined()
      expect(getLauncherCatalog().map(m => m.type)).toEqual(bundled)
    } finally {
      warnings.mockRestore()
    }
  })

  describe('on the beta channel', () => {
    const g = globalThis as { location?: { origin?: string; search?: string } }
    let had = false
    let previous: typeof g.location
    const onOrigin = (origin: string) => {
      had = Object.prototype.hasOwnProperty.call(g, 'location')
      previous = g.location
      g.location = { origin, search: '' }
    }
    afterEach(() => {
      if (had) g.location = previous
      else delete g.location
    })

    const BETA_LOCAL_INDEX = LOCAL_INDEX.replace('researcher', 'beta_researcher')

    it('reads the local index-beta.md first', async () => {
      onOrigin('https://beta.velloc.app')
      const { transport, request } = fakeTransport(p =>
        p.path.endsWith('/index-beta.md')
          ? { ok: true, result: utf8(BETA_LOCAL_INDEX) }
          : p.path.endsWith('/index.md')
            ? { ok: true, result: utf8(LOCAL_INDEX) }
            : { ok: true },
      )
      await loadLocalCatalogIfRequested(transport, '?template=local')
      expect(getLauncherCatalog().map(m => m.type)).toEqual(['beta_researcher'])
      expect(request).not.toHaveBeenCalledWith(
        expect.objectContaining({ payload: { path: `${LOCAL_TEMPLATE_ROOT}/index.md` } }),
      )
    })

    it('falls back to the local index.md when the folder has no index-beta.md', async () => {
      onOrigin('https://beta.velloc.app')
      const { transport } = fakeTransport(p =>
        p.path.endsWith('/index.md') ? { ok: true, result: utf8(LOCAL_INDEX) } : { ok: true },
      )
      await loadLocalCatalogIfRequested(transport, '?template=local')
      expect(getLauncherCatalog().map(m => m.type)).toEqual(['researcher'])
    })

    it('never reads index-beta.md on stable', async () => {
      onOrigin('https://app.velloc.app')
      const { transport, request } = fakeTransport(p =>
        p.path.endsWith('/index.md') ? { ok: true, result: utf8(LOCAL_INDEX) } : { ok: true },
      )
      await loadLocalCatalogIfRequested(transport, '?template=local')
      expect(request).not.toHaveBeenCalledWith(
        expect.objectContaining({ payload: { path: `${LOCAL_TEMPLATE_ROOT}/index-beta.md` } }),
      )
      expect(getLauncherCatalog().map(m => m.type)).toEqual(['researcher'])
    })
  })

  it('an absent or empty local index.md keeps the bundled catalog', async () => {
    // ok but no result (file absent) → undefined → no overlay.
    const absent = fakeTransport(() => ({ ok: true }))
    await loadLocalCatalogIfRequested(absent.transport, '?template=local')
    expect(getLauncherCatalog().map(m => m.type)).toEqual([
      'code',
      'agent',
      'chat',
      'safe_code',
    ])

    // Present but EMPTY `types:` list → applyLocalCatalog is a no-op.
    const empty = fakeTransport(p =>
      p.path.endsWith('/index.md')
        ? { ok: true, result: utf8('---\ntypes: []\n---\n') }
        : { ok: true },
    )
    await loadLocalCatalogIfRequested(empty.transport, '?template=local')
    expect(getLauncherCatalog().map(m => m.type)).toEqual([
      'code',
      'agent',
      'chat',
      'safe_code',
    ])
  })
})

describe('bridge request ids', () => {
  it('are unique within one millisecond — concurrent session restores must not collide', async () => {
    // Several sessions restoring at once each lazy-load their local type
    // through the same worker bridge. `local-tmpl-${Date.now()}` gave them all
    // the same id: the worker threw 'Duplicate bridge request id' and the
    // loser degraded to "file absent". Freeze the clock to make the old
    // collision certain.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const ids = new Set<string>()
      for (let i = 0; i < 200; i += 1) ids.add(nextLocalTemplateRequestId('local-tmpl'))
      expect(ids.size).toBe(200)
      for (const id of ids) expect(id).toMatch(/^local-tmpl-/)

      // And through the loaders themselves: every request carries its own id.
      const seen: string[] = []
      const request = vi.fn(async (req: { id: string }) => {
        seen.push(req.id)
        return { ok: true }
      })
      const transport = { request } as unknown as BrowserBridgeTransport
      await Promise.all([
        loadLocalTypeFilesOrFallBack(transport, 'code'),
        loadLocalTypeFilesOrFallBack(transport, 'agent'),
        loadLocalTypeFilesOrFallBack(transport, 'chat'),
      ])
      expect(seen.length).toBeGreaterThan(1)
      expect(new Set(seen).size).toBe(seen.length)
    } finally {
      now.mockRestore()
    }
  })
})

describe('loadLocalTypeFilesOrFallBack — a malformed overlay', () => {
  afterEach(() => __resetLocalOverlayForTest())

  /** A transport serving one local type: `<type>/template.md` plus the given
   *  `includes/` files (readdir + readFile over the fs bridge). */
  function typeTransport(type: string, includes: Record<string, string>) {
    const root = `${LOCAL_TEMPLATE_ROOT}/${type}`
    const manifest = `---\ntype: ${type}\ntools: [read]\n---\n\n## prompt\n!${type}_intro\n\n## begin\n`
    const request = vi.fn(
      async (req: { route: { action?: string; name?: string }; payload: { path: string } }) => {
        const { path } = req.payload
        if (path === `${root}/includes`) {
          return {
            ok: true,
            result: Object.keys(includes).map(name => ({ name, isFile: true })),
          }
        }
        if (path === `${root}/template.md`) return { ok: true, result: utf8(manifest) }
        const name = path.startsWith(`${root}/includes/`)
          ? path.slice(`${root}/includes/`.length)
          : undefined
        if (name !== undefined && name in includes) {
          return { ok: true, result: utf8(includes[name]!) }
        }
        return { ok: true }
      },
    )
    return { transport: { request } as unknown as BrowserBridgeTransport, request }
  }

  it('a BUNDLED type falls back to its bundled definition (the session runs)', async () => {
    const bundledCodeTools = getTemplate('code')!.config.tools
    const { transport } = typeTransport('code', {
      'code_intro.md': 'local intro',
      // `-v2` is not a variant suffix → parseHolderFilename throws → the
      // whole overlay is rejected (registerLocalType mutates nothing).
      'code_intro-v2.md': 'stale copy',
    })
    await expect(loadLocalTypeFilesOrFallBack(transport, 'code')).resolves.toBeUndefined()
    // Bundled definition intact: the overlay's `tools: [read]` never landed.
    expect(getTemplate('code')!.config.tools).toEqual(bundledCodeTools)
  })

  it('a LOCAL-ONLY type has nothing to fall back to — the load fails loudly', async () => {
    // Running anyway would hand the session an `undefined` template config:
    // `applyTemplateToolAllowlist(items, undefined)` returns EVERY tool and
    // the prompt loader takes the legacy monolith — a full-tool, generic
    // prompt session wearing the custom type's name.
    expect(hasTemplate('researcher')).toBe(false)
    const { transport } = typeTransport('researcher', {
      'researcher_intro.md': 'intro',
      'researcher_intro-v2.md': 'stale copy',
    })
    await expect(loadLocalTypeFilesOrFallBack(transport, 'researcher')).rejects.toThrow(
      /local template overlay for "researcher" is invalid and no bundled definition/,
    )
    expect(hasTemplate('researcher')).toBe(false)
  })

  it('a well-formed local-only overlay registers the type', async () => {
    const { transport } = typeTransport('researcher', { 'researcher_intro.md': 'intro' })
    await loadLocalTypeFilesOrFallBack(transport, 'researcher')
    expect(hasTemplate('researcher')).toBe(true)
    expect(getTemplate('researcher')!.config.tools).toEqual(['read'])
  })
})

describe('loadLocalTypeFilesOrFallBack — a local template-beta.md', () => {
  afterEach(() => {
    __setTemplateChannelForTest(null)
    __resetLocalOverlayForTest()
  })

  /** Serves `<type>/template.md` and/or `<type>/template-beta.md`, no includes. */
  function manifestsTransport(type: string, files: { base?: string; beta?: string }) {
    const root = `${LOCAL_TEMPLATE_ROOT}/${type}`
    const manifest = (tools: string) =>
      `---\ntype: ${type}\ntools: [${tools}]\n---\n\n## prompt\n!agent_intro\n`
    const request = vi.fn(async (req: { payload: { path: string } }) => {
      const { path } = req.payload
      if (path === `${root}/template.md` && files.base) {
        return { ok: true, result: utf8(manifest(files.base)) }
      }
      if (path === `${root}/template-beta.md` && files.beta) {
        return { ok: true, result: utf8(manifest(files.beta)) }
      }
      if (path === `${root}/includes`) return { ok: true, result: [] }
      return { ok: true }
    })
    return { request } as unknown as BrowserBridgeTransport
  }

  it('loads both manifests; the registry serves each on its channel', async () => {
    await loadLocalTypeFilesOrFallBack(
      manifestsTransport('researcher', { base: 'read', beta: 'read, shell' }),
      'researcher',
    )
    __setTemplateChannelForTest('stable')
    expect(getTemplate('researcher')!.config.tools).toEqual(['read'])
    __setTemplateChannelForTest('beta')
    expect(getTemplate('researcher')!.config.tools).toEqual(['read', 'shell'])
  })

  it('a folder with only template-beta.md registers a beta-only type', async () => {
    await loadLocalTypeFilesOrFallBack(
      manifestsTransport('researcher', { beta: 'read' }),
      'researcher',
    )
    __setTemplateChannelForTest('beta')
    expect(hasTemplate('researcher')).toBe(true)
    __setTemplateChannelForTest('stable')
    expect(hasTemplate('researcher')).toBe(false)
  })
})
