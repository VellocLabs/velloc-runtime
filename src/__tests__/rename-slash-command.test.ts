import { describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'

// /rename. With a name → emit the `rename` action so
// QueryEngine persists a dedicated `custom-title` entry. No name → auto-name
// via the fast model (here: no conversation / no bootstrap → graceful usage
// hint, never throws).

function stubHostBridge(): BrowserHostBridge {
  return {} as unknown as BrowserHostBridge
}

function makeContext() {
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sess',
    cwd: '/w',
    commands: [],
  })
}

const runtimeConfig = new BrowserRuntimeConfig()

function run(input: string) {
  return processUserInput(
    { input, context: makeContext() },
    {
      hostBridge: stubHostBridge(),
      runtimeConfig,
      supportedSlashCommands: ['rename'],
    },
  )
}

describe('processUserInput — /rename', () => {
  it('with a name emits the rename action + a confirmation', async () => {
    const out = await run('/rename my-feature')
    expect(out.shouldQuery).toBe(false)
    expect(out.action).toBe('rename')
    expect(out.renameTitle).toBe('my-feature')
    expect(out.messages.some(m => m.type === 'system')).toBe(true)
  })

  it('keeps internal spaces but trims the edges of the name', async () => {
    const out = await run('/rename   spaced name  ')
    expect(out.action).toBe('rename')
    expect(out.renameTitle).toBe('spaced name')
  })

  it('with no name and no conversation yet → no action, asks for a name', async () => {
    const out = await run('/rename')
    // proposeSessionTitle returns null (empty conversation) → usage hint, and
    // crucially NO rename action (nothing to persist).
    expect(out.action).toBeUndefined()
    expect(out.shouldQuery).toBe(false)
    expect(out.messages.some(m => m.type === 'system')).toBe(true)
  })
})
