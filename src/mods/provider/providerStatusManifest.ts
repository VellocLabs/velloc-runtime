/**
 * Contract: `providers.<key>.status`, a read-only view of values the
 * provider's module keeps in `$.store`, drawn by the platform on the
 * provider's settings page (F-27). Data only: a closed set of formats, no
 * markup, no script. Validated strictly: an unknown property, an unknown
 * format or a mistyped value refuses the provider, naming the field.
 * Pure: safe for the runtime and the page alike.
 */

import { isLocalizedText, whyNotLocalizedText, type LocalizedText } from '../../config/localizedText'

/** One value. */
export const PROVIDER_STATUS_VALUE_FORMATS = ['text', 'count', 'time', 'duration', 'percent', 'badge'] as const
export type ProviderStatusValueFormat = (typeof PROVIDER_STATUS_VALUE_FORMATS)[number]
/** A field's format: one value, or a table of them. */
export const PROVIDER_STATUS_FORMATS = [...PROVIDER_STATUS_VALUE_FORMATS, 'list'] as const
export type ProviderStatusFormat = (typeof PROVIDER_STATUS_FORMATS)[number]

export const PROVIDER_STATUS_MAX_FIELDS = 16
export const PROVIDER_STATUS_MAX_COLUMNS = 6
export const PROVIDER_STATUS_MAX_ACTIONS = 4
export const PROVIDER_STATUS_MAX_LIST_LIMIT = 100
export const PROVIDER_STATUS_DEFAULT_LIST_LIMIT = 20

export type ProviderStatusColumn = {
  key: string
  format: ProviderStatusValueFormat
  /** The column's heading; a list without headings shows none. */
  label?: LocalizedText
}

export type ProviderStatusField =
  | { key: string; label: LocalizedText; format: ProviderStatusValueFormat }
  | { key: string; label: LocalizedText; format: 'list'; columns: ProviderStatusColumn[]; limit: number }

/** A button that runs one of the provider's declared jobs. */
export type ProviderStatusAction = { label: LocalizedText; job: string }

export type ProviderStatusView = {
  /** The `$.store` key whose object holds the fields' values. */
  source: { store: string }
  fields: ProviderStatusField[]
  actions?: ProviderStatusAction[]
}

type Problems = (message: string) => void

const VALUE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const STORE_KEY_MAX = 128
const JOB_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[], at: string, bad: Problems): void {
  const extra = Object.keys(raw).filter(key => !allowed.includes(key))
  if (extra.length > 0) bad(`${at}: unknown ${extra.length === 1 ? 'property' : 'properties'} ${extra.map(k => `"${k}"`).join(', ')}`)
}

function checkKey(raw: Record<string, unknown>, at: string, seen: Set<string>, bad: Problems): string | undefined {
  if (typeof raw.key !== 'string' || !VALUE_KEY.test(raw.key)) {
    bad(`${at}.key: required; a property name of letters, digits, "_" and "-" (at most 64, not starting with a digit)`)
    return undefined
  }
  if (seen.has(raw.key)) {
    bad(`${at}.key: "${raw.key}" is used twice`)
    return undefined
  }
  seen.add(raw.key)
  return raw.key
}

function checkLabel(value: unknown, at: string, bad: Problems): LocalizedText | undefined {
  if (isLocalizedText(value)) return value
  bad(`${at}.label ${whyNotLocalizedText(value)}`)
  return undefined
}

function checkColumns(value: unknown, at: string, bad: Problems): ProviderStatusColumn[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROVIDER_STATUS_MAX_COLUMNS) {
    bad(`${at}: a "list" field needs 1 to ${PROVIDER_STATUS_MAX_COLUMNS} columns, each { key, format }`)
    return undefined
  }
  const seen = new Set<string>()
  const out: ProviderStatusColumn[] = []
  value.forEach((raw, index) => {
    const here = `${at}[${index}]`
    if (!isRecord(raw)) {
      bad(`${here}: expected an object { key, format }`)
      return
    }
    onlyKeys(raw, ['key', 'format', 'label'], here, bad)
    const key = checkKey(raw, here, seen, bad)
    const label = raw.label === undefined ? undefined : checkLabel(raw.label, here, bad)
    if (!(PROVIDER_STATUS_VALUE_FORMATS as readonly unknown[]).includes(raw.format)) {
      bad(`${here}.format: expected one of ${PROVIDER_STATUS_VALUE_FORMATS.join(' / ')}`)
      return
    }
    if (key === undefined) return
    out.push({ key, format: raw.format as ProviderStatusValueFormat, ...(label !== undefined ? { label } : {}) })
  })
  return out
}

