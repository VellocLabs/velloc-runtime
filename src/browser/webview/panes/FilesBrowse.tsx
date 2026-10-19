import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'

import { useT } from '../i18n'
import {
  applyListing,
  filterTree,
  flattenTree,
  isNodeRow,
  markListing,
  pendingListings,
  retryListing,
  revealPath,
  toggleDir,
  type FileTreeState,
  type FolderListing,
} from '../layout/fileTree'
import { FileTreeView } from './FileTreeView'

/** Lists one folder, one level; `null` when it cannot be read. */
export type FilesListDir = (path: string) => Promise<FolderListing | null>

export type TreeUpdate = (update: (tree: FileTreeState) => FileTreeState) => void

/**
 * The Files pane's browse body (F-9): a filter box above the session's file
 * tree. Expanded folders are listed as they come on screen. A non-empty box
 * narrows the rows to the listed entries whose name contains the text.
 */
export type FilesBrowseProps = {
  tree: FileTreeState
  onTreeChange: TreeUpdate
  listDir: FilesListDir
  onOpen: (path: string) => void
  /** The open file, marked current in the tree. */
  currentPath?: string | null
}

export function FilesBrowse(props: FilesBrowseProps): ReactElement {
  const t = useT()
  const { tree, onTreeChange, listDir } = props
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const treeBoxRef = useRef<HTMLDivElement>(null)
  // Folders asked for by this mount; a listing is requested once until it settles.
  const inFlight = useRef(new Set<string>())

  useEffect(() => {
    const pending = pendingListings(tree).filter(path => !inFlight.current.has(path))
    if (pending.length === 0) return
    for (const path of pending) inFlight.current.add(path)
    onTreeChange(current => pending.reduce(markListing, current))
    for (const path of pending) {
      listDir(path)
        .catch(() => null)
        .then(listing => {
          inFlight.current.delete(path)
          onTreeChange(current => applyListing(current, path, listing))
        })
    }
  }, [tree, listDir, onTreeChange])

  const filtering = query.trim() !== ''
  const rows = useMemo(
    () => (filtering ? filterTree(tree, query) : flattenTree(tree)),
    [filtering, tree, query],
  )

  const onToggle = (path: string) => {
    if (!filtering) {
      onTreeChange(current => toggleDir(current, path))
      return
    }
    // A filtered folder opens for real, so its listing joins what the box searches.
    onTreeChange(current => {
      const revealed = revealPath(current, path).state
      return revealed.expanded.has(path) ? revealed : toggleDir(revealed, path)
    })
  }

  const focusFirstRow = () => {
    treeBoxRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex]')?.focus()
  }

  const clear = () => {
    setQuery('')
    inputRef.current?.focus()
  }

  return (
    <div data-testid="files-browse" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          data-testid="files-browse-filter"
          aria-label={t('filesBrowse.filterLabel')}
          placeholder={t('filesBrowse.filterPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              focusFirstRow()
            } else if (event.key === 'Enter' && filtering) {
              const first = rows.find(row => isNodeRow(row) && row.kind !== 'dir')
              if (first) {
                event.preventDefault()
                props.onOpen(first.path)
              }
            } else if (event.key === 'Escape' && query !== '') {
              event.preventDefault()
              event.stopPropagation()
              setQuery('')
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
        />
        {query !== '' && (
          <button
            type="button"
            aria-label={t('filesBrowse.clearFilter')}
            data-testid="files-browse-clear"
            onClick={clear}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div ref={treeBoxRef} className="flex min-h-0 flex-1 flex-col">
        {filtering && rows.length === 0 ? (
          <p data-testid="files-browse-no-matches" className="px-3 py-4 text-center text-body text-muted-foreground">
            {t('filesBrowse.noMatches')}
          </p>
        ) : (
          <FileTreeView
            rows={rows}
            label={t('filesBrowse.title')}
            currentPath={props.currentPath}
            activeKey={activeKey}
            onActiveKeyChange={setActiveKey}
            onToggle={onToggle}
            onOpen={props.onOpen}
            onRetry={path => onTreeChange(current => retryListing(current, path))}
            onExitTop={() => inputRef.current?.focus()}
            onEscape={filtering ? clear : undefined}
          />
        )}
      </div>
    </div>
  )
}
