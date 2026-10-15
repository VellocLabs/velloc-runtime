import { describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'

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
      supportedSlashCommands: ['mcp'],
    },
  )
}

describe('processUserInput — /mcp', () => {
  it('signals the runtime to open the MCP settings page', async () => {
    const out = await run('/mcp')
    expect(out.shouldQuery).toBe(false)
    expect(out.action).toBe('open-settings')
    expect(out.settingsSection).toBe('mcp')
    // The typed command is echoed as a visible user message, followed by the
    // confirmation note surfaced in-thread for hosts that can't open settings
    // (mock / dev), where the action is a no-op.
    expect(out.messages.length).toBe(2)
    expect(out.messages[0]!.type).toBe('user')
    expect(out.messages[1]!.type).toBe('system')
  })

  it('ignores trailing args — /mcp has a single behavior', async () => {
    const out = await run('/mcp add foo https://example.com/mcp')
    expect(out.action).toBe('open-settings')
    expect(out.settingsSection).toBe('mcp')
    expect(out.shouldQuery).toBe(false)
  })
})
