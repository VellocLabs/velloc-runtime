import { useContext, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { ChevronRightIcon, FileTextIcon, FolderIcon, LinkIcon, Loader2Icon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { useT } from '../i18n'
import {
  isFocusableRow,
  isNodeRow,
  moveFocus,
  rowKey,
  type TreeKey,
  type TreeNode,
  type TreeRow,
  type TreeStatusRow,
} from '../layout/fileTree'
import { FILES_ROW_PATH_ATTR, FilesRowMenu, FilesRowMenuContext } from './FilesRowMenu'

const TREE_KEYS: ReadonlySet<string> = new Set<TreeKey>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
])

/** Per-level indent; the guides and the row padding both read it. */
const INDENT_PX = 12
/** Start padding of a depth-0 row. */
const ROW_START_PX = 4
/** Width of the chevron column (`size-4`); a guide sits at its centre. */
const CHEVRON_PX = 16

/**
 * The Files pane's tree (F-9 browse state): one row per entry of the rows the
 * model flattened, with status rows under folders being listed, unreadable,
 * empty or capped. One row is in the tab order at a time (`activeKey`); the
 * arrow keys move it with tree semantics.
 */
export type FileTreeViewProps = {
  rows: readonly TreeRow[]
  /** Accessible name of the tree. */
  label: string
  /** The open file's path, marked current. */
  currentPath?: string | null
  /** The row in the tab order; the first focusable row when absent or gone. */
  activeKey: string | null
  onActiveKeyChange: (key: string) => void
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onRetry: (path: string) => void
  /** ↑ on the first focusable row. */
  onExitTop?: () => void
  onEscape?: () => void
}

export function FileTreeView(props: FileTreeViewProps): ReactElement {
  const t = useT()
  const { rows } = props
  const rowMenu = useContext(FilesRowMenuContext)
  const rowEls = useRef(new Map<string, HTMLElement>())
  const firstFocusable = rows.findIndex(isFocusableRow)
  const activeIndex = (() => {
    const at = props.activeKey === null ? -1 : rows.findIndex(row => rowKey(row) === props.activeKey)
    return at >= 0 && isFocusableRow(rows[at]) ? at : firstFocusable
  })()

  const focusRow = (index: number) => {
    const key = rowKey(rows[index])
    props.onActiveKeyChange(key)
    rowEls.current.get(key)?.focus()
  }

  const activate = (row: TreeRow) => {
    if (!isNodeRow(row)) {
      if (row.kind === 'error') props.onRetry(row.path)
      return
    }
    if (row.kind === 'dir') props.onToggle(row.path)
    else props.onOpen(row.path)
  }

  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const row = rows[index]
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate(row)
      return
    }
    if (event.key === 'Escape') {
      if (props.onEscape) {
        event.preventDefault()
        props.onEscape()
      }
      return
    }
    if (!TREE_KEYS.has(event.key)) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && index === firstFocusable && props.onExitTop) {
      props.onExitTop()
      return
    }
    const move = moveFocus(rows, index, event.key as TreeKey)
    if (move.toggle !== undefined) props.onToggle(move.toggle)
    else if (move.index !== index) focusRow(move.index)
  }

  const tree = (
    <div
      role="tree"
      aria-label={props.label}
      data-testid="files-tree"
      className="group/tree flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-1"
    >
      {rows.map((row, index) => {
        const key = rowKey(row)
        const focusable = isFocusableRow(row)
        const setEl = (el: HTMLElement | null) => {
          if (el) rowEls.current.set(key, el)
          else rowEls.current.delete(key)
        }
        const shared = {
          ref: setEl,
          role: 'treeitem',
          'aria-level': row.depth + 1,
          tabIndex: focusable ? (index === activeIndex ? 0 : -1) : undefined,
          onFocus: focusable ? () => props.onActiveKeyChange(key) : undefined,
          onKeyDown: focusable ? (event: KeyboardEvent<HTMLElement>) => onRowKeyDown(event, index) : undefined,
          style: { paddingInlineStart: ROW_START_PX + row.depth * INDENT_PX },
        }
        if (isNodeRow(row)) {
          return (
            <div
              key={key}
              {...shared}
              aria-expanded={row.kind === 'dir' ? row.expanded === true : undefined}
              aria-current={row.path === props.currentPath ? 'true' : undefined}
              data-testid={`files-tree-row:${row.path}`}
              data-kind={row.kind}
              {...{ [FILES_ROW_PATH_ATTR]: row.path }}
              title={row.path}
              onClick={() => activate(row)}
              className={cn(
                'relative flex h-6 shrink-0 cursor-default select-none items-center gap-1 rounded-md pe-2 text-body outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
                row.path === props.currentPath && 'bg-muted font-medium',
              )}
            >
              <IndentGuides depth={row.depth} />
              <NodeContent row={row} linkLabel={t('filesBrowse.symbolicLink')} />
            </div>
          )
        }
        return (
          <div
            key={key}
            {...shared}
            aria-disabled={focusable ? undefined : true}
            data-testid={`files-tree-status:${row.kind}:${row.path}`}
            className="relative flex h-6 shrink-0 select-none items-center gap-1.5 rounded-md pe-2 text-body text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <IndentGuides depth={row.depth} />
            <StatusContent row={row} onRetry={() => props.onRetry(row.path)} />
          </div>
        )
      })}
    </div>
  )
  return rowMenu ? <FilesRowMenu {...rowMenu}>{tree}</FilesRowMenu> : tree
}

