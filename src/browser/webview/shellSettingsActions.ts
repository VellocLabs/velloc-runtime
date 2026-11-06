import { type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { BrowserBridgeTransport, BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import {
  openPane,
  setMaximized,
  type SessionPaneRecord,
  CHAT_WEIGHT as PANE_CHAT_WEIGHT,
} from './layout/paneLayout'
import { type SessionLayoutsStore } from './layout/sessionLayouts'
import { forgetAskedPane, modsPaneWeight } from './layout/modsPane'
import { saveModPanesAsked } from './layout/layoutStorage'
import { setWindowDragRegions } from './nexusBridgeActions'
import type { WindowDragRect } from '../bridge/protocol/ui'
import type { SettingsSectionId } from './settings/SettingsScreen'

/** The Plugins pane's px around its body's cells: frame borders, the body's insets, the scrollbar's room. */
export const MODS_PANE_CHROME_PX = 40
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
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  sessionLayoutsStore: SessionLayoutsStore,
  modCellWidth: number,
  modRowWidthRef: RefObject<number>,
) {
  return (sessionId: string, columns: number | undefined, forward: boolean) => {
    updatePaneRecord(r => {
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
      const opened = openPane(r, 'mods', asked !== null ? { ...weights, mods: asked } : weights)
      return forward && opened.maximized !== null ? setMaximized(opened, 'mods') : opened
    }, sessionId)
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
export function createShellHandleCloseCustomize(
  setCustomizeOpen: Dispatch<SetStateAction<boolean>>,
) {
  return () => {
    setCustomizeOpen(false)
  }
}
export function createShellHandleOpenProviderSettings(
  setProviderSettingsRequest: Dispatch<SetStateAction<{ providerId: string; seq: number; } | null>>,
  setSettingsSection: Dispatch<SetStateAction<SettingsSectionId | null>>,
) {
  return (providerId: string) => {
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
