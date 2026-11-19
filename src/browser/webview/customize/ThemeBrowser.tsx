import * as React from 'react'
import { CheckIcon, CircleAlertIcon, CircleCheckIcon, Loader2Icon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { ThemeLook } from '../../../pluginHost/registryFormats'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'
import { INSTALL_TOAST_MS } from './InstallToasts'
import { AVATAR_TINT, avatarHue } from './ItemAvatar'
import { PAGE_COLUMN } from './MarketplaceBrowser'
import {
  DEFAULT_LOOK,
  lookInUse,
  lookKey,
  type ThemeCatalogView,
  type ThemeFailure,
  type ThemeNotice,
  type ThemePlugin,
  type ThemeStanding,
  type ThemeTarget,
} from './useThemeCatalog'

/** Looks a pack's section shows before "Show all": two rows of three. */
export const PACK_LIMIT = 6

type Filter = 'all' | 'light' | 'dark'
const FILTERS: readonly Filter[] = ['all', 'light', 'dark']

const REASON: Record<ThemeFailure, MessageKey> = {
  unknownLook: 'customize.themes.reason.unknownLook',
  notLoaded: 'customize.themes.reason.notLoaded',
  notOwnCommand: 'customize.themes.reason.notOwnCommand',
  unanswered: 'customize.themes.reason.unanswered',
  commandFailed: 'customize.themes.reason.commandFailed',
  request: 'customize.themes.reason.request',
}

const GRID = 'grid grid-cols-1 gap-3 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3'

export type ThemeBrowserProps = {
  view: ThemeCatalogView
  /** The session a look is applied to; null when the window shows none that takes one. */
  target: ThemeTarget | null
  /** The target session's standing theme; leave out when it cannot be read. */
  standing?: ThemeStanding
  /** Back to the conversation, to see an applied look. */
  onClose: () => void
}

/**
 * The theme directory (F-35): the built-in marketplace's themes as a grid of
 * looks. A pack is one plugin with several looks under its own header; a
 * single theme is a card of its own. Add downloads the plugin; Use applies a
 * look to the session the screen was opened from.
 */
export function ThemeBrowser({ view, target, standing, onClose }: ThemeBrowserProps) {
  const t = useT()
  const [filter, setFilter] = React.useState<Filter>('all')
  const shows = (look: ThemeLook) =>
    filter === 'all' || look.appearance === undefined || look.appearance === 'both' || look.appearance === filter
  const packs = view.plugins.filter(p => p.theme.looks.length > 1)
  const singles = view.plugins.filter(p => p.theme.looks.length === 1 && shows(p.theme.looks[0]!))
  const blocked: MessageKey | null = !target
    ? 'customize.themes.noSession'
    : target.busy
      ? 'customize.themes.busy'
      : null
  const inUse = target ? lookInUse(view.inUse[target.sessionId], standing, view.plugins) : null
  const shared = { view, target, blocked, inUse }
  const defaultShown = filter === 'all'

  let body: React.ReactNode
  if (view.status === 'loading') {
    body = <p className="py-4 text-sm text-muted-foreground">{t('customize.loading')}</p>
  } else if (view.status === 'failed' || view.status === 'notFetched') {
    body = (
      <div data-testid="customize-themes-failed" className="flex items-center gap-3 py-4">
        <p className={cn('text-sm', view.refreshing ? 'text-muted-foreground' : 'text-destructive')}>
          {t(view.refreshing ? 'customize.browse.downloading' : 'customize.themes.loadFailed')}
        </p>
        {view.refreshing ? null : (
          <Button type="button" variant="outline" size="sm" data-testid="customize-themes-retry" onClick={view.refresh}>
            {t('customize.retry')}
          </Button>
        )}
      </div>
    )
  } else if (view.plugins.length === 0) {
    body = (
      <p data-testid="customize-themes-empty" className="py-4 text-sm text-muted-foreground">
        {t('customize.themes.empty')}
      </p>
    )
  } else {
    body = (
      <>
        {packs.map(plugin => (
          <PackSection key={plugin.name} plugin={plugin} looks={plugin.theme.looks.filter(shows)} {...shared} />
        ))}
        {defaultShown || singles.length > 0 ? (
          <section
            data-testid="customize-themes-singles"
            aria-label={t(singles.length > 0 ? 'customize.themes.singles' : 'customize.themes.default.name')}
            className="@container flex flex-col gap-3 py-4"
          >
            {singles.length > 0 ? (
              <h3 className="text-[15px] leading-5 font-semibold text-foreground">{t('customize.themes.singles')}</h3>
            ) : null}
            <ul className={GRID}>
              {defaultShown ? <DefaultCard {...shared} /> : null}
              {singles.map(plugin => (
                <LookCard key={plugin.name} plugin={plugin} look={plugin.theme.looks[0]!} single {...shared} />
              ))}
            </ul>
          </section>
        ) : null}
      </>
    )
  }

  return (
    <div data-testid="customize-themes" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={PAGE_COLUMN}>
        <div className="flex flex-col gap-1 pt-6 pb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-foreground">{t('customize.themes.heading')}</h2>
            {view.refreshing && view.status === 'ready' ? (
              <span data-testid="customize-themes-refreshing" className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2Icon className="size-3 animate-spin" />
                {t('customize.browse.updating')}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{t('customize.themes.subtitle')}</p>
          <p data-testid="customize-themes-target" className="text-sm text-muted-foreground">
            {blocked ? t(blocked) : t('customize.themes.appliesTo', { title: target!.title })}
          </p>
        </div>
        <div className="flex items-center gap-3 py-2">
          <div
            role="group"
            aria-label={t('customize.themes.filter.aria')}
            data-testid="customize-themes-filter"
            className="flex items-center rounded-md border p-0.5"
          >
            {FILTERS.map(value => (
              <button
                key={value}
                type="button"
                data-value={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:focus-ring',
                  filter === value && 'bg-muted text-foreground',
                )}
              >
                {t(`customize.themes.filter.${value}`)}
              </button>
            ))}
          </div>
        </div>
        <NoticeLine notice={view.notice} onDismiss={view.dismissNotice} onView={onClose} />
        {body}
      </div>
    </div>
  )
}

type Shared = {
  view: ThemeCatalogView
  target: ThemeTarget | null
  blocked: MessageKey | null
  /** The look marked In use for the target session. */
  inUse: string | null
}

function PackSection({ plugin, looks, view, target, blocked, inUse }: Shared & { plugin: ThemePlugin; looks: ThemeLook[] }) {
  const t = useT()
  const [all, setAll] = React.useState(false)
  const shown = all ? looks : looks.slice(0, PACK_LIMIT)
  const count = String(plugin.theme.looks.length)
  const installing = view.installing.has(plugin.name)
  return (
    <section
      data-testid="customize-theme-pack"
      data-name={plugin.name}
      aria-label={plugin.name}
      className="@container flex flex-col gap-3 py-4"
    >
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="truncate text-[15px] leading-5 font-semibold text-foreground">{plugin.name}</h3>
        <span
          data-testid="customize-theme-pack-count"
          title={t('customize.themes.looksCount', { count })}
          className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground"
        >
          <span aria-hidden>{count}</span>
          <span className="sr-only">{t('customize.themes.looksCount', { count })}</span>
        </span>
        {plugin.theme.official ? <OfficialBadge /> : null}
        {plugin.author?.name ? (
          <span className="truncate text-[13px] text-muted-foreground/80">
            {t('customize.item.byPublisher', { publisher: plugin.author.name })}
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-2">
          {looks.length > PACK_LIMIT ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="customize-theme-pack-toggle"
              aria-expanded={all}
              onClick={() => setAll(open => !open)}
            >
              {t(all ? 'customize.themes.showFewer' : 'customize.themes.showAll', { count: String(looks.length) })}
            </Button>
          ) : null}
          {plugin.installed ? (
            <InstalledMark />
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={installing}
              data-testid="customize-theme-pack-add"
              onClick={() => view.add(plugin.name)}
            >
              {installing ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {t(installing ? 'customize.item.adding' : 'customize.item.add')}
            </Button>
          )}
        </span>
      </div>
      {plugin.description ? (
        <p title={plugin.description} className="-mt-2 line-clamp-3 text-sm text-muted-foreground">
          {plugin.description}
        </p>
      ) : null}
      {view.installFailed.has(plugin.name) ? (
        <p role="status" className="text-xs text-destructive">
          {t('customize.item.failed.install')}
        </p>
      ) : null}
      {looks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('customize.themes.noneMatch')}</p>
      ) : (
        <ul className={GRID}>
          {shown.map(look => (
            <LookCard key={look.id} plugin={plugin} look={look} view={view} target={target} blocked={blocked} inUse={inUse} />
          ))}
        </ul>
      )}
    </section>
  )
}

function LookCard({
  plugin,
  look,
  single = false,
  view,
  target,
  blocked,
  inUse,
}: Shared & { plugin: ThemePlugin; look: ThemeLook; single?: boolean }) {
  const t = useT()
  const name = look.name ?? look.id
  const description = look.description ?? (single ? plugin.description : undefined)
  const key = lookKey(plugin.name, look.id)
  const installing = view.installing.has(plugin.name)
  const usable = target !== null && blocked === null

  let action: React.ReactNode
  if (installing) {
    action = (
      <Button type="button" size="xs" disabled data-testid="customize-theme-adding">
        <Loader2Icon className="size-3.5 animate-spin" />
        {t('customize.item.adding')}
      </Button>
    )
  } else if (!plugin.installed) {
    // A single theme is its plugin: loading it is the look. A pack's look is
    // picked after the download, when a session can take it.
    const andUse = !single && usable
    action = (
      <Button
        type="button"
        size="xs"
        data-testid="customize-theme-add"
        onClick={() => view.add(plugin.name, andUse ? { look, target: target! } : undefined)}
      >
        {t(andUse ? 'customize.themes.addAndUse' : 'customize.item.add')}
      </Button>
    )
  } else if (inUse === key) {
    action = <InUseMark />
  } else {
    const applying = view.applying === key
    action = (
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!usable || view.applying !== null}
        title={blocked ? t(blocked) : undefined}
        data-testid="customize-theme-use"
        onClick={() => target && view.use(plugin.name, look, target)}
      >
        {applying ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
        {t(applying ? 'customize.themes.applying' : 'customize.themes.use')}
      </Button>
    )
  }

  return (
    <li
      data-testid="customize-theme-look"
      data-plugin={plugin.name}
      data-look={look.id}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-muted"
    >
      <LookPreview name={name} url={look.preview} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          {single && plugin.theme.official ? <OfficialBadge /> : null}
          {look.appearance ? (
            <span
              data-testid="customize-theme-appearance"
              className="ms-auto shrink-0 rounded-full border px-1.5 text-[11px] leading-4 text-muted-foreground"
            >
              {t(`customize.themes.appearance.${look.appearance}`)}
            </span>
          ) : null}
        </span>
        {description ? (
          <p title={description} className="line-clamp-2 text-[13px] leading-[17px] text-muted-foreground">
            {description}
          </p>
        ) : null}
        <span className="mt-auto flex min-w-0 items-center gap-2 pt-1">
          {single && plugin.author?.name ? (
            <span className="truncate text-[13px] leading-4 text-muted-foreground/80">
              {t('customize.item.byPublisher', { publisher: plugin.author.name })}
            </span>
          ) : null}
          <span className="ms-auto shrink-0">{action}</span>
        </span>
        {single && view.installFailed.has(plugin.name) ? (
          <p role="status" className="text-xs text-destructive">
            {t('customize.item.failed.install')}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/** The app's own look: Use removes the session's theme. */
function DefaultCard({ view, target, blocked, inUse }: Shared) {
  const t = useT()
  const usable = target !== null && blocked === null
  const applying = view.applying === DEFAULT_LOOK
  return (
    <li
      data-testid="customize-theme-default"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-muted"
    >
      <div aria-hidden className="flex aspect-[16/10] w-full items-center justify-center border-b bg-background">
        <span className="flex gap-1.5">
          <span className="size-4 rounded-full bg-primary" />
          <span className="size-4 rounded-full bg-muted-foreground/40" />
          <span className="size-4 rounded-full border bg-card" />
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <span className="truncate text-sm font-medium text-foreground">{t('customize.themes.default.name')}</span>
        <p className="line-clamp-2 text-[13px] leading-[17px] text-muted-foreground">
          {t('customize.themes.default.description')}
        </p>
        <span className="mt-auto flex pt-1">
          <span className="ms-auto shrink-0">
            {inUse === DEFAULT_LOOK ? (
              <InUseMark />
            ) : (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!usable || view.applying !== null}
                title={blocked ? t(blocked) : undefined}
                data-testid="customize-theme-default-use"
                onClick={() => target && view.clear(target)}
              >
                {applying ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                {t(applying ? 'customize.themes.applying' : 'customize.themes.use')}
              </Button>
            )}
          </span>
        </span>
      </div>
    </li>
  )
}

/** A look's picture, or the name's initial on its own tint when there is none to show. */
function LookPreview({ name, url }: { name: string; url: string }) {
  const t = useT()
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => setBroken(false), [url])
  if (broken || !/^https?:\/\//.test(url)) {
    return (
      <div
        aria-hidden
        data-testid="customize-theme-preview-fallback"
        style={{ '--avatar-hue': avatarHue(name) } as React.CSSProperties}
        className={cn(
          'flex aspect-[16/10] w-full items-center justify-center text-2xl font-semibold uppercase',
          AVATAR_TINT,
        )}
      >
        {name.trim().charAt(0) || '?'}
      </div>
    )
  }
  return (
    <img
      data-testid="customize-theme-preview"
      src={url}
      alt={t('customize.themes.previewAlt', { name })}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="aspect-[16/10] w-full bg-background object-cover"
      onError={() => setBroken(true)}
    />
  )
}

function OfficialBadge() {
  const t = useT()
  return (
    <span
      data-testid="customize-theme-official"
      className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[11px] leading-4 font-medium text-primary"
    >
      {t('customize.themes.official')}
    </span>
  )
}

function InstalledMark() {
  const t = useT()
  return (
    <span data-testid="customize-theme-installed" className="flex items-center gap-1 text-xs text-muted-foreground">
      <CheckIcon className="size-3.5" />
      {t('customize.item.installed')}
    </span>
  )
}

function InUseMark() {
  const t = useT()
  return (
    <span data-testid="customize-theme-in-use" className="flex h-6 items-center gap-1 text-xs font-medium text-primary">
      <CheckIcon className="size-3.5" />
      {t('customize.themes.inUse')}
    </span>
  )
}

/** How the last Use ended; leaves after a few seconds or when dismissed. */
function NoticeLine({
  notice,
  onDismiss,
  onView,
}: {
  notice: ThemeNotice | null
  onDismiss: () => void
  onView: () => void
}) {
  const t = useT()
  const seq = notice?.seq
  const failed = notice?.kind === 'failed'
  React.useEffect(() => {
    // A failure stays until it is dismissed or the next Use answers.
    if (seq === undefined || failed) return
    const timer = window.setTimeout(onDismiss, INSTALL_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [seq, failed, onDismiss])
  if (!notice) return null
  const title =
    notice.kind === 'applied'
      ? t('customize.themes.notice.applied', { name: notice.name, title: notice.session })
      : notice.kind === 'cleared'
        ? t('customize.themes.notice.cleared', { title: notice.session })
        : notice.name
          ? t('customize.themes.notice.failed', { name: notice.name })
          : t('customize.themes.notice.failedClear')
  return (
    <div
      role={failed ? 'alert' : 'status'}
      data-testid="customize-theme-notice"
      data-kind={notice.kind}
      className="sticky top-2 z-10 my-1 flex items-start gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-sm"
    >
      {failed ? (
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        {failed ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(REASON[notice.reason])}
            {notice.detail ? ` ${t('customize.themes.notice.detail', { detail: notice.detail })}` : null}
          </p>
        ) : null}
      </div>
      {failed ? null : (
        <Button type="button" variant="outline" size="xs" data-testid="customize-theme-notice-view" onClick={onView}>
          {t('customize.themes.notice.view')}
        </Button>
      )}
      <button
        type="button"
        data-testid="customize-theme-notice-dismiss"
        aria-label={t('customize.install.toast.dismiss')}
        title={t('customize.install.toast.dismiss')}
        onClick={onDismiss}
        className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:focus-ring"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
