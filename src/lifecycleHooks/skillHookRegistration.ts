/**
 * Register a skill's frontmatter `hooks:` as session-scoped hooks at invoke
 * time, with `skillRoot` in the options bag. Re-registers on every invocation,
 * without dedup.
 */
import type { WorkingState } from '../runtime/RuntimeTypes'
import { attachTransientHook } from './sessionScopedHooks'
import { LIFECYCLE_EVENT_NAMES, type HookTableByEvent } from './hookTypes'

type WorkingStateWriter = (updater: (prev: WorkingState) => WorkingState) => void

export function armSkillHooks(params: {
  setAppState: WorkingStateWriter
  sessionId: string
  hooks: HookTableByEvent
  skillRoot?: string
}): void {
  for (const event of LIFECYCLE_EVENT_NAMES) {
    const matchers = params.hooks[event]
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
          { skillRoot: params.skillRoot },
        )
      }
    }
  }
}
