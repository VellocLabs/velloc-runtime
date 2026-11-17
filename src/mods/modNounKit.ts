/**
 * Primitives shared by the `$` noun tables: the always-valid result check, the record test, the
 * `NotSupportedError` refusal, and the `{ value } | { deny }` shape a hook may answer with.
 */

import type { NounMethod } from './modNouns'

export const VOID: Pick<NounMethod, 'accepts'> = { accepts: () => true }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function notSupported(message: string): never {
  const error = new Error(message)
  error.name = 'NotSupportedError'
  throw error
}

/**
 * How the hooks on a `$` call's event see its result: "`{ value }`, the
 * call's answer, or `{ deny }`, the reason the caller's promise rejects"
 * (`ValueOrDeny`, `OpEventResult`). Core answers `{ value }`; a hook's
 * `{ deny: reason }` makes the call reject with a `DeniedError` naming it.
 */
export type OpResult = { value: unknown; deny?: undefined } | { deny: string; value?: undefined }

export function isOpResult(result: unknown, acceptsValue: ((value: unknown) => boolean) | undefined): boolean {
  if (!isRecord(result)) return false
  if (typeof result.deny === 'string') return result.deny !== '' && result.value === undefined
  if (result.deny !== undefined) return false
  return acceptsValue ? acceptsValue(result.value) : result.value !== undefined
}
