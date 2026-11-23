/**
 * Opening a provider's settings app from the Models page (F-27, F-40): the
 * same opener a topbar press uses, offered first to the app's background
 * module as an `app.press` with `trigger: "provider"`. Page-side; no runtime
 * action of its own.
 */

import * as React from 'react'
import type { ContributedApp } from '../../runtimeProtocol/modContributions'
import type { BrowserLlmProvider } from '../../bridge/protocol/nexus_llm'
import { isRouterMod } from '../settings/modRouterView'
import { runAppPress, type AppPressPort } from './appPress'
import { getModContributions } from '../mods/modContributionsView'

/** The app a provider's settings name, as the page publishes it. */
export type ProviderSettingsApp = Pick<ContributedApp, 'appId' | 'type' | 'title' | 'plugin'>

/** Opens a provider's settings app: Settings closes once the app is to open. */
export type ProviderAppOpener = (app: ProviderSettingsApp) => void

/** Provided by the shell around Settings and the topbar; absent where apps cannot open (no runtime connection). */
export const ProviderAppOpenerContext = React.createContext<ProviderAppOpener | undefined>(undefined)

/**
 * The published app with id `appId` of `plugin`: an app id another plugin
 * holds is never the provider's. The apps list is served on the beta channel
 * alone, so on stable there is none, and neither entry exists.
 */
export function providerSettingsApp(
  appId: string | undefined,
  plugin: string | undefined,
  apps: readonly ContributedApp[] | undefined,
): ContributedApp | undefined {
  if (appId === undefined || plugin === undefined || !apps) return undefined
  return apps.find(app => app.appId === appId && app.plugin === plugin)
}

/** True on the render a provider goes from not added to added: its settings app opens then. */
export function addedJustNow(before: boolean | undefined, now: boolean): boolean {
  return before === false && now
}

export type ProviderAppOpenerDeps = {
  /** Offers the open to the app's module; absent: the app opens at once. */
  port: AppPressPort | undefined
  /** The topbar's opener (`createOpenApp`). */
  openApp: (type: string) => void
  /** The sign-ins a plain press starts; absent: none. */
  signIn: ((urls: readonly string[]) => void) | undefined
  closeSettings: () => void
}

const publishedApps = (): readonly ContributedApp[] | undefined => getModContributions().apps

/**
 * A ready router that names a settings app is configured in that app alone
 * (F-27, F-40): opens it and returns true. Any other provider, or a router
 * whose plugin publishes no such app, opens nothing and returns false.
 */
export function openRouterSettingsApp(
  providerId: string,
  providers: readonly BrowserLlmProvider[] | undefined,
  open: ProviderAppOpener | undefined,
  apps: readonly ContributedApp[] | undefined = publishedApps(),
): boolean {
  if (!open) return false
  const mod = providers?.find(p => p.id === providerId)?.mod
  if (mod?.state !== 'ready' || !isRouterMod(mod)) return false
  const app = providerSettingsApp(mod.settingsApp, mod.plugin, apps)
  if (!app) return false
  open(app)
  return true
}

/** Plain-name inputs, so the shell's memo holds no render scope. */
export function createProviderAppOpener(
  deps: ProviderAppOpenerDeps,
  apps: () => readonly ContributedApp[] | undefined = publishedApps,
): ProviderAppOpener {
  let seq = 0
  return app => {
    const mine = ++seq
    const published = providerSettingsApp(app.appId, app.plugin, apps())
    runAppPress(
      deps.port,
      app.appId,
      {
        open: () => {
          deps.closeSettings()
          deps.openApp(app.type)
        },
        defaultSignIn: () => {
          if (published?.signInUrls?.length) deps.signIn?.(published.signInUrls)
        },
        // A settings app is opened from no icon, so there is nowhere to draw a menu.
        showMenu: () => undefined,
        isCurrent: () => mine === seq,
      },
      'provider',
    )
  }
}
