import type { RetryInfo } from './AgentTurnController'
import { MSG_TYPE_SYSTEM } from '../../runtime/VercelModelConstants'

type RuntimeSettingsNamespaces = {
  memorySettings?: Record<string, unknown>
  sessionModelSettings?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Read the two live-update namespaces that share the generic runtime-settings
 * transport. Unknown or primitive values are ignored by design.
 */
export function extractRuntimeSettingsNamespaces(
  config: Record<string, unknown>,
): RuntimeSettingsNamespaces {
  const memorySettings = config.memorySettings
  const sessionModelSettings = config.sessionModelSettings
  return {
    ...(isRecord(memorySettings) ? { memorySettings } : {}),
    ...(isRecord(sessionModelSettings) ? { sessionModelSettings } : {}),
  }
}

/**
 * Recognize the system api_error event emitted for a scheduled provider retry.
 * Keeping this boundary in one parser prevents the worker facade from relying
 * on repeated unchecked event-shape assertions.
 */
export function parseApiErrorRetryEvent(event: unknown): RetryInfo | null {
  if (!isRecord(event)) {
    return null
  }
  if (event.type !== MSG_TYPE_SYSTEM || event.subtype !== 'api_error') {
    return null
  }
  if (
    typeof event.retryInMs !== 'number' ||
    typeof event.retryAttempt !== 'number' ||
    typeof event.maxRetries !== 'number'
  ) {
    return null
  }
  return {
    retryInMs: event.retryInMs,
    attempt: event.retryAttempt,
    maxRetries: event.maxRetries,
    ...(typeof event.error === 'string' ? { errorKind: event.error } : {}),
    ...(typeof event.errorTitleKey === 'string'
      ? { errorTitleKey: event.errorTitleKey }
      : {}),
    ...(typeof event.errorTitle === 'string'
      ? { errorTitle: event.errorTitle }
      : {}),
    ...(typeof event.errorDetail === 'string'
      ? { errorDetail: event.errorDetail }
      : {}),
  }
}
