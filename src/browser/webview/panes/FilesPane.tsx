import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { FileTextIcon, FolderIcon, ListTreeIcon, SearchIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { baseName } from '@/utils/paths'

import { FilePanel } from '../FilePanel'
import { useT } from '../i18n'
import { emptyFileTree, revealPath, withRoots, type FileTreeState } from '../layout/fileTree'
import { reconcileMountedFiles, sameMountedFiles } from '../layout/filesPane'
import { dockFits, maxDockWidth, treeSpelling } from '../layout/filesTreeDock'
import type { FilesPaneState } from '../layout/paneLayout'
import { FILES_TREE_ARIA_SHORTCUT, PANE_SHORTCUT_MODIFIER } from '../layout/paneShortcuts'
import { FilesBrowse, type FilesListDir, type TreeUpdate } from './FilesBrowse'
import { FilesTreeHandle } from './FilesTreeHandle'
import { setFilesTreeVisible, setFilesTreeWidth, toggleFilesTreeVisible, useFilesTreePrefs } from './filesTreePrefs'

/**
 * The Files pane's content (F-9): a tab strip in the title slot, the editor
 * bodies below, mounted on first activation and kept within the files LRU
 * (never a body with unsaved edits). No active tab: the browse state, a
 * filter box over the session's file tree (expansion kept per session).
 * A tab active: Go to file and Show file tree in the header; the same tree
 * docks at the end edge and reveals the active file. Last tab closed: browse.
 */
export type FilesPaneProps = {
  state: FilesPaneState
  /** Scopes the body cache: a session switch releases the other session's bodies. */
  sessionKey: string
  onActivate: (path: string) => void
  onCloseTab: (path: string) => void
  /** Paths whose editor holds unsaved edits; never released, never evicted. */
  protectedPaths: ReadonlySet<string>
  onDirtyChange: (path: string, dirty: boolean) => void
  fileReveal?: { path: string; line: number; nonce: number } | null
  readFileText?: (path: string) => Promise<string | null>
  writeFileText?: (path: string, text: string) => Promise<boolean>
  editingLocked?: boolean
  /** Opens a file from the tree, as a path link in the conversation does. */
  onOpen: (path: string) => void
  /** Lists a folder for the tree; absent while the session has no runtime to ask. */
  listDir?: FilesListDir
  /** The tree's roots: the session's folders. `null` while the session has not reported them. */
  roots?: readonly string[] | null
  /** Builds the frame around the strip, the header actions and the bodies. */
  frame: (parts: { title: ReactNode; actions?: ReactNode; body: ReactNode }) => ReactNode
}

export function FilesPane(props: FilesPaneProps): ReactElement {
  const t = useT()
  const { state, sessionKey } = props
  const visible = state.active ? [state.active] : []
  const [cache, setCache] = useState<{ key: string; paths: readonly string[] }>(() => ({
    key: sessionKey,
    paths: visible,
  }))
  let mounted = cache.paths
  if (cache.key !== sessionKey) {
    mounted = visible
    setCache({ key: sessionKey, paths: visible })
  } else {
    const next = reconcileMountedFiles({
      previous: cache.paths,
      visible,
      openTabs: state.tabs,
      protectedPaths: props.protectedPaths,
    })
    if (!sameMountedFiles(next, cache.paths)) {
      mounted = next
      setCache({ key: sessionKey, paths: next })
    }
  }
  const mountedSet = new Set(mounted)

  const [trees, setTrees] = useState<ReadonlyMap<string, FileTreeState>>(() => new Map())
  const roots = props.roots ?? null
  const tree = roots ? withRoots(trees.get(sessionKey) ?? emptyFileTree(roots), roots) : null
  const updateTree = useCallback<TreeUpdate>(
    update => {
      if (!roots) return
      setTrees(previous => {
        const current = withRoots(previous.get(sessionKey) ?? emptyFileTree(roots), roots)
        const next = new Map(previous)
        next.set(sessionKey, update(current))
        return next
      })
    },
    [sessionKey, roots],
  )

  const prefs = useFilesTreePrefs()
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyWidth, setBodyWidth] = useState(0)
  const [liveWidth, setLiveWidth] = useState<number | null>(null)
  const treeWidth = liveWidth ?? prefs.width
  const docked = state.active !== null && prefs.visible && dockFits(bodyWidth, prefs.width)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setBodyWidth(el.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Reveal: expand the folders above a file (the tree lists them as they come
  // on screen), mark it current, and scroll its row into view once drawn.
  const scrollTarget = useRef<string | null>(null)
  const focusFilter = useRef(false)
  const reveal = useCallback(
    (path: string) => {
      if (!roots) return
      updateTree(current => revealPath(current, path).state)
      scrollTarget.current = treeSpelling(roots, path)
    },
    [roots, updateTree],
  )
  useEffect(() => {
    const box = bodyRef.current
    if (!box) return
    const target = scrollTarget.current
    if (target !== null) {
      const row = [...box.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
        el => el.getAttribute('data-testid') === `files-tree-row:${target}`,
      )
      if (row) {
        row.scrollIntoView?.({ block: 'nearest' })
        scrollTarget.current = null
      }
    }
    if (focusFilter.current) {
      const filter = dockFilter(box)
      if (filter) {
        filter.focus()
        focusFilter.current = false
      }
    }
  })

  // The docked tree follows the active tab while it is shown.
  useEffect(() => {
    if (docked && state.active) reveal(state.active)
  }, [docked, state.active, sessionKey, reveal])

  // The last tab closed: browse opens on the closed file's row.
  const lastActive = useRef({ key: sessionKey, path: state.active })
  const [browseCurrent, setBrowseCurrent] = useState<{ key: string; path: string } | null>(null)
  useEffect(() => {
    const previous = lastActive.current
    lastActive.current = { key: sessionKey, path: state.active }
    if (previous.key !== sessionKey || previous.path === null || state.active !== null) return
    setBrowseCurrent({ key: sessionKey, path: previous.path })
    reveal(previous.path)
  }, [sessionKey, state.active, reveal])

  // Go to file: the tree comes in if hidden, and its filter box takes focus.
  const goToFile = () => {
    const filter = bodyRef.current ? dockFilter(bodyRef.current) : null
    if (filter) {
      filter.focus()
      return
    }
    focusFilter.current = true
    setFilesTreeVisible(true)
  }

  const spelled = (path: string | null) => (path && roots ? treeSpelling(roots, path) : path)
  const browseTree = (currentPath: string | null) =>
    !props.listDir || !tree ? (
      <BrowseNotice testId="files-browse-not-started" text={t('filesBrowse.notStarted')} />
    ) : tree.roots.length === 0 ? (
      <BrowseNotice testId="files-browse-no-folder" text={t('filesBrowse.noWorkingDirectory')} />
    ) : (
      <FilesBrowse
        key={sessionKey}
        tree={tree}
        onTreeChange={updateTree}
        listDir={props.listDir}
        onOpen={props.onOpen}
        currentPath={currentPath}
      />
    )

  const title = state.tabs.length === 0 ? (
    <>
      <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span data-testid="files-pane-browse-title" className="min-w-0 truncate">
        {t('filesBrowse.title')}
      </span>
    </>
  ) : (
    <div role="tablist" data-testid="files-pane-tabs" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
      {state.tabs.map(path => {
        const active = path === state.active
        const label = baseName(path)
        return (
          <div
            key={path}
            className={cn(
              'group flex min-w-0 items-center gap-0.5 rounded-md py-0.5 pe-0.5 ps-1.5 text-[12px]',
              active ? 'bg-muted' : 'hover:bg-muted/50',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`files-pane-tab:${path}`}
              title={path}
              onClick={() => props.onActivate(path)}
              className={cn(
                'flex min-w-0 max-w-[12rem] items-center gap-1 outline-none',
                active ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              <FileTextIcon aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{label}</span>
            </button>
            <button
              type="button"
              aria-label={t('pane.closeFileTab', { name: label })}
              data-testid={`files-pane-close:${path}`}
              onClick={() => props.onCloseTab(path)}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )

  // Header while a file is open, start to end after the strip: Go to file,
  // Show file tree, then the pane menu.
  const actions = state.active === null ? null : (
    <TooltipProvider>
      <HeaderButton
        testId="files-pane-go-to-file"
        label={t('filesPane.goToFile')}
        onClick={goToFile}
        icon={<SearchIcon className="size-3.5" />}
      />
      <HeaderButton
        testId="files-pane-tree-toggle"
        label={t('filesPane.showTree')}
        tooltip={t(prefs.visible ? 'filesPane.hideTree' : 'filesPane.showTree')}
        shortcut={t('filesPane.treeShortcutKeys', { modifier: PANE_SHORTCUT_MODIFIER })}
        ariaShortcut={FILES_TREE_ARIA_SHORTCUT}
        pressed={prefs.visible}
        onClick={toggleFilesTreeVisible}
        icon={<ListTreeIcon className="size-3.5" />}
      />
    </TooltipProvider>
  )

  // `[file | handle | tree]`: the file at the start, the docked tree at the end edge.
  const body = (
    <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-row">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {state.tabs.map(path => {
          if (!mountedSet.has(path)) return null
          const active = path === state.active
          return (
            <div
              key={`${sessionKey}:${path}`}
              data-files-pane-body={path}
              className={cn('min-h-0 flex-1 flex-col overflow-hidden', active ? 'flex' : 'hidden')}
            >
              <FilePanel
                target={{ path }}
                readFileText={props.readFileText}
                writeFileText={props.writeFileText}
                editingLocked={props.editingLocked}
                onDirtyChange={props.onDirtyChange}
                reveal={
                  props.fileReveal && props.fileReveal.path === path
                    ? { line: props.fileReveal.line, nonce: props.fileReveal.nonce }
                    : undefined
                }
              />
            </div>
          )
        })}
        {state.active === null && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {browseTree(browseCurrent?.key === sessionKey ? spelled(browseCurrent.path) : null)}
          </div>
        )}
      </div>
      {docked && (
        <>
          <FilesTreeHandle
            width={treeWidth}
            maxWidth={maxDockWidth(bodyWidth)}
            onResize={setLiveWidth}
            onResizeEnd={width => {
              setLiveWidth(null)
              setFilesTreeWidth(width)
            }}
          />
          <div
            data-files-tree-dock
            data-testid="files-pane-tree-dock"
            className="flex min-h-0 shrink-0 flex-col overflow-hidden"
            style={{ width: treeWidth }}
          >
            {browseTree(spelled(state.active))}
          </div>
        </>
      )}
    </div>
  )

  return <>{props.frame({ title, actions, body })}</>
}

/** The docked tree's filter box, once drawn. */
function dockFilter(box: HTMLElement): HTMLInputElement | null {
  return box.querySelector<HTMLInputElement>('[data-files-tree-dock] [data-testid="files-browse-filter"]')
}

function HeaderButton(props: {
  testId: string
  label: string
  /** The tooltip, when it differs from the label. */
  tooltip?: string
  shortcut?: string
  ariaShortcut?: string
  pressed?: boolean
  onClick: () => void
  icon: ReactNode
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7"
          data-testid={props.testId}
          aria-label={props.label}
          aria-pressed={props.pressed}
          aria-keyshortcuts={props.ariaShortcut}
          onClick={props.onClick}
        >
          {props.icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {props.tooltip ?? props.label}
        {props.shortcut && <span className="ms-2 opacity-70">{props.shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function BrowseNotice({ testId, text }: { testId: string; text: string }): ReactElement {
  return (
    <div
      data-testid={testId}
      className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-body text-muted-foreground"
    >
      <FolderIcon aria-hidden className="size-5" />
      <p>{text}</p>
    </div>
  )
}
