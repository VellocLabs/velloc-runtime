/**
 * Contract: web profiles (F-27, web profiles). A profile is a lasting browser
 * session of its own (cookies and site data), kept by the host as a storage
 * partition; a sign-in window may be opened in one. Profiles are shared: every
 * plugin sees all of them and may open a window in any. What a profile is
 * signed in to is recorded twice, both readable by all. A plugin's login
 * records `{ site, account, plugin }` are written and removed only by the
 * plugin they name. The profile's account records `{ site, account }`, one per
 * site, are written by the platform when a sign-in it accepted ended in that
 * profile, and removed by it when no provider is signed in through that site
 * of the profile any more. A profile with no record of either kind and no
 * window open is deleted, its session with it.
 *
 * Security: a profile's id and session are the platform's; no plugin names or
 * makes one except by opening a window in a new one. A plugin writes only its
 * own login records and no account record. A record is a note every plugin
 * reads: not a place for credentials. Nothing of a profile's session is
 * readable here.
 */

import { isPlainHostName } from './providerBaseUrlRule'

export const WEB_PROFILES_MAX = 64
export const WEB_PROFILE_LOGINS_PER_PLUGIN_MAX = 16
export const WEB_PROFILE_ACCOUNT_MAX = 200
export const WEB_PROFILE_LOGIN_DATA_MAX_CHARS = 1024
export const WEB_PROFILE_ID_PREFIX = 'velloc-profile-'
/** `profile` of `interact.openWindow`: a session that ends with its window. */
export const TEMPORARY_WEB_PROFILE = 'temporary'
/** `profile` of `interact.openWindow`: a profile made for this window. */
export const NEW_WEB_PROFILE = 'new'

const FILE_VERSION = 3
const PARTITION_PREFIX = 'vellocprofile'

/** One sign-in a plugin made in a profile. */
export type WebProfileLogin = {
  /** The site's host name, lower case. */
  site: string
  /** Who is signed in there, in the plugin's words (an id or an address). */
  account: string
  /** The plugin that recorded it; set by the platform. */
  plugin: string
  /** When it was recorded or last replaced. */
  at: number
  /** The plugin's own small note about this sign-in. */
  data?: Readonly<Record<string, unknown>>
}

/** Who is signed in to a site of a profile, as the last accepted sign-in there said. */
export type WebProfileAccount = {
  /** The host the sign-in window was opened on, lower case. */
  site: string
  /** The account that sign-in answered. */
  account: string
  /** When it was recorded or last replaced. */
  at: number
}

export type WebProfile = {
  id: string
  createdAt: number
  lastUsedAt?: number
  logins: readonly WebProfileLogin[]
  accounts: readonly WebProfileAccount[]
}

type StoredProfile = WebProfile & { number: number }

export type WebProfilesDeps = {
  /** The stored table as text, or null when there is none yet. */
  load: () => Promise<string | null>
  save: (text: string) => Promise<void>
  /** Whether this host keeps partitions. */
  hostKeepsProfiles: () => boolean
  /** Deletes everything the host stored in a partition. */
  deletePartition: (partition: string) => Promise<void>
  now?: () => number
  report?: (line: string) => void
}

export type HeldWebProfile = { id: string; partition: string; release: () => void }

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The host's name for profile `number`: lower-case letters only, as a
 * partition name must be (`a` is 0, `ba` is 26).
 */
export function webProfilePartition(number: number): string {
  let rest = number
  let letters = ''
  do {
    letters = String.fromCharCode(97 + (rest % 26)) + letters
    rest = Math.floor(rest / 26)
  } while (rest > 0)
  return PARTITION_PREFIX + letters
}

function readSite(method: string, value: unknown): string {
  const site = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!isPlainHostName(site)) throw new TypeError(`webProfiles.${method}: site must be a plain host name (no scheme, port or path)`)
  return site
}

/** `{ site, account, data? }` of `setLogin`, checked. */
function readLogin(value: unknown): { site: string; account: string; data?: Record<string, unknown> } {
  if (!isRecord(value)) throw new TypeError('webProfiles.setLogin takes (profile, { site, account, data? })')
  const site = readSite('setLogin', value.site)
  const account = typeof value.account === 'string' ? value.account.trim() : ''
  if (account.length < 1 || account.length > WEB_PROFILE_ACCOUNT_MAX) {
    throw new TypeError(`webProfiles.setLogin: account must be 1 to ${WEB_PROFILE_ACCOUNT_MAX} characters`)
  }
  if (value.data === undefined) return { site, account }
  if (!isRecord(value.data)) throw new TypeError('webProfiles.setLogin: data must be an object')
  let text: string
  try {
    text = JSON.stringify(value.data)
  } catch {
    throw new TypeError('webProfiles.setLogin: data must be plain JSON')
  }
  if (text.length > WEB_PROFILE_LOGIN_DATA_MAX_CHARS) {
    throw new TypeError(`webProfiles.setLogin: data is larger than ${WEB_PROFILE_LOGIN_DATA_MAX_CHARS} characters of JSON`)
  }
  return { site, account, data: JSON.parse(text) as Record<string, unknown> }
}

