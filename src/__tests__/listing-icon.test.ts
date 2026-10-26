import { describe, expect, it } from 'vitest'

import { githubOwnerOf, listingIconUrl } from '../customize/listingIcon'
import { avatarHue } from '../browser/webview/customize/ItemAvatar'
import type { CatalogListing } from '../pluginHost/registryFormats'

const listing = (extra: Partial<CatalogListing>): CatalogListing =>
  ({ name: 'p', source: './plugins/p', ...extra }) as CatalogListing

describe('githubOwnerOf', () => {
  it('reads the owner from https, ssh and scp-style github.com URLs', () => {
    expect(githubOwnerOf('https://github.com/acme/tool.git')).toBe('acme')
    expect(githubOwnerOf('https://www.github.com/Acme-Labs/tool/tree/main')).toBe('Acme-Labs')
    expect(githubOwnerOf('ssh://git@github.com/acme/tool.git')).toBe('acme')
    expect(githubOwnerOf('git@github.com:acme/tool.git')).toBe('acme')
  })

  it('refuses other hosts, other schemes and names GitHub does not allow', () => {
    expect(githubOwnerOf('https://gitlab.com/acme/tool')).toBeUndefined()
    expect(githubOwnerOf('https://github.com.evil.example/acme/tool')).toBeUndefined()
    expect(githubOwnerOf('javascript:github.com/acme')).toBeUndefined()
    expect(githubOwnerOf('https://github.com/-acme/tool')).toBeUndefined()
    expect(githubOwnerOf('https://github.com/ac--me/tool')).toBeUndefined()
    expect(githubOwnerOf('https://github.com/')).toBeUndefined()
    expect(githubOwnerOf('not a url')).toBeUndefined()
    expect(githubOwnerOf(undefined)).toBeUndefined()
  })
})

describe('listingIconUrl', () => {
  it('prefers the repository the plugin installs from', () => {
    expect(
      listingIconUrl(listing({ source: { source: 'github', repo: 'acme/tool' }, homepage: 'https://github.com/other/x' })),
    ).toBe('https://github.com/acme.png?size=96')
    expect(listingIconUrl(listing({ source: { source: 'git-subdir', url: 'https://github.com/acme/mono.git', path: 'p' } }))).toBe(
      'https://github.com/acme.png?size=96',
    )
  })

  it('falls back to a GitHub homepage, then a GitHub author page', () => {
    expect(listingIconUrl(listing({ homepage: 'https://github.com/home-owner/tool' }))).toBe(
      'https://github.com/home-owner.png?size=96',
    )
    expect(listingIconUrl(listing({ homepage: 'https://example.com', author: { url: 'https://github.com/someone' } }))).toBe(
      'https://github.com/someone.png?size=96',
    )
  })

  it('names no picture when nothing points at a GitHub account', () => {
    expect(listingIconUrl(listing({ homepage: 'https://example.com/tool' }))).toBeUndefined()
    expect(listingIconUrl(listing({ source: { source: 'url', url: 'https://gitlab.com/acme/tool.git' } }))).toBeUndefined()
  })
})

describe('avatarHue', () => {
  it('is stable per name and stays within the colour wheel', () => {
    expect(avatarHue('lint')).toBe(avatarHue('lint'))
    for (const name of ['', 'a', 'lint', 'a very long plugin name', '插件']) {
      const hue = avatarHue(name)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })
})
