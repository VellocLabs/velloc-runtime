
import { useComposerRuntime } from '@assistant-ui/react'
import { FolderIcon, SparklesIcon, XIcon } from 'lucide-react'

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { ProviderMissingPrompt } from '../bridge/browserBridgeProtocol'
import { basenameRuntimePath } from '../../utils/runtimePaths'
import {
  normalizeProjectPath,
  type AddedProject,
  type RecentFolder,
} from '../../utils/workspaceState'

import { useT, type TranslateFn } from './i18n'
import { useWorkspaceState } from './workspaceStore'

import { Button } from '@/components/ui/button'
import { useUnsavedEditsGate } from '@/glic/unsavedEditsGate'
import { useCan, useCapabilities } from './useCan'
import { useSessionAreaVisible } from './sessionAreaVisibility'

// Static import on purpose: a lazy() Thread suspends on cold load for its chunk and its
// markdown chunk (P-2).
import { Thread } from '@/components/assistant-ui/thread'

type ProviderMissingDialogProps = {
  pendingText: string
  resources: ProviderMissingPrompt | null
  onClose: () => void
  onOpenSettings?: () => void | Promise<void>
}

/** Built from the catalog at render time — the host may override it via
 *  `resources.dialog`, which arrives already localised. */
function providerMissingDialogFallback(
  t: TranslateFn,
): ProviderMissingPrompt['dialog'] {
  return {
    title: t('thread.setUpModelProvider'),
    description: t('thread.providerMissingDescription'),
    confirmLabel: t('thread.openSettings'),
    cancelLabel: t('thread.cancel'),
  }
}

