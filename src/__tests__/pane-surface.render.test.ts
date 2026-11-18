// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { BackgroundTasksDrawer } from '../browser/webview/BackgroundTasksDrawer'
import { PlanDetailsPanel } from '../browser/webview/PlanDetailsPanel'
import { I18nProvider } from '../browser/webview/i18n'
import { PaneFrame } from '../browser/webview/panes/PaneFrame'
import { PANE_BODY, PANE_SURFACE } from '../browser/webview/panes/paneSurface'

/**
 * Every side pane shows one surface (F-9): the frame paints it, a body paints
 * none, so a theme's glass frosts each pane through one layer alike.
 */

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
const GROUND = /\bbg-(background|card|base-surface|toolbar|sidebar)\b/

afterEach(() => {
  cleanup()
})

describe('side pane surface', () => {
  it('the frame paints the surface and a body paints no ground', () => {
    expect(PANE_SURFACE).toMatch(GROUND)
    expect(PANE_BODY).not.toMatch(/\bbg-/)
    for (const maximized of [false, true]) {
      const view = render(
        createElement(PaneFrame, {
          kind: 'diff',
          name: 'Diff',
          title: 'Diff',
          maximized,
          onToggleMaximized: () => {},
          onClose: () => {},
          children: null,
        }),
      )
      const classes = view.getByTestId('pane-diff').classList
      for (const token of PANE_SURFACE.split(' ')) expect(classes.contains(token)).toBe(true)
      view.unmount()
    }
  })

  it('each pane body roots on the shared body class', () => {
    const bodies = [
      'browser/webview/BackgroundTasksDrawer.tsx',
      'browser/webview/PlanDetailsPanel.tsx',
      'browser/webview/SkillPanel.tsx',
      'browser/webview/DiffPanel.tsx',
      'browser/webview/panes/SideChatPane.tsx',
      'browser/webview/shellSidePane.tsx',
      'browser/webview/a2ui/A2uiProviderHost.tsx',
    ]
    const missing = bodies.filter(rel => !read(rel).includes('className={PANE_BODY}'))
    expect(missing).toEqual([])
  })

  it('the terminal placeholder leaves the frame surface showing', () => {
    const text = read('browser/webview/terminal/TerminalPane.tsx')
    const match = /data-testid="pane-terminal-placeholder"[^<]*?className="([^"]*)"/.exec(text)
    expect(match).not.toBeNull()
    expect(match![1]).not.toMatch(GROUND)
  })

  it('the Background Tasks and Plan bodies render without a ground of their own', () => {
    const drawer = render(
      createElement(
        I18nProvider,
        null,
        createElement(BackgroundTasksDrawer, {
          rows: [],
          onClose: () => {},
          onStop: () => {},
          onResume: () => {},
          loadTranscript: async () => null,
        }),
      ),
    )
    const drawerRoot = drawer.getByTestId('background-tasks-drawer')
    expect(drawerRoot.className).toBe(PANE_BODY)
    drawer.unmount()

    const plan = render(
      createElement(
        I18nProvider,
        null,
        createElement(PlanDetailsPanel, {
          entry: {
            toolCallId: 'tc-1',
            request: { toolName: 'ExitPlanMode', planText: '# Plan', planFilePath: '/tmp/plan.md', restoreMode: 'default' },
          },
          onClose: () => {},
        }),
      ),
    )
    expect(plan.getByTestId('plan-details-panel').className).toBe(PANE_BODY)
  })
})
