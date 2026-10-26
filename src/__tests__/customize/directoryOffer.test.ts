import { describe, expect, it } from 'vitest'

import {
  directoryIconUrl,
  directoryLookupUrl,
  installDirectoryTarget,
  normalizeRepoUrl,
  parseDirectoryIntent,
  resolveDirectoryIntent,
  type DirectoryOfferDeps,
} from '../../customize/directoryOffer'
import { DIRECTORY_API_ORIGIN, DIRECTORY_SITE_ORIGIN } from '../../customize/directorySite'
import type { CatalogListing, PluginOrigin } from '../../pluginHost/registryFormats'

const ID = 'b2be6e33-a55f-45ca-9453-3dabeb179a53'

describe('parseDirectoryIntent', () => {
  it('reads a connector page and a plugin page', () => {
    expect(parseDirectoryIntent('/directory/slack')).toEqual({ kind: 'connector', slug: 'slack' })
    expect(parseDirectoryIntent('/directory/google-drive-drivemcp?x=1')).toEqual({
      kind: 'connector',
      slug: 'google-drive-drivemcp',
    })
    expect(parseDirectoryIntent(`/customize/plugins/id/${ID}%40plugin-directory?via=directory`)).toEqual({
      kind: 'plugin',
      manifestName: ID,
    })
    expect(parseDirectoryIntent(`/customize/plugins/id/${ID.toUpperCase()}@market`)).toEqual({
      kind: 'plugin',
      manifestName: ID,
    })
  })

  it('a list page, the start page or any other path names no item', () => {
    for (const returnTo of [
      '',
      '/directory',
      '/directory/',
      '/directory/all',
      '/directory/all-plugins',
      '/directory/trending',
      '/directory/new',
      '/directory/topic-logs-errors',
      '/directory/industry-health-life-sciences',
      '/directory/slack/extra',
      '/customize/plugins/id/not-a-uuid@market',
      '/customize/plugins',
      '/settings',
      `${DIRECTORY_SITE_ORIGIN}/directory/slack`,
      '//evil.example/directory/slack',
      "/directory/sl'ack",
      '/directory/%E0%A4%A',
    ]) {
      expect(parseDirectoryIntent(returnTo), returnTo).toBeNull()
    }
  })
})

describe('directory lookups', () => {
  it('filters the listing to the one record an intent names', () => {
    const plugin = new URL(directoryLookupUrl({ kind: 'plugin', manifestName: ID }))
    expect(plugin.origin + plugin.pathname).toBe(`${DIRECTORY_API_ORIGIN}/api/directory/plugins`)
    expect(plugin.searchParams.get('filter')).toBe(`manifest_name == '${ID}'`)
    const connector = new URL(directoryLookupUrl({ kind: 'connector', slug: 'slack' }, 'http://127.0.0.1:4100'))
    expect(connector.origin).toBe('http://127.0.0.1:4100')
    expect(connector.searchParams.get('filter')).toBe("slug == 'slack'")
  })

  it('keeps image icons, turns a site address into its favicon, and drops the rest', () => {
    expect(directoryIconUrl('https://www.notion.so/images/logo.svg')).toBe('https://www.notion.so/images/logo.svg')
    expect(directoryIconUrl('https://t0.gstatic.com/faviconV2?url=https://drive.google.com')).toBe(
      'https://t0.gstatic.com/faviconV2?url=https://drive.google.com',
    )
    expect(directoryIconUrl('https://www.figma.com/')).toBe(
      'https://www.google.com/s2/favicons?sz=64&domain=www.figma.com',
    )
    expect(directoryIconUrl('http://insecure.example/logo.png')).toBeUndefined()
    expect(directoryIconUrl('javascript:alert(1)')).toBeUndefined()
    expect(directoryIconUrl(undefined)).toBeUndefined()
  })

  it('normalizes repository addresses', () => {
    expect(normalizeRepoUrl('https://github.com/Obra/Superpowers.git')).toBe('github.com/obra/superpowers')
    expect(normalizeRepoUrl('git@github.com:obra/superpowers.git')).toBe('github.com/obra/superpowers')
    expect(normalizeRepoUrl('https://github.com/obra/superpowers/tree/main')).toBe('github.com/obra/superpowers')
    expect(normalizeRepoUrl('not a url')).toBeNull()
  })
})

type Listing = CatalogListing & { installed: boolean }

function deps(
  record: unknown,
  marketplaces: Array<{ name: string; source: PluginOrigin; isOfficial?: boolean; listings: Listing[] | 'broken' }>,
): DirectoryOfferDeps {
  return {
    fetchJson: async () => ({ data: record ? [record] : [] }),
    listMarketplaces: async () => marketplaces,
    listMarketplaceListings: async name => {
      const listings = marketplaces.find(m => m.name === name)!.listings
      if (listings === 'broken') throw new Error('no manifest')
      return listings
    },
    installPlugin: async () => {},
    listMcpServers: async () => ({}),
    upsertMcpServer: async () => {},
  }
}