function checkField(raw: unknown, at: string, seen: Set<string>, bad: Problems): ProviderStatusField | undefined {
  if (!isRecord(raw)) {
    bad(`${at}: expected an object { key, label, format }`)
    return undefined
  }
  onlyKeys(raw, ['key', 'label', 'format', 'columns', 'limit'], at, bad)
  const key = checkKey(raw, at, seen, bad)
  const label = checkLabel(raw.label, at, bad)
  if (!(PROVIDER_STATUS_FORMATS as readonly unknown[]).includes(raw.format)) {
    bad(`${at}.format: expected one of ${PROVIDER_STATUS_FORMATS.join(' / ')}`)
    return undefined
  }
  const format = raw.format as ProviderStatusFormat
  if (format !== 'list') {
    if (raw.columns !== undefined) bad(`${at}.columns: only a "list" field has columns`)
    if (raw.limit !== undefined) bad(`${at}.limit: only a "list" field has a limit`)
    return key !== undefined && label !== undefined ? { key, label, format } : undefined
  }
  const columns = checkColumns(raw.columns, `${at}.columns`, bad)
  let limit = PROVIDER_STATUS_DEFAULT_LIST_LIMIT
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > PROVIDER_STATUS_MAX_LIST_LIMIT) {
      bad(`${at}.limit: expected a whole number from 1 to ${PROVIDER_STATUS_MAX_LIST_LIMIT}`)
    } else limit = raw.limit
  }
  return key !== undefined && label !== undefined && columns !== undefined ? { key, label, format, columns, limit } : undefined
}

/** The job ids a provider declares, read without judging the `jobs` block. */
function declaredJobIds(jobs: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(jobs)) return ids
  for (const job of jobs) if (isRecord(job) && typeof job.id === 'string') ids.add(job.id)
  return ids
}

function checkActions(value: unknown, jobs: unknown, bad: Problems): ProviderStatusAction[] | undefined {
  if (!Array.isArray(value) || value.length > PROVIDER_STATUS_MAX_ACTIONS) {
    bad(`status.actions: expected a list of at most ${PROVIDER_STATUS_MAX_ACTIONS} actions, each { label, job }`)
    return undefined
  }
  const declared = declaredJobIds(jobs)
  const seen = new Set<string>()
  const out: ProviderStatusAction[] = []
  value.forEach((raw, index) => {
    const at = `status.actions[${index}]`
    if (!isRecord(raw)) {
      bad(`${at}: expected an object { label, job }`)
      return
    }
    onlyKeys(raw, ['label', 'job'], at, bad)
    const label = checkLabel(raw.label, at, bad)
    if (typeof raw.job !== 'string' || !JOB_NAME.test(raw.job)) {
      bad(`${at}.job: required; the id of one of this provider's jobs`)
      return
    }
    if (!declared.has(raw.job)) {
      bad(`${at}.job: "${raw.job}" is not a job this provider declares under "jobs"`)
      return
    }
    if (seen.has(raw.job)) {
      bad(`${at}.job: "${raw.job}" has a button already`)
      return
    }
    seen.add(raw.job)
    if (label !== undefined) out.push({ label, job: raw.job })
  })
  return out
}

/**
 * Validate one provider's `status` block. Every problem is reported through
 * `bad` (prefixed by the caller with the provider's label) and the answer is
 * then `undefined`. `jobs` is the provider's raw `jobs` value: an action may
 * name only a job id found there.
 */
export function checkProviderStatus(value: unknown, jobs: unknown, bad: Problems): ProviderStatusView | undefined {
  if (!isRecord(value)) {
    bad('status: expected an object { source, fields, actions? }')
    return undefined
  }
  let failed = false
  const note: Problems = message => {
    failed = true
    bad(message)
  }
  onlyKeys(value, ['source', 'fields', 'actions'], 'status', note)

  let store: string | undefined
  if (!isRecord(value.source)) note('status.source: required; { "store": "<key>" }')
  else {
    onlyKeys(value.source, ['store'], 'status.source', note)
    const key = value.source.store
    if (typeof key !== 'string' || key.trim() === '' || key.length > STORE_KEY_MAX) {
      note(`status.source.store: required; a $.store key of at most ${STORE_KEY_MAX} characters`)
    } else store = key
  }

  const fields: ProviderStatusField[] = []
  if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > PROVIDER_STATUS_MAX_FIELDS) {
    note(`status.fields: required; a list of 1 to ${PROVIDER_STATUS_MAX_FIELDS} fields`)
  } else {
    const seen = new Set<string>()
    value.fields.forEach((raw, index) => {
      const field = checkField(raw, `status.fields[${index}]`, seen, note)
      if (field) fields.push(field)
    })
  }

  const actions = value.actions === undefined ? undefined : checkActions(value.actions, jobs, note)

  if (failed || store === undefined) return undefined
  return {
    source: { store },
    fields,
    ...(actions && actions.length > 0 ? { actions } : {}),
  }
}
