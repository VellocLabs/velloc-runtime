/**
 * Register settings.json `hooks` (userSettings only, no policy gates) as
 * session-scoped hooks at session start; a mid-session edit applies next
 * session. Registered without `skillRoot`: no `CLAUDE_PLUGIN_ROOT`, commands
 * run from the project dir.
 */
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { readUserLayer } from '../settings/settingsStore'
import { attachTransientHook } from './sessionScopedHooks'
import { LIFECYCLE_EVENT_NAMES } from './hookTypes'

type WorkingStateWriter = (updater: (prev: WorkingState) => WorkingState) => void

export async function registerSettingsHooks(params: {
  setAppState: WorkingStateWriter
  sessionId: string
  homeDir: string
  fs: RuntimeFs
}): Promise<void> {
  const { settings } = await readUserLayer(params.homeDir, params.fs)
  if (!settings.hooks) {
    return
  }
  for (const event of LIFECYCLE_EVENT_NAMES) {
    const matchers = settings.hooks[event]
    if (!matchers) {
      continue
    }
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        // No `skillRoot` — settings hooks are user/project-scoped, not
        // tied to a plugin/skill asset directory.
        attachTransientHook(
          params.setAppState,
          params.sessionId,
          event,
          matcher.matcher ?? '',
          hook,
        )
      }
    }
  }
}
