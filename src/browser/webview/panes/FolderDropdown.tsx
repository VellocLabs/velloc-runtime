import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, FileTextIcon, FolderIcon, LinkIcon, Loader2Icon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { useT } from '../i18n'
import {
  applyListing,
  emptyFileTree,
  flattenTree,
  isFocusableRow,
  isNodeRow,
  markListing,
  moveFocus,
  pendingListings,
  retryListing,
  rowKey,
  toggleDir,
  type FileTreeState,
  type TreeKey,
  type TreeRow,
} from '../layout/fileTree'
import type { FilesListDir } from './FilesBrowse'

const TREE_KEYS: ReadonlySet<string> = new Set<TreeKey>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
])

const INDENT_PX = 12
const ROW_START_PX = 4
/** Typed letters within this gap extend the type-ahead prefix. */
const TYPE_AHEAD_RESET_MS = 700
/** How far an edge arrow scrolls the list per tick while hovered. */
const EDGE_SCROLL_PX = 6
const EDGE_SCROLL_TICK_MS = 16

/**
 * The next node row from `from` whose name starts with `prefix`
 * (case-insensitive), wrapping around. A prefix of one repeated letter cycles
 * past the current row; a longer prefix may stay on it.
 */
export function typeAheadIndex(rows: readonly TreeRow[], from: number, prefix: string): number {
  const needle = prefix.toLowerCase()
  const cycling = needle.length > 1 && [...needle].every(ch => ch === needle[0])
  const wanted = cycling ? needle[0] : needle
  const start = needle.length === 1 || cycling ? from + 1 : from
  for (let step = 0; step < rows.length; step++) {
    const i = (((start + step) % rows.length) + rows.length) % rows.length
    const row = rows[i]
    if (isNodeRow(row) && row.name.toLowerCase().startsWith(wanted)) return i
  }
  return -1
}

/** The dropdown's rows: the folder's entries, without the folder's own row, one level shallower. */
function dropdownRows(tree: FileTreeState): TreeRow[] {
  return flattenTree(tree)
    .slice(1)
    .map(row => ({ ...row, depth: row.depth - 1 }))
}

export type FolderDropdownProps = {
  folder: string
  /** A file of `folder` shown selected and focused first. */
  selectedPath?: string
  listDir: FilesListDir
  /** Height cap of the list, in pixels. */
  maxHeight: number
  /** Accessible name of the list. */
  label: string
  onOpen: (path: string) => void
}

/**
 * A path-bar segment's dropdown (F-9): `folder`'s entries as a small tree,
 * folders first. Folders expand in place, listed lazily; a file opens on click
 * or Enter. The first row (or the selected file) takes focus once listed;
 * ↑ ↓ ← → Home End move with tree semantics and typed letters jump by name.
 * The tree state lives only while the dropdown is open.
 */
