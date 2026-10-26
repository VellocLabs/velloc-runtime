import { describe, expect, it } from 'vitest'

import {
  describeDirectoryRecord,
  describeMarketplacePlugins,
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
      details: { name: 'Sales', links: { repository: 'https://github.com/acme/work-plugins' } },
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
    expect(resolved).toEqual({ details: { name: 'Remotion', links: { repository: 'https://github.com/remotion-dev/video-plugin' } }, alreadyInstalled: false, target: null })
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

describe('describeDirectoryRecord', () => {
  it('keeps what a detail page shows, with https links only and parts by kind', () => {
    const details = describeDirectoryRecord({
      name: 'code-review',
      manifest_name: ID.toUpperCase(),
      summary: 'Reviews pull requests',
      description: 'Runs several reviewers.',
      verified_tier: 'partner',
      added_time: '2025-11-20T19:47:24Z',
      updated_time: '2026-10-23T22:41:42Z',
      publisher: { name: 'Acme', url: 'http://acme.example' },
      media: {
        icons: [{ url: 'https://cdn.example/icon.png' }],
        screenshots: [{ url: 'https://cdn.example/1.png' }, 'https://cdn.example/2.png', { url: 'javascript:alert(1)' }],
      },
      links: { documentation: 'https://docs.example', support: 'ftp://support.example', privacy_policy: 'nope' },
      taxonomy: { object_acted_on: ['code', 'pull-requests'], work_department: 'engineering', junk: 'Not A Tag' },
      source: { marketplace_slug: 'plugin-directory', repository: { url: 'https://github.com/acme/plugins' } },
      components: [
        { type: 'command', name: 'code-review', slash_command: '/code-review', description: 'Review a PR' },
        { type: 'mcp_server', name: 'Tracker', tools: [{ name: 'a' }, { name: 'b' }] },
        { type: 'lsp', name: 'clangd' },
        { type: 'skill' },
      ],
    })
    expect(details).toEqual({
      name: 'code-review',
      summary: 'Reviews pull requests',
      description: 'Runs several reviewers.',
      publisher: 'Acme',
      iconUrl: 'https://cdn.example/icon.png',
      addedTime: '2025-11-20T19:47:24Z',
      updatedTime: '2026-10-23T22:41:42Z',
      pagePath: `/customize/plugins/id/${ID}@plugin-directory`,
      verified: true,
      screenshots: ['https://cdn.example/1.png', 'https://cdn.example/2.png'],
      components: [
        { type: 'command', name: '/code-review', description: 'Review a PR' },
        { type: 'mcp_server', name: 'Tracker', toolCount: 2 },
        { type: 'other', name: 'clangd' },
      ],
      links: { documentation: 'https://docs.example', repository: 'https://github.com/acme/plugins' },
      categories: ['code', 'pull-requests', 'engineering'],
    })
  })

  it('a connector record links to its own directory page; a bare record keeps only its name', () => {
    expect(describeDirectoryRecord({ name: 'Slack', slug: 'slack', source: { type: 'directory' } } as never))
      .toEqual({ name: 'Slack', pagePath: '/directory/slack' })
    expect(describeDirectoryRecord({ slug: 'acme/plugins/x', source: { repository: { url: 'https://g.example/a/b' } } }))
      .toEqual({ name: 'acme/plugins/x', links: { repository: 'https://g.example/a/b' } })
  })
})

describe('describeMarketplacePlugins', () => {
  function rig(records: unknown[], listings: Listing[], options: { pages?: boolean } = {}) {
    const urls: string[] = []
    const d: DirectoryOfferDeps = {
      ...deps(null, [{ name: 'work', source: KWP, listings }]),
      fetchJson: async url => {
        urls.push(url)
        const page = new URL(url).searchParams.get('page')
        if (options.pages && !page) return { data: records.slice(0, 1), next_page: 'p2' }
        return { data: options.pages ? records.slice(1) : records }
      },
    }
    return { d, urls }
  }

  it('asks the listing once for the repositories the marketplace lists and matches each plugin by name', async () => {
    const { d, urls } = rig(
      [
        { name: 'Sales', summary: 'Pipeline', source: { repository: { url: 'https://github.com/acme/work-plugins' } } },
        { name: 'Finance', source: { repository: { url: 'https://github.com/acme/work-plugins', path: 'finance' } } },
        { name: 'Notes', source: { repository: { url: 'https://github.com/Other/Notes' } } },
        { name: 'stranger', source: { repository: { url: 'https://github.com/x/y' } } },
      ],
      [
        { name: 'sales', source: { source: 'local', path: './sales' }, installed: false },
        { name: 'finance', source: { source: 'local', path: './finance' }, installed: false },
        { name: 'legal', source: { source: 'local', path: './legal' }, installed: false },
        { name: 'notes', source: { source: 'url', url: 'https://github.com/Other/Notes.git' }, installed: true },
      ],
    )
    const described = await describeMarketplacePlugins('work', d, 'http://127.0.0.1:4100')
    expect(Object.keys(described).sort()).toEqual(['finance', 'notes', 'sales'])
    expect(described.sales).toMatchObject({ name: 'Sales', summary: 'Pipeline' })
    expect(urls).toHaveLength(1)
    const query = new URL(urls[0]!)
    expect(query.origin + query.pathname).toBe('http://127.0.0.1:4100/api/directory/plugins')
    expect(query.searchParams.get('filter')).toBe(
      "source.repository.url in ['https://github.com/acme/work-plugins', " +
        "'https://github.com/Other/Notes', 'https://github.com/other/notes']",
    )
  })

  it('follows the listing to its next page, and an unknown marketplace asks nothing', async () => {
    const { d, urls } = rig(
      [
        { name: 'sales', source: { repository: { url: 'https://github.com/acme/work-plugins' } } },
        { name: 'finance', source: { repository: { url: 'https://github.com/acme/work-plugins' } } },
      ],
      [
        { name: 'sales', source: { source: 'local', path: './sales' }, installed: false },
        { name: 'finance', source: { source: 'local', path: './finance' }, installed: false },
      ],
      { pages: true },
    )
    expect(Object.keys(await describeMarketplacePlugins('work', d))).toEqual(['sales', 'finance'])
    expect(new URL(urls[1]!).searchParams.get('page')).toBe('p2')
    expect(await describeMarketplacePlugins('missing', d)).toEqual({})
    expect(urls).toHaveLength(2)
  })

  it('a quote in a repository address cannot end the filter string', async () => {
    const { d, urls } = rig([], [
      { name: 'odd', source: { source: 'url', url: "https://github.com/a/b'] || true" }, installed: false },
    ])
    await describeMarketplacePlugins('work', d)
    expect(new URL(urls[0]!).searchParams.get('filter')).toContain("'https://github.com/a/b\\'] || true'")
  })
})
