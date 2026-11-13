/**
 * A refusal or failure that came out of the raw provider stream (the host's
 * byte transport for provider-defined wire protocols), recognised by the
 * code prefix the transport puts on its message. The worker carries that
 * message as the API-error detail; this maps it to a catalog sentence so the
 * card and the retry status line say it in the reader's language instead of
 * printing the transport's English text.
 *
 * Dependency-free: the worker and the webview both import it.
 */
import type { MessageKey } from '../browser/webview/i18n/messages/en'

export type RawStreamProblem =
  | 'egress_unsupported'
  | 'egress_invalid'
  | 'egress_unavailable'
  | 'egress_blocked'
  | 'target_not_allowed'
  | 'too_many_streams'
  | 'response_too_large'
  | 'protocol'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'sign_in_required'

const CODE_PROBLEMS: Readonly<Record<string, RawStreamProblem>> = {
  EGRESS_UNSUPPORTED: 'egress_unsupported',
  EGRESS_INVALID: 'egress_invalid',
  EGRESS_UNAVAILABLE: 'egress_unavailable',
  EGRESS_BLOCKED: 'egress_blocked',
  TARGET_NOT_ALLOWED: 'target_not_allowed',
  TOO_MANY_STREAMS: 'too_many_streams',
  RESPONSE_TOO_LARGE: 'response_too_large',
  PROTOCOL: 'protocol',
  NETWORK_ERROR: 'network',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
}

// `errorText` (models/drivers/driverStreamHost.ts) rewrites NETWORK_ERROR to
// the native stream's wording before the detail is stored.
const STREAM_NETWORK_ERROR = /^Stream network error:/i
const CODE_PREFIX = /^([A-Z][A-Z0-9_]*):/
// The sign-in refusal is stored as its sentence, not as OAUTH_UNAVAILABLE.
const SIGN_IN_REQUIRED = /^Sign in to this provider in Settings to continue$/

const SUMMARY_KEYS: Readonly<Record<RawStreamProblem, MessageKey>> = {
  egress_unsupported: 'providerIssue.egressUnsupported.summary',
  egress_invalid: 'providerIssue.rawStream.egressInvalid.summary',
  egress_unavailable: 'providerIssue.rawStream.egressUnavailable.summary',
  egress_blocked: 'providerIssue.rawStream.egressBlocked.summary',
  target_not_allowed: 'providerIssue.rawStream.targetNotAllowed.summary',
  too_many_streams: 'providerIssue.localStreamLimit.summary',
  response_too_large: 'providerIssue.rawStream.responseTooLarge.summary',
  protocol: 'providerIssue.rawStream.protocol.summary',
  network: 'providerIssue.rawStream.network.summary',
  timeout: 'providerIssue.streamTimeout.summary',
  cancelled: 'providerIssue.rawStream.cancelled.summary',
  sign_in_required: 'providerIssue.rawStream.signInRequired.summary',
}

/** The transport code a stored API-error detail starts with, or undefined. */
export function rawStreamProblemOf(detail: string): RawStreamProblem | undefined {
  const text = detail.trim()
  if (STREAM_NETWORK_ERROR.test(text)) return 'network'
  if (SIGN_IN_REQUIRED.test(text)) return 'sign_in_required'
  const match = CODE_PREFIX.exec(text)
  return match ? CODE_PROBLEMS[match[1]!] : undefined
}

export function rawStreamProblemSummaryKey(problem: RawStreamProblem): MessageKey {
  return SUMMARY_KEYS[problem]
}
