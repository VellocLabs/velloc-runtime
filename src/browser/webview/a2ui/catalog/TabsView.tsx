// The Velloc catalog's Tabs (F-1): the basic catalog's Tabs props plus a count
// badge per tab and the tab shown first. Children render through the binder's
// buildChild, as in any container.

import { useId, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createComponentImplementation, type ReactCatalogComponent } from '@a2ui/react'
import { CommonSchemas, type ComponentApi } from '@a2ui/web_core/v1_0'
import { WeightSchema } from '@a2ui/web_core/catalogs/basic/v1'
import { z } from 'zod/v3'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Typed loosely: the protocol schemas' full types are too deep to infer here.
const DynamicString = CommonSchemas.DynamicString as unknown as z.ZodTypeAny
const DynamicNumber = CommonSchemas.DynamicNumber as unknown as z.ZodTypeAny
const Child = CommonSchemas.Child as unknown as z.ZodTypeAny

export const tabsSchema = z
  .object({
    tabs: z
      .array(
        z
          .object({
            title: DynamicString.describe('REF:#/$defs/DynamicString|The tab title.'),
            child: Child.describe('REF:#/$defs/Child|The ID of the child component.'),
            badge: z
              .union([DynamicNumber, DynamicString])
              .optional()
              .describe(
                'A count drawn as a small red pill after the title, e.g. open items; literal or a data binding. Hidden when missing, 0 or empty.',
              ),
          })
          .strict(),
      )
      .min(1)
      .describe('An array of objects, where each object defines a tab with a title, a child component and an optional badge.'),
    open: DynamicNumber.optional().describe(
      'The zero-based index of the tab shown first, literal or a data binding; default 0, out of range is 0. Once the user picks a tab, a later change does not move them.',
    ),
    weight: (WeightSchema as unknown as z.ZodTypeAny).optional(),
  })
  .strict()
  .describe('A set of tabs, each showing one child component.')

/** Usage guidance for Tabs, appended to the catalog's instructions. */
export const TABS_CATALOG_INSTRUCTIONS =
  'Give a tab a badge for a count that needs attention, e.g. {title: "To do", child: todo, badge: $/todo/count}; ' +
  'a badge of 0 or no value is hidden, so bind it rather than leaving it out. Use open=1 (zero-based) to show a tab other than the first when the surface is drawn.'

function label(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/** A badge's text, or '' when it is hidden (missing, 0, '' or '0'). */
export function tabBadgeText(value: unknown): string {
  const shown = label(value).trim()
  return shown === '' || shown === '0' ? '' : shown
}

/** The tab `open` names, or undefined while it has no value; out of range is the first tab. */
export function openTabIndex(open: unknown, count: number): number | undefined {
  if (open === undefined || open === null || open === '') return undefined
  const index = typeof open === 'string' && /^\d+$/.test(open.trim()) ? Number(open) : open
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < count ? index : 0
}

type TabItem = { title?: unknown; child?: unknown; badge?: unknown }
type TabsProps = { tabs?: TabItem[]; open?: unknown }

function TabsView({ tabs: items, open, buildChild }: TabsProps & { buildChild: (id: string) => ReactNode }): ReactElement | null {
  const tabs = Array.isArray(items) ? items : []
  const id = useId()
  const [picked, setPicked] = useState<number | null>(null)
  const [opened, setOpened] = useState<number | null>(null)
  const first = openTabIndex(open, tabs.length)
  // The first value `open` has is latched; a later one never moves the view.
  if (opened === null && first !== undefined) setOpened(first)
  const wanted = picked ?? opened ?? first ?? 0
  const active = wanted < tabs.length ? wanted : 0

  const focusTab = (index: number, bar: HTMLElement | null) => {
    setPicked(index)
    bar?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = tabs.length - 1
    const next = { ArrowRight: active === last ? 0 : active + 1, ArrowLeft: active === 0 ? last : active - 1, Home: 0, End: last }[event.key]
    if (next === undefined) return
    event.preventDefault()
    focusTab(next, event.currentTarget)
  }

  if (tabs.length === 0) return null
  const child = tabs[active]?.child
  return (
    <div data-slot="a2ui-tabs" className="flex w-full min-w-0 flex-col">
      <div role="tablist" onKeyDown={onKeyDown} className="flex min-w-0 gap-1 overflow-x-auto border-b">
        {tabs.map((tab, index) => {
          const selected = index === active
          const count = tabBadgeText(tab.badge)
          return (
            <button
              key={index}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              aria-labelledby={count ? `${id}-title-${index} ${id}-badge-${index}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setPicked(index)}
              className={cn(
                '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
                selected ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <span id={`${id}-title-${index}`}>{label(tab.title)}</span>
              {count && (
                <Badge
                  id={`${id}-badge-${index}`}
                  data-slot="a2ui-tab-badge"
                  variant="destructive"
                  size="sm"
                  className="min-w-5 rounded-full tabular-nums"
                >
                  {count}
                </Badge>
              )}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active}`} className="min-w-0 pt-3">
        {typeof child === 'string' ? buildChild(child) : null}
      </div>
    </div>
  )
}

// Typed loosely: `zod/v3` and the renderer's own zod copy match at runtime.
export const tabsComponent: ReactCatalogComponent = createComponentImplementation(
  { name: 'Tabs', schema: tabsSchema } as unknown as ComponentApi,
  ({ props, buildChild }) => <TabsView {...(props as TabsProps)} buildChild={buildChild} />,
)
