// Keeps the shell in step with the host and settings: the window title out; agent config, focus regain, installed CLIs and provider configs in.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  BrowserBridgeTransport,
  BrowserLlmSelection,
} from '../bridge/browserBridgeProtocol'
import type { useSessionManager } from './useSessionManager'
import type { useMultiSessionClients } from './useMultiSessionClients'
import type { useCapabilityQuery } from './useCan'
import type { useResolvedConnection } from './terminal/useTerminals'
import type { NexusSettingsBridge } from './nexusSettingsBridge'
import { setCustomProviderRecords } from '../../config/customProviderRegistry'
import {
  createProvidersReadGate,
  isProvidersChangedEvent,
  providersChangeAffectsCatalog,
} from './settings/clients'
import type { NexusProviderConfig } from '../../settings/settingsTypes'
import { setActiveSessionTitle, subscribeAgentConfig } from './nexusBridgeActions'
import {
  applyE2eTestCodePrefix,
  formatWindowTitle,
  getE2eTestCode,
  resolveActiveSessionWindowTitle,
  subscribeE2eTestCode,
} from './windowTitle'
import { getProductName } from '../../branding/productName'
import { getLauncherCatalog } from '../../prompting/templateCatalog'
import { TERMINAL_CAPABILITY } from '../../terminal/protocol'

type SessionClients = ReturnType<typeof useMultiSessionClients>

export type HostSettingsSyncInput = {
  hostBridgeTransport: BrowserBridgeTransport
  sessions: ReturnType<typeof useSessionManager>['sessions']
  activeSessionId: string
  setModelSelection: SessionClients['setModelSelection']
  setBrowserDefaultSelection: Dispatch<SetStateAction<BrowserLlmSelection | null>>
  pickGlobalDefaultSelection: (selection: BrowserLlmSelection) => void
  refreshModelCatalog: SessionClients['refreshModelCatalog']
  refreshProjectBranch: SessionClients['refreshProjectBranch']
  runtimeCapabilities: ReturnType<typeof useCapabilityQuery>
  terminalConnection: ReturnType<typeof useResolvedConnection>
  settingsBridge: NexusSettingsBridge | undefined
  setProviderOrder: Dispatch<SetStateAction<string[]>>
}

