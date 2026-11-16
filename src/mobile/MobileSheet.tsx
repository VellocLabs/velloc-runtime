/**
 * The phone shell's bottom sheet (F-24): a modal panel anchored to the bottom edge, at most 85% of
 * the dynamic viewport tall, its body scrolling. Tapping the dimmed backdrop or pressing Escape
 * closes it. Content stays clear of the home-indicator area.
 */
import type { ReactNode } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'

export type MobileSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The sheet's heading; also its accessible name. */
  title: string
  /** Shown under the title, e.g. the session the sheet acts on. */
  subtitle?: string
  testId: string
  children: ReactNode
}

export function MobileSheet({ open, onOpenChange, title, subtitle, testId, children }: MobileSheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid={`${testId}-backdrop`}
          className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          data-testid={testId}
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border-border border-t bg-background shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" />
          <div className="shrink-0 px-5 pt-3 pb-2">
            <DialogPrimitive.Title className="truncate font-semibold text-body">{title}</DialogPrimitive.Title>
            {subtitle ? <p className="truncate text-muted-foreground text-sm">{subtitle}</p> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** One full-width, touch-sized row of a sheet's action list. */
export function MobileSheetAction({
  icon,
  label,
  detail,
  tone = 'default',
  testId,
  onSelect,
}: {
  icon: ReactNode
  label: string
  detail?: string
  tone?: 'default' | 'destructive'
  testId: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onSelect}
      className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left active:bg-accent ${
        tone === 'destructive' ? 'text-destructive' : 'text-foreground'
      }`}
    >
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body">{label}</span>
        {detail ? <span className="block truncate text-muted-foreground text-sm">{detail}</span> : null}
      </span>
    </button>
  )
}
