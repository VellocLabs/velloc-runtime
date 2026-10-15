/**
 * Contract: provider credentials (F-27): one service per realm owns login state (never
 * the module's worker or the page). Sign-in raises `provider.login` and writes the
 * validated result as sealed named secrets; refresh is SINGLE-FLIGHT per provider
 * and keyed by token epoch; sign-out clears the credentials whatever the hook does.
 * A second `startLogin` while one runs joins it.
 */
import {
  EMPTY_LOGIN_STATE,
  MAX_LOGIN_CODE_CHARS,
  MAX_LOGIN_OPTIONS,
  PROVIDER_LOGIN_WALL_MS,
  answerPayloadProblem,
  isTerminalStep,
  loginTextProblem,
  loginUrlProblem,
  type ProviderLoginAnswerPayload,
  type ProviderLoginAnswerResult,
  type ProviderLoginFailureCode,
  type ProviderLoginSession,
  type ProviderLoginStartResult,
  type ProviderLoginState,
  type ProviderLoginStep,
  type ProviderSignedOut,
} from './loginProtocol'
import type { LocalizedText } from '../../../config/localizedText'
import type { NexusProviderConfig } from '../../../settings/settingsTypes'
import { queueProviderEntryWrite } from './providerEntryWrites'
import {
  ProviderSignInRequiredError,
  type ProviderSeamCredentials,
} from '../../../models/drivers/providerRequestSeam'

/** What the service uses of the module runtime (`ProviderModRuntime` satisfies it). */
export interface CredentialRuntime {
  call<R = unknown>(
    providerId: string,
    event: 'provider.login' | 'provider.refresh' | 'provider.logout',
    e?: Readonly<Record<string, unknown>>,
    options?: { signal?: AbortSignal },
  ): Promise<{ raised: false } | { raised: true; value: R }>
  hasHook(providerId: string, event: 'provider.login' | 'provider.refresh' | 'provider.logout'): boolean | undefined
}

export type CredentialDeps = {
  runtime: () => CredentialRuntime | undefined
  /** A registered provider: the secret names it declares and its methods. */
  describe: (providerId: string) => { secrets: readonly string[]; methods: readonly string[] } | undefined
  storedConfigOf: (providerId: string) => NexusProviderConfig | undefined
  /** The settings write path (`providers.upsert`: replaces the entry, seals secrets). */
  writeConfig: (providerId: string, config: NexusProviderConfig) => Promise<void>
  report: (line: string) => void
  now?: () => number
  /** The whole sign-in's wall clock. Default 10 minutes. */
  wallMs?: number
  /** `provider.logout` is waited for at most this long. Default 30 s (its own
   *  budget is 10 s; the rest is a cold start). */
  logoutWaitMs?: number
}

/** A refused request: the capability maps `code` onto a protocol error. */
export class CredentialRefusal extends Error {
  constructor(
    readonly code: 'bad_payload' | 'not_found' | 'stale' | 'conflict' | 'host_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'CredentialRefusal'
  }
}

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── results ──

export type CredentialResult = {
  secrets: Record<string, string>
  account?: string
  expiresAt?: number
}

const MAX_ACCOUNT_CHARS = 200
/** As `$.provider.setSecrets`. */
const MAX_SECRET_CHARS = 16 * 1024

