import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Hover treatment shared by every sidebar disclosure caret. */
export const DISCLOSURE_CARET_HOVER =
  'rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

/**
 * Outline chevron that marks a collapsible sidebar item: points right while
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

/** The bare chevron, for a caller that is itself the hover target. */
export function DisclosureCaretGlyph({ expanded }: { expanded: boolean }) {
  const Icon = expanded ? ChevronDownIcon : ChevronRightIcon
  return <Icon aria-hidden className="size-3.5" />
}
