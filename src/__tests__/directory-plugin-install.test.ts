/**
 * Plugins installed straight from a plugin-directory record (F-35): the
 * record's repository, folder and reviewed commit; the installed name from
 * the plugin's manifest; the code identity every install records; and
 * updates read from the record's newer reviewed commit (F-14).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codeSourceOf, normalizeCodePath, sameCode, sameCommit } from '../pluginHost/codeSource'
import {
  directoryListingSource,
  installFromDirectory,
  listingApiOrigin,
  refreshDirectoryListings,
  type DirectoryPluginSpec,
} from '../pluginHost/directoryInstall'
import { DIRECTORY_CATALOG_KEY, loadDirectoryPlugins } from '../pluginHost/directoryListings'
import { setupPlugin, teardownPlugin } from '../pluginHost/installSteps'
import { forgetRegistryFile, loadInstalledPlugins } from '../pluginHost/installedRegistry'
import { marketplaceNameProblem } from '../pluginHost/marketplaceNaming'
import { addMarketplace, forgetCatalogs } from '../pluginHost/marketplaces'
import { MARKETPLACE_MANIFEST_FILE_NAME, PLUGIN_MANIFEST_DIR_NAME } from '../pluginHost/pluginDirs'
import { createPluginUpdateService } from '../pluginHost/pluginUpdates'
import { wipeSettingsMemos } from '../settings/settingsStore'
import { makeMemFs } from './_helpers/memFs'
import { archive } from './_helpers/pluginArchive'

const HOME = '/home/u'
const ctx = { homeDir: HOME }
const API = 'https://api.example'
const ID = 'b2be6e33-a55f-45ca-9453-3dabeb179a53'
const C1 = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const C2 = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
const NOW = '2026-10-26T00:00:00.000Z'

function spec(over: Partial<DirectoryPluginSpec> = {}): DirectoryPluginSpec {
  return {
    manifestName: ID,
    apiOrigin: API,
    repositoryUrl: 'https://github.com/acme/tools',
    path: 'plugins/lint',
    commit: C1,
    fallbackName: 'lint-slug',
    ...over,
  }
}

/** A repository whose `plugins/lint` folder holds a plugin named `name`, at
 *  `version`; the directory answers `record` for its listing API. */
async function rig(options: { name?: string } = {}) {
  const fs = makeMemFs()
  const commits = new Map<string, string>([[C1, '1.0.0'], [C2, '1.0.0']])
  let record: Record<string, unknown> = {
    manifest_name: ID,
    source: { repository: { url: 'https://github.com/acme/tools', path: 'plugins/lint', reviewed_commit: C1 } },
  }
  let directoryUp = true
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith(`${API}/api/directory/plugins?`)) {
      return directoryUp ? Response.json({ data: [record] }) : new Response('down', { status: 503 })
    }
    const sha = /^https:\/\/codeload\.github\.com\/acme\/tools\/tar\.gz\/([0-9a-f]+)$/.exec(url)?.[1]
    if (sha && commits.has(sha)) {
      const body = await archive(
        [
          {
            name: `plugins/lint/${PLUGIN_MANIFEST_DIR_NAME}/plugin.json`,
            content: JSON.stringify({ name: options.name ?? 'lint', version: commits.get(sha) }),
          },
          { name: 'plugins/lint/skills/check/SKILL.md', content: `at ${sha.slice(0, 2)}\n` },
          { name: 'README.md', content: 'outside the folder\n' },
        ],
        `acme-tools-${sha.slice(0, 7)}`,
      )
      return new Response(new Uint8Array(body))
    }
    return new Response('missing', { status: 404 })
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } }
  return {
    fs,
    fetchImpl,
    review: (commit: string, over: Record<string, unknown> = {}) => {
      record = {
        ...record,
        source: { repository: { url: 'https://github.com/acme/tools', path: 'plugins/lint', reviewed_commit: commit, ...over } },
      }
    },
    goDown: () => {
      directoryUp = false
    },
    installed: async (id: string) => (await loadInstalledPlugins(ctx, fs)).registry.plugins[id]?.[0],
  }
}

beforeEach(() => {
  wipeSettingsMemos()
  forgetCatalogs()
  forgetRegistryFile()
})