function storedLogins(value: unknown): WebProfileLogin[] {
  const out: WebProfileLogin[] = []
  if (!Array.isArray(value)) return out
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || typeof entry.site !== 'string' || typeof entry.account !== 'string') continue
    if (typeof entry.plugin !== 'string' || typeof entry.at !== 'number') continue
    if (out.some(kept => kept.plugin === entry.plugin && kept.site === entry.site)) continue
    out.push({
      site: entry.site,
      account: entry.account,
      plugin: entry.plugin,
      at: entry.at,
      ...(isRecord(entry.data) ? { data: entry.data } : {}),
    })
  }
  return out
}

function storedAccounts(value: unknown): WebProfileAccount[] {
  const out: WebProfileAccount[] = []
  if (!Array.isArray(value)) return out
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || typeof entry.site !== 'string' || typeof entry.account !== 'string') continue
    if (typeof entry.at !== 'number' || out.some(kept => kept.site === entry.site)) continue
    out.push({ site: entry.site, account: entry.account, at: entry.at })
  }
  return out
}

function parseStored(text: string | null): { next: number; rows: StoredProfile[] } {
  if (!text) return { next: 1, rows: [] }
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed) || !Array.isArray(parsed.profiles)) return { next: 1, rows: [] }
  const rows: StoredProfile[] = []
  for (const entry of parsed.profiles as unknown[]) {
    if (!isRecord(entry) || typeof entry.number !== 'number' || !Number.isInteger(entry.number) || entry.number < 1) continue
    if (typeof entry.createdAt !== 'number' || rows.some(kept => kept.number === entry.number)) continue
    rows.push({
      id: `${WEB_PROFILE_ID_PREFIX}${entry.number}`,
      number: entry.number,
      createdAt: entry.createdAt,
      ...(typeof entry.lastUsedAt === 'number' ? { lastUsedAt: entry.lastUsedAt } : {}),
      logins: storedLogins(entry.logins),
      accounts: storedAccounts(entry.accounts),
    })
  }
  // A number is never given out twice, whatever the file says.
  const floor = rows.reduce((max, row) => Math.max(max, row.number), 0) + 1
  const next = typeof parsed.next === 'number' && Number.isInteger(parsed.next) ? Math.max(parsed.next, floor) : floor
  return { next, rows }
}

const publicRow = ({ number: _number, ...row }: StoredProfile): WebProfile => row
const isEmpty = (row: StoredProfile): boolean => row.logins.length === 0 && row.accounts.length === 0

export class WebProfiles {
  private table: { next: number; rows: StoredProfile[] } | undefined
  private queue: Promise<unknown> = Promise.resolve()
  /** Profiles a window is open in, by id. */
  private readonly inUse = new Map<string, number>()

