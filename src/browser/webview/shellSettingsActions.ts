import { type RefObject, type Dispatch, type SetStateAction } from 'react'
import type {
  BrowserBridgeTransport,
  BrowserLlmSelection,
  NexusSettingsSection,
  ProviderMissingPrompt,
} from '../bridge/browserBridgeProtocol'
import { CHAT_WEIGHT as PANE_CHAT_WEIGHT } from './layout/paneLayout'
import { type SessionLayoutsStore } from './layout/sessionLayouts'
import type { OpenSidePane } from './openSidePane'
import { forgetAskedPane, modsPaneWeight } from './layout/modsPane'
import { saveModPanesAsked } from './layout/layoutStorage'
import type { BrowserLlmProvider } from '../bridge/protocol/nexus_llm'
import { openRouterSettingsApp, type ProviderAppOpener } from './apps/providerSettingsApp'

/** The catalog rows and app opener a provider gear consults. */
export type RouterAppSource = {
  providers: readonly BrowserLlmProvider[] | undefined
  open: ProviderAppOpener | undefined
}
import { getProviderMissingPrompt, revealProjectFolder, setWindowDragRegions } from './nexusBridgeActions'
import type { WindowDragRect } from '../bridge/protocol/ui'
import type { SettingsSectionId } from './settings/SettingsScreen'
import { marketplaceAddSourceOf } from './customize/marketplaceAddCommand'

/** The Plugins pane's px around its body's cells: frame borders, the body's insets, the scrollbar's room. */
const MODS_PANE_CHROME_PX = 40
export function createShellHandleOpenPluginSettings(
  setProviderSettingsRequest: Dispatch<SetStateAction<{ providerId: string; seq: number; } | null>>,
  setMcpSettingsRequest: Dispatch<SetStateAction<{ server: string; seq: number; } | null>>,
  setPluginSettingsRequest: Dispatch<SetStateAction<{ plugin: string; seq: number; } | null>>,
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
) {
  return (plugin: string) => {
    setProviderSettingsRequest(null)
    setMcpSettingsRequest(null)
    setPluginSettingsRequest(prev => ({ plugin, seq: (prev?.seq ?? 0) + 1 }))
    setSettingsSection('plugins')
  }
}
export function createShellHandleOpenMcpServerSettings(
  setProviderSettingsRequest: Dispatch<SetStateAction<{ providerId: string; seq: number; } | null>>,
  setPluginSettingsRequest: Dispatch<SetStateAction<{ plugin: string; seq: number; } | null>>,
  setMcpSettingsRequest: Dispatch<SetStateAction<{ server: string; seq: number; } | null>>,
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
) {
  return (server: string) => {
    setProviderSettingsRequest(null)
    setPluginSettingsRequest(null)
    setMcpSettingsRequest(prev => ({ server, seq: (prev?.seq ?? 0) + 1 }))
    setSettingsSection('mcp')
  }
}
export function createShellWriteModPanesAsked(
  modPanesAskedRef: RefObject<readonly string[]>,
  setModPanesAsked: Dispatch<SetStateAction<readonly string[]>>,
) {
  return (next: readonly string[]) => {
    if (next === modPanesAskedRef.current) return
    modPanesAskedRef.current = next
    setModPanesAsked(next)
    saveModPanesAsked(next)
  }
}
export function createShellBringModsPane(
  openSidePane: OpenSidePane,
  sessionLayoutsStore: SessionLayoutsStore,
  modCellWidth: number,
  modRowWidthRef: RefObject<number>,
) {
  return (sessionId: string, columns: number | undefined, forward: boolean) => {
    const weights = sessionLayoutsStore.getSnapshot().weights
    const asked =
      weights.mods === undefined
        ? modsPaneWeight({
            columns,
            cellWidth: modCellWidth,
            chromeWidth: MODS_PANE_CHROME_PX,
            rowWidth: modRowWidthRef.current,
            chatWeight: PANE_CHAT_WEIGHT,
          })
        : null
    openSidePane('mods', {
      sessionId,
      foreground: false,
      takeExpansion: forward,
      ...(asked !== null ? { weight: asked } : {}),
    })
  }
}
export function createShellHandleCloseModTab(
  writeModPanesAsked: (next: readonly string[]) => void,
  modPanesAskedRef: RefObject<readonly string[]>,
  closeModPane: ((plugin: string, id: string) => Promise<void>) | undefined,
) {
  return (pane: { plugin: string; id: string }) => {
    writeModPanesAsked(forgetAskedPane(modPanesAskedRef.current, pane))
    void closeModPane?.(pane.plugin, pane.id)
  }
}
export function createShellHandleSettingsNavigate(
  setPluginSettingsRequest: Dispatch<SetStateAction<{ plugin: string; seq: number; } | null>>,
  setMcpSettingsRequest: Dispatch<SetStateAction<{ server: string; seq: number; } | null>>,
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
) {
  return (section: SettingsSectionId) => {
    setPluginSettingsRequest(null)
    setMcpSettingsRequest(null)
    setSettingsSection(section)
  }
}
export function createShellHandleOpenNexusSettings(
  setProviderSettingsRequest: Dispatch<SetStateAction<{ providerId: string; seq: number; } | null>>,
  setPluginSettingsRequest: Dispatch<SetStateAction<{ plugin: string; seq: number; } | null>>,
  setMcpSettingsRequest: Dispatch<SetStateAction<{ server: string; seq: number; } | null>>,
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
) {
  return (section: SettingsSectionId = 'models') => {
    setProviderSettingsRequest(null)
    setPluginSettingsRequest(null)
    setMcpSettingsRequest(null)
    setSettingsSection(section)
  }
}
export function createShellHandleOpenCustomize(
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
  setCustomizeOpen: Dispatch<SetStateAction<boolean>>,
) {
  return () => {
    setSettingsSection(null)
    setCustomizeOpen(true)
  }
}
/** Opens Customize on its theme directory. */
export function createShellHandleOpenThemeStore(
  setThemesRequest: Dispatch<SetStateAction<{ seq: number } | null>>,
  openCustomize: () => void,
) {
  return () => {
    setThemesRequest(prev => ({ seq: (prev?.seq ?? 0) + 1 }))
    openCustomize()
  }
}
export function createShellHandleCloseCustomize(
  setCustomizeOpen: Dispatch<SetStateAction<boolean>>,
) {
  return () => {
    setCustomizeOpen(false)
  }
}
/**
 * Takes a composer line that adds a marketplace (F-35) where Customize has an
 * entry: Customize opens on it instead of the line reaching the session.
 */
