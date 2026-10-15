/**
 * Register enabled-plugin hooks into the session hook store via
 * `attachTransientHook`, with the plugin path as `skillRoot`. A hook type with no
 * runner on this runtime is skipped as `not_implemented`.
 */

import type { WorkingState } from '../runtime/RuntimeTypes'
import { attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'
import type { LifecycleEventName, HookMatcher } from '../lifecycleHooks/hookTypes'
import type { ActivePlugin } from './pluginModel'

type WorkingStateWriter = (updater: (prev: WorkingState) => WorkingState) => void

export function registerPluginHooks(params: {
  setAppState: WorkingStateWriter
  sessionId: string
  plugins: readonly ActivePlugin[]
}): void {
  for (const plugin of params.plugins) {
    const hooksConfig = plugin.hooksConfig
    if (!hooksConfig) {
      continue
    }
    for (const [event, matchers] of Object.entries(hooksConfig) as [
      LifecycleEventName,
      HookMatcher[] | undefined,
    ][]) {
      if (!matchers) {
        continue
      }
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          attachTransientHook(
            params.setAppState,
            params.sessionId,
            event,
            matcher.matcher ?? '',
            hook,
            { skillRoot: plugin.path },
          )
        }
      }
    }
  }
}
