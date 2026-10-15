/**
 * Mapping everything a handler can throw — or a legacy bridge handler can
 * return — onto the protocol's closed `WireError` set.
 */
import type { BrowserBridgeError } from '../bridge/protocol/core'
import { isErrorCode, isWireError, wireError, type WireError } from '../runtimeProtocol'

/** Legacy bridge error codes that have an exact protocol counterpart. */
const LEGACY_CODE_MAP: Record<string, WireError['code']> = {
  webui_capability_unregistered: 'unknown_route',
  unknown_action: 'unknown_route',
  unsupported_action: 'unknown_route',
  invalid_payload: 'bad_payload',
  bad_request: 'bad_payload',
  webui_bad_request: 'bad_payload',
  not_found: 'not_found',
  conflict: 'conflict',
}

/**
 * A `{code, message, data}` from a legacy bridge handler or the C++ host.
 * Codes the protocol knows pass through; everything else becomes `internal`
 * with the original code preserved in `data.code` so nothing is lost.
 */
export function legacyBridgeErrorToWire(error: BrowserBridgeError): WireError {
  if (isErrorCode(error.code)) {
    return wireError(error.code, error.message, error.data)
  }
  const mapped = LEGACY_CODE_MAP[error.code]
  if (mapped) {
    return wireError(mapped, error.message, error.data)
  }
  return wireError('internal', error.message, {
    code: error.code,
    ...(error.data !== undefined ? { data: error.data } : {}),
  })
}

export function isCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'The operation was aborted.')
  )
}

/** Whatever a handler threw, as the `WireError` the `res` frame carries. */
export function toWireError(error: unknown): WireError {
  if (isWireError(error)) return error
  if (isCancellation(error)) return wireError('cancelled', 'request cancelled')
  if (error instanceof Error) return wireError('internal', error.message)
  return wireError('internal', String(error))
}
