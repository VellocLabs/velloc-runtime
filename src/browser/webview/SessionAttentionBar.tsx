import { useState } from 'react'
import { ChevronsRightIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useT } from './i18n'
import type { AttentionEvent } from './sessionAttention'
import { getLauncherForType } from './threadLaunchers'

/**
 * The in-app notification bar: sessions waiting for the user while the user is in the
 * window but elsewhere. Pushes the conversation down; renders nothing when the queue is
 * empty. One row for one session, a count summary for more. Each row is a jump button; no
 * dismissal — an event leaves the queue when its session is visited.
 */
export function SessionAttentionBar({
  events,
  windowFocused,
  onSelect,
  className,
}: {
  events: readonly AttentionEvent[]
  /** Is the Velloc window the user's active surface? Nothing renders while it
   *  is not: queued events wait for the window, not the other way round. */
  windowFocused: boolean
  /** Go to the session. The shell switches, then clears on arrival. */
  onSelect: (sessionId: string) => void
  className?: string
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)

  if (events.length === 0 || !windowFocused) return null

  const single = events.length === 1
  const showList = single || expanded

  return (
    <div
      data-testid="session-attention-bar"
      // `status` not `alert`: this is advisory and must not interrupt a screen
      // reader mid-sentence. The count in the summary line carries the news.
      role="status"
      aria-live="polite"
      className={cn(
        'flex shrink-0 flex-col gap-1 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-sm',
        className,
      )}
    >
      {!single && (
        <button
          type="button"
          data-testid="session-attention-bar-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          className="flex w-full items-center gap-2 rounded text-left font-medium hover:underline"
        >
          <AttentionGlyph />
          <span className="flex-1">
            {t('attention.summary', { count: String(events.length) })}
          </span>
          <span className="text-xs opacity-70">
            {expanded ? t('attention.collapse') : t('attention.expand')}
          </span>
        </button>
      )}
      {showList && (
        <ul className="flex flex-col gap-0.5">
          {events.map(event => {
            // The same icon the sidebar row shows for this session.
            const TypeIcon = getLauncherForType(event.templateType).Icon
            return (
              <li key={event.id}>
                <button
                  type="button"
                  data-testid="session-attention-bar-item"
                  data-session-id={event.sessionId}
                  data-kind={event.kind}
                  onClick={() => onSelect(event.sessionId)}
                  className="group flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-warning/15"
                >
                  <TypeIcon
                    aria-hidden
                    data-slot="session-attention-bar-type-icon"
                    className="size-3.5 shrink-0 text-muted-foreground/70"
                  />
                  <span className="truncate font-medium">{event.title}</span>
                  <span className="min-w-0 flex-1 truncate opacity-80">
                    {event.kind === 'needs_input'
                      ? t('attention.needsInput')
                      : (event.detail ?? t('attention.endedWithQuestion'))}
                  </span>
                  <ChevronsRightIcon
                    aria-hidden
                    data-slot="session-attention-bar-jump"
                    className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                  />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Same amber vocabulary as the session list's attention dot, so the bar and
 *  the dot read as one signal rather than two unrelated warnings. */
function AttentionGlyph() {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full bg-warning"
      data-slot="session-attention-bar-glyph"
    />
  )
}