  constructor(private readonly deps: WebProfilesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private async state(): Promise<{ next: number; rows: StoredProfile[] }> {
    if (!this.table) {
      try {
        this.table = parseStored(await this.deps.load())
      } catch (error) {
        // An unreadable table is not overwritten: profiles on the host would be orphaned.
        throw named('DataError', `the web profiles could not be read: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.table
  }

  /** One change at a time; the table in memory follows only a successful save. */
  private change<T>(
    run: (state: { next: number; rows: StoredProfile[] }) => Promise<{ next?: number; rows: StoredProfile[]; result: T }>,
  ): Promise<T> {
    const step = this.queue.then(async () => {
      const state = await this.state()
      const { next = state.next, rows, result } = await run(state)
      if (rows === state.rows && next === state.next) return result
      await this.deps.save(
        JSON.stringify({
          version: FILE_VERSION,
          next,
          profiles: rows.map(({ id: _id, ...row }) => row),
        }),
      )
      this.table = { next, rows }
      return result
    })
    this.queue = step.catch(() => undefined)
    return step
  }

  /** `rows` without the profiles that hold no record and have no window open; their sessions are deleted first. */
  private async reaped(rows: StoredProfile[]): Promise<StoredProfile[]> {
    const kept: StoredProfile[] = []
    for (const row of rows) {
      if (!isEmpty(row) || this.inUse.has(row.id)) {
        kept.push(row)
        continue
      }
      try {
        await this.deps.deletePartition(webProfilePartition(row.number))
      } catch (error) {
        // Kept, to be tried again: forgetting it would leave its cookies on the host.
        this.deps.report?.(`web profiles: ${row.id} could not be deleted: ${error instanceof Error ? error.message : String(error)}`)
        kept.push(row)
      }
    }
    return kept
  }

  /** Every profile, with every plugin's login records and the profile's account records. */
  async list(): Promise<WebProfile[]> {
    await this.queue
    return (await this.state()).rows.map(publicRow)
  }

  private found(rows: readonly StoredProfile[], method: string, id: unknown): StoredProfile {
    const row = typeof id === 'string' ? rows.find(each => each.id === id) : undefined
    if (!row) throw named('NotFoundError', `webProfiles.${method}: there is no web profile ${String(id)}`)
    return row
  }

  /** Records that `plugin` signed `account` in to `site` in profile `id`, in place of its earlier record of that site. */
  setLogin(plugin: string, id: unknown, login: unknown): Promise<{ ok: true }> {
    const given = readLogin(login)
    return this.change(async ({ rows }) => {
      const row = this.found(rows, 'setLogin', id)
      const others = row.logins.filter(each => !(each.plugin === plugin && each.site === given.site))
      if (others.filter(each => each.plugin === plugin).length >= WEB_PROFILE_LOGINS_PER_PLUGIN_MAX) {
        throw named('QuotaExceededError', `webProfiles.setLogin: a plugin records at most ${WEB_PROFILE_LOGINS_PER_PLUGIN_MAX} sign-ins in a profile`)
      }
      const next = { ...row, logins: [...others, { ...given, plugin, at: this.now() }] }
      return { rows: rows.map(each => (each === row ? next : each)), result: { ok: true as const } }
    })
  }

  /**
   * Removes `plugin`'s record of `site` from profile `id`. A profile left
   * with no record is deleted unless a window is open in it.
   */
  removeLogin(plugin: string, id: unknown, site: unknown): Promise<{ ok: true }> {
    const host = readSite('removeLogin', site)
    return this.change(async ({ rows }) => {
      const row = this.found(rows, 'removeLogin', id)
      const next = { ...row, logins: row.logins.filter(each => !(each.plugin === plugin && each.site === host)) }
      return { rows: await this.reaped(rows.map(each => (each === row ? next : each))), result: { ok: true as const } }
    })
  }

  /**
   * The platform's record that `account` signed in to `site` in profile `id`,
   * in place of the profile's earlier record of that site. Security: reached
   * only from an accepted sign-in, never from a plugin's call.
   */
  recordAccount(id: string, site: string, account: string): Promise<void> {
    return this.change(async ({ rows }) => {
      const row = this.found(rows, 'recordAccount', id)
      const next = { ...row, accounts: [...row.accounts.filter(each => each.site !== site), { site, account, at: this.now() }] }
      return { rows: rows.map(each => (each === row ? next : each)), result: undefined }
    })
  }

  /**
   * Removes the account record of `site` from profile `id`; a profile left
   * with no record is deleted unless a window is open in it. Nothing is
   * written when there is no such record.
   */
  dropAccount(id: string, site: string): Promise<void> {
    return this.change(async ({ rows }) => {
      const row = rows.find(each => each.id === id)
      if (!row || !row.accounts.some(each => each.site === site)) return { rows, result: undefined }
      const next = { ...row, accounts: row.accounts.filter(each => each.site !== site) }
      return { rows: await this.reaped(rows.map(each => (each === row ? next : each))), result: undefined }
    })
  }

  /** A plugin is gone: its login records leave every profile, and a profile left empty is deleted. */
  forgetPlugin(plugin: string): Promise<void> {
    return this.change(async ({ rows }) => ({
      rows: await this.reaped(rows.map(row => ({ ...row, logins: row.logins.filter(each => each.plugin !== plugin) }))),
      result: undefined,
    }))
  }

  /**
   * The profile a sign-in window opens in, held until `release`: `'new'`
   * makes one, an id names an existing one. A held profile is not deleted;
   * on release one that still has no record is.
   */
  hold(profile: string): Promise<HeldWebProfile> {
    if (!this.deps.hostKeepsProfiles()) {
      return Promise.reject(named('NotSupportedError', 'interact.openWindow: this Velloc cannot keep web profiles'))
    }
    return this.change(async ({ next, rows }) => {
      let row: StoredProfile
      let after = next
      if (profile === NEW_WEB_PROFILE) {
        if (rows.length >= WEB_PROFILES_MAX) {
          throw named('QuotaExceededError', `interact.openWindow: there are ${WEB_PROFILES_MAX} web profiles, the most Velloc keeps`)
        }
        row = { id: `${WEB_PROFILE_ID_PREFIX}${next}`, number: next, createdAt: this.now(), logins: [], accounts: [] }
        after = next + 1
      } else {
        const found = rows.find(each => each.id === profile)
        if (!found) throw named('NotFoundError', `interact.openWindow: there is no web profile ${profile}`)
        row = { ...found, lastUsedAt: this.now() }
      }
      this.inUse.set(row.id, (this.inUse.get(row.id) ?? 0) + 1)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        const count = (this.inUse.get(row.id) ?? 1) - 1
        if (count > 0) this.inUse.set(row.id, count)
        else this.inUse.delete(row.id)
        void this.change(async state => ({ rows: await this.reaped(state.rows), result: undefined })).catch(error =>
          this.deps.report?.(`web profiles: ${String(error)}`),
        )
      }
      const others = rows.filter(each => each.id !== row.id)
      return {
        next: after,
        rows: [...others, row].sort((a, b) => a.number - b.number),
        result: { id: row.id, partition: webProfilePartition(row.number), release },
      }
    })
  }
}