export function ProviderMissingDialog({
  pendingText,
  resources,
  onClose,
  onOpenSettings,
}: ProviderMissingDialogProps) {
  const composer = useComposerRuntime()
  const t = useT()
  const dialogContent = resources?.dialog ?? providerMissingDialogFallback(t)
  // "Open settings" lands on Settings → Models, a page built on `providers.*`
  // (`manager`). A connection without it cannot open that page (the settings
  // shell would fall back to General), so it gets no button: the dialog still
  // says why the message was held, and Cancel puts the draft back.
  const canOpenProviderSettings = useCan('providers', 'list')
  // Hand-rolled modal, not the shared Dialog primitive (which holds the gate
  // itself): while it is up the held message lives only here, so hold the
  // background updater's reload (glic/unsavedEditsGate.ts). Mounted only
  // while shown.
  useUnsavedEditsGate(true)

  const restoreText = useCallback(() => {
    if (!pendingText) return
    try {
      composer.setText(pendingText)
    } catch (error) {
      console.warn('Failed to restore composer text:', error)
    }
  }, [composer, pendingText])

  const handleCancel = useCallback(() => {
    restoreText()
    onClose()
  }, [onClose, restoreText])

  const handleConfirm = useCallback(async () => {
    restoreText()
    onClose()
    if (onOpenSettings) {
      await onOpenSettings()
    }
  }, [onClose, onOpenSettings, restoreText])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-missing-dialog-title"
      onClick={handleCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20"
          >
            <SparklesIcon className="size-6" />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2
              id="provider-missing-dialog-title"
              className="text-lg font-semibold text-foreground"
            >
              {dialogContent.title}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {dialogContent.description}
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={handleCancel}>
            {dialogContent.cancelLabel}
          </Button>
          {onOpenSettings && canOpenProviderSettings && (
            <Button onClick={handleConfirm}>{dialogContent.confirmLabel}</Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** A folder the forced dialog offers to bind directly, without the picker. */
export type KnownProjectFolder = { path: string; name: string }

/** How many known folders the forced dialog lists. */
export const MAX_DIALOG_KNOWN_FOLDERS = 8

/**
 * The forced dialog's quick picks: the workspace's projects, then its recent
 * folders, one entry per folder, capped at {@link MAX_DIALOG_KNOWN_FOLDERS}.
 * Every one is a folder the runtime already knows, so ANY scope may bind it
 * (`runtimeHub/knownProjects.ts`).
 */
export function knownProjectFolders(
  projects: readonly AddedProject[],
  recentFolders: readonly RecentFolder[],
): KnownProjectFolder[] {
  const out: KnownProjectFolder[] = []
  const seen = new Set<string>()
  const add = (path: string, name?: string) => {
    const key = normalizeProjectPath(path)
    if (!key || seen.has(key) || out.length >= MAX_DIALOG_KNOWN_FOLDERS) return
    seen.add(key)
    out.push({ path, name: name || basenameRuntimePath(path) || path })
  }
  for (const project of projects) add(project.path)
  for (const folder of recentFolders) add(folder.path, folder.name)
  return out
}

/**
 * Forced "open a project folder" modal for a new code session with no folder bound (the
 * composer is blocked meanwhile). Cancel (X / Escape) DISCARDS the session; backdrop clicks
 * are inert. "Open folder" needs `ui.pickProjectFolder` (`full`, `canOpenFolder`).
 */
export type ProjectFolderDialogProps = {
  onOpenFolder: () => void | Promise<void>
  /** Bind one of `knownFolders` directly. Without it the list is not offered. */
  onSelectFolder?: (path: string) => void
  knownFolders?: readonly KnownProjectFolder[]
  /** May this connection open the host's folder picker? Default: yes. */
  canOpenFolder?: boolean
  onCancel: () => void
}

/**
 * {@link ProjectFolderDialog} fed from the page's workspace mirror (the known
 * folders) and the connection's grant (the picker). The subscription lives
 * HERE, in a component mounted only while the dialog shows: every workspace
 * change hands the mirror new arrays, so a subscription in the thread itself
 * re-rendered every mounted thread on every change — a recent folder, a
 * remembered search — for a dialog that was not even up.
 */
export function WorkspaceProjectFolderDialog(
  props: Omit<ProjectFolderDialogProps, 'knownFolders' | 'canOpenFolder'>,
) {
  const projects = useWorkspaceState(workspace => workspace.projects)
  const recentFolders = useWorkspaceState(workspace => workspace.recentFolders)
  // The runtime accepts a workspace folder only from a grant that covers every
  // session; a connection limited to some sessions would be offered picks
  // that each fail with `forbidden_scope`.
  const workspaceNameable = useCapabilities().allSessions?.() ?? true
  const knownFolders = useMemo(
    () => (workspaceNameable ? knownProjectFolders(projects, recentFolders) : []),
    [projects, recentFolders, workspaceNameable],
  )
  const canOpenFolder = useCan('ui', 'pickProjectFolder')
  return <ProjectFolderDialog {...props} knownFolders={knownFolders} canOpenFolder={canOpenFolder} />
}

export function ProjectFolderDialog({
  onOpenFolder,
  onSelectFolder,
  knownFolders = [],
  canOpenFolder = true,
  onCancel,
}: ProjectFolderDialogProps) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  // Hand-rolled modal (see ProviderMissingDialog): a reload under it would
  // drop the user mid-choice, so it holds the background updater's reload
  // while mounted (glic/unsavedEditsGate.ts).
  useUnsavedEditsGate(true)

  const handleOpen = useCallback(async () => {
    setBusy(true)
    try {
      await onOpenFolder()
    } finally {
      // On a successful bind this dialog unmounts (needsProjectFolder → false),
      // so the reset is moot; on cancel / failure it re-enables the button.
      setBusy(false)
    }
  }, [onOpenFolder])

  // Cancel (X / Escape) discards the still-unbound code session. Suppressed
  // while a folder pick is in flight so we never drop the session mid-bind.
  const handleCancel = useCallback(() => {
    if (busy) return
    onCancel()
  }, [busy, onCancel])

  // Escape is a cancel only while the dialog is on screen. The shell keeps the
  // session area — and this dialog — mounted under Settings, and an Escape
  // pressed there used to DISCARD the hidden, still-unbound code session.
  const sessionAreaVisible = useSessionAreaVisible()
  useEffect(() => {
    if (!sessionAreaVisible) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleCancel, sessionAreaVisible])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-folder-dialog-title"
    >
      <div className="relative w-full max-w-md rounded-2xl border bg-background p-6 shadow-2xl">
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy}
          aria-label={t('projectFolder.cancel')}
          className="aui-project-folder-dialog-close absolute end-3 top-3 flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
        <div className="flex flex-col items-center gap-4 text-center">
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20"
          >
            <FolderIcon className="size-6" />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2
              id="project-folder-dialog-title"
              className="text-lg font-semibold text-foreground"
            >
              {t('projectFolder.title')}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t('projectFolder.description')}
            </p>
          </div>
        </div>
        {onSelectFolder && knownFolders.length > 0 && (
          <div
            role="group"
            aria-label={t('projectFolder.knownFolders')}
            className="aui-project-folder-dialog-known mt-5 flex flex-col gap-0.5"
          >
            <div className="px-2.5 pb-1 text-muted-foreground text-xs select-none">
              {t('projectFolder.knownFolders')}
            </div>
            {knownFolders.map(folder => (
              <button
                key={folder.path}
                type="button"
                title={folder.path}
                data-path={folder.path}
                onClick={() => onSelectFolder(folder.path)}
                disabled={busy}
                className="aui-project-folder-dialog-known-item flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              >
                <FolderIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                <span className="truncate">{folder.name}</span>
              </button>
            ))}
          </div>
        )}
        {canOpenFolder ? (
          <div className="mt-6 flex justify-center">
            <Button
              className="aui-project-folder-dialog-open"
              onClick={handleOpen}
              disabled={busy}
            >
              {busy ? t('projectFolder.binding') : t('projectFolder.open')}
            </Button>
          </div>
        ) : (
          (!onSelectFolder || knownFolders.length === 0) && (
            <p className="aui-project-folder-dialog-none mt-6 text-center text-sm text-muted-foreground">
              {t('projectFolder.noKnownFolders')}
            </p>
          )
        )}
      </div>
    </div>
  )
}
