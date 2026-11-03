import type { ReactElement, ReactNode } from 'react'
import { FolderSyncIcon, PanelLeftOpenIcon, PlusIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import { useT } from '../i18n'
import { sessionDisplayTitle, type SessionListItem } from '../SessionRows'

/**
 * The Side chats pane (F-36): the viewed session's side chats as tabs in the
 * header, newest first, each with its state and its close; the `+` after the
 * tabs opens a new side chat cut at the conversation's end, and the header
 * action detaches the shown one. The body is the shown side chat's whole
 * conversation, which the shell mounts and hands in as `children`.
 */
export type SideChatPaneProps = {
  /** The viewed session's side chats, newest first. */
  items: readonly SessionListItem[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
  /** Absent while the conversation has no message to fork from. */
  onAdd?: () => void
  onDetach: (sessionId: string) => void
  /** Closes a side chat: archives it. Offered only while it neither starts,
   *  works nor waits for the person, which the runtime refuses. */
  onArchive: (sessionId: string) => void
  frame: (parts: { title: ReactNode; actions: ReactNode; body: ReactNode }) => ReactNode
  /** The selected side chat's mounted conversation. */
  children?: ReactNode
}

export function SideChatPane({
  items,
  selectedId,
  onSelect,
  onAdd,
  onDetach,
  onArchive,
  frame,
  children,
}: SideChatPaneProps): ReactElement {
  const t = useT()
  const shown = items.find(item => item.sessionId === selectedId) ?? null
  const title = (
    <TooltipProvider>
      <div
        role="tablist"
        aria-label={t('topbar.pane.sidechat')}
        data-testid="side-chat-list"
        className="flex min-w-0 items-center gap-0.5 overflow-hidden"
      >
        {items.length === 0 ? (
          <span className="min-w-0 truncate ps-1">{t('topbar.pane.sidechat')}</span>
        ) : null}
        {items.map(item => {
          const selected = item.sessionId === selectedId
          const label = sessionDisplayTitle(item, t)
          const busy = !!(item.starting || item.running || item.needsAnswer)
          const archiveLabel = t(busy ? 'sideChat.archiveBusy' : 'sideChat.archive')
          return (
            // The whole pill is the tab: a press on its edge selects it too.
            <div
              key={item.sessionId}
              data-testid={`side-chat-row-${item.sessionId}`}
              data-needs-answer={item.needsAnswer || undefined}
              data-running={item.running || undefined}
              onClick={event => {
                if (event.target === event.currentTarget) onSelect(item.sessionId)
              }}
              className={cn(
                'group flex h-7 min-w-0 cursor-default items-stretch gap-0.5 rounded-md pe-0.5 text-[12px]',
                selected ? 'bg-muted' : 'hover:bg-muted/50',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`side-chat-tab-${item.sessionId}`}
                title={label}
                onClick={() => onSelect(item.sessionId)}
                className={cn(
                  'flex min-w-0 max-w-[12rem] items-center gap-1.5 ps-1.5 outline-none',
                  selected ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    item.needsAnswer
                      ? 'bg-warning'
                      : item.running
                        ? 'bg-primary animate-pulse'
                        : 'bg-border',
                  )}
                />
                <span className="min-w-0 truncate">{label}</span>
                {item.needsAnswer ? (
                  <span className="sr-only">{t('sideChat.waiting')}</span>
                ) : item.running ? (
                  <span className="sr-only">{t('sideChat.working')}</span>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={archiveLabel}
                title={archiveLabel}
                data-testid={`side-chat-archive-${item.sessionId}`}
                disabled={busy}
                onClick={() => onArchive(item.sessionId)}
                className="flex size-4 shrink-0 items-center justify-center self-center rounded text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-7 shrink-0"
            data-testid="side-chat-add"
            aria-label={t('sideChat.add')}
            disabled={!onAdd}
            onClick={onAdd}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('sideChat.add')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
  const actions = shown ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-7"
            data-testid={`side-chat-detach-${shown.sessionId}`}
            aria-label={t('sideChat.detach')}
            onClick={() => onDetach(shown.sessionId)}
          >
            <PanelLeftOpenIcon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('sideChat.detach')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : null
  const body = (
    <div className="flex h-full min-h-0 flex-col">
      {items.length === 0 ? (
        <div
          data-testid="side-chat-empty"
          className="flex flex-1 items-center justify-center px-6 text-center text-body text-muted-foreground"
        >
          {t('sideChat.empty')}
        </div>
      ) : (
        <>
          <div
            data-testid="side-chat-shared-folder"
            className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1 text-[11px] text-muted-foreground"
          >
            <FolderSyncIcon className="size-3" aria-hidden />
            <span className="truncate">{t('sideChat.sharedFolder')}</span>
          </div>
          <div data-testid="side-chat-thread" className="flex min-h-0 flex-1 flex-col">
            {children}
          </div>
        </>
      )}
    </div>
  )
  return <>{frame({ title, actions, body })}</>
}
