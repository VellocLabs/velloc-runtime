import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInitialBrowserAppState } from '../browser/runtime/AgentRuntimeState'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { HookCommandRunner } from '../lifecycleHooks/hookCommandRunner'
import { fireBeforeToolCall } from '../lifecycleHooks/runHooks'
import { registerSettingsHooks } from '../lifecycleHooks/registerSettingsHooks'
import { transientHooksFor } from '../lifecycleHooks/sessionScopedHooks'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'

const HOME = '/home/user'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

/** Minimal fs that serves a single settings.json file; everything else
 *  ENOENTs (the loader treats a missing file as "no settings"). */
function settingsFs(json: string): RuntimeFs {
  const fs: Partial<RuntimeFs> = {
    readFile: async (path: string) => {
      if (path === SETTINGS_PATH) return json
      const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    },
  }
  return fs as RuntimeFs
}

// Settings are cached per-source (module-global), so reset between tests or a
// prior fixture leaks into the next loader read.
beforeEach(() => wipeSettingsMemos())
afterEach(() => wipeSettingsMemos())

describe('registerSettingsHooks', () => {
  it('loads ~/.velloc/settings.json hooks into the session store (no skillRoot)', async () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const fs = settingsFs(
      JSON.stringify({
        version: 1,
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] },
          ],
        },
      }),
    )

    await registerSettingsHooks({ setAppState, sessionId: 's1', homeDir: HOME, fs })

    const matchers = transientHooksFor(appState, 's1', 'PreToolUse').get('PreToolUse')
    expect(matchers?.[0]?.matcher).toBe('Bash')
    // Settings hooks are user-scoped, not plugin/skill-scoped.
    expect(matchers?.[0]?.skillRoot).toBeUndefined()
    expect(matchers?.[0]?.hooks[0]).toEqual({ type: 'command', command: 'echo pre' })
  })

  it('is a no-op when settings.json has no hooks section', async () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const fs = settingsFs(JSON.stringify({ version: 1, features: { a: true } }))

    await registerSettingsHooks({ setAppState, sessionId: 's', homeDir: HOME, fs })

    expect(transientHooksFor(appState, 's').size).toBe(0)
  })

  it('regression: a settings.json PreToolUse hook FIRES through the executor and blocks', async () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const fs = settingsFs(
      JSON.stringify({
        version: 1,
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 2' }] },
          ],
        },
      }),
    )
    await registerSettingsHooks({ setAppState, sessionId: 's1', homeDir: HOME, fs })

    // Stand in for the host shell: an `exit 2` command hook → block. This is
    // what proves the wiring fires end-to-end (load → register → execute),
    // not merely that the schema accepts a hooks block.
    const commandRunner: HookCommandRunner = async () => ({ stdout: '', exitCode: 2 })

    const blocked = await fireBeforeToolCall({
      toolName: 'Bash',
      sessionId: 's1',
      appState,
      setAppState,
      commandRunner,
    })
    expect(blocked.blocked).toBe(true)

    // A tool the matcher doesn't target is unaffected.
    const allowed = await fireBeforeToolCall({
      toolName: 'Read',
      sessionId: 's1',
      appState,
      commandRunner,
    })
    expect(allowed.blocked).toBe(false)
  })
})