describe('code identity', () => {
  it('a repository and folder name the code, however the listing spells them', () => {
    expect(codeSourceOf({ source: 'github', repo: 'Acme/Tools' })).toEqual({ repo: 'github.com/acme/tools', path: '' })
    expect(codeSourceOf({ source: 'url', url: 'https://github.com/acme/tools.git' })).toEqual({ repo: 'github.com/acme/tools', path: '' })
    expect(codeSourceOf({ source: 'git-subdir', url: 'acme/tools', path: './plugins/lint/' })).toEqual({
      repo: 'github.com/acme/tools',
      path: 'plugins/lint',
    })
    expect(codeSourceOf({ source: 'local', path: './lint' }, { source: 'git-subdir', url: 'acme/tools', path: 'plugins' }, 'abc')).toEqual({
      repo: 'github.com/acme/tools',
      path: 'plugins/lint',
      sha: 'abc',
    })
    expect(codeSourceOf({ source: 'local', path: './lint' })).toBeNull()
    expect(codeSourceOf({ source: 'git-subdir', url: 'acme/tools', path: '../x' })).toBeNull()
  })

  it('compares folders without commits, and commits by prefix', () => {
    expect(normalizeCodePath('./a//b/')).toBe('a/b')
    expect(normalizeCodePath('a/../b')).toBeNull()
    expect(sameCode({ repo: 'r', path: 'a', sha: '1' }, { repo: 'r', path: 'a', sha: '2' })).toBe(true)
    expect(sameCode({ repo: 'r', path: 'a' }, { repo: 'r', path: '' })).toBe(false)
    expect(sameCommit('ABCDEF1', 'abcdef1234')).toBe(true)
    expect(sameCommit('abcdef1', 'abcdef2')).toBe(false)
    expect(sameCommit(undefined, 'abc')).toBe(false)
  })
})

describe('a directory record as an install source', () => {
  it('accepts a GitHub repository, a folder without dot segments and a hex commit', () => {
    expect(directoryListingSource(spec())).toEqual({
      source: 'git-subdir',
      url: 'https://github.com/acme/tools',
      path: 'plugins/lint',
      sha: C1,
    })
    expect(directoryListingSource(spec({ path: '', repositoryUrl: 'https://github.com/acme/tools.git' }))).toEqual({
      source: 'github',
      repo: 'acme/tools',
      sha: C1,
    })
    expect(directoryListingSource(spec({ repositoryUrl: 'https://gitlab.com/acme/tools' }))).toBeNull()
    expect(directoryListingSource(spec({ path: 'plugins/../..' }))).toBeNull()
    expect(directoryListingSource(spec({ commit: 'main' }))).toBeNull()
  })

  it('reads records again only over https, or http on this computer', () => {
    expect(listingApiOrigin('https://api.example/x')).toBe('https://api.example')
    expect(listingApiOrigin('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100')
    expect(listingApiOrigin('http://api.example')).toBeNull()
    expect(listingApiOrigin('not a url')).toBeNull()
  })

  it('reserves its catalog name', () => {
    expect(marketplaceNameProblem(DIRECTORY_CATALOG_KEY)).not.toBeNull()
  })
})

describe('installFromDirectory', () => {
  it('installs the reviewed folder under the manifest\'s name and records where its code is', async () => {
    const r = await rig()
    const outcome = await installFromDirectory(ctx, r.fs, spec(), { fetchImpl: r.fetchImpl, nowIso: NOW })
    expect(outcome.identifier).toBe('lint@plugin-directory')
    const record = await r.installed('lint@plugin-directory')
    expect(record).toMatchObject({ gitCommitSha: C1, codeSource: { repo: 'github.com/acme/tools', path: 'plugins/lint', sha: C1 } })
    expect(await r.fs.readFile(`${record!.installPath}/skills/check/SKILL.md`, { encoding: 'utf-8' })).toBe('at a1\n')
    await expect(r.fs.readFile(`${record!.installPath}/README.md`, { encoding: 'utf-8' })).rejects.toThrow()
    expect((await loadDirectoryPlugins(ctx, r.fs)).lint).toMatchObject({ manifestName: ID, apiOrigin: API })
  })

  it('refuses a record that cannot be installed or found again before fetching anything', async () => {
    const r = await rig()
    await expect(installFromDirectory(ctx, r.fs, spec({ commit: 'HEAD' }), { fetchImpl: r.fetchImpl, nowIso: NOW })).rejects.toThrow()
    await expect(installFromDirectory(ctx, r.fs, spec({ manifestName: 'lint' }), { fetchImpl: r.fetchImpl, nowIso: NOW })).rejects.toThrow()
    await expect(installFromDirectory(ctx, r.fs, spec({ apiOrigin: 'http://api.example' }), { fetchImpl: r.fetchImpl, nowIso: NOW })).rejects.toThrow()
    expect(r.fetchImpl.mock.calls).toHaveLength(0)
  })

  it('refuses another folder\'s plugin under a name a directory install already holds', async () => {
    const r = await rig()
    await installFromDirectory(ctx, r.fs, spec(), { fetchImpl: r.fetchImpl, nowIso: NOW })
    await expect(
      installFromDirectory(ctx, r.fs, spec({ path: 'plugins/lint/', commit: C2 }), { fetchImpl: r.fetchImpl, nowIso: NOW }),
    ).resolves.toMatchObject({ identifier: 'lint@plugin-directory' })
    await expect(
      installFromDirectory(ctx, r.fs, spec({ repositoryUrl: 'https://github.com/other/tools' }), { fetchImpl: r.fetchImpl, nowIso: NOW }),
    ).rejects.toThrow()
  })

  it('keeps the record only for a plugin that is installed', async () => {
    const r = await rig()
    await expect(installFromDirectory(ctx, r.fs, spec({ commit: 'c3c3c3c' }), { fetchImpl: r.fetchImpl, nowIso: NOW })).rejects.toThrow()
    expect(await loadDirectoryPlugins(ctx, r.fs)).toEqual({})

    await installFromDirectory(ctx, r.fs, spec(), { fetchImpl: r.fetchImpl, nowIso: NOW })
    await teardownPlugin(ctx, ctx, r.fs, 'lint@plugin-directory')
    expect(await loadDirectoryPlugins(ctx, r.fs)).toEqual({})
  })

  it('setupPlugin reinstalls a directory install from its stored record; one never installed is refused', async () => {
    const r = await rig()
    await installFromDirectory(ctx, r.fs, spec(), { fetchImpl: r.fetchImpl, nowIso: NOW })
    await expect(setupPlugin(ctx, r.fs, DIRECTORY_CATALOG_KEY, 'lint', { nowIso: NOW, fetchImpl: r.fetchImpl })).resolves.toMatchObject({
      identifier: 'lint@plugin-directory',
    })
    await expect(setupPlugin(ctx, r.fs, DIRECTORY_CATALOG_KEY, 'other', { nowIso: NOW, fetchImpl: r.fetchImpl })).rejects.toThrow()
  })
})

describe('marketplace installs record their code too', () => {
  it('a listing inside its marketplace is in the marketplace\'s repository', async () => {
    const fs = makeMemFs()
    const tarball = await archive(
      [
        {
          name: `${PLUGIN_MANIFEST_DIR_NAME}/${MARKETPLACE_MANIFEST_FILE_NAME}`,
          content: JSON.stringify({ name: 'mkt', plugins: [{ name: 'cool', source: './plugins/cool' }] }),
        },
        { name: `plugins/cool/${PLUGIN_MANIFEST_DIR_NAME}/plugin.json`, content: JSON.stringify({ name: 'cool', version: '1.0.0' }) },
      ],
      'me-mkt-abc',
    )
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(tarball))) as unknown as typeof fetch
    await addMarketplace(ctx, fs, 'mkt', { source: 'github', repo: 'Me/Mkt' }, NOW)
    await setupPlugin(ctx, fs, 'mkt', 'cool', { nowIso: NOW, fetchImpl, refreshFirst: true })
    const record = (await loadInstalledPlugins(ctx, fs)).registry.plugins['cool@mkt']?.[0]
    expect(record?.codeSource).toMatchObject({ repo: 'github.com/me/mkt', path: 'plugins/cool' })
  })
})

