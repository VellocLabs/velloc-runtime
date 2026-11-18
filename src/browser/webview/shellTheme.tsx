/**
 * The window's share of a mod theme (F-25): the active session's theme on the
 * shell, the backdrop's reach, and the conversation's theme menu.
 */
import type { ReactNode } from 'react'

import type { ModsUiTheme } from '../runtimeProtocol'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { ModBackdrop, ModShellPaintsThemeContext, useThemeLookOf, useWindowColorScheme, type ModThemeLook } from '@/components/assistant-ui/mod-theme'
import { ModUiContext, type ModUiContextValue } from '@/components/assistant-ui/mod-ui-context'
import { ThemeModsContext, type ThemeModsContextValue } from '@/components/assistant-ui/theme-mods-context'
import { DEFAULT_THEME_BACKDROP_SCOPE } from '@/mods/themeMods'
import type { NexusSettingsBridge } from './nexusSettingsBridge'
import { useThemeMods } from './mods/themeModsView'
import { useThemeModsMenu } from './mods/useThemeModsMenu'
import type { CapabilityQuery } from './useCan'

export type ShellTheme = {
  /** What the shell's `<main>` carries: tokens, `data-mod-*` attributes, the mode's class. */
  look: ModThemeLook
  /** The shell draws the backdrop behind the whole window; a thread inside draws none. */
  paintsBackdrop: boolean
  menu: ThemeModsContextValue | undefined
}

export function useShellTheme(options: {
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined
  /** The active session's standing theme. */
  theme: ModsUiTheme | undefined
  capabilities: CapabilityQuery
  isRemoteHost: boolean
  settingsBridge: NexusSettingsBridge | null | undefined
  openCustomize: () => void
}): ShellTheme {
  const { runtimeConnection, theme, capabilities, isRemoteHost, settingsBridge, openCustomize } = options
  // Under the `conversation` reach the window shows the theme's colours and
  // mode on opaque surfaces, and each conversation draws the backdrop itself.
  const themeMods = useThemeMods(runtimeConnection)
  const backdropScope = themeMods.state?.backdropScope ?? DEFAULT_THEME_BACKDROP_SCOPE
  const look = useThemeLookOf(theme, backdropScope === 'window')
  useWindowColorScheme(look)
  // Customize is where themes are installed from; the menu's way there does
  // not wait for the channel that lists Customize in the top bar.
  const themeStoreShown = !isRemoteHost && capabilities.can('customizePage', 'show')
  const menu = useThemeModsMenu({
    view: themeMods,
    bridge: settingsBridge,
    canSetEnabled: capabilities.can('plugins', 'setEnabled') && capabilities.can('plugins', 'setLocalEnabled'),
    canSetBackdropScope: capabilities.can('themeMods', 'setBackdropScope'),
    ...(themeStoreShown ? { openThemeStore: openCustomize } : {}),
  })
  return { look, paintsBackdrop: backdropScope === 'window' && theme?.backdrop !== undefined, menu }
}

/** The contexts every conversation inside the window reads the theme through. */
export function ShellThemeProviders({ shellTheme, children }: { shellTheme: ShellTheme; children: ReactNode }) {
  return (
    <ThemeModsContext.Provider value={shellTheme.menu}>
      <ModShellPaintsThemeContext.Provider value={shellTheme.paintsBackdrop}>{children}</ModShellPaintsThemeContext.Provider>
    </ThemeModsContext.Provider>
  )
}

/** The backdrop behind the whole window, where the shell paints it. */
export function ShellBackdrop({ shellTheme, modUi }: { shellTheme: ShellTheme; modUi: ModUiContextValue }) {
  if (!shellTheme.paintsBackdrop) return null
  return (
    <ModShellPaintsThemeContext.Provider value={false}>
      <ModUiContext.Provider value={modUi}>
        <ModBackdrop />
      </ModUiContext.Provider>
    </ModShellPaintsThemeContext.Provider>
  )
}
