import * as React from 'react'
import type { ReactNode } from 'react'
import { CheckIcon, Loader2Icon, Settings2Icon, Trash2Icon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
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
import { ItemAvatar } from './ItemAvatar'

const KIND_LABEL: Record<DirectoryPageItem['kind'], MessageKey> = {
  plugin: 'customize.item.kind.plugin',
  connector: 'customize.item.kind.connector',
}

const UNINSTALL_EFFECT: Record<DirectoryPageItem['kind'], MessageKey> = {
  plugin: 'customize.item.uninstallDialog.plugin',
  connector: 'customize.item.uninstallDialog.connector',
}

const FAILURE_LABEL: Record<NonNullable<DirectoryPageItem['failure']>, MessageKey> = {
  not_found: 'customize.item.failed.notFound',
  lookup_failed: 'customize.item.failed.lookup',
  install_failed: 'customize.item.failed.install',
  remove_failed: 'customize.item.failed.remove',
}

export type DirectoryItemStatusProps = {
  item: DirectoryPageItem
  onAdd: (id: number) => void
  onRemove: (id: number) => void
  /** Opens the Settings page that manages the installed `item`. */
  onManage: (item: DirectoryPageItem) => void
}

/**
 * The top bar's centre while the directory page shows a plugin or a
 * connector (F-35): one fixed-width bar with who it is on the left and its
 * action on the right — Add when it can be installed here, or an Installed
 * badge with Manage (Settings) and Uninstall, which asks before it removes.
 */
export function DirectoryItemStatus({ item, onAdd, onRemove, onManage }: DirectoryItemStatusProps) {
  const t = useT()
  const details = item.details
  const installed = item.phase === 'installed' || (item.phase === 'ready' && item.alreadyInstalled)
  // Keyed by id so a dialog opened for one item never confirms the next one.
  const [confirmId, setConfirmId] = React.useState<number | null>(null)

  let action: ReactNode
  if (item.phase === 'resolving' || item.phase === 'removing') {
    action = (
      <span data-testid="customize-item-busy" className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" />
        {t(item.phase === 'resolving' ? 'customize.item.resolving' : 'customize.item.removing')}
      </span>
    )
  } else if (installed) {
    action = (
      <>
        {item.failure === 'remove_failed' ? (
          <span data-testid="customize-item-failed" className="truncate text-xs text-destructive">
            {t(FAILURE_LABEL.remove_failed)}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="customize-item-manage"
          onClick={() => onManage(item)}
        >
          <Settings2Icon />
          {t('customize.item.manage')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="hover:text-destructive"
          data-testid="customize-item-remove"
          aria-label={t('customize.item.uninstall')}
          title={t('customize.item.uninstall')}
          disabled={!item.installedAs}
          onClick={() => setConfirmId(item.id)}
        >
          <Trash2Icon />
        </Button>
      </>
    )
  } else if (item.phase === 'installing') {
    action = (
      <Button type="button" size="xs" disabled data-testid="customize-item-add">
        <Loader2Icon className="animate-spin" />
        {t('customize.item.adding')}
      </Button>
    )
  } else if (item.phase === 'failed') {
    action = (
      <>
        <span data-testid="customize-item-failed" className="truncate px-1 text-xs text-destructive">
          {t(FAILURE_LABEL[item.failure ?? 'lookup_failed'])}
        </span>
        {item.failure === 'install_failed' && item.installable ? (
          <Button type="button" size="xs" data-testid="customize-item-add" onClick={() => onAdd(item.id)}>
            {t('customize.item.add')}
          </Button>
        ) : null}
      </>
    )
  } else if (item.installable) {
    action = (
      <Button type="button" size="xs" data-testid="customize-item-add" onClick={() => onAdd(item.id)}>
        {t('customize.item.add')}
      </Button>
    )
  } else if (item.unsupported) {
    action = (
      <span
        data-testid="customize-item-unsupported"
        title={t('customize.item.unsupported.hint')}
        className="truncate px-1 text-xs text-muted-foreground"
      >
        {t('customize.item.unsupported.connector')}
      </span>
    )
  } else {
    action = (
      <span data-testid="customize-item-unavailable" className="truncate px-1 text-xs text-muted-foreground">
        {t(item.kind === 'plugin' ? 'customize.item.notInstallable.plugin' : 'customize.item.notInstallable.connector')}
      </span>
    )
  }

  const name = details?.name ?? item.installedAs ?? ''

  return (
    <div
      role="status"
      aria-label={t('customize.item.aria')}
      data-testid="customize-item"
      data-phase={item.phase}
      data-kind={item.kind}
      data-app-region="no-drag"
      className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border bg-muted/40 ps-1.5 pe-1"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {details ? (
          <>
            <ItemAvatar name={details.name} iconUrl={details.iconUrl} className="size-6" />
            <span data-testid="customize-item-name" className="min-w-0 truncate text-sm font-medium text-foreground">
              {details.name}
            </span>
          </>
        ) : null}
        {installed ? (
          <Badge data-testid="customize-item-installed" variant="success" size="sm">
            <CheckIcon />
            {t('customize.item.installed')}
          </Badge>
        ) : null}
        {installed && item.updateAvailable ? (
          <Badge data-testid="customize-item-update" variant="info" size="sm">
            {t('customize.item.updateAvailable')}
          </Badge>
        ) : null}
        {details ? (
          <span data-testid="customize-item-meta" className="min-w-0 shrink-[9] truncate text-xs text-muted-foreground">
            {t(KIND_LABEL[item.kind])}
            {details.publisher ? ` · ${t('customize.item.byPublisher', { publisher: details.publisher })}` : ''}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-1">{action}</div>
      <Dialog
        open={confirmId === item.id && installed}
        onOpenChange={next => {
          if (!next) setConfirmId(null)
        }}
      >
        <DialogContent data-testid="customize-item-uninstall-dialog" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('customize.item.uninstallDialog.title', { name })}</DialogTitle>
            <DialogDescription>{t(UNINSTALL_EFFECT[item.kind])}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmId(null)}>
              {t('customize.item.uninstallDialog.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="customize-item-uninstall-confirm"
              onClick={() => {
                setConfirmId(null)
                onRemove(item.id)
              }}
            >
              {t('customize.item.uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
