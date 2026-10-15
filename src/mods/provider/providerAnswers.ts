/**
 * Provider mods — reading the answers of `provider.verify` and
 * `provider.usage`. As with `provider.models` (providerModelsAnswer.ts), the
 * answer comes from a module and nothing in it is trusted: each reader
 * returns the well-formed part, or `undefined` when the answer is not of the
 * right kind at all (the caller then treats the hook as not having answered).
 */

import type { ProviderVerifyResult } from '../../config/nexusModelConfig/providerDefinition'
import type {
  PlanUsageAmount,
  PlanUsageSnapshot,
  PlanUsageWindow,
  PlanUsageWindowKind,
} from '../../models/usage/planUsage'

/** A message is a log line, not a document. */
export const VERIFY_MESSAGE_MAX_LENGTH = 500
export const USAGE_PLAN_NAME_MAX_LENGTH = 100
export const USAGE_MAX_WINDOWS = 8
export const USAGE_MAX_AMOUNTS = 8

const VERIFY_CODES = [
  'auth_unauthorized',
  'auth_forbidden',
  'network_unreachable',
  'network_timeout',
  'system_unexpected',
] as const
type VerifyCode = (typeof VERIFY_CODES)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `{ ok: true }`, or `{ ok: false, code, message, httpStatus? }` with a code
 * of the host's `providerAuth.verify` vocabulary. A failure with an unknown
 * code is `system_unexpected`; with no message, the code stands in for one.
 * Not an object, or no boolean `ok`: undefined.
 */
export function parseVerifyAnswer(answer: unknown): ProviderVerifyResult | undefined {
  if (!isRecord(answer) || typeof answer.ok !== 'boolean') return undefined
  if (answer.ok) return { ok: true }
  const code: VerifyCode = VERIFY_CODES.includes(answer.code as VerifyCode)
    ? (answer.code as VerifyCode)
    : 'system_unexpected'
  const message =
    typeof answer.message === 'string' && answer.message.trim() !== ''
      ? answer.message.trim().slice(0, VERIFY_MESSAGE_MAX_LENGTH)
      : code
  const status = answer.httpStatus
  return {
    ok: false,
    code,
    message,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatus: status }
      : {}),
  }
}

const WINDOW_KINDS: readonly string[] = ['five_hour', 'daily', 'weekly', 'monthly'] satisfies PlanUsageWindowKind[]
const AMOUNT_KINDS: readonly string[] = ['balance', 'limit_remaining', 'spent']
const PERIODS: readonly string[] = ['day', 'week', 'month', 'total']
const BALANCE_NOTES: readonly string[] = ['needs_key', 'unavailable']

function usageWindow(raw: unknown): PlanUsageWindow | undefined {
  if (!isRecord(raw) || !WINDOW_KINDS.includes(raw.kind as string)) return undefined
  const used = raw.usedPercent
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined
  const window: PlanUsageWindow = {
    kind: raw.kind as PlanUsageWindowKind,
    usedPercent: Math.min(100, Math.max(0, used)),
  }
  if (raw.subject === 'free_requests') window.subject = 'free_requests'
  if (typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) && raw.resetsAt > 0) {
    window.resetsAt = raw.resetsAt
  }
  return window
}

function usageAmount(raw: unknown): PlanUsageAmount | undefined {
  // `available` is a summary for the hover surfaces, never in a snapshot.
  if (!isRecord(raw) || !AMOUNT_KINDS.includes(raw.kind as string)) return undefined
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount)) return undefined
  if (raw.currency !== 'USD') return undefined
  const amount: PlanUsageAmount = {
    kind: raw.kind as PlanUsageAmount['kind'],
    amount: raw.amount,
    currency: 'USD',
  }
  if (PERIODS.includes(raw.period as string)) amount.period = raw.period as NonNullable<PlanUsageAmount['period']>
  return amount
}

/**
 * The well-formed part of a usage answer as a `PlanUsageSnapshot`: a window
 * or amount that is malformed is dropped, the lists are capped, a share is
 * clamped to 0-100. Undefined when the answer is not an object, or nothing
 * usable is left (the UI then shows no usage).
 */
export function parseUsageAnswer(answer: unknown): PlanUsageSnapshot | undefined {
  if (!isRecord(answer)) return undefined
  const windows = (Array.isArray(answer.windows) ? answer.windows : [])
    .map(usageWindow)
    .filter((w): w is PlanUsageWindow => w !== undefined)
    .slice(0, USAGE_MAX_WINDOWS)
  const amounts = (Array.isArray(answer.amounts) ? answer.amounts : [])
    .map(usageAmount)
    .filter((a): a is PlanUsageAmount => a !== undefined)
    .slice(0, USAGE_MAX_AMOUNTS)
  const planName =
    typeof answer.planName === 'string' && answer.planName.trim() !== '' && answer.planName.trim().length <= USAGE_PLAN_NAME_MAX_LENGTH
      ? answer.planName.trim()
      : undefined
  const note = BALANCE_NOTES.includes(answer.balanceNote as string)
    ? (answer.balanceNote as 'needs_key' | 'unavailable')
    : undefined
  if (windows.length === 0 && amounts.length === 0 && note === undefined) return undefined
  return {
    ...(planName !== undefined ? { planName } : {}),
    windows,
    ...(amounts.length > 0 ? { amounts } : {}),
    ...(note !== undefined ? { balanceNote: note } : {}),
  }
}
