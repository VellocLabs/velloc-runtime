import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { CopyButton } from '@/components/assistant-ui/file-content-view'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { normalizePathKey } from '@/utils/paths'

import { useT } from '../i18n'
import { childPath } from '../layout/fileTree'
import type { FilesListDir } from './FilesBrowse'
import { FolderDropdown } from './FolderDropdown'

/** One segment of the path bar: a folder, or the file itself (last). */
export type PathSegment = {
  label: string
  /** The folder this segment browses: the folder itself, or the file's own folder. */
  folder: string
  /** The file's path, on the file-name segment only. */
  file?: string
}

export type PathBarModel = {
  segments: PathSegment[]
  /** The platform separator the segments are joined with. */
  separator: '\\' | '/'
  /** Drawn before the first segment of an absolute path (`/` for a POSIX root). */
  leading: string
}

/** `\` for a Windows path (a drive letter or a backslash), `/` otherwise. */
export function platformSeparator(path: string): '\\' | '/' {
  return /^[a-zA-Z]:/.test(path) || path.includes('\\') ? '\\' : '/'
}

function containingRoot(path: string, root: string | null | undefined): string | null {
  if (!root) return null
  const key = normalizePathKey(path)
  const rootKey = normalizePathKey(root).replace(/\/+$/, '')
  return key.startsWith(`${rootKey}/`) ? root : null
}

/**
 * Splits `path` into segments: relative to `root` when `path` lies under it,
 * else the whole absolute path. Either slash style is accepted; each segment's
 * folder is spelled from `root` (or the path's own prefix) with `childPath`,
 * the way the tree spells it.
 */
