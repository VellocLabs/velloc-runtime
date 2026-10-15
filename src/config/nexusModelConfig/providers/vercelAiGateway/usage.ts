import type { ProviderDocumentSource } from '../../providerDefinition'
import type { PlanUsageAmount, PlanUsageSnapshot } from '../../../../models/usage/planUsage'
import { finiteNumber, isRecord } from '../shared/listing'

/**
 * `GET /credits` — the team's AI Gateway credit balance, readable with the
 * ordinary API key (vercel.com/docs/ai-gateway/usage):
 * `{balance: "95.50", total_used: "4.50"}`, US dollars as decimal strings.
 * A prepaid balance has no quota window.
 */
export const vercelUsage: ProviderDocumentSource<PlanUsageSnapshot | undefined> = {
  path: '/credits',
  parse(document) {
    if (!isRecord(document)) throw new Error('the credits document is not an object')
    const amounts: PlanUsageAmount[] = []
    const balance = finiteNumber(document.balance)
    if (balance !== undefined) amounts.push({ kind: 'balance', amount: balance, currency: 'USD' })
    const used = finiteNumber(document.total_used)
    if (used !== undefined) amounts.push({ kind: 'spent', amount: used, currency: 'USD', period: 'total' })
    return amounts.length > 0 ? { windows: [], amounts } : undefined
  },
}
