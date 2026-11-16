/**
 * The desktop top bar's remote-access connect control (F-24): shown while
 * remote access is enabled, with the device count as a badge; its popover
 * holds the share link's QR code, Copy link and a way into settings.
 * Security: the link carries the pairing secret. It is read only while the
 * popover is open, and only drawn as a QR code or copied.
 */
import * as React from 'react'
import { CopyIcon, QrCodeIcon, SettingsIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { writeClipboard } from '../../../utils/clipboard'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RemoteAccessState } from '../../runtimeHub/remoteAccessDriver'
import { useT } from '../i18n'
import { preferredShareLink, readCurrentPairing } from '../remote/shareLink'

// The QR encoder loads with the first open, off the boot chunk.
const loadQrCodeSvg = () => import('../remote/QrCodeSvg')
const QrCodeSvg = React.lazy(async () => ({ default: (await loadQrCodeSvg()).QrCodeSvg }))

/** What the control needs to find the share link. */
export type RemoteConnectSource = {
  access: RemoteAccessState
  /** The live pairing's id; a new one (Regenerate link) re-reads the link. */
  pairingKey: string | null
  connection: Pick<RuntimeConnection, 'request'>
}

type LinkRead =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'link'; url: string }

/** The popover body. Mounted only while open, so the link lives no longer. */
function RemoteConnectPanel({
  source,
  devicesLabel,
  onOpenSettings,
}: {
  source: RemoteConnectSource
  devicesLabel: string | null
  onOpenSettings: () => void
}) {
  const t = useT()
  const { access, connection, pairingKey } = source
  const listening = access.state === 'listening'
  const hasAddress = access.addresses.length > 0
  const [fragment, setFragment] = React.useState<string | null | undefined>(undefined)
  const [feedback, setFeedback] = React.useState<'idle' | 'copied' | 'failed'>('idle')

  React.useEffect(() => {
    void loadQrCodeSvg()
  }, [])

  React.useEffect(() => {
    if (!listening || !hasAddress) return
    let live = true
    setFragment(undefined)
    void readCurrentPairing(connection).then(pairing => {
      if (live) setFragment(pairing?.fragment ?? null)
    })
    return () => {
      live = false
    }
  }, [connection, listening, hasAddress, pairingKey])

  React.useEffect(() => {
    if (feedback === 'idle') return
    const timer = setTimeout(() => setFeedback('idle'), 2000)
    return () => clearTimeout(timer)
  }, [feedback])

  const read: LinkRead =
    fragment === undefined
      ? { kind: 'loading' }
      : fragment === null
        ? { kind: 'unavailable' }
        : (() => {
            const url = preferredShareLink(access, fragment)
            return url ? { kind: 'link' as const, url } : { kind: 'unavailable' as const }
          })()

  const note = !listening
    ? access.state === 'error'
      ? t('topbar.remoteConnect.error')
      : t('topbar.remoteConnect.starting')
    : !hasAddress
      ? t('topbar.remoteConnect.noAddress')
      : read.kind === 'loading'
        ? t('topbar.remoteConnect.loading')
        : read.kind === 'unavailable'
          ? t('topbar.remoteConnect.noLink')
          : null
  const url = listening && hasAddress && read.kind === 'link' ? read.url : null

  const copy = async () => {
    if (!url) return
    const ok = await writeClipboard(url).catch(() => false)
    setFeedback(ok ? 'copied' : 'failed')
  }

  return (
    <div className="flex flex-col gap-3 p-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t('topbar.remoteConnect.title')}</span>
        {devicesLabel ? (
          <span className="text-muted-foreground text-xs" data-testid="topbar-remote-connect-devices">
            {devicesLabel}
          </span>
        ) : null}
      </div>
      {url ? (
        <>
          <React.Suspense fallback={<div aria-hidden className="mx-auto size-48" />}>
            <QrCodeSvg
              text={url}
              label={t('topbar.remoteConnect.qrLabel')}
              testId="topbar-remote-connect-qr"
              className="mx-auto size-48 rounded-sm"
            />
          </React.Suspense>
          <p className="text-muted-foreground text-center text-xs">{t('topbar.remoteConnect.hint')}</p>
          <Button
            type="button"
            size="sm"
            data-testid="topbar-remote-connect-copy"
            onClick={() => void copy()}
          >
            <CopyIcon className="size-4" aria-hidden />
            {feedback === 'copied'
              ? t('topbar.remoteConnect.copied')
              : feedback === 'failed'
                ? t('topbar.remoteConnect.copyFailed')
                : t('topbar.remoteConnect.copyLink')}
          </Button>
        </>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="topbar-remote-connect-note">
          {note}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start"
        data-testid="topbar-remote-connect-settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon className="size-4" aria-hidden />
        {t('topbar.remoteConnect.settings')}
      </Button>
    </div>
  )
}

export function RemoteConnectButton({
  source,
  deviceCount,
  devicesLabel,
  onOpenSettings,
  foldProps,
}: {
  source: RemoteConnectSource
  deviceCount: number
  /** The connected-devices phrase, or null with none connected. */
  devicesLabel: string | null
  onOpenSettings: () => void
  /** The top bar's fold marker for this control. */
  foldProps: Record<string, string>
}) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const label = devicesLabel ?? t('topbar.remoteConnect.title')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="topbar-remote-devices"
              data-count={deviceCount > 0 ? deviceCount : undefined}
              {...foldProps}
              aria-label={label}
              aria-expanded={open}
              className="relative"
            >
              <QrCodeIcon className="size-4" />
              {deviceCount > 0 ? (
                <span
                  aria-hidden
                  className="absolute right-0.5 top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground"
                >
                  {deviceCount}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-64 p-1"
        data-testid="topbar-remote-connect"
      >
        {open ? (
          <RemoteConnectPanel
            source={source}
            devicesLabel={devicesLabel}
            onOpenSettings={() => {
              setOpen(false)
              onOpenSettings()
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
