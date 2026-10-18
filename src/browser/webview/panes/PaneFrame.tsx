import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { Maximize2Icon, Minimize2Icon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { useT } from '../i18n'
import type { SidePaneKind } from '../layout/paneLayout'

/**
 * The chrome every side pane shares (F-9): a card with a 36px header — the
 * pane's title slot at the start, its own actions, then Expand / Restore and
 * Close — over a body that owns its scrolling. The header outside its controls
 * is the pane's handle. Brings its own TooltipProvider: panes render outside
 * the thread providers.
 */
export type PaneFrameProps = {
  kind: SidePaneKind
  /** The pane's name, for the handle's label. */
  name: string
  /** The header's start: a label, a picker, a tab strip. */
  title: ReactNode
  /** The pane's own header actions, before Expand and Close. */
  actions?: ReactNode
  maximized: boolean
  onToggleMaximized: () => void
  onClose: () => void
  /** A press or focus inside the pane: it becomes the focused pane. */
  onFocus?: () => void
  style?: CSSProperties
  className?: string
  children: ReactNode
}

export function PaneFrame(props: PaneFrameProps): ReactElement {
  const t = useT()
  const { kind, name } = props
  return (
    <TooltipProvider>
      <section
        data-testid={`pane-${kind}`}
        data-pane={kind}
        data-maximized={props.maximized ? 'true' : undefined}
        aria-label={name}
        className={cn(
          'flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground',
          props.className,
        )}
        style={props.style}
        onPointerDownCapture={props.onFocus}
        onFocusCapture={props.onFocus}
      >
        <div
          data-testid={`pane-${kind}-header`}
          className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border pe-1 ps-2"
        >
          <div
            role="button"
            tabIndex={0}
            aria-label={t('pane.move', { pane: name })}
            data-testid={`pane-${kind}-handle`}
            className="flex h-full min-w-0 flex-1 cursor-grab items-center gap-1.5 text-[13px] font-medium leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {props.title}
          </div>
          {props.actions}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-7"
                data-testid={`pane-${kind}-expand`}
                aria-pressed={props.maximized}
                aria-label={t(props.maximized ? 'pane.restore' : 'pane.expand')}
                onClick={props.onToggleMaximized}
              >
                {props.maximized ? (
                  <Minimize2Icon className="size-3.5" />
                ) : (
                  <Maximize2Icon className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t(props.maximized ? 'pane.restore' : 'pane.expand')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-7"
                data-testid={`pane-${kind}-close`}
                aria-label={t('pane.close')}
                onClick={props.onClose}
              >
                <XIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('pane.close')}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      </section>
    </TooltipProvider>
  )
}
