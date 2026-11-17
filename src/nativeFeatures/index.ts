/**
 * Contract: the composition root of the native hook tier (F-26). The order table
 * is the only place link order is decided; each feature module contributes its
 * registrations through its own `nativeHookRegistrations()`.
 */
import {
  createNativeHooks,
  type NativeHookOrder,
  type NativeHookRegistration,
  type NativeHooks,
} from '../toolkit/nativeHooks'

/** Per event, the modules whose links run, outermost first. */
export const NATIVE_HOOK_ORDER: NativeHookOrder = Object.freeze({})

/** Every built-in registration, in no particular order. */
export function nativeHookRegistrations(): NativeHookRegistration[] {
  return []
}

export function buildNativeHooks(): NativeHooks {
  return createNativeHooks(NATIVE_HOOK_ORDER, nativeHookRegistrations())
}
