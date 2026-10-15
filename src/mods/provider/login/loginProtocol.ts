/**
 * Contract: provider sign-in on the runtime protocol (P-3). The dialog is PUBLISHED
 * STATE on `providers/login`; answers are ACTIONS. Security: no credential is in the
 * state, and a secret prompt's answer is not echoed. Every action is scope
 * `manager` (it writes credentials; the state holds a device code and sign-in URL).
 */
import type { LocalizedText } from '../../../config/localizedText'
import { isLocalizedText } from '../../../config/localizedText'

export const PROVIDER_LOGIN_CAPABILITY = 'providerLogin'
export const PROVIDER_LOGIN_TOPIC = 'providers/login'

/** The wall clock of a whole sign-in (plan 3.4): the person's time included. */
export const PROVIDER_LOGIN_WALL_MS = 10 * 60_000

/** Longest text answer the page may send for a prompt (a pasted token). */
export const MAX_LOGIN_ANSWER_CHARS = 16 * 1024
export const MAX_LOGIN_URL_CHARS = 2048
export const MAX_LOGIN_CODE_CHARS = 128
export const MAX_LOGIN_OPTIONS = 50
export const MAX_LOGIN_ID_CHARS = 128

export type ProviderLoginFailureCode =
  /** The module's `provider.login` hook rejected; `reason` is its own words. */
  | 'module'
  /** The 10 minutes ran out. */
  | 'timeout'
  /** The module could not be started. */
  | 'unavailable'
  /** The hook ended without an answer (it overran, or answered nothing). */
  | 'unanswered'
  /** The module has no `provider.login` hook. */
  | 'no_hook'
  /** The hook's answer was not `{ secrets, account?, expiresAt? }` of declared names. */
  | 'invalid_result'
  /** The credentials could not be written. */
  | 'write_failed'

export type ProviderLoginStep =
  /** Started, or an answer was taken: the module has not asked for anything yet. */
  | { kind: 'working' }
  /** `interact.openUrl`: the page offers a button; the click is the answer. */
  | { kind: 'openUrl'; url: string }
  /** `interact.showCode`: a code and where to enter it; shown until the next step. */
  | { kind: 'code'; code: string; url: string }
  /** `interact.prompt`: a text (or secret) answer. */
  | { kind: 'prompt'; label: LocalizedText; secret: boolean }
  /** `interact.choose`: the answer is the index of an option. */
  | { kind: 'choose'; label: LocalizedText; options: ReadonlyArray<{ label: LocalizedText }> }
  /** `interact.progress`: nothing to answer. */
  | { kind: 'progress'; text: LocalizedText }
  /** Terminal: the credentials are written. */
  | { kind: 'done'; account?: string }
  /** Terminal. */
  | { kind: 'failed'; code: ProviderLoginFailureCode; reason: string }

export type ProviderLoginSession = {
  loginId: string
  providerId: string
  /** Changes with every step; an answer names the step it answers. */
  stepId: string
  step: ProviderLoginStep
}

export type ProviderSignedOut = {
  /** Why: the vendor said so, or the refresh could not be done. English, for the detail line. */
  reason: string
  at: number
}

/** Snapshot and every `state` delta: the whole table. */
export type ProviderLoginState = {
  /** Increases with every publication; a reader keeps the highest it has seen. */
  seq: number
  /** The live (or just ended) sign-in of each provider; at most one per provider. */
  logins: Record<string, ProviderLoginSession>
  /** Providers whose stored sign-in no longer works (refresh failed or said so). */
  signedOut: Record<string, ProviderSignedOut>
}

export const EMPTY_LOGIN_STATE: ProviderLoginState = Object.freeze({ seq: 0, logins: {}, signedOut: {} })

export function isTerminalStep(step: ProviderLoginStep): boolean {
  return step.kind === 'done' || step.kind === 'failed'
}

// ── actions ──

export type ProviderLoginStartPayload = { providerId: string }
/** `joined`: a sign-in of this provider was already running; this is it. */
export type ProviderLoginStartResult = { loginId: string; joined: boolean }

export type ProviderLoginAnswerValue =
  | { kind: 'ack' }
  | { kind: 'text'; text: string }
  | { kind: 'choice'; index: number }

export type ProviderLoginAnswerPayload = { loginId: string; stepId: string; value: ProviderLoginAnswerValue }
/** `duplicate`: this step was already answered; nothing happened again. */
export type ProviderLoginAnswerResult = { accepted: boolean; duplicate?: boolean }

export type ProviderLoginCancelPayload = { loginId: string }
export type ProviderLoginSignOutPayload = { providerId: string }

const ID_PATTERN = /^[A-Za-z0-9_.:\-]{1,128}$/

export function isLoginId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** A provider id as the registry spells it (`mod.<plugin>.<key>`). */
export function isLoginProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\s/\\]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The first problem with a `providerLogin.answer` payload, or null. */
export function answerPayloadProblem(payload: unknown): string | null {
  if (!isRecord(payload)) return 'the payload must be an object'
  if (!isLoginId(payload.loginId)) return 'loginId must be a login id'
  if (!isLoginId(payload.stepId)) return 'stepId must be a step id'
  const value = payload.value
  if (!isRecord(value)) return 'value must be an object'
  if (value.kind === 'ack') return null
  if (value.kind === 'text') {
    if (typeof value.text !== 'string') return 'value.text must be a string'
    if (value.text.length > MAX_LOGIN_ANSWER_CHARS) return `value.text is longer than ${MAX_LOGIN_ANSWER_CHARS} characters`
    return null
  }
  if (value.kind === 'choice') {
    if (!Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) >= MAX_LOGIN_OPTIONS) {
      return 'value.index must be a small non-negative integer'
    }
    return null
  }
  return "value.kind must be 'ack', 'text' or 'choice'"
}

// ── what a module may put on a step ──

/** The https/http URL a sign-in step may carry, or why not. No other scheme,
 *  no embedded credentials: the page opens it on the person's click. */
export function loginUrlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return 'the url must be a non-empty string'
  if (url.length > MAX_LOGIN_URL_CHARS) return `the url is longer than ${MAX_LOGIN_URL_CHARS} characters`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'the url is not an absolute URL'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `only http and https links can be opened, not ${parsed.protocol}`
  }
  if (parsed.username !== '' || parsed.password !== '') return 'the url must not carry a user name or password'
  return null
}

export function loginTextProblem(text: unknown, what: string): string | null {
  return isLocalizedText(text) ? null : `${what} must be text or a { locale: text } object`
}
