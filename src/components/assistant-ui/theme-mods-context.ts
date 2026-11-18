import { createContext, useContext } from 'react'

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
  /** Enable or disable the plugin itself; rejects with the reason. */
  setEnabled?: (mod: ThemeModEntry, enabled: boolean) => Promise<void>
  /** Open the place themes are installed from. */
  openThemeStore?: () => void
}

/** Undefined outside a window that manages themes: no menu. */
export const ThemeModsContext = createContext<ThemeModsContextValue | undefined>(undefined)

export function useThemeModsContext(): ThemeModsContextValue | undefined {
  return useContext(ThemeModsContext)
}
