import type { ReactNode } from 'react'
import { CheckCircle2Icon, Loader2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import type { DirectoryPageItem } from '../../../customize/directoryOffer'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'
import type { SettingsSectionId } from '../settings/settingsNav'
import { ItemAvatar } from './ItemAvatar'
import { IncludedParts, VerifiedMark } from './ItemDetailsSections'

export type AddItemDialogProps = {
  /** The page item the page asked to add; null closes the dialog. */
  item: DirectoryPageItem | null
  onAdd: (id: number) => void
  onOpenSettings: (section: SettingsSectionId) => void
  onClose: () => void
}

const KIND_SECTION: Record<DirectoryPageItem['kind'], SettingsSectionId> = {
  plugin: 'plugins',
  connector: 'mcp',
}

const INCLUDED_LIMIT = 6

/**
 * Asks before adding the item the directory page's own add button named
 * (F-35): what it is, what it brings and what adding it does, then Add. It
 * follows the item through the install — Adding…, then added (with Manage)
 * or failed (with Try again) — and says plainly when it cannot be added here.
 */
export function AddItemDialog({ item, onAdd, onOpenSettings, onClose }: AddItemDialogProps) {
  const t = useT()
  const open = item !== null
  const details = item?.details
  const name = details?.name ?? ''
  const installed = item?.phase === 'installed' || (item?.phase === 'ready' && item.alreadyInstalled)
  const canAdd =
    !!item &&
    !item.alreadyInstalled &&
    ((item.phase === 'ready' && item.installable) || (item.phase === 'failed' && item.failure === 'install_failed'))

  let title: string
  let body: MessageKey | null = null
  let tone: 'plain' | 'error' | 'done' = 'plain'
  if (!item || item.phase === 'resolving') {
    title = t('customize.addDialog.lookingUp')
  } else if (item.phase === 'failed' && item.failure !== 'install_failed') {
    title = t('customize.addDialog.cannotAddTitle')
    body = item.failure === 'not_found' ? 'customize.addDialog.notFound' : 'customize.addDialog.lookupFailed'
    tone = 'error'
  } else if (installed) {
    title = t(item.phase === 'installed' ? 'customize.addDialog.addedTitle' : 'customize.addDialog.alreadyTitle', { name })
    body = item.kind === 'plugin' ? 'customize.addDialog.addedPlugin' : 'customize.addDialog.addedConnector'
    tone = 'done'
  } else if (!item.installable) {
    title = t('customize.addDialog.cannotAddNamed', { name })
    body = item.kind === 'plugin' ? 'customize.addDialog.noSource' : 'customize.addDialog.noAddress'
    tone = 'error'
  } else {
    title = t('customize.addDialog.title', { name })
    body = item.kind === 'plugin' ? 'customize.addDialog.whatPlugin' : 'customize.addDialog.whatConnector'
    if (item.phase === 'failed') tone = 'error'
  }

  let actions: ReactNode
  if (installed) {
    actions = (
      <>
        <Button
          type="button"
          variant="outline"
          data-testid="customize-add-dialog-manage"
          onClick={() => {
            onClose()
            onOpenSettings(KIND_SECTION[item!.kind])
          }}
        >
          {t('customize.item.manage')}
        </Button>
        <Button type="button" data-testid="customize-add-dialog-done" onClick={onClose}>
          {t('customize.addDialog.done')}
        </Button>
      </>
    )
  } else if (item?.phase === 'installing') {
    actions = (
      <Button type="button" disabled data-testid="customize-add-dialog-confirm">
        <Loader2Icon className="size-3.5 animate-spin" />
        {t('customize.item.adding')}
      </Button>
    )
  } else if (canAdd || !item || item.phase === 'resolving') {
    actions = (
      <>
        <Button type="button" variant="outline" data-testid="customize-add-dialog-cancel" onClick={onClose}>
          {t('customize.addDialog.cancel')}
        </Button>
        <Button
          type="button"
          disabled={!canAdd}
          data-testid="customize-add-dialog-confirm"
          onClick={() => item && onAdd(item.id)}
        >
          {t(item?.phase === 'failed' ? 'customize.addDialog.tryAgain' : 'customize.item.add')}
        </Button>
      </>
    )
  } else {
    actions = (
      <>
        <Button type="button" data-testid="customize-add-dialog-close" onClick={onClose}>
          {t('customize.addDialog.close')}
        </Button>
      </>
    )
  }

  return (
    <Dialog open={open} onOpenChange={next => (next ? undefined : onClose())}>
      <DialogContent
        data-testid="customize-add-dialog"
        data-phase={item?.phase}
        className="max-w-lg"
      >
        <DialogHeader>
          <div className="flex items-start gap-3">
            {details ? (
              <ItemAvatar name={details.name} iconUrl={details.iconUrl} className="size-12 rounded-lg text-base" />
            ) : (
              <span className="flex size-12 shrink-0 items-center justify-center rounded-lg border bg-muted">
                <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              </span>
            )}
            <div className="flex min-w-0 flex-col gap-1 text-left">
              <DialogTitle data-testid="customize-add-dialog-title" className="flex items-center gap-2">
                {tone === 'done' ? <CheckCircle2Icon className="size-4 shrink-0 text-primary" /> : null}
                <span className="min-w-0 break-words">{title}</span>
              </DialogTitle>
              {details && item ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{t(item.kind === 'plugin' ? 'customize.item.kind.plugin' : 'customize.item.kind.connector')}</span>
                  {details.publisher ? <span>· {t('customize.item.byPublisher', { publisher: details.publisher })}</span> : null}
                  <VerifiedMark details={details} />
                </span>
              ) : null}
            </div>
          </div>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2 text-left">
              {details?.summary ? <p className="text-sm text-foreground">{details.summary}</p> : null}
              {body ? (
                <p className={tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
                  {t(body, { name: item?.installedAs ?? name })}
                </p>
              ) : null}
              {installed && item?.updateAvailable ? (
                <p data-testid="customize-add-dialog-update" className="text-sm text-foreground">
                  {t('customize.addDialog.updateAvailable')}
                </p>
              ) : null}
              {item?.phase === 'failed' && item.failure === 'install_failed' ? (
                <p className="text-sm text-destructive">{t('customize.addDialog.installFailed')}</p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>
        {details?.components?.length && !installed ? (
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            <span className="text-xs font-semibold text-foreground">{t('customize.detail.included')}</span>
            <IncludedParts parts={details.components} limit={INCLUDED_LIMIT} />
          </div>
        ) : null}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
