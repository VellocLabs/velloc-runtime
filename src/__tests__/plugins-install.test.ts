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
import { loadEnabledPlugins, saveEnabledPlugins } from '../pluginHost/enabledStore'
import type { ActivePlugin, PluginScan } from '../pluginHost/pluginModel'
import { processUserInput } from '../input/submitUserInput'

function makeWritableFs(): RuntimeFs {
  const files = new Map<string, string>()
  return {
    ...unconfiguredFs,
    async mkdir() {},
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
}

function stubHostBridge(): BrowserHostBridge {
  return {} as unknown as BrowserHostBridge
}

function contextWithBash(callTool: (params: unknown) => Promise<unknown>) {
  const platformCapabilities = {
    browser: { callTool },
  } as unknown as PlatformCapabilities
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities,
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sess',
    cwd: '/w',
    projectRoot: '/w',
    commands: [],
  })
}

const EMPTY_RESULT: PluginScan = { enabled: [], disabled: [], errors: [] }
const runtimeConfig = new BrowserRuntimeConfig()

afterEach(() => resetProcessFs())

describe('/plugins install', () => {
  it('git-clones via the Bash tool, enables, and requests a reload', async () => {
    installProcessFs(makeWritableFs())
    const callTool = vi.fn(async (_params: unknown) => ({
      output: 'Cloning…',
      exit_code: 0,
    }))

    const out = await processUserInput(
      { input: '/plugins install owner/repo', context: contextWithBash(callTool) },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: EMPTY_RESULT,
      },
    )

    expect(out.action).toBe('reload-plugins')
    expect(out.enabledPlugins).toContain('repo')
    expect(await loadEnabledPlugins('/w')).toContain('repo')

    const command = (callTool.mock.calls[0]![0] as { args: { command: string } })
      .args.command
    expect(command).toContain('git clone')
    expect(command).toContain('https://github.com/owner/repo.git')
    expect(command).toContain('/w/.velloc/plugins/repo')
    // `--` ends git option parsing so a clone target starting with `-` cannot be
    // read as a flag (e.g. `--upload-pack=…`, a clone-time exec vector). The url
    // and target must both sit AFTER the separator.
    expect(command).toContain('git clone --depth 1 -- ')
    const sepIdx = command.indexOf(' -- ')
    expect(sepIdx).toBeGreaterThan(0)
    expect(command.indexOf('github.com/owner/repo')).toBeGreaterThan(sepIdx)
  })

  it('keeps every directory plugin enabled by its FOLDER, not its manifest name', async () => {
    installProcessFs(makeWritableFs())
    // `compact-on-idle/` holds a plugin named `idle-compact`; `gamma` is
    // enabled but not discovered this boot.
    await saveEnabledPlugins('/w', ['compact-on-idle', 'gamma'])
    const idle: ActivePlugin = {
      name: 'idle-compact',
      manifest: { name: 'idle-compact' },
      path: '/w/.velloc/plugins/compact-on-idle',
      source: 'project:/w/.velloc/plugins/compact-on-idle',
      enabled: true,
    }
    const market: ActivePlugin = {
      name: 'cool',
      manifest: { name: 'cool' },
      path: '/install/cool',
      source: 'marketplace:cool@mkt',
      enabled: true,
      installIdentifier: 'cool@mkt',
    }
    const callTool = vi.fn(async (_params: unknown) => ({ output: '', exit_code: 0 }))
    const out = await processUserInput(
      { input: '/plugins install owner/repo', context: contextWithBash(callTool) },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: { enabled: [idle, market], disabled: [], errors: [] },
      },
    )
    // The reload's allowlist names folders: the already-enabled plugin stays
    // enabled, and a marketplace plugin (settings map) is not on it.
    expect(out.enabledPlugins).toEqual(['compact-on-idle', 'repo'])
    expect((await loadEnabledPlugins('/w'))?.sort()).toEqual(['compact-on-idle', 'gamma', 'repo'])
  })

  it('reports a clone failure without requesting a reload', async () => {
    installProcessFs(makeWritableFs())
    const callTool = vi.fn(async () => ({
      output: 'fatal: repository not found',
      exit_code: 128,
    }))

    const out = await processUserInput(
      { input: '/plugins install owner/nope', context: contextWithBash(callTool) },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: EMPTY_RESULT,
      },
    )

    expect(out.action).toBeUndefined()
    expect(out.shouldQuery).toBe(false)
  })

  it('guides the user when there is no Bash capability', async () => {
    const context = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      sessionId: 'sess',
      cwd: '/w',
      projectRoot: '/w',
      commands: [],
    })
    const out = await processUserInput(
      { input: '/plugins install owner/repo', context },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: EMPTY_RESULT,
      },
    )
    expect(out.action).toBeUndefined()
  })
})

