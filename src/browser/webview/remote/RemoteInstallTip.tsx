/**
 * The remote page's "install as an app" tip (F-24), a strip under the topbar. Renders
 * nothing inside the installed app, after a load that showed it visibly or after
 * "Not now" / an install, where no route gives a working app, or before the boot
 * called `enableAppInstall`. Mounted for a remote page only.
 */
import * as React from 'react'

import { AppWindowIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { useT } from '../i18n'
import {
  getInstallState,
  installRoute,
  isInstallTipSuppressed,
  isRunningAsApp,
  markInstallTipSeen,
  promptInstall,
  subscribeInstallState,
  suppressInstallTip,
} from './appInstall'

export function RemoteInstallTip() {
  const t = useT()
  const install = React.useSyncExternalStore(subscribeInstallState, getInstallState)
  // Read once per mount: neither changes while this page lives, except by
  // this component's own hand (tracked in `hidden`).
  const [hidden, setHidden] = React.useState(
    () => isRunningAsApp() || isInstallTipSuppressed(),
  )

  React.useEffect(() => {
    if (install.installed) suppressInstallTip('installed')
  }, [install.installed])

  const route = installRoute(globalThis.navigator?.userAgent, install.prompt !== null)
  const visible = install.enabled && !hidden && !install.installed && route !== null

  // Seen once per device, and only where a person can look at it: the next
  // page load finds the mark and stays quiet.
  React.useEffect(() => {
    if (!visible) return undefined
    return markInstallTipSeen()
  }, [visible])

  if (!visible) return null

  const dismiss = () => {
    suppressInstallTip('dismissed')
    setHidden(true)
  }

  const message =
    route === 'prompt'
      ? t('remote.install.prompt')
      : route === 'chrome-menu'
        ? t('remote.install.chromeMenu')
        : t('remote.install.edgeMenu')

  return (
    <div
      data-testid="remote-install-tip"
      data-route={route}
      role="status"
      aria-live="polite"
      className="bg-muted/60 text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-sm"
    >
      <AppWindowIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {route === 'prompt' ? (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          className="shrink-0"
          data-testid="remote-install-tip-install"
          onClick={() => {
            void promptInstall().catch((err: unknown) => {
              console.warn('[remote] install prompt failed', err)
            })
          }}
        >
          {t('remote.install.install')}
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="shrink-0"
        data-testid="remote-install-tip-dismiss"
        aria-label={t('remote.install.dismiss')}
        title={t('remote.install.dismiss')}
        onClick={dismiss}
      >
        <XIcon aria-hidden className="size-3.5" />
      </Button>
    </div>
  )
}
