import { cn } from '@/lib/utils'

/**
 * "This session needs your response" dot for a background session halted on an
 * approval control. An absolutely-positioned overlay: the parent must be `relative`.
 */
export function SessionAttentionDot({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <>
      <span
        aria-hidden
        data-slot="session-attention-dot"
        className={cn(
          'nexus-attention-dot pointer-events-none absolute z-10 size-2 rounded-full bg-warning ring-2 ring-sidebar',
          className,
        )}
      />
      {/* Contributes to the enclosing row/button accessible name. */}
      <span className="sr-only">{label}</span>
    </>
  )
}
