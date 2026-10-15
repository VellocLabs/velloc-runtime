/**
 * React contexts for the settings surface. The bridge itself is
 * `runtimeClient/settingsBridgeOverConnection.ts`, on the one runtime connection.
 */

import { createContext, useContext } from 'react'

import type { SettingsBridge } from '../runtimeClient/settingsBridgeOverConnection'

/** What the settings UI holds — see `settingsBridgeOverConnection.ts`. */
export type NexusSettingsBridge = SettingsBridge

/** React context carrying the app-wide settings bridge. `null` on mock/dev
 *  hosts that don't wire one (callers gate on it). */
export const SettingsBridgeContext = createContext<NexusSettingsBridge | null>(
  null,
)

export function useSettingsBridge(): NexusSettingsBridge | null {
  return useContext(SettingsBridgeContext)
}

/**
 * Host-bridge actions the settings UI needs. The `ui` capability (reveal a
 * folder in the OS file manager) lives on the C++ direct/host transport, NOT
 * the worker settings bridge — so it's threaded separately. `null` on mock/dev
 * hosts; consumers gate on it (and fall back to showing the path).
 */
export type SettingsHostActions = {
  /** Reveal a folder/file path in the native OS file manager. */
  revealFolder: (path: string) => Promise<void>
}

/**
 * The session this window shows, for the settings pages whose answer depends on
 * a project (the instruction files). The runtime has no "current session" to
 * assume — the page says which one it means.
 */
export const SettingsSessionContext = createContext<string | null>(null)

export function useSettingsSession(): string | null {
  return useContext(SettingsSessionContext)
}

export const SettingsHostActionsContext =
  createContext<SettingsHostActions | null>(null)

export function useSettingsHostActions(): SettingsHostActions | null {
  return useContext(SettingsHostActionsContext)
}
