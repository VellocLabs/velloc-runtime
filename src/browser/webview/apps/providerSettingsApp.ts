/**
 * Opening a provider's settings app from the Models page (F-27, F-40): the
 * same opener a topbar press uses, offered first to the app's background
 * module as an `app.press` with `trigger: "provider"`. Page-side; no runtime
 * action of its own.
 */

import * as React from 'react'
import type { ContributedApp } from '../../runtimeProtocol/modContributions'
import { runAppPress, type AppPressPort } from './appPress'
import { getModContributions } from '../mods/modContributionsView'

/** The app a provider's settings name, as the page publishes it. */
export type ProviderSettingsApp = Pick<ContributedApp, 'appId' | 'type' | 'title' | 'plugin'>

/** Opens a provider's settings app: Settings closes once the app is to open. */
export type ProviderAppOpener = (app: ProviderSettingsApp) => void

/** Provided by the shell around Settings; absent where apps cannot open (no runtime connection). */
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

/** Where a picker's settings button goes for the selected provider: its published settings app, else its settings page, else the Models page. */
export type ProviderSettingsTarget =
  | { kind: 'app'; app: ContributedApp }
  | { kind: 'page'; providerId: string }
  | { kind: 'models' }

export function providerSettingsTarget(
  provider: { id: string; mod?: { settingsApp?: string; plugin?: string } } | undefined,
  apps: readonly ContributedApp[] | undefined,
  canOpenApps: boolean,
): ProviderSettingsTarget {
  if (!provider) return { kind: 'models' }
  const app = canOpenApps ? providerSettingsApp(provider.mod?.settingsApp, provider.mod?.plugin, apps) : undefined
  return app ? { kind: 'app', app } : { kind: 'page', providerId: provider.id }
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
