import { describe, expect, it, vi } from 'vitest'
import { createInitialBrowserAppState } from '../browser/runtime/AgentRuntimeState'
import type { WorkingState } from '../runtime/RuntimeTypes'
import { fireBeforeToolCall } from '../lifecycleHooks/runHooks'
import type {
  HookCommandRunner,
  HookCommandRunnerInput,
} from '../lifecycleHooks/hookCommandRunner'
import { attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'

describe('command hook ${VAR} expansion', () => {
  it('expands ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_PROJECT_DIR} in the command', async () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (u: (p: WorkingState) => WorkingState) => {
      appState = u(appState)
    }
    attachTransientHook(
      setAppState,
      'sess',
      'PreToolUse',
      'Bash',
      { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/check.sh" --root "${CLAUDE_PROJECT_DIR}"' },
      { skillRoot: '/plugins/p' },
    )

    let received: HookCommandRunnerInput | undefined
    const runner: HookCommandRunner = vi.fn(async (input: HookCommandRunnerInput) => {
      received = input
      return { stdout: '', exitCode: 0 }
    })

    await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 'sess',
      appState,
      setAppState,
      commandRunner: runner,
      hookInput: { cwd: '/w', projectRoot: '/proj' },
    })

    expect(received?.command).toBe('"/plugins/p/check.sh" --root "/proj"')
    // The vars remain exported too, for hooks that rely on shell expansion.
    expect(received?.env.CLAUDE_PLUGIN_ROOT).toBe('/plugins/p')
    expect(received?.env.CLAUDE_PROJECT_DIR).toBe('/proj')
  })
})
