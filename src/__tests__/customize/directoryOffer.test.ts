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

type Installed = { identifier: string; codeSource?: { repo: string; path: string; sha?: string }; gitCommitSha?: string }

function deps(
  record: unknown,
  marketplaces: Array<{ name: string; source: PluginOrigin; isOfficial?: boolean; listings: Listing[] | 'broken' }>,
  installed: Installed[] = [],
): DirectoryOfferDeps {
  return {
    fetchJson: async () => ({ data: record ? [record] : [] }),
    listMarketplaces: async () => marketplaces,
    listMarketplaceListings: async name => {
      const listings = marketplaces.find(m => m.name === name)!.listings
      if (listings === 'broken') throw new Error('no manifest')
      return listings
    },
    listInstalledPlugins: async () => installed,
    installFromDirectory: async spec => `${spec.fallbackName}@plugin-directory`,
    listMcpServers: async () => ({}),
    upsertMcpServer: async () => {},
    uninstallPlugin: async () => {},
    removeMcpServer: async () => {},
  }
}

const KWP = { source: 'github', repo: 'acme/work-plugins' } as const

describe('resolveDirectoryIntent — plugins', () => {
  const plugin = { kind: 'plugin', manifestName: ID } as const
  const COMMIT = '8ca22dba9a94f28898bbce59f2537ff4d87c747d'
  const sales = {
    name: 'Sales',
    slug: 'acme/work-plugins/sales',
    manifest_name: ID,
    source: { repository: { url: 'https://github.com/acme/work-plugins', path: './sales/', reviewed_commit: COMMIT } },
  }
  const salesCode = { repo: 'github.com/acme/work-plugins', path: 'sales' }

  it('Add installs the reviewed commit of the record\'s folder, with what finds the record again', async () => {
    const resolved = await resolveDirectoryIntent(plugin, deps(sales, []), 'https://api.example')
    expect(resolved.alreadyInstalled).toBe(false)
    expect(resolved.target).toEqual({
      kind: 'plugin',
      spec: {
        manifestName: ID,
        apiOrigin: 'https://api.example',
        repositoryUrl: 'https://github.com/acme/work-plugins',
        path: './sales/',
        commit: COMMIT,
        fallbackName: 'sales',
      },
    })
  })

  it('an installed plugin with the same repository and folder is it, whatever it is called; another commit is an update', async () => {
    const same = await resolveDirectoryIntent(
      plugin,
      deps(sales, [], [
        { identifier: 'finance@work', codeSource: { repo: 'github.com/acme/work-plugins', path: 'finance', sha: COMMIT } },
        { identifier: 'deals@team', codeSource: { ...salesCode, sha: COMMIT.slice(0, 12) } },
      ]),
    )
    expect(same).toMatchObject({ alreadyInstalled: true, installedAs: 'deals@team', updateAvailable: false })

    const older = await resolveDirectoryIntent(
      plugin,
      deps(sales, [], [{ identifier: 'sales@plugin-directory', codeSource: salesCode, gitCommitSha: '1111111111aa' }]),
    )
    expect(older).toMatchObject({ alreadyInstalled: true, installedAs: 'sales@plugin-directory', updateAvailable: true })

    const elsewhere = await resolveDirectoryIntent(
      plugin,
      deps(sales, [], [{ identifier: 'finance@work', codeSource: { repo: 'github.com/acme/work-plugins', path: 'finance' } }]),
    )
    expect(elsewhere.alreadyInstalled).toBe(false)
  })

  it('an install whose record names no code is matched through its marketplace listing; a broken marketplace is skipped', async () => {
    const resolved = await resolveDirectoryIntent(
      plugin,
      deps(sales, [
        { name: 'broken', source: KWP, listings: 'broken' },
        {
          name: 'work',
          source: KWP,
          listings: [
            { name: 'finance', source: { source: 'local', path: './finance' }, installed: true },
            { name: 'sales', source: { source: 'local', path: './sales' }, installed: true },
          ],
        },
      ]),
    )
    expect(resolved).toMatchObject({ alreadyInstalled: true, installedAs: 'sales@work' })
    expect(resolved.target).not.toBeNull()
  })

  it('a record without a reviewed commit, on another host, or with a dot segment in its folder cannot be installed', async () => {
    const variants = [
      { url: 'https://github.com/acme/work-plugins', path: 'sales' },
      { url: 'https://gitlab.com/acme/work-plugins', path: 'sales', reviewed_commit: COMMIT },
      { url: 'https://github.com/acme/work-plugins', path: '../sales', reviewed_commit: COMMIT },
    ]
    for (const repository of variants) {
      const record = { ...sales, source: { repository } }
      expect((await resolveDirectoryIntent(plugin, deps(record, []))).target).toBeNull()
    }
    const unnamed = { ...sales, manifest_name: undefined }
    expect((await resolveDirectoryIntent(plugin, deps(unnamed, []))).target).toBeNull()
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

  const acme = { name: 'Acme', components: [{ type: 'mcp_server', endpoint: { type: 'fixed', url: 'https://mcp.acme.test' } }] }

  it('a server at the connector address counts as installed, preferring the one under its id', async () => {
    const d = deps(acme, [])
    d.listMcpServers = async () => ({
      mine: { transport: 'http', url: 'https://mcp.acme.test/' },
      acme: { transport: 'http', url: 'https://mcp.acme.test' },
    })
    expect(await resolveDirectoryIntent(connector, d)).toMatchObject({ alreadyInstalled: true, installedAs: 'acme' })
  })

  it('a server of another address under the same id is not it, and Add takes a free id', async () => {
    const d = deps(acme, [])
    d.listMcpServers = async () => ({
      acme: { command: 'node' },
      'acme-2': { transport: 'http', url: 'https://self-hosted.example/mcp' },
    })
    const resolved = await resolveDirectoryIntent(connector, d)
    expect(resolved).toMatchObject({ alreadyInstalled: false })
    expect(resolved.installedAs).toBeUndefined()
    expect(resolved.target).toEqual({ kind: 'connector', id: 'acme-3', config: { transport: 'http', url: 'https://mcp.acme.test' } })
  })

  it('an inherited property name is no server', async () => {
    const record = { ...acme, slug: 'constructor' }
    const resolved = await resolveDirectoryIntent({ kind: 'connector', slug: 'constructor' }, deps(record, []))
    expect(resolved).toMatchObject({ alreadyInstalled: false })
    expect(resolved.target).toMatchObject({ id: 'constructor' })
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
    d.installFromDirectory = async spec => {
      calls.push(`install ${spec.repositoryUrl} ${spec.commit}`)
      return 'sales@plugin-directory'
    }
    d.upsertMcpServer = async (id, config) => void calls.push(`upsert ${id} ${config.url}`)
    const spec = {
      manifestName: ID,
      apiOrigin: 'https://api.example',
      repositoryUrl: 'https://github.com/acme/work-plugins',
      commit: 'abcdef1',
      fallbackName: 'sales',
    }
    await expect(installDirectoryTarget({ kind: 'plugin', spec }, d)).resolves.toBe('sales@plugin-directory')
    await expect(
      installDirectoryTarget({ kind: 'connector', id: 'acme', config: { transport: 'http', url: 'https://mcp.acme.test' } }, d),
    ).resolves.toBe('acme')
    expect(calls).toEqual(['install https://github.com/acme/work-plugins abcdef1', 'upsert acme https://mcp.acme.test'])
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
