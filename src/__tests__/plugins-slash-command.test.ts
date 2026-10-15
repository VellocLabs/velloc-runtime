import { describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'
import type { ActivePlugin, PluginScan } from '../pluginHost/pluginModel'

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
    commands: [],
  })
}

function plugin(name: string, over: Partial<ActivePlugin> = {}): ActivePlugin {
  return {
    name,
    manifest: { name, version: '1.0.0', description: `${name} desc` },
    path: `/u/.velloc/plugins/${name}`,
    source: `user:/u/.velloc/plugins/${name}`,
    enabled: true,
    ...over,
  }
}

function textOf(messages: ReadonlyArray<unknown>): string {
  // Slash commands now lead with a visible user echo of the typed command;
  // the command's own output is the system message that follows it.
  const m = (messages.find(
    msg => (msg as { type?: string }).type === 'system',
  ) ?? messages[0]) as { message?: { content?: unknown }; content?: unknown }
  const content = (m.message?.content ?? m.content) as
    | string
    | Array<{ text?: string }>
    | undefined
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => c.text ?? '').join('\n')
  return JSON.stringify(m)
}

const runtimeConfig = new BrowserRuntimeConfig()

describe('processUserInput — /plugins', () => {
  it('lists enabled, disabled, capabilities, and load errors', async () => {
    const result: PluginScan = {
      enabled: [
        plugin('alpha', { skillsPath: '/x/skills', agentsPath: '/x/agents' }),
      ],
      disabled: [plugin('beta', { enabled: false })],
      errors: [{ type: 'generic-error', source: 'user:/p', error: 'boom' }],
    }
    const out = await processUserInput(
      { input: '/plugins', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: result,
      },
    )
    expect(out.shouldQuery).toBe(false)
    const text = textOf(out.messages)
    expect(text).toContain('1 enabled, 1 disabled')
    expect(text).toContain('alpha')
    expect(text).toContain('skills')
    expect(text).toContain('agents')
    expect(text).toContain('beta')
    expect(text).toContain('boom')
  })

  it('shows guidance when no plugins are discovered', async () => {
    const out = await processUserInput(
      { input: '/plugins', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: { enabled: [], disabled: [], errors: [] },
      },
    )
    expect(out.shouldQuery).toBe(false)
    expect(textOf(out.messages)).toContain('No plugins discovered')
  })
})