/** `{ secrets, account?, expiresAt? }` of declared names, or the problem. */
export function parseCredentialResult(
  value: unknown,
  declared: readonly string[],
  allowAccount: boolean,
): { ok: true; result: CredentialResult } | { ok: false; problem: string } {
  if (!isRecord(value)) return { ok: false, problem: 'the answer is not an object' }
  const rawSecrets = value.secrets
  if (!isRecord(rawSecrets)) return { ok: false, problem: 'secrets must be an object of secret values' }
  const secrets: Record<string, string> = {}
  for (const [name, secret] of Object.entries(rawSecrets)) {
    if (!declared.includes(name)) {
      return {
        ok: false,
        problem: `${name} is not a secret the provider declares${declared.length > 0 ? ` (it declares ${declared.join(', ')})` : ''}`,
      }
    }
    if (typeof secret !== 'string' || secret.length > MAX_SECRET_CHARS) {
      return { ok: false, problem: `secrets.${name} must be a string of at most ${MAX_SECRET_CHARS} characters` }
    }
    secrets[name] = secret
  }
  const result: CredentialResult = { secrets }
  if (value.account !== undefined) {
    if (!allowAccount) return { ok: false, problem: 'a refresh does not answer an account' }
    if (typeof value.account !== 'string' || value.account.trim() === '' || value.account.length > MAX_ACCOUNT_CHARS) {
      return { ok: false, problem: `account must be a non-empty string of at most ${MAX_ACCOUNT_CHARS} characters` }
    }
    result.account = value.account.trim()
  }
  if (value.expiresAt !== undefined) {
    // Epoch milliseconds: seconds would be read as a date in 1970.
    if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt < 1e11) {
      return { ok: false, problem: 'expiresAt must be a time in epoch milliseconds' }
    }
    result.expiresAt = Math.floor(value.expiresAt)
  }
  return { ok: true, result }
}

// ── the interact specs the nouns hand in ──

export type InteractSpec =
  | { kind: 'openUrl'; url: unknown }
  | { kind: 'showCode'; code: unknown; url: unknown }
  | { kind: 'prompt'; label: unknown; secret: unknown }
  | { kind: 'choose'; label: unknown; options: unknown }
  | { kind: 'progress'; text: unknown }

