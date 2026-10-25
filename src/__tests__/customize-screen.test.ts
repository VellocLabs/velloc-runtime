import { describe, expect, it } from 'vitest'

import type { PluginInstalledUiEntry } from '../browser/bridge/protocol/plugins'
import type { InstalledSkillUiEntry } from '../browser/bridge/protocol/skills'
import type { ModPluginSummary } from '../browser/webview/mods/modsStateView'
import {
  CUSTOMIZE_SEGMENTS,
  customizeUrl,
  segmentOfPath,
} from '../browser/webview/customize/customizeRoutes'
import {
  buildInstalledRows,
  EMPTY_INVENTORY,
  GROUP_SETTINGS_SECTION,
} from '../browser/webview/customize/installedRows'

describe('Customize routes', () => {
  it('each segment has its own page, and the page maps back to it', () => {
    for (const segment of CUSTOMIZE_SEGMENTS) {
      const url = customizeUrl(segment)
      expect(url).toBe(`https://claude.ai/customize/${segment}`)
      expect(segmentOfPath(url)).toBe(segment)
      expect(segmentOfPath(new URL(url).pathname)).toBe(segment)
    }
  })

  it('an e2e run may point the pages at another origin, never at a path', () => {
    const g = globalThis as { __NEXUS_E2E_CUSTOMIZE_ORIGIN__?: unknown }
    try {
      g.__NEXUS_E2E_CUSTOMIZE_ORIGIN__ = 'http://127.0.0.1:4100'
      expect(customizeUrl('plugins')).toBe('http://127.0.0.1:4100/customize/plugins')
      g.__NEXUS_E2E_CUSTOMIZE_ORIGIN__ = 'http://127.0.0.1:4100/elsewhere'
      expect(customizeUrl('plugins')).toBe('https://claude.ai/customize/plugins')
      g.__NEXUS_E2E_CUSTOMIZE_ORIGIN__ = 'javascript:alert(1)'
      expect(customizeUrl('plugins')).toBe('https://claude.ai/customize/plugins')
    } finally {
      delete g.__NEXUS_E2E_CUSTOMIZE_ORIGIN__
    }
  })

  it('reads a segment through a trailing slash, a deeper path, a query or a fragment', () => {
    expect(segmentOfPath('/customize/connectors/')).toBe('connectors')
    expect(segmentOfPath('/customize/plugins/some-plugin')).toBe('plugins')
    expect(segmentOfPath('/customize/skills?tab=mine')).toBe('skills')
    expect(segmentOfPath('https://claude.ai/customize/skills#top')).toBe('skills')
  })

  it('any other page names no segment', () => {
    expect(segmentOfPath('/')).toBeNull()
    expect(segmentOfPath('/customize')).toBeNull()
    expect(segmentOfPath('/customize/unknown')).toBeNull()
    expect(segmentOfPath('/settings/customize/skills')).toBeNull()
    expect(segmentOfPath('https://')).toBeNull()
  })

})

describe('Customize installed rows', () => {
  it('groups, names and sorts each list, with one line of detail', () => {
    const rows = buildInstalledRows({
      plugins: [
        { name: 'zeta', marketplace: 'market-a' },
        { name: 'alpha', marketplace: 'market-b', description: 'Does alpha things' },
      ] as unknown as PluginInstalledUiEntry[],
      mods: [{ plugin: 'status-mod', provenance: 'user' }] as unknown as ModPluginSummary[],
      skills: [
        { id: 'user:review', name: 'review', publisher: 'user' },
      ] as unknown as InstalledSkillUiEntry[],
      mcp: {
        remote: { url: 'https://mcp.example.test/sse' },
        local: { command: 'node', args: ['server.js', '--stdio'] },
      },
    })
    expect(rows.plugins).toEqual([
      { id: 'alpha@market-b', name: 'alpha', detail: 'Does alpha things' },
      { id: 'zeta@market-a', name: 'zeta', detail: 'market-a' },
    ])
    expect(rows.mods).toEqual([{ id: 'status-mod', name: 'status-mod', detail: 'user' }])
    expect(rows.skills).toEqual([{ id: 'user:review', name: 'review', detail: 'user' }])
    expect(rows.mcp).toEqual([
      { id: 'local', name: 'local', detail: 'node server.js --stdio' },
      { id: 'remote', name: 'remote', detail: 'https://mcp.example.test/sse' },
    ])
  })

  it('an empty machine has four empty groups', () => {
    expect(buildInstalledRows(EMPTY_INVENTORY)).toEqual({ plugins: [], mods: [], skills: [], mcp: [] })
  })

  it('each group opens the Settings page that manages it', () => {
    expect(GROUP_SETTINGS_SECTION).toEqual({
      plugins: 'plugins',
      mods: 'plugins',
      skills: 'features',
      mcp: 'mcp',
    })
  })
})
