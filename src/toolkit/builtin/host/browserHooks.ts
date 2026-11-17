/**
 * The browser tools on the native hook tier (F-26): after a step that called a
 * Browser tool the prompt is rendered again, so the next request carries the
 * page context as it is now.
 */
import type { NativeHookRegistration } from '../../nativeHooks'
import { NATIVE_EVENTS, type PromptRerenderEvent } from '../../nativeHookEvents'

export const BROWSER_MODULE = 'browser'

async function rerenderAfterBrowserStep(
  e: unknown,
  _live: unknown,
  next: (e: unknown) => Promise<unknown>,
): Promise<unknown> {
  if ((e as PromptRerenderEvent).calls.some(call => call.toolName.startsWith('Browser'))) return true
  return next(e)
}

export function browserHooks(): NativeHookRegistration[] {
  return [{ module: BROWSER_MODULE, event: NATIVE_EVENTS.promptRerender, scope: 'all', around: rerenderAfterBrowserStep }]
}