function IndentGuides({ depth }: { depth: number }): ReactNode {
  if (depth === 0) return null
  return Array.from({ length: depth }, (_, level) => (
    <span
      key={level}
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-px bg-border opacity-0 transition-opacity group-hover/tree:opacity-100 group-focus-within/tree:opacity-100"
      style={{ insetInlineStart: ROW_START_PX + level * INDENT_PX + CHEVRON_PX / 2 }}
    />
  ))
}

function NodeContent({ row, linkLabel }: { row: TreeNode; linkLabel: string }): ReactElement {
  const Icon = row.kind === 'dir' ? FolderIcon : row.kind === 'link' ? LinkIcon : FileTextIcon
  return (
    <>
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {row.kind === 'dir' && (
          <ChevronRightIcon className={cn('size-3.5 transition-transform', row.expanded && 'rotate-90')} />
        )}
      </span>
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{row.name}</span>
      {row.kind === 'link' && (
        <span className="min-w-0 shrink-0 truncate text-caption text-muted-foreground">{linkLabel}</span>
      )}
    </>
  )
}

function StatusContent({ row, onRetry }: { row: TreeStatusRow; onRetry: () => void }): ReactElement {
  const t = useT()
  const spacer = <span aria-hidden className="size-4 shrink-0" />
  switch (row.kind) {
    case 'loading':
      return (
        <>
          {spacer}
          <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">{t('filesBrowse.listing')}</span>
        </>
      )
    case 'error':
      return (
        <>
          {spacer}
          <span className="min-w-0 truncate text-destructive">{t('filesBrowse.readError')}</span>
          <button
            type="button"
            tabIndex={-1}
            data-testid={`files-tree-retry:${row.path}`}
            onClick={onRetry}
            className="shrink-0 rounded px-1 text-foreground underline-offset-2 hover:underline"
          >
            {t('filesBrowse.retry')}
          </button>
        </>
      )
    case 'empty':
      return (
        <>
          {spacer}
          <span className="min-w-0 truncate italic">{t('filesBrowse.emptyFolder')}</span>
        </>
      )
    case 'more':
      return (
        <>
          {spacer}
          <span className="min-w-0 truncate">{t('filesBrowse.moreEntries')}</span>
        </>
      )
  }
}
