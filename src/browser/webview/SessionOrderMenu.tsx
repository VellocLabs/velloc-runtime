import { CheckIcon, ChevronRightIcon, ListFilterIcon } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'

import { useT } from './i18n'
import type { MessageKey } from './i18n/messages/en'
import type {
  SessionListOrder,
  SessionSortDirection,
  SessionSortField,
} from './sessionListOrder'
import { cn } from '@/lib/utils'

const FIELD_LABELS: Record<SessionSortField, MessageKey> = {
  updated: 'sidebar.sortLastUpdated',
  created: 'sidebar.sortDateCreated',
}

const DIRECTION_LABELS: Record<SessionSortDirection, MessageKey> = {
  desc: 'sidebar.sortDescending',
  asc: 'sidebar.sortAscending',
}

const ITEM_CLASS =
  'flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none data-[highlighted]:bg-muted'

const CONTENT_CLASS =
  'z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md'

/**
 * The session list's options menu: "Sort by" opens a submenu with the sort
 * field and, below a separator, the direction — the current pick of each
 * checked. (F-17)
 */
export function SessionOrderMenu({
  order,
  onOrderChange,
  className,
}: {
  order: SessionListOrder
  onOrderChange: (next: SessionListOrder) => void
  className?: string
}) {
  const t = useT()
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          data-testid="sidebar-list-options"
          aria-label={t('sidebar.listOptionsAria')}
          title={t('sidebar.listOptionsAria')}
          className={cn(
            'rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground',
            className,
          )}
        >
          <ListFilterIcon aria-hidden className="size-3.5" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          sideOffset={4}
          onCloseAutoFocus={e => e.preventDefault()}
          className={CONTENT_CLASS}
        >
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger
              data-testid="sidebar-sort-by"
              className={cn(ITEM_CLASS, 'data-[state=open]:bg-muted')}
            >
              <span className="flex-1">{t('sidebar.sortBy')}</span>
              <span className="text-muted-foreground">
                {t(FIELD_LABELS[order.field])}
              </span>
              <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent
                sideOffset={6}
                className={CONTENT_CLASS}
              >
                <DropdownMenuPrimitive.RadioGroup
                  value={order.field}
                  onValueChange={value =>
                    onOrderChange({ ...order, field: value as SessionSortField })
                  }
                >
                  {(Object.keys(FIELD_LABELS) as SessionSortField[]).map(field => (
                    <DropdownMenuPrimitive.RadioItem
                      key={field}
                      value={field}
                      data-testid={`sidebar-sort-field-${field}`}
                      className={ITEM_CLASS}
                    >
                      <span className="flex-1">{t(FIELD_LABELS[field])}</span>
                      <DropdownMenuPrimitive.ItemIndicator>
                        <CheckIcon aria-hidden className="size-4 text-primary" />
                      </DropdownMenuPrimitive.ItemIndicator>
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
                <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
                <DropdownMenuPrimitive.RadioGroup
                  value={order.direction}
                  onValueChange={value =>
                    onOrderChange({
                      ...order,
                      direction: value as SessionSortDirection,
                    })
                  }
                >
                  {(Object.keys(DIRECTION_LABELS) as SessionSortDirection[]).map(
                    direction => (
                      <DropdownMenuPrimitive.RadioItem
                        key={direction}
                        value={direction}
                        data-testid={`sidebar-sort-direction-${direction}`}
                        className={ITEM_CLASS}
                      >
                        <span className="flex-1">
                          {t(DIRECTION_LABELS[direction])}
                        </span>
                        <DropdownMenuPrimitive.ItemIndicator>
                          <CheckIcon aria-hidden className="size-4 text-primary" />
                        </DropdownMenuPrimitive.ItemIndicator>
                      </DropdownMenuPrimitive.RadioItem>
                    ),
                  )}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}
