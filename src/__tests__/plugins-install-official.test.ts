import { describe, expect, it } from 'vitest'
import {
  buildInitialOfficialEntries,
  getOfficialMarketplaceSource,
  listOfficialMarketplaces,
} from '../pluginHost/defaultMarketplace'
import { reservedNameSourceProblem } from '../pluginHost/marketplaceNaming'
import { isCuratedCatalog } from '../pluginHost/pluginRef'

describe('isCuratedCatalog (RESERVED_MARKETPLACE_NAMES allow-list)', () => {
  it('recognises both default catalogs, in any letter case', () => {
    expect(isCuratedCatalog('claude-plugins-official')).toBe(true)
    expect(isCuratedCatalog('claude-plugins-community')).toBe(true)
    expect(isCuratedCatalog('CLAUDE-PLUGINS-OFFICIAL')).toBe(true)
    expect(isCuratedCatalog('agent-skills')).toBe(false)
  })

  it('returns false for non-reserved names', () => {
    expect(isCuratedCatalog('claude-plugins')).toBe(false)
    expect(isCuratedCatalog('superpowers-dev')).toBe(false)
    expect(isCuratedCatalog('')).toBe(false)
  })
})

describe('getOfficialMarketplaceSource', () => {
  it('returns the hardcoded GitHub source for claude-plugins-official', () => {
    expect(getOfficialMarketplaceSource('claude-plugins-official')).toEqual({
      source: 'github',
      repo: 'anthropics/claude-plugins-official',
    })
  })

  it('returns the hardcoded GitHub source for claude-plugins-community', () => {
    expect(getOfficialMarketplaceSource('claude-plugins-community')).toEqual({
      source: 'github',
      repo: 'anthropics/claude-plugins-community',
    })
  })

  it('returns undefined for non-reserved names', () => {
    expect(getOfficialMarketplaceSource('my-marketplace')).toBeUndefined()
  })
})

describe('reservedNameSourceProblem (impersonation guard)', () => {
  // reservedNameSourceProblem returns a string error message OR null —
  // not an envelope. These tests pin that exact contract.

  it('PASSES (returns null) for a non-reserved name with any source', () => {
    expect(
      reservedNameSourceProblem('my-marketplace', {
        source: 'github',
        repo: 'me/anywhere',
      }),
    ).toBeNull()
  })

  it('PASSES for a reserved name from the official Anthropic org', () => {
    expect(
      reservedNameSourceProblem('claude-plugins-official', {
        source: 'github',
        repo: 'anthropics/claude-plugins-official',
      }),
    ).toBeNull()
  })

  it('PASSES for any reserved name from the official Anthropic org regardless of repo name', () => {
    // The check is just "repo starts with anthropics/" — any sub-name is OK.
    // This is intentional: the org could legitimately host
    // `anthropics/agent-skills` and use the reserved name `agent-skills`.
    expect(
      reservedNameSourceProblem('agent-skills', {
        source: 'github',
        repo: 'anthropics/agent-skills',
      }),
    ).toBeNull()
  })

  it('REJECTS a reserved name with a DIFFERENT github repo (not anthropics org)', () => {
    const result = reservedNameSourceProblem('claude-plugins-official', {
      source: 'github',
      repo: 'evil/claude-plugins-official',
    })
    expect(typeof result).toBe('string')
    expect(result).toMatch(/reserved/i)
    expect(result).toMatch(/anthropics/)
  })

  it('REJECTS a reserved name from a non-anthropics source kind (url/etc.)', () => {
    const result = reservedNameSourceProblem('claude-plugins-official', {
      source: 'url',
      url: 'https://github.com/evil/claude-plugins-official.git',
    })
    expect(typeof result).toBe('string')
    expect(result).toMatch(/reserved/i)
  })

  it('PASSES a reserved name via a git URL pointing at the anthropics org', () => {
    // `source: 'git'` with an HTTPS / SSH URL pointing at anthropics is accepted too.
    expect(
      reservedNameSourceProblem('claude-plugins-community', {
        source: 'git',
        url: 'https://github.com/anthropics/claude-plugins-community.git',
      }),
    ).toBeNull()
    expect(
      reservedNameSourceProblem('claude-plugins-community', {
        source: 'git',
        url: 'git@github.com:anthropics/claude-plugins-community.git',
      }),
    ).toBeNull()
  })
})

describe('listOfficialMarketplaces', () => {
  it('returns both Anthropic marketplaces in stable order', () => {
    const list = listOfficialMarketplaces()
    expect(list.map(m => m.name)).toEqual([
      'claude-plugins-official',
      'claude-plugins-community',
    ])
    expect(list[0]!.description.length).toBeGreaterThan(0)
    expect(list[1]!.description.length).toBeGreaterThan(0)
  })
})

describe('buildInitialOfficialEntries', () => {
  it('seeds an entry for every official with the given timestamp', () => {
    const nowIso = '2023-11-14T22:13:20.000Z'
    const ctx = { homeDir: '/home/user' }
    const entries = buildInitialOfficialEntries(ctx, nowIso)
    expect(Object.keys(entries).sort()).toEqual([
      'claude-plugins-community',
      'claude-plugins-official',
    ])
    expect(entries['claude-plugins-official']).toEqual({
      source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
      installLocation: '/home/user/.velloc/plugins/marketplaces/claude-plugins-official',
      lastUpdated: nowIso,
    })
    expect(entries['claude-plugins-community']?.lastUpdated).toBe(nowIso)
  })
})
