import { createContext, useContext } from 'react'
import type { RoutedVia } from '../../models/drivers/providerRouter'
import type { BrowserLlmCatalog, BrowserLlmModel, BrowserLlmProvider, BrowserLlmSelection } from '../bridge/protocol/nexus_llm'
import { activeModelLabel, findActiveModel } from './activeModel'
import type { MessageKey } from './i18n/messages/en'
import type { TranslateFn } from './i18n/translate'

/** Thread-message `metadata.custom` key holding a routed reply's record (F-27). */
export const ROUTED_VIA_KEY = 'routedVia'

/** True for a router provider: decided by the catalog row's `kind`, never by its id. */
export function isRouterProvider(provider: Pick<BrowserLlmProvider, 'mod'>): boolean {
  return provider.mod?.kind === 'router'
}

function isTarget(value: unknown): value is { provider: string; model: string } {
  const v = value as { provider?: unknown; model?: unknown } | null
  return !!v && typeof v.provider === 'string' && typeof v.model === 'string'
}

/** The stored record of a reply row, when it is well formed; anything else reads as no route. */
export function routedViaOfRow(row: unknown): RoutedVia | undefined {
  const via = (row as { routedVia?: unknown } | null)?.routedVia
  if (!isTarget(via)) return undefined
  const out: RoutedVia = { provider: via.provider, model: via.model }
  const facts = via as { label?: unknown; tiers?: unknown; defaultTier?: unknown }
  if (typeof facts.label === 'string' && facts.label) out.label = facts.label
  if (Array.isArray(facts.tiers) && facts.tiers.every(tier => typeof tier === 'string')) out.tiers = facts.tiers as string[]
  if (typeof facts.defaultTier === 'string' && facts.defaultTier) out.defaultTier = facts.defaultTier
  const from = (via as { switchedFrom?: unknown }).switchedFrom
  if (isTarget(from)) {
    const reason = (from as { reason?: unknown }).reason
    out.switchedFrom = {
      provider: from.provider,
      model: from.model,
      ...(typeof reason === 'string' ? { reason: reason as NonNullable<RoutedVia['switchedFrom']>['reason'] } : {}),
    }
  }
  return out
}

/** Who served the session's most recent routed reply, read from its transcript rows. */
export function latestRoutedVia(rows: readonly unknown[]): RoutedVia | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const via = routedViaOfRow(rows[i])
    if (via) return via
  }
  return undefined
}

/**
 * A reader of who serves the turn in hand, over a session's live events: a
 * reply row or a stream event that names its member. Each call reads only the
 * events added since the last one; a list that was cleared or replaced is
 * read from its start.
 */
export function liveRouteMemberReader(): (events: readonly unknown[]) => RoutedVia | undefined {
  let first: unknown
  let read = 0
  let found: RoutedVia | undefined
  return (events) => {
    if (events.length < read || events[0] !== first) {
      read = 0
      found = undefined
    }
    first = events[0]
    for (; read < events.length; read += 1) found = routedViaOfRow(events[read]) ?? found
    return found
  }
}

/**
 * A member's name: the provider's label and the model's display name, a
 * Latest entry named by the model it runs today. A provider id is opaque: an
 * unknown provider falls back to its stored id whole, an unknown model to its
 * raw id.
 */
export function routeMemberName(
  t: TranslateFn,
  catalog: Pick<BrowserLlmCatalog, 'providers'> | null | undefined,
  target: { provider: string; model: string },
): string {
  const provider = catalog?.providers.find((p) => p.id === target.provider)
  const model = provider?.models.find((m) => m.id === target.model)
  const providerName = provider?.label || target.provider
  const modelName =
    provider && model ? activeModelLabel({ provider, model: model.label ? model : { ...model, label: model.id } }) : target.model
  return t('routeMember.name', { model: modelName, source: providerName })
}

/**
 * The member serving the selection when it is a router row: the catalog entry
 * of the latest routed reply's member, or, for a member the catalog does not
 * list, an entry made from what the reply recorded (its name, else its raw id,
 * and its tiers). Null for any other selection and before a routed reply.
 */
export function servingRouteMember(
  catalog: BrowserLlmCatalog | null | undefined,
  selection: BrowserLlmSelection | null | undefined,
  member: Pick<RoutedVia, 'provider' | 'model' | 'label' | 'tiers' | 'defaultTier'> | undefined,
): { provider: BrowserLlmProvider; model: BrowserLlmModel } | null {
  if (!member || !catalog) return null
  const active = findActiveModel(catalog, selection)
  if (!active || !isRouterProvider(active.provider)) return null
  const provider = catalog.providers.find((p) => p.id === member.provider)
  const model = provider?.models.find((m) => m.id === member.model)
  if (provider && model) return { provider, model }
  const recorded: BrowserLlmModel = {
    id: member.model,
    label: member.label ?? member.model,
    enabled: true,
    supportsStreaming: true,
    ...(member.tiers ? { availableThinkingTiers: member.tiers } : {}),
    ...(member.defaultTier ? { defaultThinkingTier: member.defaultTier } : {}),
  }
  const unlisted: BrowserLlmProvider = { id: member.provider, label: member.provider, iconSvg: '', enabled: true, models: [] }
  const source = provider ?? unlisted
  return { provider: source, model: recorded }
}

const NOTICE_KEYS: Record<string, MessageKey> = {
  rate_limit: 'routeNotice.rate_limit',
  quota: 'routeNotice.quota',
  billing: 'routeNotice.billing',
  credentials: 'routeNotice.credentials',
  model_unavailable: 'routeNotice.model_unavailable',
  service: 'routeNotice.service',
  network: 'routeNotice.network',
}

/** The catalog sentence for a switch, by the failed send's verdict kind. */
export function routeNoticeKey(reason: string | undefined): MessageKey {
  return (reason && NOTICE_KEYS[reason]) || 'routeNotice.other'
}

/** The catalog the conversation names route members from; empty outside a thread. */
export const RouteNamesContext = createContext<Pick<BrowserLlmCatalog, 'providers'> | null>(null)

export function useRouteNames(): Pick<BrowserLlmCatalog, 'providers'> | null {
  return useContext(RouteNamesContext)
}
