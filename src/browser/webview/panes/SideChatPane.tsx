import type { ReactElement, ReactNode } from 'react'
import { FolderSyncIcon, PanelLeftOpenIcon, PlusIcon, Trash2Icon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import { useT } from '../i18n'
import { sessionDisplayTitle, type SessionListItem } from '../SessionRows'

/**
 * The Side chats pane (F-36): the viewed session's side chats as a list,
 * newest first, each with its state; under it the selected one's whole
 * conversation, which the shell mounts and hands in as `children`. The `+`
 * in the header opens a new side chat cut at the conversation's end.
 */
export type SideChatPaneProps = {
  /** The viewed session's side chats, newest first. */
  items: readonly SessionListItem[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
  /** Absent while the conversation has no message to fork from. */
  onAdd?: () => void
  onDetach: (sessionId: string) => void
  onDelete: (sessionId: string) => void
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
  onDelete,
  frame,
  children,
}: SideChatPaneProps): ReactElement {
  const t = useT()
  const title = <span className="min-w-0 truncate">{t('topbar.pane.sidechat')}</span>
  const actions = (
    <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="side-chat-add"
          aria-label={t('sideChat.add')}
          disabled={!onAdd}
          onClick={onAdd}
        >
          <PlusIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('sideChat.add')}</TooltipContent>
    </Tooltip>
    </TooltipProvider>
  )
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
          <ul
            role="listbox"
            aria-label={t('topbar.pane.sidechat')}
            data-testid="side-chat-list"
            className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border p-1"
          >
            {items.map(item => {
              const selected = item.sessionId === selectedId
              const label = sessionDisplayTitle(item, t)
              return (
                <li
                  key={item.sessionId}
                  role="option"
                  aria-selected={selected}
                  data-testid={`side-chat-row-${item.sessionId}`}
                  data-needs-answer={item.needsAnswer || undefined}
                  data-running={item.running || undefined}
                  className={cn(
                    'group flex items-center gap-2 rounded-md px-2 py-1 text-[12px]',
                    selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-start outline-none"
                    onClick={() => onSelect(item.sessionId)}
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
                    aria-label={t('sideChat.detach')}
                    title={t('sideChat.detach')}
                    data-testid={`side-chat-detach-${item.sessionId}`}
                    onClick={() => onDetach(item.sessionId)}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                  >
                    <PanelLeftOpenIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('sidebar.delete')}
                    title={t('sidebar.delete')}
                    data-testid={`side-chat-delete-${item.sessionId}`}
                    onClick={() => onDelete(item.sessionId)}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
          <div
            data-testid="side-chat-shared-folder"
            className="flex shrink-0 items-center gap-1.5 px-3 py-1 text-[11px] text-muted-foreground"
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