export function pathBarModel(path: string, root?: string | null): PathBarModel {
  const separator = platformSeparator(root || path)
  const base = containingRoot(path, root)
  // Outside the root: a POSIX root (`/`) or a UNC prefix (`\\`) leads the bar.
  const prefix = base === null ? (/^[\\/]{1,2}/.exec(path)?.[0] ?? '') : ''
  const parts = path
    .slice(base !== null ? base.length : prefix.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  let folder: string | null = base ?? (prefix || null)
  const leading = separator.repeat(prefix.length)
  const pathSep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const segments: PathSegment[] = []
  parts.forEach((part, index) => {
    const isFile = index === parts.length - 1
    if (isFile) {
      segments.push({ label: part, folder: folder ?? part, file: path })
      return
    }
    // A bare drive (`D:`) is listed as its root folder (`D:\`).
    const next =
      folder === null ? (/^[a-zA-Z]:$/.test(part) ? `${part}${pathSep}` : part) : childPath(folder, part)
    segments.push({ label: part, folder: next })
    folder = next
  })
  return { segments, separator, leading }
}

/** A segment drawn in the bar, or `…` standing for the `hidden` leading folders. */
export type PathBarItem =
  | { kind: 'segment'; segment: PathSegment; index: number }
  | { kind: 'ellipsis'; hidden: PathSegment[] }

/**
 * The bar with its first `hidden` folder segments collapsed into `…`. Leading
 * folders go first; the file name is never collapsed.
 */
export function collapseSegments(segments: readonly PathSegment[], hidden: number): PathBarItem[] {
  const folders = segments.filter(segment => !segment.file).length
  const count = Math.max(0, Math.min(hidden, folders))
  const items: PathBarItem[] = []
  if (count > 0) items.push({ kind: 'ellipsis', hidden: segments.slice(0, count) })
  segments.forEach((segment, index) => {
    if (index >= count) items.push({ kind: 'segment', segment, index })
  })
  return items
}

export type FilesPathBarProps = {
  path: string
  /** The session root; the path is shown relative to it when inside. */
  root?: string | null
  listDir: FilesListDir
  onOpen: (path: string) => void
  /** Controls kept at the row's end. */
  trailing?: ReactNode
  copyText?: string
  copyTooltip?: string
}

/** Share of the pane's height a segment dropdown may take. */
const DROPDOWN_PANE_SHARE = 0.6
const DROPDOWN_MIN_HEIGHT_PX = 120
const DROPDOWN_FALLBACK_HEIGHT_PX = 320

/**
 * The Files pane's path bar (F-9): the open file's path as segment buttons.
 * A folder segment opens a dropdown of that folder's entries; the file-name
 * segment opens the file's own folder with the file selected. On overflow
 * the leading folders collapse into `…`, which browses the last of them.
 */
export function FilesPathBar(props: FilesPathBarProps): ReactElement {
  const t = useT()
  const model = pathBarModel(props.path, props.root)
  const [open, setOpen] = useState<string | null>(null)
  const [maxHeight, setMaxHeight] = useState(DROPDOWN_FALLBACK_HEIGHT_PX)
  const rowRef = useRef<HTMLDivElement>(null)
  const segmentsRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  // How many leading folders are collapsed, fitted afresh for each path and width.
  const fitKey = `${props.path}\n${width}`
  const [fit, setFit] = useState({ key: fitKey, hidden: 0 })
  const hidden = fit.key === fitKey ? fit.hidden : 0

  useLayoutEffect(() => {
    const el = segmentsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = segmentsRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    const folders = model.segments.filter(segment => !segment.file).length
    if (hidden < folders) setFit({ key: fitKey, hidden: hidden + 1 })
  })

  const openChange = (key: string, next: boolean) => {
    if (next) {
      const pane = rowRef.current?.closest('[data-testid="file-panel"]')
      const height = pane?.clientHeight ?? 0
      setMaxHeight(
        height > 0
          ? Math.max(DROPDOWN_MIN_HEIGHT_PX, Math.round(height * DROPDOWN_PANE_SHARE))
          : DROPDOWN_FALLBACK_HEIGHT_PX,
      )
    }
    setOpen(next ? key : current => (current === key ? null : current))
  }

  const items = collapseSegments(model.segments, hidden)
  const separator = (
    <span aria-hidden className="shrink-0 select-none px-0.5 text-muted-foreground">
      {model.separator}
    </span>
  )

  const segmentButton = (key: string, segment: PathSegment, label: ReactNode, isFile: boolean) => (
    <Popover key={key} open={open === key} onOpenChange={next => openChange(key, next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="tree"
          aria-label={
            isFile
              ? t('filesPathBar.browseSiblings', { name: segment.label })
              : t('filesPathBar.browseFolder', { name: folderName(segment.folder) })
          }
          title={isFile ? segment.file : segment.folder}
          data-testid={`files-pathbar-segment:${isFile ? segment.file : segment.folder}`}
          data-kind={isFile ? 'file' : 'dir'}
          className={cn(
            'min-w-0 shrink-0 whitespace-nowrap rounded px-1 py-0.5 outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted',
            isFile ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={2}
        className="w-64 p-1"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        {open === key && (
          <FolderDropdown
            folder={segment.folder}
            selectedPath={segment.file}
            listDir={props.listDir}
            maxHeight={maxHeight}
            label={t('filesPathBar.folderEntries', { name: folderName(segment.folder) })}
            onOpen={file => {
              setOpen(null)
              props.onOpen(file)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )

  return (
    <div
      ref={rowRef}
      data-slot="file-path-header"
      data-testid="files-pathbar"
      className="group flex items-center gap-2"
    >
      <div
        ref={segmentsRef}
        data-slot="path-label"
        role="navigation"
        aria-label={t('filesPathBar.label')}
        title={props.path}
        className="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-code"
      >
        {model.leading && (
          <span aria-hidden className="shrink-0 select-none text-muted-foreground">
            {model.leading}
          </span>
        )}
        {items.map((item, at) => {
          const sep = at > 0 ? separator : null
          if (item.kind === 'ellipsis') {
            const last = item.hidden[item.hidden.length - 1]
            return (
              <span key="ellipsis" className="flex shrink-0 items-center">
                {segmentButton(`ellipsis:${last.folder}`, last, '…', false)}
              </span>
            )
          }
          const isFile = item.segment.file !== undefined
          return (
            <span key={item.index} className="flex shrink-0 items-center">
              {sep}
              {segmentButton(String(item.index), item.segment, item.segment.label, isFile)}
            </span>
          )
        })}
      </div>
      {props.trailing}
      {props.copyText !== undefined && (
        <CopyButton text={props.copyText} tooltip={props.copyTooltip} alwaysVisible />
      )}
    </div>
  )
}

function folderName(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (at >= 0 ? trimmed.slice(at + 1) : trimmed) || folder
}
