import { BadgeCheckIcon, ExternalLinkIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'

import type { DirectoryComponent, DirectoryComponentType, DirectoryItemDetails } from '../../../customize/directoryOffer'
import { useLocale, useT } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'

const COMPONENT_GROUPS: Array<{ type: DirectoryComponentType; label: MessageKey }> = [
  { type: 'skill', label: 'customize.detail.parts.skills' },
  { type: 'command', label: 'customize.detail.parts.commands' },
  { type: 'agent', label: 'customize.detail.parts.agents' },
  { type: 'hook', label: 'customize.detail.parts.hooks' },
  { type: 'mcp_server', label: 'customize.detail.parts.mcpServers' },
  { type: 'other', label: 'customize.detail.parts.other' },
]

const LINK_LABELS: Array<{ key: keyof NonNullable<DirectoryItemDetails['links']>; label: MessageKey }> = [
  { key: 'documentation', label: 'customize.detail.links.documentation' },
  { key: 'repository', label: 'customize.detail.links.repository' },
  { key: 'support', label: 'customize.detail.links.support' },
  { key: 'privacy', label: 'customize.detail.links.privacy' },
]

/** The parts an item brings, grouped by kind: one count per kind. */
export function PartCounts({ parts }: { parts: DirectoryComponent[] | undefined }) {
  const t = useT()
  if (!parts?.length) return null
  return (
    <span className="flex flex-wrap gap-1.5">
      {COMPONENT_GROUPS.map(group => {
        const count = parts.filter(p => p.type === group.type).length
        return count ? (
          <Badge key={group.type} variant="outline" className="font-normal text-muted-foreground">
            {t(group.label)} · {count}
          </Badge>
        ) : null
      })}
    </span>
  )
}

/** "Verified" beside a name, for an item the directory reviewed. */
export function VerifiedMark({ details }: { details: DirectoryItemDetails | undefined }) {
  const t = useT()
  if (!details?.verified) return null
  return (
    <span
      data-testid="customize-verified"
      className="inline-flex shrink-0 items-center gap-1 text-xs text-primary"
      title={t('customize.detail.verifiedHint')}
    >
      <BadgeCheckIcon className="size-3.5" />
      {t('customize.detail.verified')}
    </span>
  )
}

/** Every part, grouped under its kind, with its description. `limit` keeps the first ones and counts the rest. */
export function IncludedParts({ parts, limit }: { parts: DirectoryComponent[] | undefined; limit?: number }) {
  const t = useT()
  if (!parts?.length) return null
  let left = limit ?? Number.POSITIVE_INFINITY
  const groups = COMPONENT_GROUPS.map(group => {
    const all = parts.filter(p => p.type === group.type)
    const shown = all.slice(0, Math.max(0, left))
    left -= shown.length
    return { ...group, shown }
  }).filter(group => group.shown.length > 0)
  const hidden = parts.length - groups.reduce((n, g) => n + g.shown.length, 0)
  return (
    <div data-testid="customize-included" className="flex flex-col gap-3">
      {groups.map(group => (
        <div key={group.type} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t(group.label)}</span>
          <ul className="flex flex-col gap-1">
            {group.shown.map(part => (
              <li key={`${part.type}:${part.name}`} className="flex min-w-0 flex-col rounded-md border px-2.5 py-1.5">
                <span className="truncate font-mono text-xs text-foreground">
                  {part.name}
                  {part.toolCount ? (
                    <span className="ms-2 font-sans text-muted-foreground">
                      {t('customize.detail.toolCount', { count: String(part.toolCount) })}
                    </span>
                  ) : null}
                </span>
                {part.description ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{part.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {hidden > 0 ? (
        <span className="text-xs text-muted-foreground">{t('customize.detail.parts.more', { count: String(hidden) })}</span>
      ) : null}
    </div>
  )
}

/** The item's screenshots, side by side; each opens full size in a new window. */
export function Screenshots({ urls }: { urls: string[] | undefined }) {
  const t = useT()
  if (!urls?.length) return null
  return (
    <div data-testid="customize-screenshots" className="flex gap-3 overflow-x-auto pb-1">
      {urls.map((url, i) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="shrink-0">
          <img
            src={url}
            alt={t('customize.detail.screenshotAlt', { index: String(i + 1) })}
            className="h-44 w-auto rounded-md border object-cover"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  )
}

/** A date from the directory, in the reader's locale; nothing for a value that is not a date. */
export function useFormatDate(): (iso: string | undefined) => string | null {
  const locale = useLocale()
  return iso => {
    if (!iso) return null
    const time = Date.parse(iso)
    if (Number.isNaN(time)) return null
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(time)
  }
}

export type FactRow = { label: MessageKey; value: string | null | undefined; href?: string }

/** A side column of facts (label: value) and the item's links. */
export function FactsAndLinks({
  facts,
  details,
  homepage,
}: {
  facts: FactRow[]
  details: DirectoryItemDetails | undefined
  homepage?: string
}) {
  const t = useT()
  const shown = facts.filter(f => f.value)
  const links = [
    ...(homepage && /^https:\/\//i.test(homepage)
      ? [{ label: 'customize.detail.links.homepage' as MessageKey, href: homepage }]
      : []),
    ...LINK_LABELS.flatMap(l => (details?.links?.[l.key] ? [{ label: l.label, href: details.links[l.key]! }] : [])),
  ]
  return (
    <aside data-testid="customize-facts" className="flex flex-col gap-5">
      {shown.length ? (
        <dl className="flex flex-col gap-2.5">
          {shown.map(f => (
            <div key={f.label} className="flex flex-col">
              <dt className="text-xs text-muted-foreground">{t(f.label)}</dt>
              <dd className="truncate text-sm text-foreground">
                {f.href ? (
                  <a href={f.href} target="_blank" rel="noreferrer" className="hover:underline">
                    {f.value}
                  </a>
                ) : (
                  f.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {links.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">{t('customize.detail.links')}</span>
          {links.map(link => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline"
            >
              <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
              {t(link.label)}
            </a>
          ))}
        </div>
      ) : null}
      {details?.categories?.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">{t('customize.detail.categories')}</span>
          <span className="flex flex-wrap gap-1.5">
            {details.categories.map(tag => (
              <Badge key={tag} variant="secondary" className="font-normal">
                {tag.replace(/-/g, ' ')}
              </Badge>
            ))}
          </span>
        </div>
      ) : null}
    </aside>
  )
}
