/**
 * The topbar control a REMOTE page has where the desktop has its OS caption buttons
 * (F-24): which machine this session runs on, and how to stop. The shell renders it
 * or the connected-devices link, never both. The predicate is page identity, not a
 * grant: no scope predicts it, so the boot path states it.
 */
import * as React from 'react'

import { LaptopIcon, LogOutIcon, MonitorIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { useT } from '../i18n'
import type { DrivenDesktop } from './hostIdentity'

export type { DrivenDesktop }

export type RemoteHostIndicatorProps = {
  host: DrivenDesktop
  /**
   * Forget this device's pairing and hand the page back to the connect
   * screen. Destructive in the only sense that matters here: the link has to
   * be opened again afterwards, which is why it sits behind the menu and not
   * on the button.
   */
  onLogOut: () => void
}

/** The identity lines under the headline, most identifying first. The
 *  headline — the machine name, or the address when an older host reports
 *  none — is NOT repeated here: both surfaces already say it in their first
 *  line ("Connected to studio-pc" / the menu's bold name), and listing it again
 *  underneath read as a duplicate. Missing fields are skipped, so an older
 *  host shows a shorter tooltip rather than an empty row. */
export function hostDetailLines(host: DrivenDesktop): string[] {
  const headline = host.hostName ?? host.address
  const lines: string[] = []
  if (host.hostName) lines.push(host.hostName)
  if (host.osName) lines.push(host.osName)
  if (host.userName) lines.push(host.userName)
  lines.push(host.address)
  return lines.filter((line) => line !== headline)
}

export function RemoteHostIndicator({ host, onLogOut }: RemoteHostIndicatorProps) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const lines = hostDetailLines(host)
  // The tooltip's one-line summary doubles as the button's accessible name:
  // a screen reader hears the machine, not "button".
  const label = t('remote.host.connectedTo', { host: host.hostName ?? host.address })

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="topbar-remote-host"
                data-app-region="no-drag"
                aria-label={label}
                aria-expanded={open}
              >
                <MonitorIcon className="size-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          {/* The tooltip is the requirement, not a nicety: it is the only
              place a remote user can read WHICH machine this is without
              opening anything. It repeats the menu's header on purpose. */}
          <TooltipContent side="bottom" align="end">
            <span
              data-testid="topbar-remote-host-tooltip"
              className="flex flex-col gap-0.5"
            >
              <span className="font-medium">{label}</span>
              {lines.map((line) => (
                <span key={line} className="opacity-80">
                  {line}
                </span>
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="bottom"
          align="end"
          className="w-64 p-1"
          data-testid="topbar-remote-host-menu"
        >
          <div className="flex items-start gap-2 px-2 py-1.5">
            <LaptopIcon className="mt-0.5 size-4 shrink-0 opacity-70" aria-hidden />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">
                {host.hostName ?? host.address}
              </span>
              {lines.map((line) => (
                <span
                  key={line}
                  className="text-muted-foreground truncate text-xs"
                >
                  {line}
                </span>
              ))}
            </div>
          </div>
          <div aria-hidden className="bg-border my-1 h-px" />
          <button
            type="button"
            data-testid="topbar-remote-log-out"
            className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
            onClick={() => {
              setOpen(false)
              onLogOut()
            }}
          >
            <LogOutIcon className="size-4 shrink-0" aria-hidden />
            {t('remote.host.logOut')}
          </button>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}
