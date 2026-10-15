import type { ProviderModelDisplay } from '../../providerDefinition'
import type { PlanUsageAmount, PlanUsageSnapshot } from '../../../../models/usage/planUsage'

/**
 * OpenRouter display: a free model's "(free)" name suffix is dropped (the page shows
 * a free icon), and a free model shows only its free-request quota.
 */
export const openrouterDisplay: ProviderModelDisplay = {
  modelLabel(name, model) {
    if (!model.free) return name
    // Anywhere, not only last: a version label is appended after the family
    // name (`Zeta (free) 6.1`).
    return name.replace(/\s*\(free\)/gi, '').trim() || name
  },
  usageFor(usage, model) {
    const windows = usage.windows.filter(w =>
      model.free ? w.subject === 'free_requests' : w.subject !== 'free_requests',
    )
    if (!model.free) return { ...usage, windows }
    const { amounts: _amounts, balanceNote: _balanceNote, ...rest } = usage
    return { ...rest, windows }
  },
  usageSummary: openrouterUsageSummary,
}

/**
 * One `available` figure: the lower of the account balance and the key's remaining
 * limit. Without the account balance there is no Available (a key limit is not
 * money held). Spend figures are kept.
 */
export function openrouterUsageSummary(usage: PlanUsageSnapshot): PlanUsageSnapshot {
  const { balanceNote: _balanceNote, amounts = [], ...rest } = usage
  const bounds = amounts.filter(a => a.kind === 'balance' || a.kind === 'limit_remaining')
  const others = amounts.filter(a => a.kind !== 'balance' && a.kind !== 'limit_remaining')
  const merged: PlanUsageAmount[] = bounds.some(a => a.kind === 'balance')
    ? [{ kind: 'available', amount: Math.min(...bounds.map(a => a.amount)), currency: 'USD' }]
    : []
  const summary = [...merged, ...others]
  return summary.length > 0 ? { ...rest, amounts: summary } : rest
}
