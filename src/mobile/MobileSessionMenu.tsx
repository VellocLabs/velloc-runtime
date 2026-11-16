/**
 * The phone shell's session menu and rename sheet (F-24). The top bar's `…` opens the menu for the
 * open session; a long press on a drawer row opens it for that row. Items: Rename, Copy branch
 * name (only when the session's branch is known), Archive.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { ArchiveIcon, GitBranchIcon, PencilIcon } from 'lucide-react'

import { useUnsavedEditsGate } from '../glic/unsavedEditsGate'
import { useT } from '../browser/webview/i18n'
import { writeClipboard } from '../utils/clipboard'
import { MobileSheet, MobileSheetAction } from './MobileSheet'

export type MobileMenuTarget = {
  sessionId: string
  title: string
  /** The session's git branch, when known. */
  branch?: string
}

export type MobileSessionMenuProps = {
  target: MobileMenuTarget | null
  onClose: () => void
  onRename: (target: MobileMenuTarget) => void
  onArchive: (sessionId: string) => void
  /** Clipboard writer; a test passes its own. Resolves whether the copy happened. */
  writeText?: (text: string) => Promise<boolean>
}

export function MobileSessionMenu({
  target,
  onClose,
  onRename,
  onArchive,
  writeText = writeClipboard,
}: MobileSessionMenuProps) {
  const t = useT()
  const [copyFailed, setCopyFailed] = useState(false)
  useEffect(() => setCopyFailed(false), [target?.sessionId])
  const title = target ? target.title.trim() || t('mobile.topbar.untitledSession') : ''
  return (
    <MobileSheet
      open={target !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      title={title}
      testId="mobile-session-menu"
    >
      {target ? (
        <div role="menu" aria-label={title}>
          <MobileSheetAction
            testId="mobile-menu-rename"
            icon={<PencilIcon className="size-5" />}
            label={t('mobile.menu.rename')}
            onSelect={() => onRename(target)}
          />
          {target.branch ? (
            <MobileSheetAction
              testId="mobile-menu-copy-branch"
              icon={<GitBranchIcon className="size-5" />}
              label={t('mobile.menu.copyBranch')}
              detail={target.branch}
              onSelect={() => {
                // Started inside the tap: the http remote page copies through the
                // legacy path, which needs the gesture.
                void writeText(target.branch!).then(ok => {
                  if (ok) onClose()
                  else setCopyFailed(true)
                })
              }}
            />
          ) : null}
          {copyFailed ? (
            <p role="alert" data-testid="mobile-menu-copy-failed" className="px-3 pb-1 text-destructive text-sm">
              {t('mobile.menu.copyFailed')}
            </p>
          ) : null}
          <div aria-hidden className="mx-3 my-1 h-px bg-border" />
          <MobileSheetAction
            testId="mobile-menu-archive"
            icon={<ArchiveIcon className="size-5" />}
            label={t('mobile.menu.archive')}
            onSelect={() => {
              onArchive(target.sessionId)
              onClose()
            }}
          />
        </div>
      ) : null}
    </MobileSheet>
  )
}

export type MobileRenameSheetProps = {
  target: MobileMenuTarget | null
  onClose: () => void
  /** A blank title clears the custom name. */
  onSave: (sessionId: string, title: string) => void
}

export function MobileRenameSheet({ target, onClose, onSave }: MobileRenameSheetProps) {
  const t = useT()
  return (
    <MobileSheet
      open={target !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      title={t('mobile.rename.title')}
      testId="mobile-rename-sheet"
    >
      {target ? <RenameForm key={target.sessionId} target={target} onClose={onClose} onSave={onSave} /> : null}
    </MobileSheet>
  )
}

function RenameForm({
  target,
  onClose,
  onSave,
}: {
  target: MobileMenuTarget
  onClose: () => void
  onSave: (sessionId: string, title: string) => void
}) {
  const t = useT()
  const [value, setValue] = useState(target.title)
  // A half-typed title is page-local state a background reload would discard.
  useUnsavedEditsGate(true)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave(target.sessionId, value.trim())
    onClose()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-3 pt-1">
      <input
        data-testid="mobile-rename-input"
        autoFocus
        enterKeyHint="done"
        value={value}
        onChange={e => setValue(e.target.value)}
        aria-label={t('mobile.rename.label')}
        className="h-11 w-full rounded-lg border border-border bg-muted/40 px-3 text-body focus-visible:focus-ring"
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="mobile-rename-cancel"
          onClick={onClose}
          className="h-11 flex-1 rounded-lg border border-border text-body active:bg-accent"
        >
          {t('mobile.rename.cancel')}
        </button>
        <button
          type="submit"
          data-testid="mobile-rename-save"
          className="h-11 flex-1 rounded-lg bg-primary font-medium text-body text-primary-foreground active:opacity-90"
        >
          {t('mobile.rename.save')}
        </button>
      </div>
    </form>
  )
}
