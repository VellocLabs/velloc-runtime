import * as React from 'react'
import { CircleCheckIcon, EllipsisIcon, Loader2Icon } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

import type { ThemePluginRow } from '../../../mods/themeMods'
import { useT } from '../i18n'
import { packTitle } from './ThemeBrowser'
import { LookPreview, THEME_GRID, ThemeNoticeShell } from './themeCardParts'
import type { ThemePlugin, ThemeStanding } from './useThemeCatalog'

const MENU_CONTENT = 'z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md'
const MENU_ITEM =
  'flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50'

/** What this connection may do with the person's theme plugins; an absent function is a missing control. */
export type YourThemesActions = {
  setSingle?: (on: boolean) => Promise<void>
  /** Every theme plugin off; answers how many were on. */
  turnOffAll?: () => Promise<number>
  /**
   * On turns every other theme plugin off and answers how many, or null when
   * the plugin is on but the others could not be turned off; off answers 0.
   */
  setEnabled?: (row: ThemePluginRow, enabled: boolean) => Promise<number | null>
  uninstall?: (row: ThemePluginRow) => Promise<void>
}

export type YourThemesProps = {
  /** Null until the runtime has answered. */
  rows: readonly ThemePluginRow[] | null
  single: boolean | null
  /** The built-in marketplace's theme listings, for pictures and names. */
  listings: readonly ThemePlugin[]
  /** The standing theme of the session Customize was opened from; undefined when there is none to read. */
  standing: ThemeStanding
  /** A look is being applied from the Theme directory; Turn off all waits for it. */
  applying: boolean
  actions: YourThemesActions
  onBrowse: () => void
  /** The Theme directory at this pack. */
  onChooseLook: (plugin: string) => void
  /** The Plugins tab at this plugin's row. */
  onManage: (plugin: string) => void
}

type Notice =
  | { kind: 'enabled'; name: string; count: number }
  | { kind: 'disabled' | 'uninstalled'; name: string }
  | { kind: 'turnedOff'; count: number }
  | { kind: 'failed'; name: string | null }

type Card = { row: ThemePluginRow; listing: ThemePlugin | undefined; name: string; inEffect: boolean }

const uninstallable = (row: ThemePluginRow) => !row.id.endsWith('@inline') && !row.id.endsWith('@builtin')

/**
 * Yours → Themes (F-35): every known theme plugin as a card. The one in
 * effect carries a check; its menu enables (turning the others off),
 * disables or uninstalls it.
 */
export function YourThemes({
  rows,
  single,
  listings,
  standing,
  applying,
  actions,
  onBrowse,
  onChooseLook,
  onManage,
}: YourThemesProps) {
  const t = useT()
  const [pending, setPending] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<(Notice & { seq: number }) | null>(null)
  const [uninstalling, setUninstalling] = React.useState<Card | null>(null)
  const seq = React.useRef(0)
  const say = React.useCallback((next: Notice) => {
    seq.current += 1
    setNotice({ ...next, seq: seq.current })
  }, [])
  const dismissNotice = React.useCallback(() => setNotice(null), [])

  const cards = React.useMemo(() => cardsOf(rows ?? [], listings, standing), [rows, listings, standing])
  const on = (rows ?? []).filter(row => row.enabled).length

  const run = (key: string, ask: () => Promise<Notice>) => {
    setPending(key)
    ask()
      .then(say, () => say({ kind: 'failed', name: key === '*' ? null : (cards.find(c => c.row.id === key)?.name ?? key) }))
      .finally(() => setPending(current => (current === key ? null : current)))
  }

  let body: React.ReactNode
  if (rows === null) {
    body = <p className="py-4 text-sm text-muted-foreground">{t('customize.loading')}</p>
  } else if (cards.length === 0) {
    body = (
      <div data-testid="customize-yours-empty" className="flex flex-col items-start gap-3 py-6">
        <p className="text-sm text-muted-foreground">{t('customize.yours.empty')}</p>
        <Button type="button" variant="outline" size="sm" data-testid="customize-yours-browse" onClick={onBrowse}>
          {t('customize.yours.browse')}
        </Button>
      </div>
    )
  } else {
    body = (
      <ul data-testid="customize-yours-themes" className={cn('@container py-3', THEME_GRID)}>
        {cards.map(card => (
          <ThemeCard
            key={`${card.row.id}|${card.row.root ?? ''}`}
            card={card}
            pending={pending === card.row.id}
            actions={actions}
            onEnable={enabled =>
              run(card.row.id, async () => {
                const count = await actions.setEnabled!(card.row, enabled)
                if (count === null) return { kind: 'failed', name: null }
                return enabled ? { kind: 'enabled', name: card.name, count } : { kind: 'disabled', name: card.name }
              })
            }
            onUninstall={() => setUninstalling(card)}
            onChooseLook={onChooseLook}
            onManage={onManage}
          />
        ))}
      </ul>
    )
  }

  return (
    <div data-testid="customize-yours-themes-tab" className="flex flex-col">
      <p className="pt-2 text-sm text-muted-foreground">{t('customize.yours.subtitle')}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
        <SingleSwitch single={single} setSingle={actions.setSingle} />
        {actions.turnOffAll ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="customize-themes-turn-off"
            disabled={pending !== null || applying || on === 0}
            onClick={() =>
              run('*', async () => ({ kind: 'turnedOff', count: await actions.turnOffAll!() }))
            }
          >
            {t('customize.themes.turnOffAll')}
          </Button>
        ) : null}
      </div>
      <NoticeLine notice={notice} onDismiss={dismissNotice} />
      {body}
      <UninstallDialog
        card={uninstalling}
        onClose={() => setUninstalling(null)}
        onUninstall={async card => {
          await actions.uninstall!(card.row)
          say({ kind: 'uninstalled', name: card.name })
        }}
      />
    </div>
  )
}