export function FolderDropdown(props: FolderDropdownProps): ReactElement {
  const t = useT()
  const { listDir } = props
  const [tree, setTree] = useState<FileTreeState>(() => emptyFileTree([props.folder]))
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const inFlight = useRef(new Set<string>())
  const rowEls = useRef(new Map<string, HTMLElement>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const focusedOnce = useRef(false)
  const typed = useRef({ text: '', at: 0 })
  const [edges, setEdges] = useState({ up: false, down: false })
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const pending = pendingListings(tree).filter(path => !inFlight.current.has(path))
    if (pending.length === 0) return
    for (const path of pending) inFlight.current.add(path)
    setTree(current => pending.reduce(markListing, current))
    for (const path of pending) {
      listDir(path)
        .catch(() => null)
        .then(listing => {
          inFlight.current.delete(path)
          setTree(current => applyListing(current, path, listing))
        })
    }
  }, [tree, listDir])

  const rows = useMemo(() => dropdownRows(tree), [tree])
  const firstFocusable = rows.findIndex(isFocusableRow)
  const activeIndex = (() => {
    const at = activeKey === null ? -1 : rows.findIndex(row => rowKey(row) === activeKey)
    return at >= 0 && isFocusableRow(rows[at]) ? at : firstFocusable
  })()

  const focusRow = (index: number) => {
    const key = rowKey(rows[index])
    setActiveKey(key)
    const el = rowEls.current.get(key)
    el?.focus()
    el?.scrollIntoView?.({ block: 'nearest' })
  }

  // Focus lands once, when the folder's entries first arrive.
  useEffect(() => {
    if (focusedOnce.current || firstFocusable < 0) return
    focusedOnce.current = true
    const selected = props.selectedPath === undefined ? -1 : rows.findIndex(row => isNodeRow(row) && row.path === props.selectedPath)
    focusRow(selected >= 0 ? selected : firstFocusable)
  })

  const updateEdges = () => {
    const el = scrollRef.current
    if (!el) return
    const up = el.scrollTop > 0
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1
    setEdges(current => (current.up === up && current.down === down ? current : { up, down }))
  }
  useEffect(updateEdges, [rows])

  const stopEdgeScroll = () => {
    if (edgeTimer.current !== null) clearInterval(edgeTimer.current)
    edgeTimer.current = null
  }
  const startEdgeScroll = (direction: 1 | -1) => {
    stopEdgeScroll()
    edgeTimer.current = setInterval(() => {
      const el = scrollRef.current
      if (!el) return
      const before = el.scrollTop
      el.scrollTop += direction * EDGE_SCROLL_PX
      updateEdges()
      // At the edge its arrow unmounts under the pointer, which then never leaves it.
      if (el.scrollTop === before) stopEdgeScroll()
    }, EDGE_SCROLL_TICK_MS)
  }
  useEffect(() => stopEdgeScroll, [])

  const activate = (row: TreeRow) => {
    if (!isNodeRow(row)) {
      if (row.kind === 'error') setTree(current => retryListing(current, row.path))
      return
    }
    if (row.kind === 'dir') setTree(current => toggleDir(current, row.path))
    else props.onOpen(row.path)
  }

  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const row = rows[index]
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate(row)
      return
    }
    if (TREE_KEYS.has(event.key)) {
      event.preventDefault()
      const move = moveFocus(rows, index, event.key as TreeKey)
      if (move.toggle !== undefined) setTree(current => toggleDir(current, move.toggle!))
      else if (move.index !== index) focusRow(move.index)
      return
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    const now = Date.now()
    const text = now - typed.current.at > TYPE_AHEAD_RESET_MS ? event.key : typed.current.text + event.key
    typed.current = { text, at: now }
    const next = typeAheadIndex(rows, index, text)
    if (next >= 0 && next !== index) focusRow(next)
  }

  return (
    <div data-testid="files-pathbar-dropdown" className="flex flex-col">
      {edges.up && (
        <div
          aria-hidden
          data-testid="files-pathbar-dropdown-scroll-up"
          onPointerEnter={() => startEdgeScroll(-1)}
          onPointerLeave={stopEdgeScroll}
          className="flex h-4 shrink-0 items-center justify-center text-muted-foreground"
        >
          <ChevronUpIcon className="size-3.5" />
        </div>
      )}
      <div
        ref={scrollRef}
        role="tree"
        aria-label={props.label}
        onScroll={updateEdges}
        style={{ maxHeight: props.maxHeight }}
        className="flex flex-col overflow-y-auto [scrollbar-width:none]"
      >
        {rows.map((row, index) => {
          const key = rowKey(row)
          const focusable = isFocusableRow(row)
          const shared = {
            ref: (el: HTMLElement | null) => {
              if (el) rowEls.current.set(key, el)
              else rowEls.current.delete(key)
            },
            role: 'treeitem',
            'aria-level': row.depth + 1,
            tabIndex: focusable ? (index === activeIndex ? 0 : -1) : undefined,
            onFocus: focusable ? () => setActiveKey(key) : undefined,
            onKeyDown: focusable ? (event: KeyboardEvent<HTMLElement>) => onRowKeyDown(event, index) : undefined,
            style: { paddingInlineStart: ROW_START_PX + row.depth * INDENT_PX },
          }
          if (isNodeRow(row)) {
            const Icon = row.kind === 'dir' ? FolderIcon : row.kind === 'link' ? LinkIcon : FileTextIcon
            const selected = row.path === props.selectedPath
            return (
              <div
                key={key}
                {...shared}
                aria-expanded={row.kind === 'dir' ? row.expanded === true : undefined}
                aria-selected={selected || undefined}
                data-testid={`files-pathbar-dropdown-row:${row.path}`}
                data-kind={row.kind}
                title={row.path}
                onClick={() => activate(row)}
                className={cn(
                  'flex h-6 shrink-0 cursor-default select-none items-center gap-1 rounded-md pe-2 text-body outline-none hover:bg-muted focus:ring-1 focus:ring-ring focus:ring-inset',
                  selected && 'bg-muted font-medium',
                )}
              >
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {row.kind === 'dir' && (
                    <ChevronRightIcon className={cn('size-3.5 transition-transform', row.expanded && 'rotate-90')} />
                  )}
                </span>
                <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{row.name}</span>
              </div>
            )
          }
          return (
            <div
              key={key}
              {...shared}
              aria-disabled={focusable ? undefined : true}
              data-testid={`files-pathbar-dropdown-status:${row.kind}:${row.path}`}
              className="flex h-6 shrink-0 select-none items-center gap-1.5 rounded-md pe-2 text-body text-muted-foreground outline-none focus:ring-1 focus:ring-ring focus:ring-inset"
            >
              <span aria-hidden className="size-4 shrink-0" />
              {row.kind === 'loading' && <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />}
              <span className={cn('min-w-0 truncate', row.kind === 'error' && 'text-destructive', row.kind === 'empty' && 'italic')}>
                {row.kind === 'loading'
                  ? t('filesPathBar.listing')
                  : row.kind === 'error'
                    ? t('filesPathBar.readError')
                    : row.kind === 'empty'
                      ? t('filesPathBar.emptyFolder')
                      : t('filesPathBar.moreEntries')}
              </span>
            </div>
          )
        })}
      </div>
      {edges.down && (
        <div
          aria-hidden
          data-testid="files-pathbar-dropdown-scroll-down"
          onPointerEnter={() => startEdgeScroll(1)}
          onPointerLeave={stopEdgeScroll}
          className="flex h-4 shrink-0 items-center justify-center text-muted-foreground"
        >
          <ChevronDownIcon className="size-3.5" />
        </div>
      )}
    </div>
  )
}