export function createShellInterceptMarketplaceAdd(
  customizeShown: boolean,
  setMarketplaceAddRequest: Dispatch<SetStateAction<{ source: string; seq: number } | null>>,
  openCustomize: () => void,
) {
  return (text: string): boolean => {
    if (!customizeShown) return false
    const source = marketplaceAddSourceOf(text)
    if (source === null) return false
    setMarketplaceAddRequest(prev => ({ source, seq: (prev?.seq ?? 0) + 1 }))
    openCustomize()
    return true
  }
}
export function createShellHandleOpenProviderSettings(
  setProviderSettingsRequest: Dispatch<SetStateAction<{ providerId: string; seq: number; } | null>>,
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
  /** Read at press time: a router's settings app opens straight away, never via Settings → Models (F-27, F-40). */
  routerApps?: RefObject<RouterAppSource>,
) {
  return (providerId: string) => {
    const source = routerApps?.current
    if (source && openRouterSettingsApp(providerId, source.providers, source.open)) return
    setProviderSettingsRequest(prev => ({ providerId, seq: (prev?.seq ?? 0) + 1 }))
    setSettingsSection('models')
  }
}
export function createShellHandleDragRegionsChange(
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return (regions: WindowDragRect[]) => {
    void setWindowDragRegions(hostBridgeTransport, regions).catch(() => {
      /* build-gated C++ route / mock host has no window to drag */
    })
  }
}
export function createShellHandleTopbarSelectModel(
  pickGlobalDefaultSelection: (selection: BrowserLlmSelection) => void,
  setModelSelection: (selection: BrowserLlmSelection) => Promise<void>,
) {
  return (selection: BrowserLlmSelection) => {
    pickGlobalDefaultSelection(selection)
    void setModelSelection(selection).catch(() => {})
  }
}
export function createShellHandleSessionSelectModel(
  setModelSelectionForSession: (sessionId: string, selection: BrowserLlmSelection) => Promise<void>,
) {
  return (sessionId: string, selection: BrowserLlmSelection) => {
    void setModelSelectionForSession(sessionId, selection).catch(() => {})
  }
}
export function createShellHandleSetAutoCompactWindow(
  setAutoCompactWindowForSession: (sessionId: string, value: number | "auto") => Promise<void>,
) {
  return (sessionId: string, value: number | 'auto') => {
    void setAutoCompactWindowForSession(sessionId, value).catch(() => {})
  }
}
export function createShellHandleOpenSettings(
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
) {
  return async (section?: NexusSettingsSection): Promise<void> => {
    // Settings render IN-APP (React) instead of the separate Lit
    // panel pane. Map the legacy bridge sections onto the React nav: the
    // webapp-URL field now lives under "About".
    const legacySection = section as string | undefined
    const mapped: SettingsSectionId =
      legacySection === 'mcp'
        ? 'mcp'
        : legacySection === 'webapp'
          ? 'about'
          : legacySection === 'tools'
            ? 'general'
            : 'models'
    setSettingsSection(mapped)
  }
}
export function createShellHandleLoadProviderMissingPrompt(
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return async (): Promise<ProviderMissingPrompt> =>
      getProviderMissingPrompt(hostBridgeTransport)
}
export function createShellSettingsHostActions(
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return (() => ({
      revealFolder: (path: string) =>
        revealProjectFolder(hostBridgeTransport, path),
    }))()
}

/**
 * Closes Settings, however it is left, and drops the requests that opened it
 * on a section. `adoptDefaultAfterSettings` arms the one-shot pass that
 * replaces a session's stale pinned model with the new default.
 */
export function createShellCloseSettings(
  setProviderSettingsRequest: Dispatch<SetStateAction<{ providerId: string; seq: number; } | null>>,
  setPluginSettingsRequest: Dispatch<SetStateAction<{ plugin: string; seq: number; } | null>>,
  setMcpSettingsRequest: Dispatch<SetStateAction<{ server: string; seq: number; } | null>>,
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
  adoptDefaultAfterSettings: { current: boolean },
) {
  return (): void => {
    adoptDefaultAfterSettings.current = true
    setProviderSettingsRequest(null)
    setPluginSettingsRequest(null)
    setMcpSettingsRequest(null)
    setSettingsSection(null)
  }
}
