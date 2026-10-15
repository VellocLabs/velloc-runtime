/**
 * The remote page's fullscreen button (F-24), right of the host indicator; never on
 * the desktop panel. Not rendered where `document.fullscreenEnabled` is false.
 */
import * as React from 'react'

import { MaximizeIcon, MinimizeIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { useT } from '../i18n'

function isFullscreen(): boolean {
  return typeof document !== 'undefined' && document.fullscreenElement != null
}

export function RemoteFullscreenToggle() {
  const t = useT()
  const [active, setActive] = React.useState(isFullscreen)

  // The browser leaves fullscreen on its own (Esc, F11, a tab switch on some
  // platforms), so the icon follows the document's event, not the click.
  React.useEffect(() => {
    const sync = () => setActive(isFullscreen())
    document.addEventListener('fullscreenchange', sync)
    sync()
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  if (typeof document === 'undefined' || !document.fullscreenEnabled) return null

  const label = active ? t('remote.fullscreen.exit') : t('remote.fullscreen.enter')
  const toggle = () => {
    const request = active
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen()
    // A refusal (no user activation, a permissions policy) leaves the page as
    // it was; the icon already reflects that, so only the console hears it.
    void Promise.resolve(request).catch((err: unknown) => {
      console.warn('[remote] fullscreen request refused', err)
    })
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="topbar-remote-fullscreen"
            data-active={active ? 'true' : 'false'}
            data-app-region="no-drag"
            aria-label={label}
            aria-pressed={active}
            onClick={toggle}
          >
            {active ? (
              <MinimizeIcon className="size-4" />
            ) : (
              <MaximizeIcon className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
