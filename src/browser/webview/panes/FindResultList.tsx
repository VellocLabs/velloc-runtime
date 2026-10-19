import { useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** One row of a flat result list; a row without `onActivate` is a note and takes no focus. */
export type FindRow = {
  key: string
  testId: string
  content: ReactNode
  onActivate?: () => void
  title?: string
  /** Drawn one step in (a content hit under its file). */
  inset?: boolean
}

export type FindResultListProps = {
  rows: readonly FindRow[]
  /** Accessible name of the list. */
  label: string
  /** ↑ on the first focusable row. */
  onExitTop?: () => void
  onEscape?: () => void
}

/**
 * The Files pane's flat results (F-9 filter modes): one row per result, one
 * focusable row in the tab order at a time; ↑ ↓ Home End move it, Enter or
 * Space opens it, Escape hands back to the filter box.
 */
export function FindResultList(props: FindResultListProps): ReactElement {
  const { rows } = props
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const rowEls = useRef(new Map<string, HTMLElement>())
  const focusable = rows.flatMap((row, index) => (row.onActivate ? [index] : []))
  const activeIndex = (() => {
    const at = activeKey === null ? -1 : rows.findIndex(row => row.key === activeKey)
    return at >= 0 && rows[at]!.onActivate ? at : (focusable[0] ?? -1)
  })()

  const focusAt = (index: number | undefined) => {
    if (index === undefined) return
    const key = rows[index]!.key
    setActiveKey(key)
    rowEls.current.get(key)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const at = focusable.indexOf(index)
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault()
        rows[index]!.onActivate?.()
        return
      case 'Escape':
        if (props.onEscape) {
          event.preventDefault()
          props.onEscape()
        }
        return
      case 'ArrowDown':
        event.preventDefault()
        focusAt(focusable[at + 1])
        return
      case 'ArrowUp':
        event.preventDefault()
        if (at <= 0) props.onExitTop?.()
        else focusAt(focusable[at - 1])
        return
      case 'Home':
        event.preventDefault()
        focusAt(focusable[0])
        return
      case 'End':
        event.preventDefault()
        focusAt(focusable[focusable.length - 1])
        return
    }
  }

  return (
    <div
      role="list"
      aria-label={props.label}
      data-testid="files-find-results"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-1"
    >
      {rows.map((row, index) => {
        const canFocus = row.onActivate !== undefined
        return (
          <div
            key={row.key}
            role="listitem"
            ref={el => {
              if (el) rowEls.current.set(row.key, el)
              else rowEls.current.delete(row.key)
            }}
            data-testid={row.testId}
            data-find-row={canFocus ? '' : undefined}
            title={row.title}
            tabIndex={canFocus ? (index === activeIndex ? 0 : -1) : undefined}
            onFocus={canFocus ? () => setActiveKey(row.key) : undefined}
            onKeyDown={canFocus ? event => onKeyDown(event, index) : undefined}
            onClick={row.onActivate}
            className={cn(
              'flex min-h-6 shrink-0 select-none items-center gap-1.5 rounded-md pe-2 text-body outline-none',
              row.inset ? 'ps-6' : 'ps-1.5',
              canFocus
                ? 'cursor-default hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset'
                : 'text-muted-foreground',
            )}
          >
            {row.content}
          </div>
        )
      })}
    </div>
  )
}
