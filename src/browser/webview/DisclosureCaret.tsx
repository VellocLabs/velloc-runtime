import { cn } from '@/lib/utils'

/** Hover treatment shared by every sidebar disclosure caret. */
export const DISCLOSURE_CARET_HOVER =
  'rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

/**
 * Solid triangle that marks a collapsible sidebar item: points right while
 * collapsed, down while expanded. Placed after the item's label. `title`
 * is the hover tip; the owning control carries the accessible name.
 */
export function DisclosureCaret({
  expanded,
  title,
  className,
}: {
  expanded: boolean
  title?: string
  className?: string
}) {
  return (
    <span
      data-slot="disclosure-caret"
      data-expanded={expanded || undefined}
      title={title}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center',
        title !== undefined && DISCLOSURE_CARET_HOVER,
        className,
      )}
    >
      <DisclosureCaretGlyph expanded={expanded} />
    </span>
  )
}

/** The bare triangle, for a caller that is itself the hover target. */
export function DisclosureCaretGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="size-3 fill-current">
      <path d={expanded ? 'M2 4 10 4 6 9Z' : 'M4 2 9 6 4 10Z'} />
    </svg>
  )
}
