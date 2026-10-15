/**
 * `/plugins` listing (`input/pluginInstallCommands.ts::buildPluginsListing`): returns translatable parts (a `key()`
 * entry per prose line), not a pre-rendered string.
 */

import { describe, expect, it } from 'vitest'
import { buildPluginsListing } from '../input/pluginInstallCommands'
import { renderPartsEnglish } from '../input/systemMessageParts'
import type { ActivePlugin, PluginScan } from '../pluginHost/pluginModel'

function plugin(overrides: Partial<ActivePlugin> & Pick<ActivePlugin, 'name'>): ActivePlugin {
  return {
    manifest: { name: overrides.name },
    path: `/plugins/${overrides.name}`,
    source: 'user:/home/plugins',
    ...overrides,
  }
}

describe('buildPluginsListing', () => {
  it('explains where to place a plugin when nothing is discovered', () => {
    const text = renderPartsEnglish(buildPluginsListing(undefined))
    expect(text).toContain('No plugins discovered')
    expect(text).toContain('plugins/<name>/')
    expect(text).toContain('/plugins enable <name>')
  })

  it('treats a result with zero enabled and zero disabled as the empty state too', () => {
    const result: PluginScan = { enabled: [], disabled: [], errors: [] }
    expect(renderPartsEnglish(buildPluginsListing(result))).toContain('No plugins discovered')
  })

  it('lists enabled and disabled plugins with their capability facets', () => {
    const result: PluginScan = {
      enabled: [
        plugin({
          name: 'linter',
          manifest: { name: 'linter', version: '1.2.0' },
          commandFolder: 'commands',
          hooksConfig: { PreToolUse: [] },
        }),
      ],
      disabled: [plugin({ name: 'old-thing', source: 'project:/repo/plugins' })],
      errors: [],
    }
    const text = renderPartsEnglish(buildPluginsListing(result))
    expect(text).toContain('Plugins: 1 enabled, 1 disabled')
    expect(text).toContain('**Enabled:**')
    expect(text).toContain('- **linter** v1.2.0 (user)')
    // The capability list trails the scope: `[caps] (scope)` is markdown link
    // syntax and rendered the facets as a hyperlink.
    expect(text).toContain('(user) — commands, hooks')
    expect(text).toContain('Disabled (present on disk but not in the enabled allowlist):')
    expect(text).toContain('- **old-thing**')
    expect(text).toContain('(project) — no components')
  })

  it('lists load errors', () => {
    const result: PluginScan = {
      enabled: [],
      disabled: [plugin({ name: 'broken' })],
      errors: [
        {
          type: 'manifest-parse-error',
          source: 'user:/home/plugins',
          plugin: 'broken',
          manifestPath: '/home/plugins/broken/.claude-plugin/plugin.json',
          parseError: 'Unexpected token',
        },
      ],
    }
    const text = renderPartsEnglish(buildPluginsListing(result))
    expect(text).toContain('Load errors:')
    expect(text).toContain('Unexpected token')
  })

  it('returns translatable parts, not a pre-rendered string', () => {
    // The regression this guards: a builder silently reverting to a plain
    // English string would still satisfy every `.toContain` assertion above
    // (renderPartsEnglish renders either shape to the same English text),
    // but the webview would then render English in every locale. Assert the
    // return value itself carries at least one catalog `key()` entry.
    const empty = buildPluginsListing(undefined)
    expect(Array.isArray(empty)).toBe(true)
    expect(empty.some(part => 'key' in part)).toBe(true)

    const populated = buildPluginsListing({
      enabled: [plugin({ name: 'a' })],
      disabled: [],
      errors: [],
    })
    expect(populated.some(part => 'key' in part && part.key === 'slash.out.plugins.header')).toBe(
      true,
    )
  })
})
