import { useState, type ReactElement, type ReactNode } from 'react'
import { FileTextIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { baseName } from '@/utils/paths'

import { FilePanel } from '../FilePanel'
import { useT } from '../i18n'
import { reconcileMountedFiles, sameMountedFiles } from '../layout/filesPane'
import type { FilesPaneState } from '../layout/paneLayout'

/**
 * The Files pane's content (F-9): a strip with one tab per opened path in
 * the frame's title slot, and the editor bodies below. Bodies mount on first
 * activation and stay while the strip keeps the tab, bounded by the files
 * LRU; a body with unsaved edits is never released. Only the active body shows.
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
  /** Builds the frame around the strip and the bodies. */
  frame: (parts: { title: ReactNode; body: ReactNode }) => ReactNode
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

  const title = (
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

  const body = (
    <div className="relative flex min-h-0 flex-1 flex-col">
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
    </div>
  )

  return <>{props.frame({ title, body })}</>
}
