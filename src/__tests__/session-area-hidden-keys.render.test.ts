// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import {
  ComposerModePicker,
  PermissionModeProvider,
} from '../components/assistant-ui/thread'
import { PlanDetailsPanel } from '../browser/webview/PlanDetailsPanel'
import { BackgroundTasksDrawer } from '../browser/webview/BackgroundTasksDrawer'
import { ProjectFolderDialog } from '../browser/webview/ThreadDialogs'
import { SessionAreaVisibleContext } from '../browser/webview/sessionAreaVisibility'

/**
 * The session area stays mounted (hidden) while Settings is open; every window/document keyboard handler in it
 * gates on `SessionAreaVisibleContext`, so none fires under Settings.
 */

afterEach(() => {
  cleanup()
})

function inArea(visible: boolean, child: ReactNode) {
  return createElement(SessionAreaVisibleContext.Provider, { value: visible }, child)
}

// Dispatched on `document` so both the document-level (plan panel, drawer)
// and the window-level (dialog, mode picker) listeners see it, as a real
// keypress bubbles.
const escape = () => fireEvent.keyDown(document, { key: 'Escape' })
const cycleMode = () =>
  fireEvent.keyDown(document, { key: 'M', ctrlKey: true, shiftKey: true })

describe('Ctrl+Shift+M permission-mode cycle', () => {
  function picker(visible: boolean, setMode: (mode: string) => void) {
    return inArea(
      visible,
      createElement(
        PermissionModeProvider,
        { value: { mode: 'default', isActive: true, setMode } },
        createElement(ComposerModePicker),
      ),
    )
  }

  it('cycles the mode while the session area is visible', () => {
    const setMode = vi.fn()
    render(picker(true, setMode))
    cycleMode()
    expect(setMode).toHaveBeenCalledTimes(1)
    expect(setMode.mock.calls[0][0]).not.toBe('default')
  })

  it('does NOT cycle the mode while the session area is hidden (Settings open)', () => {
    const setMode = vi.fn()
    render(picker(false, setMode))
    cycleMode()
    expect(setMode).not.toHaveBeenCalled()
  })

  it('defaults to visible outside the shell (single-thread embeds, tests)', () => {
    const setMode = vi.fn()
    render(
      createElement(
        PermissionModeProvider,
        { value: { mode: 'default', isActive: true, setMode } },
        createElement(ComposerModePicker),
      ),
    )
    cycleMode()
    expect(setMode).toHaveBeenCalledTimes(1)
  })
})

describe('Escape handlers inside the session area', () => {
  const planEntry = {
    toolCallId: 'tc-1',
    request: {
      toolName: 'ExitPlanMode',
      planText: '# Plan',
      planFilePath: '/tmp/plan.md',
      restoreMode: 'default' as const,
    },
  }

  it('PlanDetailsPanel closes on Escape only while visible', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      inArea(
        false,
        createElement(PlanDetailsPanel, { entry: planEntry, onResolve: async () => {}, onClose }),
      ),
    )
    escape()
    expect(onClose, 'hidden: Escape must not reach the panel').not.toHaveBeenCalled()
    unmount()

    render(
      inArea(
        true,
        createElement(PlanDetailsPanel, { entry: planEntry, onResolve: async () => {}, onClose }),
      ),
    )
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('BackgroundTasksDrawer closes on Escape only while visible', () => {
    const onClose = vi.fn()
    const drawer = () =>
      createElement(BackgroundTasksDrawer, {
        rows: [],
        onClose,
        onStop: () => {},
        onResume: () => {},
        loadTranscript: async () => null,
      })
    const { unmount } = render(inArea(false, drawer()))
    escape()
    expect(onClose, 'hidden: Escape must not reach the drawer').not.toHaveBeenCalled()
    unmount()

    render(inArea(true, drawer()))
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ProjectFolderDialog does not discard the session on Escape while hidden', () => {
    const onCancel = vi.fn()
    const dialog = () =>
      createElement(ProjectFolderDialog, { onOpenFolder: async () => {}, onCancel })
    const { unmount } = render(inArea(false, dialog()))
    escape()
    expect(onCancel, 'hidden: Escape must not discard the code session').not.toHaveBeenCalled()
    unmount()

    render(inArea(true, dialog()))
    escape()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
