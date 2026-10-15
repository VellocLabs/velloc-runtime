import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  NoopUserInputPipeline,
  createEmptyAppState,
  createMemoryFileStateCache,
} from '../runtime/testing/noopAdapters'
import type { WorkingState } from '../runtime/RuntimeTypes'

/**
 * Entering plan mode through the engine must remember the mode it was entered
 * from under the key every reader uses (`permissionRules.modeBeforePlan`):
 * plan exit, the interactive halt, plan approval and restart recovery all
 * restore from it. Leaving plan mode clears it again.
 */
function makeEngine(appStateRef: { current: WorkingState }) {
  const runtimeConfig = new DefaultRuntimeConfig()
  return new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appStateRef.current,
    writeAppState: updater => {
      appStateRef.current = updater(appStateRef.current)
    },
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore('session-plan-restore'),
    userInputPipeline: new NoopUserInputPipeline(runtimeConfig, false),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
  })
}

describe('plan mode remembers the mode it was entered from', () => {
  it('records modeBeforePlan on entry and clears it on exit', () => {
    const base = createEmptyAppState()
    const appStateRef = {
      current: {
        ...base,
        permissionRules: { ...base.permissionRules, mode: 'acceptEdits' },
      } as WorkingState,
    }
    const engine = makeEngine(appStateRef)

    engine.setPermissionMode('plan')
    expect(engine.getCurrentPermissionMode()).toBe('plan')
    expect(appStateRef.current.permissionRules.modeBeforePlan).toBe('acceptEdits')
    expect(appStateRef.current.permissionRules).not.toHaveProperty('prePlanMode')

    engine.setPermissionMode('default')
    expect(engine.getCurrentPermissionMode()).toBe('default')
    expect(appStateRef.current.permissionRules.modeBeforePlan).toBeUndefined()
  })

  it('keeps the remembered mode while staying in plan mode', () => {
    const base = createEmptyAppState()
    const appStateRef = {
      current: {
        ...base,
        permissionRules: { ...base.permissionRules, mode: 'acceptEdits' },
      } as WorkingState,
    }
    const engine = makeEngine(appStateRef)
    engine.setPermissionMode('plan')
    engine.setPermissionMode('plan')
    expect(appStateRef.current.permissionRules.modeBeforePlan).toBe('acceptEdits')
  })
})
