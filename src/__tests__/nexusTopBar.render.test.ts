import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip'

import type { ScopeMode } from '../browser/runtimeProtocol'
import { NexusTopBar } from '../browser/webview/topbar/NexusTopBar'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

// NexusTopBar mounts outside the <TooltipProvider> inside AssistantUiThread, so it wraps its own. This renders it
// with no provider ancestor via react-dom/server and asserts it does not throw.
describe('NexusTopBar render', () => {
  // Proves the harness genuinely DETECTS the missing-provider crash, so the
  // topbar test below is not a vacuous pass: a bare <Tooltip> with no
  // TooltipProvider ancestor must throw under renderToStaticMarkup. This is
  // exactly the failure mode the topbar had before its self-provider fix.
  it('a bare <Tooltip> with no provider throws (the crash this guards against)', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Tooltip, null, createElement(TooltipTrigger, null, 'x')),
      ),
    ).toThrow(/TooltipProvider/)
  })

  it('renders standalone (no TooltipProvider ancestor) without throwing', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(NexusTopBar, {
          catalog: null,
          selection: null,
          onSelectModel: () => {},
          onOpenSettings: () => {},
          sidebarCollapsed: false,
          onToggleSidebar: () => {},
        }),
      ),
    ).not.toThrow()
  })

  // A teammate keeps the model its lead spawned it on: a pick made on its tab
  // moved four teammates of one run onto the lead's model (and could move a
  // trusted child onto an untrusted relay). The picker is read-only there,
  // and says why.
  it('the model picker is read-only on a teammate tab, and says why', () => {
    const base = {
      catalog: null,
      selection: null,
      onSelectModel: () => {},
      onOpenSettings: () => {},
    }
    const trigger = (markup: string) =>
      /<button[^>]*data-testid="nexus-model-picker-trigger"[^>]*>/.exec(markup)?.[0] ?? ''

    const teammate = trigger(
      renderToStaticMarkup(
        createElement(NexusTopBar, {
          ...base,
          activeSessionId: 'teammate-lead-1-worker-a-1789000000000',
        }),
      ),
    )
    expect(teammate).toContain('disabled=""')
    expect(teammate).toContain('title="A teammate keeps the model it was started with.')

    const lead = trigger(
      renderToStaticMarkup(
        createElement(NexusTopBar, { ...base, activeSessionId: 'lead-1' }),
      ),
    )
    expect(lead).not.toContain('disabled=""')
    expect(lead).not.toContain('title=')
  })

  it('renders the browser view toggle button only when wired', () => {
    const base = {
      catalog: null,
      selection: null,
      onSelectModel: () => {},
      onOpenSettings: () => {},
    }
    const without = renderToStaticMarkup(createElement(NexusTopBar, base))
    expect(without).not.toContain('data-testid="topbar-open-browser-window"')

    const withButton = renderToStaticMarkup(
      createElement(NexusTopBar, { ...base, onToggleAgentZone: () => {} }),
    )
    expect(withButton).toContain('data-testid="topbar-open-browser-window"')
  })

  // With no browser tab to show, the toggle opens a HOST browser window
  // (`ui.openBrowserWindow`, `full`). A scoped client has no tab counts and no
  // docked view, so that is all the button could do, and the runtime refused
  // it: a click did nothing. The button is not rendered without the route.
  // The grants come from the real scope tables.
  describe('the browser view toggle follows the grant', () => {
    const wired = {
      catalog: null,
      selection: null,
      onSelectModel: () => {},
      onOpenSettings: () => {},
      onToggleAgentZone: () => {},
    }
    const markupFor = (mode: ScopeMode) =>
      renderToStaticMarkup(
        createElement(
          RuntimeCapabilitiesContext.Provider,
          { value: queryFor(advertsForScope(mode)) },
          createElement(NexusTopBar, wired),
        ),
      )

    it('renders for a full grant', () => {
      expect(markupFor('full')).toContain('data-testid="topbar-open-browser-window"')
    })

    it.each<ScopeMode>(['manager', 'control', 'observe'])(
      'is not rendered for a %s grant',
      mode => {
        const markup = markupFor(mode)
        expect(markup).not.toContain('data-testid="topbar-open-browser-window"')
        // The rest of the bar is still there.
        expect(markup).toContain('data-slot="nexus-topbar"')
      },
    )
  })

  it('renders the Right Panel toggle button only when wired', () => {
    const base = {
      catalog: null,
      selection: null,
      onSelectModel: () => {},
      onOpenSettings: () => {},
    }
    const without = renderToStaticMarkup(createElement(NexusTopBar, base))
    expect(without).not.toContain('data-testid="topbar-background-tasks"')

    const withButton = renderToStaticMarkup(
      createElement(NexusTopBar, { ...base, onToggleRightPanel: () => {} }),
    )
    expect(withButton).toContain('data-testid="topbar-background-tasks"')
  })

  it('reflects the Right Panel visibility as the toggle pressed state + label', () => {
    const base = {
      catalog: null,
      selection: null,
      onSelectModel: () => {},
      onOpenSettings: () => {},
      onToggleRightPanel: () => {},
    }
    // Hidden → not pressed, "show" label.
    const hidden = renderToStaticMarkup(
      createElement(NexusTopBar, { ...base, rightPanelVisible: false }),
    )
    expect(hidden).toContain('aria-label="Show side panel"')
    expect(hidden).not.toContain('aria-pressed="true"')
    // Shown → pressed, "hide" label.
    const shown = renderToStaticMarkup(
      createElement(NexusTopBar, { ...base, rightPanelVisible: true }),
    )
    expect(shown).toContain('aria-label="Hide side panel"')
    expect(shown).toContain('aria-pressed="true"')
  })
})
