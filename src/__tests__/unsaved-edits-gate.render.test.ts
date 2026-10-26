// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../components/ui/dialog'
import {
  hasUnsavedEdits,
  registerUnsavedEdits,
} from '../glic/unsavedEditsGate'
import { EditableField } from '../browser/webview/settings/EditableField'
import { McpSection } from '../browser/webview/settings/sections/McpSection'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import {
  ProjectFolderDialog,
  ProviderMissingDialog,
} from '../browser/webview/ThreadDialogs'
import { ProjectDeleteDialog } from '../browser/webview/MultiSessionShell'

/**
 * The "unsaved edits" gate (glic/unsavedEditsGate.ts): no background reload of a hidden page while a surface holds
 * it. Pins the registry and the shared registration points (dialogs, `EditableField`, the MCP form).
 */

afterEach(() => {
  cleanup()
  ;(globalThis as { __nexusUnsavedEdits?: number }).__nexusUnsavedEdits = 0
})

describe('unsavedEditsGate registry', () => {
  it('counts holds on the window global, and a release is idempotent', () => {
    const target: { __nexusUnsavedEdits?: number } = {}
    const a = registerUnsavedEdits(target)
    const b = registerUnsavedEdits(target)
    expect(target.__nexusUnsavedEdits).toBe(2)
    a()
    a()
    expect(hasUnsavedEdits(target)).toBe(true)
    b()
    expect(hasUnsavedEdits(target)).toBe(false)
    expect(target.__nexusUnsavedEdits).toBe(0)
  })
})

describe('registration points', () => {
  it('an open Dialog holds the gate; closing it releases', () => {
    const view = (open: boolean) =>
      createElement(
        Dialog,
        { open },
        createElement(
          DialogContent,
          { 'aria-describedby': undefined },
          createElement(DialogTitle, null, 'Title'),
        ),
      )
    const { rerender } = render(view(false))
    expect(hasUnsavedEdits()).toBe(false)
    rerender(view(true))
    expect(hasUnsavedEdits()).toBe(true)
    rerender(view(false))
    expect(hasUnsavedEdits()).toBe(false)
  })

  it('an EditableField holds the gate only while an edit differs from the value', () => {
    render(
      createElement(EditableField, {
        value: 'https://a.example',
        ariaLabel: 'Agent URL',
        onCommit: () => {},
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /Agent URL/ }))
    // Editing, but nothing changed yet.
    expect(hasUnsavedEdits()).toBe(false)
    const input = screen.getByLabelText('Agent URL')
    fireEvent.change(input, { target: { value: 'https://b.example' } })
    expect(hasUnsavedEdits()).toBe(true)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(hasUnsavedEdits()).toBe(false)
  })

  it('the MCP add/edit form holds the gate while open', async () => {
    const bridge = {
      request: vi.fn(async () => ({ servers: {} })),
      subscribeEvents: () => () => {},
    } as unknown as NexusSettingsBridge
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(McpSection, {}),
      ),
    )
    fireEvent.click(await screen.findByTestId('mcp-add-server'))
    expect(hasUnsavedEdits()).toBe(true)
    fireEvent.click(screen.getByTestId('mcp-cancel'))
    expect(hasUnsavedEdits()).toBe(false)
  })
})

/**
 * The three modals that do NOT use the shared Dialog primitive (so its
 * built-in hold does not cover them). Each is mounted only while shown, so
 * mounting it must hold the gate and unmounting must release it.
 */
describe('hand-rolled modals hold the gate while shown', () => {
  /** ProviderMissingDialog restores the held draft through the composer. */
  function WithRuntime({ children }: { children: ReactNode }) {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      convertMessage: m => m,
      isRunning: false,
      onNew: async () => {},
    })
    return createElement(AssistantRuntimeProvider, { runtime }, children)
  }

  it.each([
    [
      'ProviderMissingDialog',
      () =>
        createElement(
          WithRuntime,
          null,
          createElement(ProviderMissingDialog, {
            pendingText: 'held message',
            resources: null,
            onClose: () => {},
          }),
        ),
    ],
    [
      'ProjectFolderDialog',
      () =>
        createElement(ProjectFolderDialog, {
          onOpenFolder: async () => {},
          onCancel: () => {},
        }),
    ],
    [
      'ProjectDeleteDialog',
      () =>
        createElement(ProjectDeleteDialog, {
          path: '/work/api',
          sessionCount: 2,
          onCancel: () => {},
          onConfirm: () => {},
        }),
    ],
  ])('%s', (_name, dialog) => {
    expect(hasUnsavedEdits()).toBe(false)
    const { unmount } = render(dialog())
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(hasUnsavedEdits()).toBe(true)
    unmount()
    expect(hasUnsavedEdits()).toBe(false)
  })
})
