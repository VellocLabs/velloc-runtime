import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { GripVerticalIcon, Maximize2Icon, Minimize2Icon, XIcon } from 'lucide-react'

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
import { PANE_ICON } from './paneKinds'
import { usePaneHandle } from './usePaneDrag'

/**
 * The chrome every side pane shares (F-9): a 36px header (icon, title slot,
 * own actions, Expand / Restore, Close) over a body that owns its scrolling.
 * The icon becomes a grip while the header is hovered and is the only drag
 * handle (pointer, or arrow keys when focused). Brings its own
 * TooltipProvider: panes render outside the thread providers.
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
  const handle = usePaneHandle(kind)
  const KindIcon = PANE_ICON[kind]
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
          className="group/pane-header flex h-9 shrink-0 items-center gap-0.5 border-b border-border pe-1 ps-2"
        >
          <div
            role="button"
            tabIndex={0}
            aria-label={t('pane.move', { pane: name })}
            data-testid={`pane-${kind}-handle`}
            className={cn(
              'flex h-6 w-4 shrink-0 touch-none select-none items-center justify-center rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
              handle ? 'cursor-grab hover:bg-muted hover:text-foreground' : 'cursor-default',
            )}
            {...handle}
          >
            <KindIcon
              aria-hidden="true"
              data-testid={`pane-${kind}-icon`}
              className={cn('size-3.5', handle ? 'group-hover/pane-header:hidden group-focus-within/pane-header:hidden' : null)}
            />
            {handle ? (
              <GripVerticalIcon
                aria-hidden="true"
                data-testid={`pane-${kind}-grip`}
                className="hidden size-3.5 group-hover/pane-header:block group-focus-within/pane-header:block"
              />
            ) : null}
          </div>
          <div
            data-testid={`pane-${kind}-title`}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium leading-none"
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