/** The cards in order: the one in effect, then the enabled ones, then the rest; by name within each. */
export function cardsOf(
  rows: readonly ThemePluginRow[],
  listings: readonly ThemePlugin[],
  standing: ThemeStanding,
): Card[] {
  const enabled = rows.filter(row => row.enabled)
  const effectOf = (row: ThemePluginRow) => {
    if (standing === undefined) return enabled.length === 1 && enabled[0] === row
    if (standing === null) return false
    return standing.plugin === row.plugin || standing.plugin === row.id
  }
  const cards = rows.map(row => {
    const listing = listings.find(each => each.name === row.plugin && each.installed)
    const looks = listing?.theme.looks ?? []
    const name = looks.length === 1 && looks[0]!.name ? looks[0]!.name : packTitle(row.plugin)
    return { row, listing, name, inEffect: effectOf(row) }
  })
  const rank = (card: Card) => (card.inEffect ? 0 : card.row.enabled ? 1 : 2)
  return cards.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

function ThemeCard({
  card,
  pending,
  actions,
  onEnable,
  onUninstall,
  onChooseLook,
  onManage,
}: {
  card: Card
  pending: boolean
  actions: YourThemesActions
  onEnable: (enabled: boolean) => void
  onUninstall: () => void
  onChooseLook: (plugin: string) => void
  onManage: (plugin: string) => void
}) {
  const t = useT()
  const { row, listing, name, inEffect } = card
  const looks = listing?.theme.looks ?? []
  const author = listing?.author?.name
  const source = row.id.endsWith('@inline')
    ? t('customize.yours.source.local')
    : row.id.endsWith('@builtin')
      ? t('customize.yours.source.builtin')
      : t('customize.yours.source.marketplace', { name: row.id.slice(row.id.lastIndexOf('@') + 1) })
  const state = inEffect ? null : t(row.enabled ? 'customize.yours.on' : 'customize.yours.off')
  return (
    <li
      data-testid="customize-yours-theme"
      data-plugin={row.plugin}
      data-enabled={row.enabled}
      data-in-effect={inEffect}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-muted"
    >
      <LookPreview name={name} url={looks[0]?.preview ?? ''} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          {looks.length > 1 ? (
            <span className="shrink-0 rounded-full border px-1.5 text-[11px] leading-4 text-muted-foreground">
              {t('customize.themes.looksCount', { count: String(looks.length) })}
            </span>
          ) : null}
        </span>
        <span className="mt-auto flex min-w-0 items-center gap-2 pt-1">
          <span className="truncate text-[13px] leading-4 text-muted-foreground/80">
            {author ? t('customize.item.byPublisher', { publisher: author }) : source}
          </span>
          {state ? (
            <span data-testid="customize-yours-state" className="shrink-0 text-xs text-muted-foreground">
              {state}
            </span>
          ) : null}
          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {inEffect ? (
              <span
                data-testid="customize-yours-in-effect"
                title={t('customize.yours.inEffect')}
                className="flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground shadow-sm"
              >
                <CircleCheckIcon aria-hidden className="size-3.5" />
                {t('customize.yours.inEffect')}
              </span>
            ) : null}
            {pending ? (
              <span data-testid="customize-yours-pending" className="flex size-7 items-center justify-center">
                <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
              </span>
            ) : (
              <CardMenu
                name={name}
                row={row}
                pack={looks.length > 1}
                actions={actions}
                onEnable={onEnable}
                onUninstall={onUninstall}
                onChooseLook={() => onChooseLook(row.plugin)}
                onManage={() => onManage(row.plugin)}
              />
            )}
          </span>
        </span>
      </div>
    </li>
  )
}

function CardMenu({
  name,
  row,
  pack,
  actions,
  onEnable,
  onUninstall,
  onChooseLook,
  onManage,
}: {
  name: string
  row: ThemePluginRow
  pack: boolean
  actions: YourThemesActions
  onEnable: (enabled: boolean) => void
  onUninstall: () => void
  onChooseLook: () => void
  onManage: () => void
}) {
  const t = useT()
  const label = t('customize.yours.menu.open', { name })
  const canUninstall = actions.uninstall !== undefined && uninstallable(row)
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          data-testid="customize-yours-menu"
          aria-label={label}
          title={label}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:focus-ring"
        >
          <EllipsisIcon aria-hidden className="size-4" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content data-testid="customize-yours-menu-content" align="end" sideOffset={4} className={MENU_CONTENT}>
          {actions.setEnabled ? (
            <DropdownMenuPrimitive.Item
              data-testid={row.enabled ? 'customize-yours-disable' : 'customize-yours-enable'}
              className={MENU_ITEM}
              onSelect={() => onEnable(!row.enabled)}
            >
              {t(row.enabled ? 'customize.yours.menu.disable' : 'customize.yours.menu.enable')}
            </DropdownMenuPrimitive.Item>
          ) : null}
          {pack ? (
            <DropdownMenuPrimitive.Item data-testid="customize-yours-choose-look" className={MENU_ITEM} onSelect={onChooseLook}>
              {t('customize.yours.menu.chooseLook')}
            </DropdownMenuPrimitive.Item>
          ) : null}
          <DropdownMenuPrimitive.Item data-testid="customize-yours-manage" className={MENU_ITEM} onSelect={onManage}>
            {t('customize.yours.menu.manage')}
          </DropdownMenuPrimitive.Item>
          {canUninstall ? (
            <>
              <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                data-testid="customize-yours-uninstall"
                className={cn(MENU_ITEM, 'text-destructive')}
                onSelect={onUninstall}
              >
                {t('customize.yours.menu.uninstall')}
              </DropdownMenuPrimitive.Item>
            </>
          ) : null}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

/** One theme plugin at a time (settings `mods.singleThemeMod`). */
function SingleSwitch({ single, setSingle }: { single: boolean | null; setSingle?: (on: boolean) => Promise<void> }) {
  const t = useT()
  const [saving, setSaving] = React.useState(false)
  const id = React.useId()
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs text-muted-foreground">
      <Switch
        id={id}
        data-testid="customize-themes-single"
        checked={single === true}
        disabled={!setSingle || single === null || saving}
        onCheckedChange={on => {
          if (!setSingle) return
          setSaving(true)
          void setSingle(on)
            .catch(() => undefined)
            .finally(() => setSaving(false))
        }}
      />
      {t('customize.themes.single')}
    </label>
  )
}

function NoticeLine({ notice, onDismiss }: { notice: (Notice & { seq: number }) | null; onDismiss: () => void }) {
  const t = useT()
  if (!notice) return null
  const failed = notice.kind === 'failed'
  const text =
    notice.kind === 'enabled'
      ? t(notice.count > 0 ? 'customize.yours.notice.enabledOthersOff' : 'customize.yours.notice.enabled', { name: notice.name })
      : notice.kind === 'disabled'
        ? t('customize.yours.notice.disabled', { name: notice.name })
        : notice.kind === 'uninstalled'
          ? t('customize.yours.notice.uninstalled', { name: notice.name })
          : notice.kind === 'turnedOff'
            ? t(notice.count > 0 ? 'customize.themes.notice.turnedOff' : 'customize.themes.notice.noneOn')
            : notice.name
              ? t('customize.yours.notice.failed', { name: notice.name })
              : t('customize.themes.notice.failedTurnOff')
  return (
    <ThemeNoticeShell testId="customize-yours-notice" kind={notice.kind} seq={notice.seq} failed={failed} onDismiss={onDismiss}>
      <p className="min-w-0 flex-1 text-sm font-medium">{text}</p>
    </ThemeNoticeShell>
  )
}

function UninstallDialog({
  card,
  onClose,
  onUninstall,
}: {
  card: Card | null
  onClose: () => void
  onUninstall: (card: Card) => Promise<void>
}) {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const shown = React.useRef(card)
  if (card !== null) shown.current = card
  React.useEffect(() => {
    setBusy(false)
    setFailed(false)
  }, [card])
  const name = shown.current?.name ?? ''
  const confirm = async () => {
    if (card === null || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await onUninstall(card)
      onClose()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={card !== null}
      onOpenChange={next => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent data-testid="customize-yours-uninstall-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('customize.yours.uninstall.title', { name })}</DialogTitle>
          <DialogDescription>{t('customize.yours.uninstall.description')}</DialogDescription>
        </DialogHeader>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t('customize.yours.uninstall.failed', { name })}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t('customize.addMarket.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            data-testid="customize-yours-uninstall-confirm"
            disabled={busy}
            onClick={confirm}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {t('customize.yours.uninstall.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
