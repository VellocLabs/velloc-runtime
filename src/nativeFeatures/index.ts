/**
 * Contract: the composition root of the native hook tier (F-26). The order table
 * is the only place link order is decided; each feature module contributes its
 * registrations through its own `<feature>Hooks()` function.
 */
import {
  createNativeHooks,
  type NativeHookOrder,
  type NativeHookRegistration,
  type NativeHooks,
} from '../toolkit/nativeHooks'
import { NATIVE_EVENTS } from '../toolkit/nativeHookEvents'
import { SESSION_ACTIVITY_MODULE, sessionActivityHooks } from '../browser/worker/sessionActivityHooks'
import { MEMORY_MODULE, memoryHooks } from '../memory/memoryHooks'
import { BROWSER_MODULE, browserHooks } from '../toolkit/builtin/host/browserHooks'

/** Per event, the modules whose links run, outermost first. */
export const NATIVE_HOOK_ORDER: NativeHookOrder = Object.freeze({
  [NATIVE_EVENTS.toolStarted]: [SESSION_ACTIVITY_MODULE],
  [NATIVE_EVENTS.toolSettled]: [SESSION_ACTIVITY_MODULE],
  [NATIVE_EVENTS.turnStreamStart]: [SESSION_ACTIVITY_MODULE],
  [NATIVE_EVENTS.turnStreamEnd]: [SESSION_ACTIVITY_MODULE],
  [NATIVE_EVENTS.turnBackground]: [MEMORY_MODULE],
  [NATIVE_EVENTS.rowsGather]: [MEMORY_MODULE],
  [NATIVE_EVENTS.turnEnd]: [MEMORY_MODULE],
  [NATIVE_EVENTS.promptRerender]: [BROWSER_MODULE],
})

/** Every built-in registration, in no particular order. */
export function nativeHookRegistrations(): NativeHookRegistration[] {
  return [...sessionActivityHooks(), ...memoryHooks(), ...browserHooks()]
}

export function buildNativeHooks(): NativeHooks {
  return createNativeHooks(NATIVE_HOOK_ORDER, nativeHookRegistrations())
}
