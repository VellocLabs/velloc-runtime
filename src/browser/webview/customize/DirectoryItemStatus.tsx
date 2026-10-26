import type { ReactNode } from 'react'
import { CheckIcon, Loader2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'

import type { DirectoryPageItem } from '../../../customize/directoryOffer'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'
import type { SettingsSectionId } from '../settings/settingsNav'
import { ItemAvatar } from './ItemAvatar'

const KIND_LABEL: Record<DirectoryPageItem['kind'], MessageKey> = {
  plugin: 'customize.item.kind.plugin',
  connector: 'customize.item.kind.connector',
}

const KIND_SECTION: Record<DirectoryPageItem['kind'], SettingsSectionId> = {
  plugin: 'plugins',
  connector: 'mcp',
}

const FAILURE_LABEL: Record<NonNullable<DirectoryPageItem['failure']>, MessageKey> = {
  not_found: 'customize.item.failed.notFound',
  lookup_failed: 'customize.item.failed.lookup',
  install_failed: 'customize.item.failed.install',
}

export type DirectoryItemStatusProps = {
  item: DirectoryPageItem
  onAdd: (id: number) => void
  onOpenSettings: (section: SettingsSectionId) => void
}

/**
 * The top bar's right side while the directory page shows a plugin or a
 * connector (F-35): who it is, and Add when it can be installed here, or
 * where it is installed with a link to the Settings page that manages it.
 */
export function DirectoryItemStatus({ item, onAdd, onOpenSettings }: DirectoryItemStatusProps) {
  const t = useT()
  const details = item.details
  const installed = item.phase === 'installed' || (item.phase === 'ready' && item.alreadyInstalled)

  let action: ReactNode
  if (item.phase === 'resolving') {
    action = (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" />
        {t('customize.item.resolving')}
      </span>
    )
  } else if (installed) {
    action = (
      <>
        <span data-testid="customize-item-installed" className="flex items-center gap-1 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5" />
          {item.installedAs ? t('customize.item.installedAs', { name: item.installedAs }) : t('customize.item.installed')}
        </span>
        {item.updateAvailable ? (
          <span data-testid="customize-item-update" className="text-xs font-medium text-primary">
            {t('customize.item.updateAvailable')}
          </span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="customize-item-manage"
          onClick={() => onOpenSettings(KIND_SECTION[item.kind])}
        >
          {t('customize.item.manage')}
        </Button>
      </>
    )
  } else if (item.phase === 'installing') {
    action = (
      <Button type="button" size="sm" disabled data-testid="customize-item-add">
        <Loader2Icon className="size-3.5 animate-spin" />
        {t('customize.item.adding')}
      </Button>
    )
  } else if (item.phase === 'failed') {
    action = (
      <>
        <span data-testid="customize-item-failed" className="text-xs text-destructive">
          {t(FAILURE_LABEL[item.failure ?? 'lookup_failed'])}
        </span>
        {item.failure === 'install_failed' && item.installable ? (
          <Button type="button" size="sm" data-testid="customize-item-add" onClick={() => onAdd(item.id)}>
            {t('customize.item.add')}
          </Button>
        ) : null}
      </>
    )
  } else if (item.installable) {
    action = (
      <Button type="button" size="sm" data-testid="customize-item-add" onClick={() => onAdd(item.id)}>
        {t('customize.item.add')}
      </Button>
    )
  } else {
    action = (
      <span data-testid="customize-item-unavailable" className="text-xs text-muted-foreground">
        {t(item.kind === 'plugin' ? 'customize.item.notInstallable.plugin' : 'customize.item.notInstallable.connector')}
      </span>
    )
  }

  return (
    <div
      role="status"
      aria-label={t('customize.item.aria')}
      data-testid="customize-item"
      data-phase={item.phase}
      data-kind={item.kind}
      data-app-region="no-drag"
      className="flex min-w-0 items-center gap-3"
    >
      {details ? (
        <div className="flex min-w-0 items-center gap-2">
          <ItemAvatar name={details.name} iconUrl={details.iconUrl} />
          <div className="flex min-w-0 flex-col leading-tight">
            <span data-testid="customize-item-name" className="truncate text-sm font-medium text-foreground">
              {details.name}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {t(KIND_LABEL[item.kind])}
              {details.publisher ? ` · ${t('customize.item.byPublisher', { publisher: details.publisher })}` : ''}
            </span>
          </div>
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-2">{action}</div>
    </div>
  )
}
