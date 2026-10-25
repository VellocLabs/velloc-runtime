import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ScopeMode } from '../browser/runtimeProtocol'
import { NexusTopBar, type NexusTopBarProps } from '../browser/webview/topbar/NexusTopBar'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { __setUiChannelForTest } from '../branding/updateChannels'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

const BASE: NexusTopBarProps = {
  catalog: null,
  selection: null,
  onSelectModel: () => {},
  onOpenSettings: () => {},
  onTogglePane: () => {},
}

function markup(props: Partial<NexusTopBarProps> = {}, mode?: ScopeMode): string {
  const bar = createElement(NexusTopBar, { ...BASE, ...props })
  if (!mode) return renderToStaticMarkup(bar)
  return renderToStaticMarkup(
    createElement(RuntimeCapabilitiesContext.Provider, { value: queryFor(advertsForScope(mode)) }, bar),
  )
}

function button(html: string, testId: string): string {
  return new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? ''
}

describe('NexusTopBar Customize button', () => {
  beforeEach(() => __setUiChannelForTest('beta'))
  afterEach(() => __setUiChannelForTest(null))

  it('is absent on the stable channel, button and folded row alike', () => {
    __setUiChannelForTest('stable')
    const html = markup({ onOpenCustomize: () => {} }, 'full')
    expect(button(html, 'topbar-customize')).toBe('')
    expect(html).not.toContain('topbar-folded-customize')
    expect(html).not.toContain('data-topbar-fold="customize"')
  })

  it('sits right after the import buttons, labelled', () => {
    const html = markup({
      onOpenCustomize: () => {},
      onOpenImport: () => {},
      importSources: [{ source: 'codex' as never, label: 'Codex' }],
    })
    const customize = button(html, 'topbar-customize')
    expect(customize).toContain('aria-label="Customize"')
    expect(customize).toContain('data-topbar-fold="customize"')
    const importAt = html.indexOf('data-testid="topbar-import-codex"')
    expect(importAt).toBeGreaterThan(-1)
    expect(html.indexOf('data-testid="topbar-customize"')).toBeGreaterThan(importAt)
  })

  it('is absent when the shell offers no Customize screen', () => {
    expect(button(markup(), 'topbar-customize')).toBe('')
  })

  it('is absent on a connection that may not show the Customize page', () => {
    expect(button(markup({ onOpenCustomize: () => {} }, 'full'), 'topbar-customize')).not.toBe('')
    for (const mode of ['manager', 'control', 'observe'] as const) {
      expect(button(markup({ onOpenCustomize: () => {} }, mode), 'topbar-customize')).toBe('')
    }
  })
})
