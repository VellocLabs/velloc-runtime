// @vitest-environment happy-dom
/**
 * The provider-missing prompt read (`ui.getProviderMissingPrompt`, `full`) is not issued without the action; the
 * hook stays `null` (catalog strings). Grants come from the real scope tables.
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

import type { ProviderMissingPrompt } from '../browser/bridge/browserBridgeProtocol'
import type { ScopeMode } from '../browser/runtimeProtocol'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { useProviderMissingPrompt } from '../browser/webview/useProviderMissingPrompt'
import type { AgentRuntimeWorkerSnapshot } from '../browser/worker/workerProtocol'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

afterEach(() => cleanup())

const PROMPT: ProviderMissingPrompt = {
  header: { iconSvg: '', title: 'Host title', caption: 'Host caption' },
  dialog: {
    title: 'Set up a model provider',
    description: 'From the host',
    confirmLabel: 'Open settings',
    cancelLabel: 'Cancel',
  },
}

/** The hook reads only the snapshot's presence and identity. */
const SNAPSHOT = { sessionId: 's1' } as unknown as AgentRuntimeWorkerSnapshot

function renderPrompt(
  capabilities: CapabilityQuery | undefined,
  options: { hasValidProvider?: boolean; snapshot?: AgentRuntimeWorkerSnapshot | null } = {},
) {
  const load = vi.fn(async () => PROMPT)
  const wrapper = capabilities
    ? ({ children }: { children: ReactNode }) =>
        createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, children)
    : undefined
  const hook = renderHook(
    () =>
      useProviderMissingPrompt(
        load,
        options.snapshot === undefined ? SNAPSHOT : options.snapshot,
        options.hasValidProvider ?? false,
      ),
    wrapper ? { wrapper } : undefined,
  )
  return { load, hook }
}

/** Let the effect's promise settle, so an issued read would have landed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('useProviderMissingPrompt — the read follows the grant', () => {
  it.each([
    ['with no capability provider (the desktop tree)', undefined],
    ['for a full grant', queryFor(advertsForScope('full'))],
  ])('reads the host strings %s', async (_label, capabilities) => {
    const { load, hook } = renderPrompt(capabilities)
    await waitFor(() => expect(hook.result.current).toEqual(PROMPT))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it.each<ScopeMode>(['manager', 'control', 'observe'])(
    'never issues the read for a %s grant, and stays null (catalog strings)',
    async mode => {
      const { load, hook } = renderPrompt(queryFor(advertsForScope(mode)))
      await settle()
      expect(load).not.toHaveBeenCalled()
      expect(hook.result.current).toBeNull()
    },
  )

  it('reads nothing while a provider is valid or before the first snapshot, whatever the grant', async () => {
    const valid = renderPrompt(undefined, { hasValidProvider: true })
    const early = renderPrompt(undefined, { snapshot: null })
    await settle()
    expect(valid.load).not.toHaveBeenCalled()
    expect(early.load).not.toHaveBeenCalled()
  })
})
