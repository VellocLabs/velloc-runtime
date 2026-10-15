// @vitest-environment happy-dom
/**
 * The provider-missing dialog's "Open settings" button opens Settings → Models (`providers.*`, `manager`): it is not
 * rendered for a control or observe connection; the dialog still explains and Cancel restores the draft.
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import type { ScopeMode } from '../browser/runtimeProtocol'
import { ProviderMissingDialog } from '../browser/webview/ThreadDialogs'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

afterEach(() => cleanup())

/** The dialog restores the draft through the composer, so it needs a runtime. */
function WithRuntime({ children }: { children: ReactNode }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: m => m,
    isRunning: false,
    onNew: async () => {},
  })
  return createElement(AssistantRuntimeProvider, { runtime }, children)
}

function renderDialog(
  capabilities: CapabilityQuery | undefined,
  onOpenSettings: () => void,
) {
  const tree = createElement(
    WithRuntime,
    null,
    createElement(ProviderMissingDialog, {
      pendingText: '',
      resources: null,
      onClose: () => {},
      onOpenSettings,
    }),
  )
  return render(
    capabilities
      ? createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, tree)
      : tree,
  )
}

describe('ProviderMissingDialog — Open settings follows the grant', () => {
  it.each([
    ['with no capability provider (the desktop tree)', undefined],
    ['for a full grant', queryFor(advertsForScope('full'))],
    ['for a manager grant', queryFor(advertsForScope('manager'))],
  ])('offers Open settings %s', async (_label, capabilities) => {
    const onOpenSettings = vi.fn()
    renderDialog(capabilities, onOpenSettings)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledTimes(1))
  })

  it.each<ScopeMode>(['control', 'observe'])(
    'offers only Cancel for a %s grant, which cannot open Settings → Models',
    mode => {
      renderDialog(queryFor(advertsForScope(mode)), vi.fn())
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(screen.getByText('Set up a model provider')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    },
  )
})
