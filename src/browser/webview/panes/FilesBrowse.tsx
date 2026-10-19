import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  ArrowUpIcon,
  CaseSensitiveIcon,
  FileTextIcon,
  FolderIcon,
  Loader2Icon,
  RegexIcon,
  SearchIcon,
  WholeWordIcon,
  XIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'

import type { FileSearchRequest } from '../../runtimeClient/fileAccess'
import type { FsxSearchState } from '../../runtimeProtocol'
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
import {
  goUpTarget,
  highlightSegments,
  joinUnder,
  parseFilterInput,
  splitFoundPath,
  type FilterInput,
} from './fileFind'
import { FileTreeView } from './FileTreeView'
import { FindResultList, type FindRow } from './FindResultList'

/** Lists one folder, one level; `null` when it cannot be read. */
export type FilesListDir = (path: string) => Promise<FolderListing | null>

export type TreeUpdate = (update: (tree: FileTreeState) => FileTreeState) => void

/**
 * Runs one search and follows its state; resolves with the function that ends
 * it, or `null` when no runtime can be asked. Rejects when it cannot start.
 */
export type FilesSearch = (
  request: FileSearchRequest,
  onState: (state: FsxSearchState) => void,
) => Promise<(() => void) | null>

/** Quiet time after a keystroke before a search starts. */
export const FILES_FIND_DEBOUNCE_MS = 120

type ContentToggles = { caseSensitive: boolean; wholeWord: boolean; regex: boolean }

/** What the results area shows for the latest search: its state, or that it could not start. */
type SearchView = { key: string; state: FsxSearchState | null; failed: boolean }

/**
 * The Files pane's browse body (F-9): a filter box above the session's file
 * tree, whose folders are listed as they come on screen. The box's modes
 * (`parseFilterInput`): empty shows the tree; a name finds files anywhere
 * below the session folder; `folder/` lists that folder under a go-up row and
 * `folder/name` finds inside it; `?text` searches file contents. Without
 * `search` a name narrows the listed rows instead.
 */
export type FilesBrowseProps = {
  tree: FileTreeState
  onTreeChange: TreeUpdate
  listDir: FilesListDir
  search?: FilesSearch
  /** Opens a file; `line` for a content hit. */
  onOpen: (path: string, line?: number) => void
  /** The open file, marked current in the tree. */
  currentPath?: string | null
}

