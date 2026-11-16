/**
 * The phone shell's session details sheet (F-24), opened by the top bar's title pill. Its
 * Environment section names the desktop computer (machine name, else the listener's address; the
 * OS beside it when known), the project folder (a tap copies the full path), and the branch when
 * it is known.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { FolderIcon, GitBranchIcon, MonitorIcon } from 'lucide-react'

import { folderName } from '../browser/webview/childSessionStatus'
import { useT } from '../browser/webview/i18n'
import type { DrivenDesktop } from '../browser/webview/remote/hostIdentity'
import { writeClipboard } from '../utils/clipboard'
import { MobileSheet } from './MobileSheet'

export type MobileSessionDetailsSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  host?: DrivenDesktop
  /** The session's project folder; absent for a session outside any project. */
  projectRoot?: string
  branch?: string
  /** Clipboard writer; a test passes its own. Resolves whether the copy happened. */
  writeText?: (text: string) => Promise<boolean>
}

function DetailRow({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) {
  return (
    <>
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-muted-foreground text-sm">{label}</span>
        <span className="block truncate text-body">{value}</span>
        {detail ? <span className="block truncate text-muted-foreground text-sm">{detail}</span> : null}
      </span>
    </>
  )
}

export function MobileSessionDetailsSheet({
  open,
  onOpenChange,
  host,
  projectRoot,
  branch,
  writeText = writeClipboard,
}: MobileSessionDetailsSheetProps) {
  const t = useT()
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (!open) setCopy('idle')
  }, [open])
  const projectName = folderName(projectRoot)
  const rowClass = 'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left'

  return (
    <MobileSheet open={open} onOpenChange={onOpenChange} title={t('mobile.details.title')} testId="mobile-details-sheet">
      <section className="flex flex-col">
        <h2 className="px-3 pt-1 pb-1 text-muted-foreground text-sm">{t('mobile.details.environment')}</h2>
        {host ? (
          <div data-testid="mobile-details-computer" className={rowClass}>
            <DetailRow
              icon={<MonitorIcon className="size-5" />}
              label={t('mobile.details.computer')}
              value={host.hostName ?? host.address}
              detail={host.osName}
            />
          </div>
        ) : null}
        {projectRoot && projectName ? (
          <button
            type="button"
            data-testid="mobile-details-project"
            onClick={() => {
              // Started inside the tap: the http remote page copies through the
              // legacy path, which needs the gesture.
              void writeText(projectRoot).then(ok => setCopy(ok ? 'copied' : 'failed'))
            }}
            className={`${rowClass} active:bg-accent`}
          >
            <DetailRow
              icon={<FolderIcon className="size-5" />}
              label={t('mobile.details.project')}
              value={projectName}
              detail={copy === 'copied' ? t('mobile.details.pathCopied') : projectRoot}
            />
          </button>
        ) : null}
        {copy === 'failed' ? (
          <p role="alert" data-testid="mobile-details-copy-failed" className="px-3 pb-1 text-destructive text-sm">
            {t('mobile.details.copyFailed')}
          </p>
        ) : null}
        {branch ? (
          <div data-testid="mobile-details-branch" className={rowClass}>
            <DetailRow icon={<GitBranchIcon className="size-5" />} label={t('mobile.details.branch')} value={branch} />
          </div>
        ) : null}
      </section>
    </MobileSheet>
  )
}