const KWP = { source: 'github', repo: 'acme/work-plugins' } as const

describe('resolveDirectoryIntent — plugins', () => {
  const plugin = { kind: 'plugin', manifestName: ID } as const

  it('a repository with several plugins is told apart by name, and a local listing uses its marketplace repo', async () => {
    const record = { name: 'Sales', slug: 'sales', source: { repository: { url: 'https://github.com/acme/work-plugins' } } }
    const resolved = await resolveDirectoryIntent(
      plugin,
      deps(record, [
        {
          name: 'work',
          source: KWP,
          listings: [
            { name: 'finance', source: { source: 'local', path: './finance' }, installed: false },
            { name: 'sales', source: { source: 'local', path: './sales' }, installed: true },
          ],
        },
      ]),
    )
    expect(resolved).toEqual({
      details: { name: 'Sales' },
      alreadyInstalled: true,
      installedAs: 'sales@work',
      target: { kind: 'plugin', identifier: 'sales@work' },
    })
  })

  it('official marketplaces come first, and a broken one is skipped', async () => {
    const record = { name: 'Superpowers', slug: 'obra/superpowers', source: { repository: { url: 'https://github.com/obra/superpowers' } } }
    const listing: Listing = { name: 'superpowers', source: { source: 'url', url: 'https://github.com/obra/superpowers.git' }, installed: false }
    const resolved = await resolveDirectoryIntent(
      plugin,
      deps(record, [
        { name: 'community', source: KWP, listings: [listing] },
        { name: 'broken', source: KWP, isOfficial: true, listings: 'broken' },
        { name: 'official', source: KWP, isOfficial: true, listings: [listing] },
      ]),
    )
    expect(resolved.target).toEqual({ kind: 'plugin', identifier: 'superpowers@official' })
  })

  it('a plugin no marketplace here lists cannot be installed', async () => {
    const record = { name: 'Remotion', source: { repository: { url: 'https://github.com/remotion-dev/video-plugin' } } }
    const resolved = await resolveDirectoryIntent(plugin, deps(record, [{ name: 'official', source: KWP, listings: [] }]))
    expect(resolved).toEqual({ details: { name: 'Remotion' }, alreadyInstalled: false, target: null })
  })
})

describe('resolveDirectoryIntent — connectors', () => {
  const connector = { kind: 'connector', slug: 'acme' } as const

  it('a connector without one fixed https address cannot be added', async () => {
    for (const endpoint of [
      { type: 'one_of', options: [] },
      { type: 'fixed', url: 'http://plain.example/mcp' },
    ]) {
      const record = { name: 'Acme', components: [{ type: 'mcp_server', endpoint }] }
      const resolved = await resolveDirectoryIntent(connector, deps(record, []))
      expect(resolved.target).toBeNull()
    }
  })

  it('a server already configured under the same id counts as installed', async () => {
    const record = { name: 'Acme', components: [{ type: 'mcp_server', endpoint: { type: 'fixed', url: 'https://mcp.acme.test' } }] }
    const d = deps(record, [])
    d.listMcpServers = async () => ({ acme: { command: 'node' } })
    expect(await resolveDirectoryIntent(connector, d)).toMatchObject({ alreadyInstalled: true, installedAs: 'acme' })
  })

  it('no record is not_found; a listing that cannot be read is lookup_failed', async () => {
    await expect(resolveDirectoryIntent(connector, deps(null, []))).rejects.toMatchObject({ code: 'not_found' })
    const d = deps(null, [])
    d.fetchJson = async () => {
      throw new Error('offline')
    }
    await expect(resolveDirectoryIntent(connector, d)).rejects.toMatchObject({ code: 'lookup_failed' })
  })
})

describe('installDirectoryTarget', () => {
  it('answers what the item is installed as', async () => {
    const calls: string[] = []
    const d = deps(null, [])
    d.installPlugin = async id => void calls.push(`install ${id}`)
    d.upsertMcpServer = async (id, config) => void calls.push(`upsert ${id} ${config.url}`)
    await expect(installDirectoryTarget({ kind: 'plugin', identifier: 'sales@work' }, d)).resolves.toBe('sales@work')
    await expect(
      installDirectoryTarget({ kind: 'connector', id: 'acme', config: { transport: 'http', url: 'https://mcp.acme.test' } }, d),
    ).resolves.toBe('acme')
    expect(calls).toEqual(['install sales@work', 'upsert acme https://mcp.acme.test'])
  })
})
