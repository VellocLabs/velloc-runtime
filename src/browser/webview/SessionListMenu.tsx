import { CheckIcon, ChevronRightIcon, ListFilterIcon } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import { Fragment } from 'react'

import { useT } from './i18n'
import type { MessageKey } from './i18n/messages/en'
import {
  SESSION_GROUP_BYS,
  SESSION_SORT_DIRECTIONS,
  SESSION_SORT_FIELDS,
  type SessionGroupBy,
  type SessionListView,
  type SessionSortDirection,
  type SessionSortField,
} from './sessionListView'
import { cn } from '@/lib/utils'

const GROUP_BY_LABELS: Record<SessionGroupBy, MessageKey> = {
  none: 'sidebar.groupNone',
  status: 'sidebar.groupStatus',
  date: 'sidebar.groupDate',
  week: 'sidebar.groupWeek',
}

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

/** One checked choice list inside a submenu; `testId` prefixes each item's test id. */
type ChoiceSection = {
  values: readonly string[]
  labelOf: (value: string) => MessageKey
  current: string
  onPick: (value: string) => void
  testId: string
}

/** A choice list over one value union; the menu only ever hands back one of `values`. */
function choiceSection<V extends string>(section: {
  values: readonly V[]
  labels: Record<V, MessageKey>
  current: V
  onPick: (value: V) => void
  testId: string
}): ChoiceSection {
  return {
    values: section.values,
    labelOf: value => section.labels[value as V],
    current: section.current,
    onPick: value => section.onPick(value as V),
    testId: section.testId,
  }
}

/**
 * A top-level item that names a setting and its current value, opening a
 * submenu of choice lists split by separators — the current pick of each checked.
 */
function ChoiceSubmenu({
  label,
  valueLabel,
  testId,
  sections,
}: {
  label: MessageKey
  valueLabel: MessageKey
  testId: string
  sections: readonly ChoiceSection[]
}) {
  const t = useT()
  return (
    <DropdownMenuPrimitive.Sub>
      <DropdownMenuPrimitive.SubTrigger
        data-testid={testId}
        className={cn(ITEM_CLASS, 'data-[state=open]:bg-muted')}
      >
        <span className="flex-1">{t(label)}</span>
        <span className="text-muted-foreground">{t(valueLabel)}</span>
        <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
      </DropdownMenuPrimitive.SubTrigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.SubContent sideOffset={6} className={CONTENT_CLASS}>
          {sections.map((section, index) => (
            <Fragment key={section.testId}>
              {index > 0 && (
                <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
              )}
              <DropdownMenuPrimitive.RadioGroup
                value={section.current}
                onValueChange={section.onPick}
              >
                {section.values.map(value => (
                  <DropdownMenuPrimitive.RadioItem
                    key={value}
                    value={value}
                    data-testid={`${section.testId}-${value}`}
                    className={ITEM_CLASS}
                  >
                    <span className="flex-1">{t(section.labelOf(value))}</span>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <CheckIcon aria-hidden className="size-4 text-primary" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </DropdownMenuPrimitive.RadioItem>
                ))}
              </DropdownMenuPrimitive.RadioGroup>
            </Fragment>
          ))}
        </DropdownMenuPrimitive.SubContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Sub>
  )
}

/**
 * The session list's options menu: "Group by" (none / status / date / week),
 * "Sort by" (field, then direction) and "Reset to defaults". (F-17)
 */
export function SessionListMenu({
  view,
  onViewChange,
  onReset,
  className,
}: {
  view: SessionListView
  onViewChange: (next: SessionListView) => void
  /** Drop the stored view and go back to the defaults. */
  onReset: () => void
  className?: string
}) {
  const t = useT()
  const groupSection = choiceSection({
    values: SESSION_GROUP_BYS,
    labels: GROUP_BY_LABELS,
    current: view.groupBy,
    onPick: groupBy => onViewChange({ ...view, groupBy }),
    testId: 'sidebar-group-by',
  })
  const fieldSection = choiceSection({
    values: SESSION_SORT_FIELDS,
    labels: FIELD_LABELS,
    current: view.field,
    onPick: field => onViewChange({ ...view, field }),
    testId: 'sidebar-sort-field',
  })
  const directionSection = choiceSection({
    values: SESSION_SORT_DIRECTIONS,
    labels: DIRECTION_LABELS,
    current: view.direction,
    onPick: direction => onViewChange({ ...view, direction }),
    testId: 'sidebar-sort-direction',
  })
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
          <ChoiceSubmenu
            label="sidebar.groupBy"
            valueLabel={GROUP_BY_LABELS[view.groupBy]}
            testId="sidebar-group-by"
            sections={[groupSection]}
          />
          <ChoiceSubmenu
            label="sidebar.sortBy"
            valueLabel={FIELD_LABELS[view.field]}
            testId="sidebar-sort-by"
            sections={[fieldSection, directionSection]}
          />
          <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
          <DropdownMenuPrimitive.Item
            data-testid="sidebar-list-reset"
            onSelect={onReset}
            className={ITEM_CLASS}
          >
            {t('sidebar.resetListView')}
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}
