/**
 * The window's share of a mod theme (F-25): the active session's theme on the
 * shell, the backdrop's reach, and the conversation's theme menu.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { ModsUiTheme } from '../runtimeProtocol'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { ModBackdrop, ModShellPaintsThemeContext, ModWindowThemeContext, useThemeLookOf, useWindowColorScheme, type ModThemeLook } from '@/components/assistant-ui/mod-theme'
import { ModUiContext, type ModUiContextValue } from '@/components/assistant-ui/mod-ui-context'
import { ThemeModsContext, type ThemeModsContextValue } from '@/components/assistant-ui/theme-mods-context'
import { DEFAULT_THEME_BACKDROP_SCOPE } from '@/mods/themeMods'
import type { NexusSettingsBridge } from './nexusSettingsBridge'
import { askThemeOnEnable, useThemeMods } from './mods/themeModsView'
import { useThemeModsMenu } from './mods/useThemeModsMenu'
import { useNexusSessionStatus, useSessionStatusChannel } from './topbar/useNexusSessionStatus'
import type { CapabilityQuery } from './useCan'

export type ShellTheme = {
  /** What the shell's `<main>` carries: tokens, `data-mod-*` attributes, the mode's class. */
  look: ModThemeLook
  /** The shell draws the backdrop behind the whole window; a thread inside draws none. */
  paintsBackdrop: boolean
  menu: ThemeModsContextValue | undefined
}

/** How long the window keeps the previous session's theme for a session that
 *  never says whether it has one. */
export const THEME_HOLD_MS = 10_000

/**
 * Contract: the mod UI the window paints its theme from (F-25). After a
 * switch to another session it is the previous session's whole value, until
 * the new one shows a theme, says its mods settled without one, or
 * `THEME_HOLD_MS` passes. A theme that goes while its session stays shown
 * goes at once. `holds` false (no session, or one whose mods this app does
 * not run) never holds.
 */
export function useThemeAcrossSwitch(
  sessionId: string | undefined,
  modUi: ModUiContextValue,
  holds: boolean,
): ModUiContextValue {
  const painted = useRef<ModUiContextValue | undefined>(undefined)
  const shown = useRef<string | undefined>(undefined)
  const waiting = useRef(false)
  const [, expire] = useState(0)
  if (shown.current !== sessionId) {
    shown.current = sessionId
    waiting.current = sessionId !== undefined && painted.current !== undefined
  }
  const isKnown = modUi.theme !== undefined || (modUi.isLoaded === true && modUi.modsSettled === true)
  if (isKnown || !holds) waiting.current = false
  const isHolding = waiting.current
  useEffect(() => {
    if (!isHolding) return
    const timer = setTimeout(() => {
      waiting.current = false
      expire(count => count + 1)
    }, THEME_HOLD_MS)
    return () => clearTimeout(timer)
  }, [isHolding, sessionId])
  if (isHolding && painted.current) return painted.current
  painted.current = modUi.theme ? modUi : undefined
  return modUi
}

export function useShellTheme(options: {
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined
  /** The active session's standing theme. */
  theme: ModsUiTheme | undefined
  capabilities: CapabilityQuery
  isRemoteHost: boolean
  settingsBridge: NexusSettingsBridge | null | undefined
  /** Opens Customize on its theme directory. */
  openThemeStore: () => void
  /** The session the window shows, unless a CLI runs it; a theme plugin turned on is started there. */
  themeTarget?: { sessionId: string; busy: boolean } | null
}): ShellTheme {
  const { runtimeConnection, theme, capabilities, isRemoteHost, settingsBridge, openThemeStore } = options
  const target = useRef(options.themeTarget)
  target.current = options.themeTarget
  const canOnEnable = capabilities.can('theme', 'onEnable')
  const afterEnable = useCallback(
    (plugin: string) => {
      const shown = target.current
      if (!runtimeConnection || !canOnEnable || !shown) return
      // During a turn the runtime runs the plugin's command once the turn ends.
      askThemeOnEnable(runtimeConnection, shown.sessionId, plugin, { waitForTurn: shown.busy })
    },
    [runtimeConnection, canOnEnable],
  )
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
    canTurnOffAll: capabilities.can('themeMods', 'turnOffAll'),
    runtimeConnection,
    canUseLook: capabilities.can('theme', 'useLook'),
    lookTarget: options.themeTarget ?? null,
    ...(themeStoreShown ? { openThemeStore } : {}),
    afterEnable,
  })
  return { look, paintsBackdrop: backdropScope === 'window' && theme?.backdrop !== undefined, menu }
}

/** The contexts every conversation inside the window reads the theme through. */
export function ShellThemeProviders({ shellTheme, children }: { shellTheme: ShellTheme; children: ReactNode }) {
  return (
    <ThemeModsContext.Provider value={shellTheme.menu}>
      <ModWindowThemeContext.Provider value={shellTheme.look.theme}>
        <ModShellPaintsThemeContext.Provider value={shellTheme.paintsBackdrop}>{children}</ModShellPaintsThemeContext.Provider>
      </ModWindowThemeContext.Provider>
    </ThemeModsContext.Provider>
  )
}

/** The backdrop behind the whole window, where the shell paints it. */
export function ShellBackdrop({ shellTheme, modUi, sessionId }: { shellTheme: ShellTheme; modUi: ModUiContextValue; sessionId: string | null }) {
  if (!shellTheme.paintsBackdrop) return null
  return <PaintedShellBackdrop modUi={modUi} sessionId={sessionId} />
}

/** Still while the session on screen runs a turn, by its own status feed. */
function PaintedShellBackdrop({ modUi, sessionId }: { modUi: ModUiContextValue; sessionId: string | null }) {
  const { sessionPhase } = useNexusSessionStatus(useSessionStatusChannel(), sessionId)
  return (
    <ModShellPaintsThemeContext.Provider value={false}>
      <ModUiContext.Provider value={modUi}>
        <ModBackdrop isWorking={sessionPhase.kind !== 'idle'} />
      </ModUiContext.Provider>
    </ModShellPaintsThemeContext.Provider>
  )
}
