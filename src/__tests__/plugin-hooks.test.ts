import { describe, expect, it } from 'vitest'
import { createInitialBrowserAppState } from '../browser/runtime/AgentRuntimeState'
import type { WorkingState } from '../runtime/RuntimeTypes'
import { transientHooksFor } from '../lifecycleHooks/sessionScopedHooks'
import { registerPluginHooks } from '../pluginHost/registerPluginHooks'
import type { ActivePlugin } from '../pluginHost/pluginModel'

function makePlugin(): ActivePlugin {
  return {
    name: 'alpha',
    path: '/plugins/alpha',
    source: 'project:/proj',
    manifest: { name: 'alpha' },
    hooksConfig: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo pre' }],
        },
      ],
    },
  }
}

describe('registerPluginHooks', () => {
  it('registers a plugin command hook into the session store, scoped by plugin path', () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }

    registerPluginHooks({
      setAppState,
      sessionId: 'session-1',
      plugins: [makePlugin()],
    })

    const hooks = transientHooksFor(appState, 'session-1', 'PreToolUse')
    const matchers = hooks.get('PreToolUse')
    expect(matchers).toBeTruthy()
    expect(matchers?.[0]?.matcher).toBe('Bash')
    expect(matchers?.[0]?.skillRoot).toBe('/plugins/alpha')
    expect(matchers?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: 'echo pre',
    })
  })

  it('is a no-op for plugins without hooks', () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    registerPluginHooks({
      setAppState,
      sessionId: 's',
      plugins: [{ name: 'p', path: '/p', source: 's', manifest: { name: 'p' } }],
    })
    expect(transientHooksFor(appState, 's').size).toBe(0)
  })
})
