import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import type { PlatformCapabilities } from '../runtime/interfaces/PlatformCapabilities'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'
import { loadEnabledPlugins } from '../pluginHost/enabledStore'
import type { ActivePlugin, PluginScan } from '../pluginHost/pluginModel'
import { processUserInput } from '../input/submitUserInput'

function stubHostBridge(): BrowserHostBridge {
  return {} as unknown as BrowserHostBridge
}

function makeFsWithRm(): { fs: RuntimeFs; removed: string[] } {
  const files = new Map<string, string>()
  const removed: string[] = []
  const fs = {
    ...unconfiguredFs,
    async mkdir() {},
    async rm(path: string) {
      removed.push(path)
    },
    async writeFile(path: string, data: string | Uint8Array) {
      files.set(path, String(data))
    },
    async readFile(path: string) {
      const value = files.get(path)
      if (value === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return value
    },
  } as RuntimeFs
  return { fs, removed }
}

function plugin(name: string, path: string): ActivePlugin {
  return { name, path, source: `project:${path}`, manifest: { name }, enabled: true }
}

function noopContext() {
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sess',
    cwd: '/w',
    projectRoot: '/w',
    commands: [],
  })
}

function bashContext(callTool: (params: unknown) => Promise<unknown>) {
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: { browser: { callTool } } as unknown as PlatformCapabilities,
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sess',
    cwd: '/w',
    projectRoot: '/w',
    commands: [],
  })
}

const runtimeConfig = new BrowserRuntimeConfig()
const opts = (pluginLoadResult: PluginScan) => ({
  hostBridge: stubHostBridge(),
  runtimeConfig,
  supportedSlashCommands: ['plugins'],
  pluginLoadResult,
})

afterEach(() => resetProcessFs())

describe('/plugins uninstall', () => {
  it('removes the plugin dir, drops it from enabled, and reloads', async () => {
    const { fs, removed } = makeFsWithRm()
    installProcessFs(fs)
    const result: PluginScan = {
      enabled: [plugin('alpha', '/w/.velloc/plugins/alpha')],
      disabled: [],
      errors: [],
    }
    const out = await processUserInput(
      { input: '/plugins uninstall alpha', context: noopContext() },
      opts(result),
    )
    expect(out.action).toBe('reload-plugins')
    expect(out.enabledPlugins).not.toContain('alpha')
    expect(removed).toContain('/w/.velloc/plugins/alpha')
    expect(await loadEnabledPlugins('/w')).not.toContain('alpha')
  })

  it('rejects an unknown plugin', async () => {
    installProcessFs(makeFsWithRm().fs)
    const out = await processUserInput(
      { input: '/plugins uninstall ghost', context: noopContext() },
      opts({ enabled: [], disabled: [], errors: [] }),
    )
    expect(out.action).toBeUndefined()
  })
})

describe('/plugins update', () => {
  it('git-pulls the plugin dir via the Bash tool and reloads', async () => {
    const callTool = vi.fn(async (_params: unknown) => ({
      output: 'Already up to date.',
      exit_code: 0,
    }))
    const result: PluginScan = {
      enabled: [plugin('alpha', '/w/.velloc/plugins/alpha')],
      disabled: [],
      errors: [],
    }
    const out = await processUserInput(
      { input: '/plugins update alpha', context: bashContext(callTool) },
      opts(result),
    )
    expect(out.action).toBe('reload-plugins')
    expect(out.enabledPlugins).toContain('alpha')
    const command = (callTool.mock.calls[0]![0] as { args: { command: string } })
      .args.command
    expect(command).toContain('git -C')
    expect(command).toContain('/w/.velloc/plugins/alpha')
    expect(command).toContain('pull')
  })

  it('reports a pull failure without reloading', async () => {
    const callTool = vi.fn(async (_params: unknown) => ({
      output: 'error: cannot pull',
      exit_code: 1,
    }))
    const out = await processUserInput(
      { input: '/plugins update alpha', context: bashContext(callTool) },
      opts({
        enabled: [plugin('alpha', '/w/.velloc/plugins/alpha')],
        disabled: [],
        errors: [],
      }),
    )
    expect(out.action).toBeUndefined()
  })
})
