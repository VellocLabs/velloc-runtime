import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip'

import type { ScopeMode } from '../browser/runtimeProtocol'
import { NexusTopBar, type NexusTopBarProps } from '../browser/webview/topbar/NexusTopBar'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

// NexusTopBar mounts outside the <TooltipProvider> inside AssistantUiThread, so it wraps its own. This renders it
// with no provider ancestor via react-dom/server and asserts it does not throw.
const BASE: NexusTopBarProps = {
  catalog: null,
  selection: null,
  onSelectModel: () => {},
  onOpenSettings: () => {},
}

function markup(props: Partial<NexusTopBarProps> = {}): string {
  return renderToStaticMarkup(createElement(NexusTopBar, { ...BASE, ...props }))
}

/** The opening tag of the control with `testId`, or '' when it is not rendered. */
function tag(html: string, testId: string): string {
  return new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? ''
}

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
      markup({ sidebarCollapsed: false, onToggleSidebar: () => {}, onTogglePane: () => {} }),
    ).not.toThrow()
  })

  // A teammate keeps the model its lead spawned it on: a pick made on its tab
  // moved four teammates of one run onto the lead's model (and could move a
  // trusted child onto an untrusted relay). The picker is read-only there,
  // and says why.
  it('the model picker is read-only on a teammate tab, and says why', () => {
    const teammate = tag(markup({ activeSessionId: 'teammate-lead-1-worker-a-1789000000000' }), 'nexus-model-picker-trigger')
    expect(teammate).toContain('disabled=""')
    expect(teammate).toContain('title="A teammate keeps the model it was started with.')

    const lead = tag(markup({ activeSessionId: 'lead-1' }), 'nexus-model-picker-trigger')
    expect(lead).not.toContain('disabled=""')
    expect(lead).not.toContain('title=')
  })

  it('the sidebar toggle sits in the left group, right after the model picker', () => {
    const html = markup({ sidebarCollapsed: false, onToggleSidebar: () => {}, onTogglePane: () => {} })
    const right = html.indexOf('data-testid="topbar-right-group"')
    const toggle = html.indexOf('data-testid="topbar-sidebar-toggle"')
    const settings = html.indexOf('data-testid="topbar-settings"')
    expect(toggle).toBeGreaterThan(settings)
    expect(toggle).toBeLessThan(right)
    // Nothing but the model picker stands between the settings button and the toggle.
    expect(html.slice(settings, toggle).match(/<button/g)?.length).toBe(2)
  })

  it('in a CLI session shows only Settings and the sidebar toggle (F-34)', () => {
    // What the shell passes while a CLI session is active: no model picker,
    // no session tabs, panes, rail, search, imports or plugin items.
    const html = markup({ hideModelPicker: true, sidebarCollapsed: false, onToggleSidebar: () => {} })
    const buttons = [...html.matchAll(/<button[^>]*data-testid="([^"]+)"/g)].map(match => match[1])
    expect(buttons).toEqual(['topbar-settings', 'topbar-sidebar-toggle'])
    expect(html).not.toContain('nexus-model-picker-trigger')
  })

  describe('the right column', () => {
    it('holds the session rail toggle, a divider, the pane toggles and the More menu, in that order', () => {
      const html = markup({
        sidebarCollapsed: false,
        onToggleSidebar: () => {},
        onTogglePane: () => {},
        sessionOverview: { shown: true, onToggle: () => {} },
      })
      const group = /<div[^>]*data-testid="topbar-right-group"[\s\S]*$/.exec(html)?.[0] ?? ''
      const order = [
        'topbar-session-rail',
        'topbar-session-rail-divider',
        'topbar-pane-terminal',
        'topbar-pane-diff',
        'topbar-pane-browser',
        'topbar-pane-files',
        'topbar-more-panes',
      ].map(id => group.indexOf(`data-testid="${id}"`))
      expect(order.every(index => index >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      expect(group).not.toContain('topbar-sidebar-toggle')
      // The retired controls are gone.
      for (const id of ['topbar-background-tasks', 'topbar-session-cards', 'topbar-open-browser-window']) {
        expect(html).not.toContain(id)
      }
    })

    it('the session rail toggle is pressed exactly when the card stack is shown', () => {
      const shown = tag(markup({ sessionOverview: { shown: true, onToggle: () => {} } }), 'topbar-session-rail')
      expect(shown).toContain('aria-pressed="true"')
      expect(shown).toContain('aria-label="Hide Session rail"')
      const hidden = tag(markup({ sessionOverview: { shown: false, onToggle: () => {} } }), 'topbar-session-rail')
      expect(hidden).toContain('aria-pressed="false"')
      expect(hidden).toContain('aria-label="Show Session rail"')
    })

    it('a terminal and a files toggle follow the layout like any pane', () => {
      for (const kind of ['terminal', 'files'] as const) {
        expect(tag(markup({ onTogglePane: () => {} }), `topbar-pane-${kind}`)).toContain('aria-pressed="false"')
        expect(tag(markup({ onTogglePane: () => {}, openPanes: [kind] }), `topbar-pane-${kind}`)).toContain(
          'aria-pressed="true"',
        )
      }
    })

    it('renders no pane toggle and no More menu on a host without panes', () => {
      const html = markup({ sidebarCollapsed: false, onToggleSidebar: () => {} })
      expect(html).toContain('topbar-sidebar-toggle')
      expect(html).not.toContain('topbar-pane-diff')
      expect(html).not.toContain('topbar-more-panes')
    })

    it('a pane toggle is pressed exactly when its pane is in the layout, with the matching label', () => {
      const closed = tag(markup({ onTogglePane: () => {}, openPanes: ['tasks'] }), 'topbar-pane-diff')
      expect(closed).toContain('aria-pressed="false"')
      expect(closed).toContain('aria-label="Show Diff"')
      const open = tag(markup({ onTogglePane: () => {}, openPanes: ['tasks', 'diff'] }), 'topbar-pane-diff')
      expect(open).toContain('aria-pressed="true"')
      expect(open).toContain('aria-label="Hide Diff"')
    })

    // The browser is a pane of the layout: its toggle is pressed exactly when
    // the pane is in the tree, whatever the session's tab count (the shell
    // decides what a press does: close, open, or create the first tab).
    it('the browser toggle follows the layout like any pane', () => {
      const closed = tag(markup({ onTogglePane: () => {}, openPanes: ['diff'] }), 'topbar-pane-browser')
      expect(closed).toContain('aria-pressed="false"')
      expect(closed).toContain('aria-label="Show Browser"')
      const open = tag(markup({ onTogglePane: () => {}, openPanes: ['browser'] }), 'topbar-pane-browser')
      expect(open).toContain('aria-pressed="true"')
      expect(open).toContain('aria-label="Hide Browser"')
      expect(markup({ onTogglePane: () => {} })).toContain('topbar-pane-browser')
    })

    it('the running-task badge sits on the More button', () => {
      const html = markup({ onTogglePane: () => {}, backgroundTaskCount: 3 })
      const more = /<button[^>]*data-testid="topbar-more-panes"[\s\S]*?<\/button>/.exec(html)?.[0] ?? ''
      expect(more).toContain('data-testid="topbar-running-tasks"')
      expect(more).toContain('>3<')
      expect(markup({ onTogglePane: () => {}, backgroundTaskCount: 0 })).not.toContain('topbar-running-tasks')
    })
  })

  // The browser pane shows THIS window's native tab view and its toggle
  // creates a session tab in this window (`ui.openSessionTab`, `full`). A
  // scoped client has no tab counts and no native view, so the button is not
  // rendered without the route. The grants come from the real scope tables.
  describe('the browser toggle follows the grant', () => {
    const wired: NexusTopBarProps = {
      ...BASE,
      onTogglePane: () => {},
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
      expect(markupFor('full')).toContain('data-testid="topbar-pane-browser"')
    })

    it.each<ScopeMode>(['manager', 'control', 'observe'])(
      'is not rendered for a %s grant',
      mode => {
        const html = markupFor(mode)
        expect(html).not.toContain('data-testid="topbar-pane-browser"')
        // The rest of the bar is still there.
        expect(html).toContain('data-slot="nexus-topbar"')
        expect(html).toContain('data-testid="topbar-pane-diff"')
      },
    )
  })

  // A terminal runs programs on the host as the person (`terminal.create`,
  // `full`): a paired remote client never sees the toggle, and neither does
  // a host that reports no pseudoconsole.
  describe('the terminal toggle follows the grant and the host', () => {
    const markupFor = (mode: ScopeMode, props: Partial<NexusTopBarProps> = {}) =>
      renderToStaticMarkup(
        createElement(
          RuntimeCapabilitiesContext.Provider,
          { value: queryFor(advertsForScope(mode)) },
          createElement(NexusTopBar, { ...BASE, onTogglePane: () => {}, ...props }),
        ),
      )

    it('renders for a full grant on a host with terminals', () => {
      expect(markupFor('full')).toContain('data-testid="topbar-pane-terminal"')
      expect(markupFor('full', { terminalAvailable: true })).toContain('data-testid="topbar-pane-terminal"')
    })

    it.each<ScopeMode>(['manager', 'control', 'observe'])('is not rendered for a %s grant', mode => {
      const html = markupFor(mode)
      expect(html).not.toContain('data-testid="topbar-pane-terminal"')
      expect(html).toContain('data-testid="topbar-pane-diff"')
    })

    it('is not rendered when the host reports no pseudoconsole', () => {
      const html = markupFor('full', { terminalAvailable: false })
      expect(html).not.toContain('data-testid="topbar-pane-terminal"')
      expect(html).toContain('data-testid="topbar-pane-diff"')
    })
  })
})