describe('/marketplace fetch threading (CSP-safe bridge fetch)', () => {
  // Regression for the real-browser failure:
  //   couldn't load marketplace.json: [fetch] network error fetching
  //   https://codeload.github.com/... : Failed to fetch
  // A direct globalThis.fetch from the SharedWorker is CSP-blocked. The runtime
  // threads a bridge-backed fetch as `marketplaceFetch`; dispatchCommandInput must
  // forward it into the command's `fetchImpl`. Pre-fix it was never threaded, so
  // the command fell back to the (blocked) globalThis.fetch.
  it('routes the marketplace fetch through the threaded fetch, not globalThis.fetch', async () => {
    installProcessFs(makeWritableFs())
    // If the command path falls back to globalThis.fetch (the bug), this spy
    // fires. Mock it so the bug path makes no real network call.
    const globalFetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 500 }))
    const bridgeFetch = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response('', { status: 404, statusText: 'Not Found' }),
    )

    const out = await processUserInput(
      { input: '/marketplace add me/repo', context: contextWithBash(vi.fn()) },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['marketplace'],
        pluginLoadResult: EMPTY_RESULT,
        settingsHomeDir: '/home/user',
        marketplaceFetch: bridgeFetch,
      },
    )

    // The threaded fetch hit codeload; globalThis.fetch was never used.
    expect(bridgeFetch).toHaveBeenCalledTimes(1)
    expect(String(bridgeFetch.mock.calls[0]![0])).toContain(
      'codeload.github.com/me/repo',
    )
    expect(globalFetchSpy).not.toHaveBeenCalled()
    // The 404 makes the add itself fail gracefully — we only assert routing.
    expect(out.messages.length).toBeGreaterThan(0)
    globalFetchSpy.mockRestore()
  })
})

describe('/plugins (plural) listing — TC-032 large list does not crash/overflow', () => {
  it('lists many discovered plugins completely (no truncation by design)', async () => {
    const N = 60
    const enabled: ActivePlugin[] = Array.from({ length: N }, (_, i) => ({
      name: `plug-${String(i).padStart(3, '0')}`,
      manifest: { name: `plug-${i}` },
      path: `/w/.velloc/plugins/plug-${i}`,
      source: 'project:/w',
      enabled: true,
    }))
    const out = await processUserInput(
      { input: '/plugins', context: contextWithBash(vi.fn()) },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: { enabled, disabled: [], errors: [] },
      },
    )
    // The system listing is whichever message carries a string `.message`
    // (processUserInput may prepend a non-string echo message at index 0).
    const text = out.messages
      .map(m => (m as { message?: unknown }).message)
      .filter((m): m is string => typeof m === 'string')
      .join('\n')
    // Accurate count header + first and last entries present — a read-only
    // listing renders all N without crashing/overflowing.
    expect(text).toContain(`Plugins: ${N} enabled, 0 disabled`)
    expect(text).toContain('plug-000')
    expect(text).toContain('plug-059')
    // Read-only: no reload, no model query.
    expect(out.action).toBeUndefined()
    expect(out.shouldQuery).toBe(false)
  })
})