describe('updates for directory installs', () => {
  function service(r: Awaited<ReturnType<typeof rig>>) {
    return createPluginUpdateService({
      homeDir: HOME,
      fs: r.fs,
      fetchImpl: () => r.fetchImpl,
      readAutoUpdate: async () => false,
      writeAutoUpdate: async () => {},
      reloadPluginsOnAllSessions: () => {},
      now: () => NOW,
      report: () => undefined,
    })
  }

  it('a newer reviewed commit is offered, and update installs it', async () => {
    const r = await rig()
    await installFromDirectory(ctx, r.fs, spec(), { fetchImpl: r.fetchImpl, nowIso: NOW })
    const updates = service(r)
    expect((await updates.check({ force: true })).plugins).toEqual([
      expect.objectContaining({ identifier: 'lint@plugin-directory', state: 'up-to-date' }),
    ])

    r.review(C2)
    const state = await updates.check({ force: true })
    expect(state.plugins[0]).toMatchObject({ identifier: 'lint@plugin-directory', state: 'available' })
    await updates.update('lint@plugin-directory')
    const record = await r.installed('lint@plugin-directory')
    expect(record).toMatchObject({ gitCommitSha: C2, codeSource: { sha: C2 } })
    expect(await r.fs.readFile(`${record!.installPath}/skills/check/SKILL.md`, { encoding: 'utf-8' })).toBe('at b2\n')
  })

  it('a record that now names other code is not followed', async () => {
    const r = await rig()
    await installFromDirectory(ctx, r.fs, spec(), { fetchImpl: r.fetchImpl, nowIso: NOW })
    r.review(C2, { path: 'plugins/other' })
    const listings = await refreshDirectoryListings(ctx, r.fs, ['lint'], r.fetchImpl)
    expect(listings[0]!.source).toMatchObject({ path: 'plugins/lint', sha: C1 })
  })

  it('an unreachable directory is reported and changes nothing', async () => {
    const r = await rig()
    await installFromDirectory(ctx, r.fs, spec(), { fetchImpl: r.fetchImpl, nowIso: NOW })
    r.goDown()
    const state = await service(r).check({ force: true })
    expect(state.unreachable).toEqual([{ marketplace: DIRECTORY_CATALOG_KEY, reason: expect.any(String) }])
    expect((await loadDirectoryPlugins(ctx, r.fs)).lint!.listing.source).toMatchObject({ sha: C1 })
  })
})