type Pending = {
  stepId: string
  kind: 'openUrl' | 'prompt' | 'choose'
  optionValues?: readonly string[]
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type LoginRun = {
  loginId: string
  providerId: string
  secrets: readonly string[]
  session: ProviderLoginSession
  abort: AbortController
  stepCount: number
  answered: Set<string>
  pending?: Pending
  terminal: boolean
  moduleFailure?: string
  wallTimer?: ReturnType<typeof setTimeout>
}

const SIGN_OUT_REASON_VENDOR = 'the vendor ended the sign-in'

export class ProviderCredentials {
  private seq = 0
  private loginCount = 0
  private readonly byProvider = new Map<string, LoginRun>()
  private readonly byId = new Map<string, LoginRun>()
  private readonly signedOut = new Map<string, ProviderSignedOut>()
  private readonly listeners = new Set<(state: ProviderLoginState) => void>()
  private readonly flights = new Map<string, Promise<'refreshed' | 'unhooked'>>()
  private readonly epochs = new Map<string, number>()
  /** Bumped by every sign-in and sign-out: a refresh that began under an older
   *  one must not write its result over the new credentials. */
  private readonly generations = new Map<string, number>()

  constructor(private readonly deps: CredentialDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ── published state ──

  state(): ProviderLoginState {
    if (this.seq === 0 && this.byProvider.size === 0 && this.signedOut.size === 0) return EMPTY_LOGIN_STATE
    const logins: Record<string, ProviderLoginSession> = {}
    for (const [providerId, run] of this.byProvider) logins[providerId] = run.session
    const signedOut: Record<string, ProviderSignedOut> = {}
    for (const [providerId, entry] of this.signedOut) signedOut[providerId] = entry
    return { seq: this.seq, logins, signedOut }
  }

  subscribe(listener: (state: ProviderLoginState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    this.seq += 1
    const state = this.state()
    for (const listener of [...this.listeners]) {
      try {
        listener(state)
      } catch (error) {
        this.deps.report(`provider sign-in: a state listener failed: ${errorText(error)}`)
      }
    }
  }

  private generationOf(providerId: string): number {
    return this.generations.get(providerId) ?? 0
  }

  private bumpGeneration(providerId: string): void {
    this.generations.set(providerId, this.generationOf(providerId) + 1)
  }

  // ── sign-in ──

  startLogin(providerId: string): ProviderLoginStartResult {
    const existing = this.byProvider.get(providerId)
    if (existing && !existing.terminal) return { loginId: existing.loginId, joined: true }
    const described = this.deps.describe(providerId)
    if (!described) throw new CredentialRefusal('not_found', `${providerId} is not a registered provider mod`)
    if (!described.methods.includes('login')) {
      throw new CredentialRefusal('conflict', `${providerId} does not offer sign-in`)
    }
    const runtime = this.deps.runtime()
    if (!runtime) throw new CredentialRefusal('host_unavailable', 'the provider module runtime is not running')
    if (existing) this.dropRun(existing)
    this.loginCount += 1
    const loginId = `login-${this.now().toString(36)}-${this.loginCount}`
    const run: LoginRun = {
      loginId,
      providerId,
      secrets: described.secrets,
      session: { loginId, providerId, stepId: `${loginId}:0`, step: { kind: 'working' } },
      abort: new AbortController(),
      stepCount: 0,
      answered: new Set(),
      terminal: false,
    }
    this.byProvider.set(providerId, run)
    this.byId.set(loginId, run)
    run.wallTimer = setTimeout(() => {
      this.fail(run, 'timeout', 'the sign-in took longer than 10 minutes')
      run.abort.abort()
    }, this.deps.wallMs ?? PROVIDER_LOGIN_WALL_MS)
    this.publish()
    void this.runLogin(run, runtime)
    return { loginId, joined: false }
  }

  private async runLogin(run: LoginRun, runtime: CredentialRuntime): Promise<void> {
    let outcome: Awaited<ReturnType<CredentialRuntime['call']>>
    try {
      outcome = await runtime.call(run.providerId, 'provider.login', { loginId: run.loginId, method: 'login' }, {
        signal: run.abort.signal,
      })
    } catch (error) {
      if (run.terminal) return
      this.fail(run, ...this.classify(run, error))
      return
    }
    if (run.terminal) return
    if (!outcome.raised) {
      this.fail(run, 'no_hook', `${run.providerId} has no provider.login hook`)
      return
    }
    const parsed = parseCredentialResult(outcome.value, run.secrets, true)
    if (!parsed.ok) {
      this.fail(run, 'invalid_result', parsed.problem)
      return
    }
    // A new generation before the write: a refresh begun under the old one
    // finds it moved and does not write over this sign-in.
    this.bumpGeneration(run.providerId)
    const generation = this.generationOf(run.providerId)
    try {
      await this.write(run.providerId, () => {
        if (this.generationOf(run.providerId) !== generation) throw named('AbortError', 'the sign-in ended while it was being written')
        return {
          secrets: parsed.result.secrets,
          account: parsed.result.account ?? null,
          // With no account named, the mark is what says it is signed in.
          signedIn: parsed.result.account === undefined ? true : null,
          tokenExpiresAt: parsed.result.expiresAt ?? null,
          dropAnonymous: true,
        }
      })
    } catch (error) {
      if (run.terminal) return
      this.fail(run, 'write_failed', errorText(error))
      return
    }
    if (run.terminal) return
    this.bumpEpoch(run.providerId)
    this.signedOut.delete(run.providerId)
    this.finish(run, { kind: 'done', ...(parsed.result.account !== undefined ? { account: parsed.result.account } : {}) })
  }

  private classify(run: LoginRun, error: unknown): [ProviderLoginFailureCode, string] {
    if (run.moduleFailure !== undefined) return ['module', run.moduleFailure]
    const name = error instanceof Error ? error.name : ''
    if (name === 'ProviderModUnavailableError') return ['unavailable', errorText(error)]
    if (name === 'ProviderHookUnansweredError') return ['unanswered', errorText(error)]
    return ['module', errorText(error)]
  }

  /** The module's own failure words: `provider.login` rejected with `message`. */
  moduleFailed(loginId: string, owned: readonly string[], message: unknown): void {
    const run = this.byId.get(loginId)
    if (!run || !owned.includes(run.providerId) || run.terminal) return
    run.moduleFailure = typeof message === 'string' && message !== '' ? message.slice(0, 2000) : 'the sign-in failed'
  }

  private setStep(run: LoginRun, step: ProviderLoginStep): void {
    run.stepCount += 1
    run.session = { loginId: run.loginId, providerId: run.providerId, stepId: `${run.loginId}:${run.stepCount}`, step }
    this.publish()
  }

  private finish(run: LoginRun, step: ProviderLoginStep): void {
    if (run.terminal) return
    run.terminal = true
    if (run.wallTimer !== undefined) clearTimeout(run.wallTimer)
    this.rejectPending(run, named('AbortError', 'the sign-in is over'))
    this.setStep(run, step)
  }

  private fail(run: LoginRun, code: ProviderLoginFailureCode, reason: string): void {
    this.finish(run, { kind: 'failed', code, reason })
  }

  private rejectPending(run: LoginRun, error: Error): void {
    const pending = run.pending
    run.pending = undefined
    pending?.reject(error)
  }

  private dropRun(run: LoginRun): void {
    if (this.byProvider.get(run.providerId) === run) this.byProvider.delete(run.providerId)
    this.byId.delete(run.loginId)
  }

  /** The person cancelled (or dismissed an ended sign-in): it leaves the state. */
  cancel(loginId: string): void {
    const run = this.byId.get(loginId)
    if (!run) return
    if (!run.terminal) {
      run.terminal = true
      if (run.wallTimer !== undefined) clearTimeout(run.wallTimer)
      this.rejectPending(run, named('AbortError', 'the person cancelled the sign-in'))
      run.abort.abort()
    }
    this.dropRun(run)
    this.publish()
  }

  /** A page answer. Idempotent per step id; a step that is not the current one is stale. */
  answer(payload: ProviderLoginAnswerPayload): ProviderLoginAnswerResult {
    const problem = answerPayloadProblem(payload)
    if (problem) throw new CredentialRefusal('bad_payload', problem)
    const run = this.byId.get(payload.loginId)
    if (!run) throw new CredentialRefusal('not_found', 'no such sign-in')
    if (run.answered.has(payload.stepId)) return { accepted: false, duplicate: true }
    const pending = run.pending
    if (run.terminal || payload.stepId !== run.session.stepId || !pending || pending.stepId !== payload.stepId) {
      throw new CredentialRefusal('stale', 'that step is no longer the sign-in\'s current step')
    }
    const { value } = payload
    let resolved: unknown
    if (pending.kind === 'openUrl') {
      if (value.kind !== 'ack') throw new CredentialRefusal('bad_payload', 'this step takes an acknowledgement')
    } else if (pending.kind === 'prompt') {
      if (value.kind !== 'text') throw new CredentialRefusal('bad_payload', 'this step takes text')
      resolved = value.text
    } else {
      if (value.kind !== 'choice') throw new CredentialRefusal('bad_payload', 'this step takes a choice')
      const values = pending.optionValues ?? []
      if (value.index >= values.length) throw new CredentialRefusal('bad_payload', 'that option does not exist')
      resolved = values[value.index]
    }
    run.answered.add(payload.stepId)
    run.pending = undefined
    // The answer is NOT echoed: the step becomes "working" until the module asks again.
    this.setStep(run, { kind: 'working' })
    pending.resolve(resolved)
    return { accepted: true }
  }

  /**
   * One `interact` call from the module. Resolves at once for a step that
   * takes no answer (`showCode`, `progress`), with the answer for one that
   * does; rejects when the sign-in is cancelled, times out or ends.
   */
  interact(loginId: unknown, owned: readonly string[], spec: InteractSpec): Promise<unknown> {
    if (typeof loginId !== 'string') return Promise.reject(new TypeError('interact: the login id is missing'))
    const run = this.byId.get(loginId)
    if (!run || !owned.includes(run.providerId)) {
      return Promise.reject(named('NotAllowedError', 'interact: no sign-in of this module is running'))
    }
    if (run.terminal) return Promise.reject(named('AbortError', 'the sign-in is over'))
    let step: ProviderLoginStep
    let pendingKind: Pending['kind'] | undefined
    let optionValues: string[] | undefined
    try {
      switch (spec.kind) {
        case 'openUrl': {
          const problem = loginUrlProblem(spec.url)
          if (problem) throw new TypeError(`interact.openUrl: ${problem}`)
          step = { kind: 'openUrl', url: spec.url as string }
          pendingKind = 'openUrl'
          break
        }
        case 'showCode': {
          const code = spec.code
          if (typeof code !== 'string' || code === '' || code.length > MAX_LOGIN_CODE_CHARS || /[\r\n]/.test(code)) {
            throw new TypeError(`interact.showCode: code must be a single line of at most ${MAX_LOGIN_CODE_CHARS} characters`)
          }
          const problem = loginUrlProblem(spec.url)
          if (problem) throw new TypeError(`interact.showCode: ${problem}`)
          step = { kind: 'code', code, url: spec.url as string }
          break
        }
        case 'prompt': {
          const problem = loginTextProblem(spec.label, 'interact.prompt: label')
          if (problem) throw new TypeError(problem)
          if (spec.secret !== undefined && typeof spec.secret !== 'boolean') {
            throw new TypeError('interact.prompt: secret must be true or false')
          }
          step = { kind: 'prompt', label: spec.label as LocalizedText, secret: spec.secret === true }
          pendingKind = 'prompt'
          break
        }
        case 'choose': {
          const problem = loginTextProblem(spec.label, 'interact.choose: label')
          if (problem) throw new TypeError(problem)
          if (!Array.isArray(spec.options) || spec.options.length === 0 || spec.options.length > MAX_LOGIN_OPTIONS) {
            throw new TypeError(`interact.choose: options must be a list of 1 to ${MAX_LOGIN_OPTIONS}`)
          }
          const labels: Array<{ label: LocalizedText }> = []
          optionValues = []
          for (const option of spec.options as unknown[]) {
            const entry = typeof option === 'string' ? { label: option, value: option } : option
            if (!isRecord(entry) || typeof entry.value !== 'string' || entry.value === '' || entry.value.length > 256) {
              throw new TypeError('interact.choose: each option is a string or { label, value } with a non-empty string value')
            }
            const labelProblem = loginTextProblem(entry.label, 'interact.choose: an option label')
            if (labelProblem) throw new TypeError(labelProblem)
            if (optionValues.includes(entry.value)) throw new TypeError(`interact.choose: the value ${entry.value} is listed twice`)
            optionValues.push(entry.value)
            labels.push({ label: entry.label as LocalizedText })
          }
          step = { kind: 'choose', label: spec.label as LocalizedText, options: labels }
          pendingKind = 'choose'
          break
        }
        case 'progress': {
          const problem = loginTextProblem(spec.text, 'interact.progress: text')
          if (problem) throw new TypeError(problem)
          step = { kind: 'progress', text: spec.text as LocalizedText }
          break
        }
        default:
          throw new TypeError('interact: unknown step')
      }
    } catch (error) {
      return Promise.reject(error)
    }
    // A step the module replaced before it was answered ends that call.
    this.rejectPending(run, named('AbortError', 'a newer sign-in step replaced this one'))
    this.setStep(run, step)
    if (pendingKind === undefined) return Promise.resolve(undefined)
    const stepId = run.session.stepId
    return new Promise<unknown>((resolve, reject) => {
      run.pending = {
        stepId,
        kind: pendingKind!,
        ...(optionValues ? { optionValues } : {}),
        resolve,
        reject,
      }
    })
  }

  // ── writes ──

  /**
   * Read-modify-write of a provider's settings entry, one at a time per
   * provider. `change` returns what to set; `secrets` are sent as given
   * (`''` removes one), `account` / `tokenExpiresAt` `null` drop the field.
   * Everything else of the stored entry - `source`, `modVersion`, picks,
   * verification - rides through, because an upsert replaces the entry.
   */
  private write(
    providerId: string,
    change: () => {
      secrets: Record<string, string>
      account?: string | null
      signedIn?: true | null
      tokenExpiresAt?: number | null
      dropAnonymous?: boolean
    },
  ): Promise<void> {
    return queueProviderEntryWrite(providerId, async () => {
      const next = change()
      const stored = this.deps.storedConfigOf(providerId) ?? {}
      const {
        apiKey: _apiKey,
        hasApiKey: _hasApiKey,
        storedSecrets: _storedSecrets,
        secrets: _secrets,
        account: storedAccount,
        signedIn: storedSignedIn,
        tokenExpiresAt: storedExpiry,
        credentialMode,
        ...rest
      } = stored
      const config: NexusProviderConfig = { ...rest, source: 'mod', secrets: { ...next.secrets } }
      const account = next.account === undefined ? storedAccount : (next.account ?? undefined)
      if (account !== undefined) config.account = account
      const signedIn = next.signedIn === undefined ? storedSignedIn : (next.signedIn ?? undefined)
      if (signedIn === true) config.signedIn = true
      const expiry = next.tokenExpiresAt === undefined ? storedExpiry : (next.tokenExpiresAt ?? undefined)
      if (expiry !== undefined) config.tokenExpiresAt = expiry
      if (credentialMode !== undefined && next.dropAnonymous !== true) config.credentialMode = credentialMode
      await this.deps.writeConfig(providerId, config)
    })
  }

  // ── refresh ──

  /** When the stored token stops working (epoch ms), if the sign-in said. */
  tokenExpiresAt(providerId: string): number | undefined {
    return this.deps.storedConfigOf(providerId)?.tokenExpiresAt
  }

  /** Changes whenever the stored token was replaced. */
  epoch(providerId: string): number {
    return this.epochs.get(providerId) ?? 0
  }

  private bumpEpoch(providerId: string): void {
    this.epochs.set(providerId, this.epoch(providerId) + 1)
  }

  /** Whether the module is known not to refresh (a request then never waits on one). */
  canRefresh(providerId: string): boolean {
    const runtime = this.deps.runtime()
    return runtime !== undefined && runtime.hasHook(providerId, 'provider.refresh') !== false
  }

  /**
   * Single-flight token refresh. `since` is the caller's token epoch; nothing is asked
   * when it was replaced since. Resolves `'refreshed'` or `'unhooked'`; rejects
   * `ProviderSignInRequiredError`, or `AbortError` on `signal` (the shared call goes on).
   */
  refresh(
    providerId: string,
    reason: 'expiry' | 'unauthorized',
    options: { since?: number; signal?: AbortSignal } = {},
  ): Promise<'refreshed' | 'unhooked'> {
    if (options.since !== undefined && options.since < this.epoch(providerId)) return Promise.resolve('refreshed')
    let flight = this.flights.get(providerId)
    if (!flight) {
      flight = this.runRefresh(providerId, reason)
      this.flights.set(providerId, flight)
      const clear = (): void => {
        if (this.flights.get(providerId) === flight) this.flights.delete(providerId)
      }
      flight.then(clear, clear)
    }
    const { signal } = options
    if (!signal) return flight
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(named('AbortError', 'the request was cancelled'))
      const onAbort = (): void => reject(named('AbortError', 'the request was cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
      flight!.then(
        value => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  private async runRefresh(providerId: string, reason: 'expiry' | 'unauthorized'): Promise<'refreshed' | 'unhooked'> {
    const runtime = this.deps.runtime()
    if (!runtime || runtime.hasHook(providerId, 'provider.refresh') === false) return 'unhooked'
    const described = this.deps.describe(providerId)
    const generation = this.generationOf(providerId)
    let outcome: Awaited<ReturnType<CredentialRuntime['call']>>
    try {
      outcome = await runtime.call(providerId, 'provider.refresh', { reason })
    } catch (error) {
      // Signed out or in again while it ran: whatever is stored now is the person's.
      if (this.generationOf(providerId) !== generation) return 'refreshed'
      throw this.endedBy(providerId, `the token could not be refreshed: ${errorText(error)}`)
    }
    if (!outcome.raised) return 'unhooked'
    // Signed out (or in again) while it ran: this result is not the person's now.
    if (this.generationOf(providerId) !== generation) return 'refreshed'
    const value = outcome.value
    /** Throws inside the queued write when the sign-in moved since the refresh began. */
    const stillOurs = (): void => {
      if (this.generationOf(providerId) !== generation) throw named('AbortError', 'signed out or in again while it ran')
    }
    if (isRecord(value) && value.signedOut === true) {
      // The vendor says the sign-in is over: the stored token is no use.
      try {
        await this.write(providerId, () => {
          stillOurs()
          return {
            secrets: Object.fromEntries((described?.secrets ?? []).map(name => [name, ''])),
            tokenExpiresAt: null,
          }
        })
      } catch (error) {
        if (this.generationOf(providerId) !== generation) return 'refreshed'
        this.deps.report(`${providerId}: clearing the ended sign-in failed: ${errorText(error)}`)
      }
      this.bumpEpoch(providerId)
      throw this.endedBy(providerId, SIGN_OUT_REASON_VENDOR)
    }
    const parsed = parseCredentialResult(value, described?.secrets ?? [], false)
    if (!parsed.ok) throw this.endedBy(providerId, `the refresh answered something unusable: ${parsed.problem}`)
    try {
      await this.write(providerId, () => {
        stillOurs()
        return {
          secrets: parsed.result.secrets,
          tokenExpiresAt: parsed.result.expiresAt ?? null,
        }
      })
    } catch (error) {
      // Signed out or in again while it waited to write: what is stored is the person's.
      if (this.generationOf(providerId) !== generation) return 'refreshed'
      throw this.endedBy(providerId, `the refreshed token could not be stored: ${errorText(error)}`)
    }
    this.bumpEpoch(providerId)
    if (this.signedOut.delete(providerId)) this.publish()
    return 'refreshed'
  }

  /** The sign-in no longer works: published, and the request fails with a plain sentence. */
  private endedBy(providerId: string, reason: string): ProviderSignInRequiredError {
    this.deps.report(`${providerId}: signed out - ${reason}`)
    this.signedOut.set(providerId, { reason, at: this.now() })
    this.publish()
    return new ProviderSignInRequiredError()
  }

  // ── sign-out ──

  async signOut(providerId: string): Promise<void> {
    const described = this.deps.describe(providerId)
    if (!described) throw new CredentialRefusal('not_found', `${providerId} is not a registered provider mod`)
    const active = this.byProvider.get(providerId)
    if (active) this.cancel(active.loginId)
    this.bumpGeneration(providerId)
    const runtime = this.deps.runtime()
    if (runtime && runtime.hasHook(providerId, 'provider.logout') !== false) {
      try {
        await runtime.call(providerId, 'provider.logout', {}, {
          signal: AbortSignal.timeout(this.deps.logoutWaitMs ?? 30_000),
        })
      } catch (error) {
        // "Credentials cleared anyway."
        this.deps.report(`${providerId}: provider.logout did not finish (${errorText(error)}); the credentials are cleared anyway`)
      }
    }
    await this.write(providerId, () => ({
      secrets: Object.fromEntries(described.secrets.map(name => [name, ''])),
      account: null,
      signedIn: null,
      tokenExpiresAt: null,
    }))
    this.bumpGeneration(providerId)
    this.bumpEpoch(providerId)
    this.signedOut.delete(providerId)
    this.publish()
  }

  // ── the request seam's view ──

  /** The port the request flow uses for one provider. */
  seamCredentials(providerId: string): ProviderSeamCredentials {
    return {
      tokenExpiresAt: () => this.tokenExpiresAt(providerId),
      epoch: () => this.epoch(providerId),
      refresh: (reason, since, signal) =>
        this.refresh(providerId, reason, { ...(since !== undefined ? { since } : {}), signal }),
    }
  }
}
