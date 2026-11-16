/**
 * The drawer's session rows (F-24), grouped as `buildMobileSessionGroups` returns them. A row shows
 * the title, its state (running, waiting for you) and how long ago it was active. A tap opens the
 * session; a long press opens the row's menu.
 */
import { LoaderCircleIcon } from 'lucide-react'

import { activityAge } from '../browser/webview/childSessionStatus'
import { useLocale, useT } from '../browser/webview/i18n'
import { formatGroupDay, type SessionGroupLabel } from '../browser/webview/sessionListView'
import type { MobileSessionGroup, MobileSessionRow } from './mobileSessionGroups'
import { useLongPress } from './useLongPress'

export type MobileSessionListProps = {
  groups: readonly MobileSessionGroup[]
  now: number
  activeSessionId: string
  onSelect: (sessionId: string) => void
  onLongPress: (sessionId: string) => void
}

export function MobileSessionList({ groups, now, activeSessionId, onSelect, onLongPress }: MobileSessionListProps) {
  const t = useT()
  const locale = useLocale()
  const groupLabel = (group: MobileSessionGroup): string | null => {
    if (group.pinned) return t('sidebar.pinned')
    const label: SessionGroupLabel | null = group.label
    if (!label) return null
    return label.kind === 'message' ? t(label.key) : formatGroupDay(label.dayStart, locale, now)
  }
  return (
    <div data-testid="mobile-session-list" className="pb-2">
      {groups.map(group => {
        const label = groupLabel(group)
        return (
          <section key={group.key} aria-label={label ?? undefined}>
            {label ? (
              <h2 className="px-4 pt-3 pb-1 font-medium text-muted-foreground text-xs">{label}</h2>
            ) : null}
            <ul>
              {group.rows.map(row => (
                <li key={row.sessionId}>
                  <MobileSessionRowButton
                    row={row}
                    now={now}
                    active={row.sessionId === activeSessionId}
                    onSelect={onSelect}
                    onLongPress={onLongPress}
                  />
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function MobileSessionRowButton({
  row,
  now,
  active,
  onSelect,
  onLongPress,
}: {
  row: MobileSessionRow
  now: number
  active: boolean
  onSelect: (sessionId: string) => void
  onLongPress: (sessionId: string) => void
}) {
  const t = useT()
  const press = useLongPress(() => onLongPress(row.sessionId))
  const title = row.title.trim() || t('mobile.topbar.untitledSession')
  return (
    <button
      type="button"
      data-testid="mobile-session-row"
      data-session-id={row.sessionId}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(row.sessionId)}
      {...press}
      className={`flex min-h-12 w-full select-none items-center gap-3 px-4 py-2 text-left [-webkit-touch-callout:none] active:bg-accent ${
        active ? 'bg-accent/60' : ''
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body">{title}</span>
        <span className="block truncate text-muted-foreground text-xs">
          {row.needsAnswer ? (
            <span data-testid="mobile-session-row-waiting" className="text-amber-600 dark:text-amber-400">
              {t('childSession.state.waiting')}
              {' · '}
            </span>
          ) : null}
          {activityAge(row.activityAt, now, t)}
        </span>
      </span>
      {row.running ? (
        <LoaderCircleIcon
          data-testid="mobile-session-row-running"
          role="img"
          aria-label={t('childSession.state.running')}
          className="size-4 shrink-0 animate-spin text-muted-foreground"
        />
      ) : null}
    </button>
  )
}
