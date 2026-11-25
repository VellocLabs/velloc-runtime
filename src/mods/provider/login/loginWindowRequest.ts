/**
 * The checks of an `interact.openWindow` request (F-27, the sign-in window). Security: the
 * page is https (plain http only on a loopback host) on a host the manifest
 * allows (or a sub-domain of one), and the redirect to capture is a loopback
 * http address with an explicit port, as the host requires, so a capture
 * never swallows a navigation to a real site.
 */
import { hostCoveredBy, isLoopbackHost } from '../providerBaseUrlRule'
import { loginUrlProblem } from './loginProtocol'

const MAX_TITLE_CHARS = 200

function notAllowed(message: string): Error {
  const error = new Error(message)
  error.name = 'NotAllowedError'
  return error
}

/** Why `url` cannot be the redirect a sign-in window captures, or null. */
export function captureRedirectProblem(url: unknown): string | null {
  const problem = loginUrlProblem(url)
  if (problem) return problem
  const parsed = new URL(url as string)
  if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
    return 'only an http address on 127.0.0.1, localhost or [::1] can be captured'
  }
  if (parsed.port === '') return 'the address needs an explicit port other than 80'
  return null
}

/** The error an `interact.openWindow` request is refused with, or null. */
export function loginWindowProblem(spec: Readonly<Record<string, unknown>>, allow: readonly string[]): Error | null {
  if (allow.length === 0) {
    return notAllowed('interact.openWindow: the manifest declares no credentials.loginWindow.allow')
  }
  const urlProblem = loginUrlProblem(spec.url)
  if (urlProblem) return new TypeError(`interact.openWindow: ${urlProblem}`)
  const page = new URL(spec.url as string)
  const host = page.hostname.toLowerCase()
  if (!hostCoveredBy(host, allow)) {
    return notAllowed(`interact.openWindow: ${host} is not among credentials.loginWindow.allow`)
  }
  if (page.protocol !== 'https:' && !isLoopbackHost(host)) {
    return new TypeError('interact.openWindow: the page must be https (plain http only on a loopback host)')
  }
  const captureProblem = captureRedirectProblem(spec.captureRedirect)
  if (captureProblem) return new TypeError(`interact.openWindow: captureRedirect: ${captureProblem}`)
  if (spec.title !== undefined && (typeof spec.title !== 'string' || spec.title.length > MAX_TITLE_CHARS)) {
    return new TypeError(`interact.openWindow: title must be text of at most ${MAX_TITLE_CHARS} characters`)
  }
  if (spec.isolated !== undefined && typeof spec.isolated !== 'boolean') {
    return new TypeError('interact.openWindow: isolated must be true or false')
  }
  return null
}
