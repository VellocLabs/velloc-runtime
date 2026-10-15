import { describe, expect, it } from 'vitest'
import { COMMUNITY_MARKETPLACE_NAME, CURATED_CATALOG_KEY } from '../pluginHost/defaultMarketplace'
import {
  looksLikeReservedName,
  marketplaceNameProblem,
  RESERVED_MARKETPLACE_NAMES,
  reservedNameSourceProblem,
} from '../pluginHost/marketplaceNaming'

describe('marketplace name rules', () => {
  it('reserves exactly the shipped default catalogs', () => {
    expect([...RESERVED_MARKETPLACE_NAMES].sort()).toEqual(
      [COMMUNITY_MARKETPLACE_NAME, CURATED_CATALOG_KEY].sort(),
    )
  })

  it('reports one problem per bad name, in a fixed order', () => {
    expect(marketplaceNameProblem('')).toMatch(/needs a name/)
    expect(marketplaceNameProblem('my market')).toMatch(/spaces/)
    for (const n of ['a/b', 'a\\b', 'a..b', '.']) expect(marketplaceNameProblem(n)).toMatch(/slash/)
    expect(marketplaceNameProblem('INLINE')).toMatch(/'inline'.*internal/)
    expect(marketplaceNameProblem('Builtin')).toMatch(/'builtin'.*internal/)
    expect(marketplaceNameProblem('team-tools')).toBeNull()
    expect(marketplaceNameProblem('team plugins x')).toMatch(/spaces/)
  })

  it('flags names that could pass for a reserved catalog', () => {
    expect(marketplaceNameProblem('Claude_Plugins-Pro')).toMatch(/impersonat/i)
    expect(looksLikeReservedName('my.claude.plugins')).toBe(true)
    expect(looksLikeReservedName(CURATED_CATALOG_KEY.toUpperCase())).toBe(false)
    expect(looksLikeReservedName('tеam')).toBe(true) // Cyrillic е
    expect(looksLikeReservedName('claude-tools')).toBe(false)
    expect(looksLikeReservedName('team')).toBe(false)
  })

  it('lets only the publisher organisation use a reserved name', () => {
    const n = CURATED_CATALOG_KEY
    expect(reservedNameSourceProblem(n, { source: 'github', repo: 'Anthropics/x' })).toBeNull()
    expect(reservedNameSourceProblem(n, { source: 'git', url: 'git@github.com:anthropics/x.git' })).toBeNull()
    expect(reservedNameSourceProblem(n, { source: 'git', url: 'https://github.com/anthropics/x' })).toBeNull()
    expect(reservedNameSourceProblem(n, { source: 'git', url: 'git@github.com:other/x.git' })).toMatch(/reserved/)
    expect(reservedNameSourceProblem(n, { source: 'git' })).toMatch(/anthropics/)
    expect(reservedNameSourceProblem(n, { source: 'url', url: 'x' })).toMatch(/reserved/)
    expect(reservedNameSourceProblem('Claude-Plugins-Community', { source: 'github', repo: 'me/x' })).toContain(
      "'Claude-Plugins-Community'",
    )
    expect(reservedNameSourceProblem('team-tools', { source: 'url', url: 'x' })).toBeNull()
  })
})