export function useHostSettingsSync({
  hostBridgeTransport,
  sessions,
  activeSessionId,
  setModelSelection,
  setBrowserDefaultSelection,
  pickGlobalDefaultSelection,
  refreshModelCatalog,
  refreshProjectBranch,
  runtimeCapabilities,
  terminalConnection,
  settingsBridge,
  setProviderOrder,
}: HostSettingsSyncInput): void {
  // Mirror the active session's title into the NATIVE window title via the host bridge (and
  // document.title). Under e2e (`?e2eTrace=1`) the running test's code is prefixed; in
  // production `applyE2eTestCodePrefix` is the identity function.
  const e2eTestCode = useSyncExternalStore(
    subscribeE2eTestCode,
    getE2eTestCode,
    getE2eTestCode,
  )
  const activeWindowTitle = resolveActiveSessionWindowTitle(
    sessions,
    activeSessionId,
  )
  // Only the NATIVE title carries the prefix: `document.title` stays the bare composed
  // title, a guest-visible contract.
  const hostWindowTitle = applyE2eTestCodePrefix(activeWindowTitle, e2eTestCode)
  useEffect(() => {
    void setActiveSessionTitle(hostBridgeTransport, hostWindowTitle).catch(
      () => {
        // Best-effort — dev/mock hosts don't implement ui.setActiveSessionTitle.
      },
    )
    document.title = formatWindowTitle(activeWindowTitle, getProductName())
  }, [hostBridgeTransport, activeWindowTitle, hostWindowTitle])

  // `session.applyAgentConfig`: route only the `model` key to the active session and mirror
  // it into `browserDefaultSelection`; other keys are ignored (global keys ride `agent.changed`).
  useEffect(() => {
    return subscribeAgentConfig(hostBridgeTransport, event => {
      const model = event.config?.['model'] as
          | { providerId?: unknown; modelId?: unknown; thinkingTier?: unknown }
          | undefined
      if (
        model &&
        typeof model.providerId === 'string' &&
        typeof model.modelId === 'string'
      ) {
        const newSelection: BrowserLlmSelection = {
          providerId: model.providerId,
          modelId: model.modelId,
          ...(typeof model.thinkingTier === 'string'
            ? { thinkingTier: model.thinkingTier }
            : {}),
        }
        void setModelSelection(newSelection)
        setBrowserDefaultSelection(newSelection)
        // A profile-wide pick is a global one: new sessions follow it. The
        // runtime writes it to `~/.velloc/settings.json` `agent.model` and
        // publishes it to every page.
        pickGlobalDefaultSelection(newSelection)
      }
    })
  }, [
    hostBridgeTransport,
    setModelSelection,
    pickGlobalDefaultSelection,
  ])

  // Refresh the model catalogue and the git branch when the view regains focus. Two calls on
  // purpose: `refreshModelCatalog` does not re-resolve the branch.
  useEffect(() => {
    function triggerRefresh() {
      void refreshModelCatalog()
      void refreshProjectBranch()
    }

    function handleVisibilityChange() {
      if (typeof document !== 'undefined' && !document.hidden) {
        triggerRefresh()
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', triggerRefresh)
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', triggerRefresh)
      }
    }
  }, [refreshModelCatalog, refreshProjectBranch])

  // Re-read which CLIs are installed when the view regains focus (F-34), so a
  // CLI installed meanwhile gets its launcher. Only where the catalog lists one.
  const canRescanClis = runtimeCapabilities.can(TERMINAL_CAPABILITY, 'rescanClis')
  useEffect(() => {
    if (!terminalConnection || !canRescanClis) return
    if (!getLauncherCatalog().some(meta => meta.kind === 'terminal')) return
    const rescan = (): void => {
      if (document.hidden) return
      void terminalConnection.request(`${TERMINAL_CAPABILITY}.rescanClis`, {}).catch(() => {})
    }
    document.addEventListener('visibilitychange', rescan)
    window.addEventListener('focus', rescan)
    return () => {
      document.removeEventListener('visibilitychange', rescan)
      window.removeEventListener('focus', rescan)
    }
  }, [terminalConnection, canRescanClis])

  // Refresh the catalog on `providers.changed` too (an in-shell settings save fires no focus
  // event). One read gate for this and the boot read, so an older `providers.list` never wins.
  const providersReadGate = useMemo(() => createProvidersReadGate(), [])
  useEffect(() => {
    if (!settingsBridge) return
    return settingsBridge.subscribeEvents(envelope => {
      if (isProvidersChangedEvent(envelope)) {
        providersReadGate.noteChanged()
        const payload = envelope.payload as {
          configs?: Record<string, NexusProviderConfig>
          order?: string[]
          reason?: string
        }
        // Mirror the worker's registry into the PAGE realm. The two run in
        // separate JS contexts, each with its own `NEXUS_MODEL_CONFIG`, so
        // without this the shell-side lookups (context-window meter, tier
        // pills, curated-rule matching) would miss every custom model even
        // though the worker resolves them fine.
        if (payload?.configs) setCustomProviderRecords(payload.configs)
        if (Array.isArray(payload?.order)) setProviderOrder(payload.order)
        // A reorder configures no provider: the picker re-sorts from
        // `providerOrder` alone, so the catalog round trip is skipped.
        if (providersChangeAffectsCatalog(payload)) void refreshModelCatalog()
      }
    })
  }, [settingsBridge, refreshModelCatalog, providersReadGate])

  // Seed the page-realm custom-provider registry once at boot — the
  // `providers.changed` subscription above only fires on WRITES, so a
  // restored session on a custom provider would otherwise render with
  // built-in-only model metadata until the user touched the settings page.
  useEffect(() => {
    if (!settingsBridge) return
    let cancelled = false
    void providersReadGate
      .read(settingsBridge)
      .then(result => {
        // `null`: a `providers.changed` landed first and already applied a
        // state at least as new as this read.
        if (cancelled || !result) return
        setCustomProviderRecords(result.configs)
        // An older worker answers without `order`: keep the catalog order.
        if (Array.isArray(result.order)) setProviderOrder(result.order)
      })
      .catch(() => {
        /* best-effort — the worker seeds its own registry independently */
      })
    return () => {
      cancelled = true
    }
  }, [settingsBridge, providersReadGate])
}
