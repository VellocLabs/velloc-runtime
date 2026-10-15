import { describe, expect, it } from 'vitest'
import type { BrowserContextSnapshot } from '../browser/bridge/BrowserHostBridge'
import { buildBrowserSystemContext } from '../browser/context/buildBrowserSystemContext'

function createSnapshot(
  overrides: Partial<BrowserContextSnapshot['session']> = {},
): BrowserContextSnapshot {
  return {
    tabs: [],
    activeTab: null,
    session: {
      browserName: 'Chromium',
      tabCount: 0,
      ...overrides,
    },
    userProfile: null,
    workspace: null,
    domSnapshot: null,
    accessibilitySnapshot: null,
  }
}

describe('buildBrowserSystemContext', () => {
  it('returns an empty dict when nothing in the snapshot is system-stable', () => {
    // No locale, no timezone, no workspace, no actor state, no MCP — all
    // the per-turn-volatile keys (tabs, activeTab) intentionally live in
    // the per-input attachment user message instead. An empty dict here
    // means the C++ host emits no "System context:" heading at all.
    const context = buildBrowserSystemContext({
      snapshot: createSnapshot(),
      mcpClients: [],
    })

    expect(context).toEqual({})
  })

  it('emits locale and timezone as separate top-level keys when present', () => {
    // Each dict key becomes its own bullet via FormatContextSection
    // ("- locale: en-US"). Splitting them avoids the multi-line value
    // formatting issue where continuation lines lose the bullet prefix.
    const context = buildBrowserSystemContext({
      snapshot: createSnapshot({
        locale: 'en-US',
        timezone: 'America/Toronto',
      }),
      mcpClients: [],
    })

    expect(context.locale).toBe('en-US')
    expect(context.timezone).toBe('America/Toronto')
  })

  it('does not surface per-turn-volatile browser state', () => {
    // browserTabs / activeTab / browserActionTarget / browserObservationState
    // were previously rebuilt every turn from the live snapshot or message
    // history. Putting them in systemContext meant the system prompt changed
    // every time the user opened/closed/navigated a tab or browser_actions
    // returned a fresh observation, busting prompt cache. They now live in
    // the per-input "Browser context attachment" user message (browser
    // state) or come directly from data.observation.tab_id in tool results
    // (actor state).
    const snapshot = createSnapshot({
      locale: 'en-US',
    })
    snapshot.tabs = [
      { id: 1, active: true, title: 'Example', url: 'https://example.com' },
    ] as unknown as BrowserContextSnapshot['tabs']
    snapshot.activeTab = {
      id: 1,
      title: 'Example',
      url: 'https://example.com',
    } as unknown as BrowserContextSnapshot['activeTab']

    const context = buildBrowserSystemContext({
      snapshot,
      mcpClients: [],
    })

    expect(context.browserTabs).toBeUndefined()
    expect(context.activeTab).toBeUndefined()
    expect(context.browserActionTarget).toBeUndefined()
    expect(context.browserObservationState).toBeUndefined()
  })

  it('does not surface non-actionable browser metadata', () => {
    // browserName, browserVersion, webviewId, runtime cwd were previously
    // bundled under a multi-line `browserHost` value. Only locale + timezone
    // measurably affect model behavior; the rest is noise.
    const context = buildBrowserSystemContext({
      snapshot: createSnapshot({
        browserName: 'Chromium',
        browserVersion: '130.0.0',
        webviewId: 'nexus-direct-bridge',
        locale: 'en-US',
        timezone: 'America/Toronto',
      }),
      mcpClients: [],
    })

    expect(context.browserHost).toBeUndefined()
    for (const value of Object.values(context)) {
      expect(value).not.toContain('Chromium')
      expect(value).not.toContain('130.0.0')
      expect(value).not.toContain('nexus-direct-bridge')
    }
  })

  it('does not duplicate tools roster or system_prompt conventions', () => {
    const context = buildBrowserSystemContext({
      snapshot: createSnapshot(),
      mcpClients: [],
    })

    expect(context.browserCapabilities).toBeUndefined()
    expect(context.browserToolCallConventions).toBeUndefined()
  })

  it('does not include truncated dom or accessibility snapshots', () => {
    const snapshot = createSnapshot()
    snapshot.domSnapshot = { content: 'a'.repeat(1000) } as unknown as BrowserContextSnapshot['domSnapshot']
    snapshot.accessibilitySnapshot = { nodes: [{ id: 1 }] } as unknown as BrowserContextSnapshot['accessibilitySnapshot']

    const context = buildBrowserSystemContext({
      snapshot,
      mcpClients: [],
    })

    expect(context.domSnapshotSummary).toBeUndefined()
    expect(context.accessibilitySnapshotSummary).toBeUndefined()
  })
})
