import { createContext, useContext } from 'react'

import type { ThemePlugin } from '@/browser/webview/mods/themeLooks'
import type { ThemeUseLookResult } from '@/mods/modThemeLooks'
import type { ThemeBackdropScope, ThemeModEntry } from '@/mods/themeMods'

/** What the window offers a conversation's theme menu (F-25). An absent
 *  function is one this connection may not ask for. */
export type ThemeModsContextValue = {
  /** The plugins that have set a theme, oldest first. */
  mods: readonly ThemeModEntry[]
  backdropScope: ThemeBackdropScope
  /** Whether each mod's plugin is enabled, by plugin name, as stored; a mod it leaves out is not known yet. */
  enabled?: Readonly<Record<string, boolean>>
  /** Read the list again. */
  refresh: () => void
  setBackdropScope?: (scope: ThemeBackdropScope) => Promise<void>
  /** Enabling one mod disables the others. */
  single: boolean
  /** Enable or disable the plugin itself; rejects with the reason. */
  setEnabled?: (mod: ThemeModEntry, enabled: boolean) => Promise<void>
  /** Open the place themes are installed from. */
  openThemeStore?: () => void
  /** How many theme plugins the runtime counts as enabled, whether or not they have set a theme. */
  pluginsOn?: number
  /** Switch every theme plugin off; answers how many were on. */
  turnOffAll?: () => Promise<number>
  /** The built-in marketplace's theme listings whose plugin is enabled, as stored. */
  looks?: readonly ThemePlugin[]
  /** The session a look applies to, as the window shows it; null when it shows none that takes one. */
  lookTarget?: { sessionId: string; busy: boolean } | null
  /**
   * Apply a listed look in a session; the runtime decides what runs. With
   * `waitForTurn` it applies once the session's turn ends; null when a later
   * pick replaced it or it was cancelled.
   */
  applyLook?: (
    sessionId: string,
    plugin: string,
    lookId: string,
    options?: { waitForTurn?: boolean },
  ) => Promise<ThemeUseLookResult | null>
}

/** Undefined outside a window that manages themes: no menu. */
export const ThemeModsContext = createContext<ThemeModsContextValue | undefined>(undefined)

export function useThemeModsContext(): ThemeModsContextValue | undefined {
  return useContext(ThemeModsContext)
}