export function FilesBrowse(props: FilesBrowseProps): ReactElement {
  const t = useT()
  const { tree, onTreeChange, listDir, search } = props
  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useState('')
  const [toggles, setToggles] = useState<ContentToggles>({ caseSensitive: false, wholeWord: false, regex: false })
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Folders asked for by this mount; a listing is requested once until it settles.
  const inFlight = useRef(new Set<string>())
  const root = tree.roots[0] ?? ''

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

  // An emptied box shows the tree at once; anything else settles first.
  useEffect(() => {
    if (query.trim() === '') {
      setSettledQuery(query)
      return
    }
    const timer = setTimeout(() => setSettledQuery(query), FILES_FIND_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const typed = useMemo(() => parseFilterInput(query), [query])
  const settled = useMemo(() => parseFilterInput(settledQuery), [settledQuery])
  const narrowing = !search && typed.mode === 'files'

  const request = useMemo((): FileSearchRequest | null => {
    if (!search || !root) return null
    if (settled.mode === 'files') return { kind: 'files', path: joinUnder(root, settled.folder), query: settled.query }
    if (settled.mode === 'content' && settled.query.trim() !== '') {
      return { kind: 'text', path: root, query: settled.query, ...toggles }
    }
    return null
  }, [search, root, settled, toggles])
  const requestKey = request ? JSON.stringify(request) : ''
  const view = useFileSearch(search, request, requestKey)

  const folderPath = settled.mode === 'folder' && root ? joinUnder(root, settled.folder) : null
  const folder = useFolderListing(listDir, folderPath)

  const rows = useMemo(
    () => (narrowing ? filterTree(tree, typed.query) : flattenTree(tree)),
    [narrowing, tree, typed],
  )

  const onToggle = (path: string) => {
    if (!narrowing) {
      onTreeChange(current => toggleDir(current, path))
      return
    }
    // A filtered folder opens for real, so its listing joins what the box searches.
    onTreeChange(current => {
      const revealed = revealPath(current, path).state
      return revealed.expanded.has(path) ? revealed : toggleDir(revealed, path)
    })
  }

  const setBox = (text: string) => {
    setQuery(text)
    inputRef.current?.focus()
  }
  const clear = () => setBox('')

  const busy =
    (request !== null && (view.key !== requestKey || (view.state?.scanning ?? !view.failed))) ||
    (folderPath !== null && folder.path === folderPath && folder.listing === 'loading')
  const shownState = view.state && settled.mode !== 'tree' ? view.state : null
  const invalidRegex = typed.mode === 'content' && shownState?.kind === 'text' && shownState.error === 'invalid_regex'

  let body: ReactNode
  if (typed.mode === 'tree' || narrowing) {
    body =
      narrowing && rows.length === 0 ? (
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
          onOpen={path => props.onOpen(path)}
          onRetry={path => onTreeChange(current => retryListing(current, path))}
          onExitTop={() => inputRef.current?.focus()}
          onEscape={narrowing ? clear : undefined}
        />
      )
  } else if (typed.mode === 'content' && typed.query.trim() === '') {
    body = <Note testId="files-find-content-hint" text={t('filesFind.contentHint')} />
  } else {
    const findRows =
      settled.mode === 'folder'
        ? folderRows(t, settled, folder, folderPath, setBox, props.onOpen)
        : resultRows(t, settled, shownState, view.failed && view.key === requestKey, root, props.onOpen)
    body = (
      <>
        {settled.mode === 'folder' && <GoUpRow folder={settled.folder} onGo={setBox} />}
        <FindResultList
          rows={findRows}
          label={t('filesFind.results')}
          onExitTop={() => inputRef.current?.focus()}
          onEscape={clear}
        />
      </>
    )
  }

  const focusFirstRow = () => {
    bodyRef.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex], [data-find-row]')?.focus()
  }
  const openFirst = (): boolean => {
    if (typed.mode === 'tree') return false
    if (narrowing) {
      const first = rows.find(row => isNodeRow(row) && row.kind !== 'dir')
      if (!first) return false
      props.onOpen(first.path)
      return true
    }
    const first = bodyRef.current?.querySelector<HTMLElement>('[data-find-row]')
    if (!first) return false
    first.click()
    return true
  }

  return (
    <div data-testid="files-browse" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        {busy ? (
          <Loader2Icon
            role="status"
            aria-label={t('filesFind.searching')}
            data-testid="files-find-spinner"
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
        ) : (
          <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={query}
          data-testid="files-browse-filter"
          aria-label={t('filesBrowse.filterLabel')}
          aria-invalid={invalidRegex || undefined}
          placeholder={search ? t('filesFind.placeholder') : t('filesBrowse.filterPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              focusFirstRow()
            } else if (event.key === 'Enter') {
              if (openFirst()) event.preventDefault()
            } else if (event.key === 'Escape' && query !== '') {
              event.preventDefault()
              event.stopPropagation()
              setQuery('')
            }
          }}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground',
            invalidRegex && 'text-destructive',
          )}
        />
        {search && typed.mode === 'content' && (
          <div role="group" aria-label={t('filesFind.searchOptions')} className="flex shrink-0 items-center gap-0.5">
            <OptionToggle
              testId="files-find-match-case"
              label={t('filesFind.matchCase')}
              pressed={toggles.caseSensitive}
              onToggle={() => setToggles(current => ({ ...current, caseSensitive: !current.caseSensitive }))}
            >
              <CaseSensitiveIcon className="size-3.5" />
            </OptionToggle>
            <OptionToggle
              testId="files-find-whole-word"
              label={t('filesFind.wholeWord')}
              pressed={toggles.wholeWord}
              onToggle={() => setToggles(current => ({ ...current, wholeWord: !current.wholeWord }))}
            >
              <WholeWordIcon className="size-3.5" />
            </OptionToggle>
            <OptionToggle
              testId="files-find-regex"
              label={t('filesFind.regex')}
              pressed={toggles.regex}
              onToggle={() => setToggles(current => ({ ...current, regex: !current.regex }))}
            >
              <RegexIcon className="size-3.5" />
            </OptionToggle>
          </div>
        )}
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
      {invalidRegex && (
        <p data-testid="files-find-invalid-regex" className="border-b px-3 py-1 text-caption text-destructive">
          {t('filesFind.invalidRegex')}
        </p>
      )}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {body}
      </div>
    </div>
  )
}

/**
 * Runs `request` (keyed by `requestKey`) and follows its state. A newer request
 * is started before the older one is ended, so a file list both read keeps
 * being built; the last one ends on unmount.
 */
function useFileSearch(search: FilesSearch | undefined, request: FileSearchRequest | null, requestKey: string): SearchView {
  const [view, setView] = useState<SearchView>({ key: '', state: null, failed: false })
  const latest = useRef(0)
  const running = useRef<(() => void) | null>(null)
  // The first file search of this mount lists the folder again; later ones reuse that list.
  const refreshNext = useRef(true)
  const requestRef = useRef(request)
  requestRef.current = request

  useEffect(() => {
    const current = requestRef.current
    const token = ++latest.current
    if (!search || !current) {
      running.current?.()
      running.current = null
      return
    }
    let started = current
    if (current.kind === 'files' && refreshNext.current) {
      refreshNext.current = false
      started = { ...current, refresh: true }
    }
    search(started, state => {
      if (latest.current === token) setView({ key: requestKey, state, failed: false })
    })
      .then(stop => {
        if (!stop) return
        if (latest.current !== token) {
          stop()
          return
        }
        const previous = running.current
        running.current = stop
        previous?.()
      })
      .catch(() => {
        if (latest.current === token) setView({ key: requestKey, state: null, failed: true })
      })
  }, [search, requestKey])

  useEffect(
    () => () => {
      latest.current += 1
      running.current?.()
      running.current = null
    },
    [],
  )

  return view
}

type FolderView = { path: string | null; listing: FolderListing | null | 'loading' }

function useFolderListing(listDir: FilesListDir, path: string | null): FolderView {
  const [view, setView] = useState<FolderView>({ path: null, listing: null })
  useEffect(() => {
    if (path === null) return
    let live = true
    setView({ path, listing: 'loading' })
    listDir(path)
      .catch(() => null)
      .then(listing => {
        if (live) setView({ path, listing })
      })
    return () => {
      live = false
    }
  }, [listDir, path])
  return view
}

type Translate = ReturnType<typeof useT>

function folderRows(
  t: Translate,
  input: Extract<FilterInput, { mode: 'folder' }>,
  folder: FolderView,
  folderPath: string | null,
  setBox: (text: string) => void,
  onOpen: (path: string) => void,
): FindRow[] {
  if (folderPath === null || folder.path !== folderPath || folder.listing === 'loading') {
    return [noteRow('files-find-listing', t('filesBrowse.listing'))]
  }
  if (folder.listing === null) return [noteRow('files-find-read-error', t('filesBrowse.readError'))]
  if (folder.listing.entries.length === 0) return [noteRow('files-find-empty-folder', t('filesBrowse.emptyFolder'))]
  const rows: FindRow[] = folder.listing.entries.map(entry => {
    const path = joinUnder(folderPath, entry.name)
    return {
      key: entry.name,
      testId: `files-find-entry:${entry.name}`,
      title: path,
      onActivate: entry.isDirectory ? () => setBox(`${input.folder}/${entry.name}/`) : () => onOpen(path),
      content: (
        <>
          {entry.isDirectory ? (
            <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{entry.name}</span>
        </>
      ),
    }
  })
  if (folder.listing.truncated) rows.push(noteRow('files-find-more-entries', t('filesBrowse.moreEntries')))
  return rows
}

function resultRows(
  t: Translate,
  input: FilterInput,
  state: FsxSearchState | null,
  failed: boolean,
  root: string,
  onOpen: (path: string, line?: number) => void,
): FindRow[] {
  if (failed) return [noteRow('files-find-failed', t('filesFind.failed'))]
  if (!state) return []
  if (state.error === 'unavailable') return [noteRow('files-find-unavailable', t('filesFind.unavailable'))]
  if (state.error === 'invalid_regex') return []
  if (state.error === 'failed') return [noteRow('files-find-failed', t('filesFind.failed'))]
  const base = input.mode === 'files' ? joinUnder(root, input.folder) : root
  const rows: FindRow[] = []
  if (state.kind === 'files') {
    if (input.mode !== 'files') return []
    for (const file of state.files) {
      const { name, parent, nameStart } = splitFoundPath(file.path)
      const path = joinUnder(base, file.path)
      rows.push({
        key: file.path,
        testId: `files-find-file:${file.path}`,
        title: path,
        onActivate: () => onOpen(path),
        content: (
          <>
            <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 shrink-0 truncate">
              <Highlighted text={name} ranges={file.ranges} offset={nameStart} />
            </span>
            {parent && (
              <span className="min-w-0 truncate text-caption text-muted-foreground">
                <Highlighted text={parent} ranges={file.ranges} offset={0} />
              </span>
            )}
          </>
        ),
      })
    }
    if (!state.scanning && state.files.length === 0) rows.push(noteRow('files-find-no-matches', t('filesFind.noFiles')))
    if (state.matched > state.files.length) {
      rows.push(noteRow('files-find-capped', t('filesFind.filesCapped', { shown: state.files.length, total: state.matched })))
    }
    if (state.indexTruncated) rows.push(noteRow('files-find-index-truncated', t('filesFind.indexTruncated')))
    return rows
  }
  if (input.mode !== 'content') return []
  for (const file of state.files) {
    const { name, parent } = splitFoundPath(file.path)
    const path = joinUnder(base, file.path)
    rows.push({
      key: `file:${file.path}`,
      testId: `files-find-hits:${file.path}`,
      title: path,
      onActivate: () => onOpen(path),
      content: (
        <>
          <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 shrink-0 truncate font-medium">{name}</span>
          {parent && <span className="min-w-0 truncate text-caption text-muted-foreground">{parent}</span>}
        </>
      ),
    })
    for (const hit of file.hits) {
      rows.push({
        key: `hit:${file.path}:${hit.line}`,
        testId: `files-find-hit:${file.path}:${hit.line}`,
        title: `${path}:${hit.line}`,
        inset: true,
        onActivate: () => onOpen(path, hit.line),
        content: (
          <>
            <span className="w-8 shrink-0 text-end font-mono text-caption tabular-nums text-muted-foreground">
              {hit.line}
            </span>
            <span className="min-w-0 truncate whitespace-pre font-mono text-caption">
              <Highlighted text={hit.text} ranges={hit.ranges} offset={0} mark />
            </span>
          </>
        ),
      })
    }
    if (file.moreInFile) {
      rows.push({ ...noteRow(`files-find-more-in-file:${file.path}`, t('filesFind.moreInFile')), inset: true })
    }
  }
  if (!state.scanning && state.files.length === 0) {
    rows.push(noteRow('files-find-no-matches', t('filesFind.noContentMatches')))
  }
  if (state.truncated) {
    const lines = state.files.reduce((sum, file) => sum + file.hits.length, 0)
    rows.push(noteRow('files-find-capped', t('filesFind.linesCapped', { count: lines })))
  }
  return rows
}

function noteRow(testId: string, text: string): FindRow {
  return { key: `note:${testId}`, testId, content: <span className="min-w-0 truncate">{text}</span> }
}

function Highlighted(props: { text: string; ranges: readonly number[]; offset: number; mark?: boolean }): ReactElement {
  return (
    <>
      {highlightSegments(props.text, props.ranges, props.offset).map((segment, index) =>
        segment.hit ? (
          <mark
            key={index}
            className={cn(
              'rounded-sm bg-transparent text-foreground',
              props.mark ? 'bg-primary/25' : 'font-semibold',
            )}
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  )
}

function Note({ testId, text }: { testId: string; text: string }): ReactElement {
  return (
    <p data-testid={testId} className="px-3 py-4 text-center text-body text-muted-foreground">
      {text}
    </p>
  )
}

function GoUpRow({ folder, onGo }: { folder: string; onGo: (text: string) => void }): ReactElement {
  const t = useT()
  const target = goUpTarget(folder)
  return (
    <button
      type="button"
      data-testid="files-find-go-up"
      onClick={() => onGo(target.kind === 'root' ? '' : target.input)}
      className="mx-1 mt-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-body text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <ArrowUpIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {target.kind === 'root' ? t('filesFind.goUpToRoot') : t('filesFind.goUpTo', { name: target.name })}
      </span>
    </button>
  )
}

function OptionToggle(props: {
  testId: string
  label: string
  pressed: boolean
  onToggle: () => void
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      onClick={props.onToggle}
      className={cn(
        'flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground',
        props.pressed && 'bg-muted text-foreground ring-1 ring-ring',
      )}
    >
      {props.children}
    </button>
  )
}
