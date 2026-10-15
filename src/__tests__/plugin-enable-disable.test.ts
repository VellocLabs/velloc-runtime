import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import { createInitialBrowserAppState } from '../browser/runtime/AgentRuntimeState'
import type { WorkingState } from '../runtime/RuntimeTypes'
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
import {
  attachInProcessHook,
  attachTransientHook,
  inProcessHooksFor,
  transientHooksFor,
  removeSessionHooksBySkillRoot,
} from '../lifecycleHooks/sessionScopedHooks'
import {
  loadDisabledPlugins,
  loadEnabledPlugins,
  patchEnabledPlugin,
  saveEnabledPlugins,
} from '../pluginHost/enabledStore'
import type { ActivePlugin, PluginScan } from '../pluginHost/pluginModel'
import { wipeSettingsMemos } from '../settings/settingsStore'
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

afterEach(() => resetProcessFs())

describe('enabledStore', () => {
  it('round-trips the enabled list and dedups', async () => {
    installProcessFs(makeWritableFs())
    expect(await loadEnabledPlugins('/w')).toBeNull()
    await saveEnabledPlugins('/w', ['a', 'b', 'a'])
    expect(await loadEnabledPlugins('/w')).toEqual(['a', 'b'])
  })

  // Settings flags a folder nobody has decided about: switching it either way
  // is a decision, so off is recorded as well as on.
  it('records a switched-off folder, and forgets it when switched on again', async () => {
    installProcessFs(makeWritableFs())
    expect(await loadDisabledPlugins('/w')).toEqual([])
    await patchEnabledPlugin('/w', 'a', true)
    await patchEnabledPlugin('/w', 'a', false)
    expect(await loadEnabledPlugins('/w')).toEqual([])
    expect(await loadDisabledPlugins('/w')).toEqual(['a'])
    await patchEnabledPlugin('/w', 'a', true)
    expect(await loadEnabledPlugins('/w')).toEqual(['a'])
    expect(await loadDisabledPlugins('/w')).toEqual([])
  })

  it('a full save keeps the switched-off folders it does not enable', async () => {
    installProcessFs(makeWritableFs())
    await patchEnabledPlugin('/w', 'off', false)
    await saveEnabledPlugins('/w', ['a'])
    expect(await loadDisabledPlugins('/w')).toEqual(['off'])
  })
})

describe('removeSessionHooksBySkillRoot', () => {
  it('drops only the matching skillRoot, keeping others and function hooks', () => {
    let appState: WorkingState = createInitialBrowserAppState()
    const setAppState = (u: (p: WorkingState) => WorkingState) => {
      appState = u(appState)
    }
    attachTransientHook(setAppState, 's', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'a',
    }, { skillRoot: '/plugins/a' })
    attachTransientHook(setAppState, 's', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'b',
    }, { skillRoot: '/plugins/b' })
    attachInProcessHook(setAppState, 's', 'PreToolUse', 'Bash', () => true, 'fn')

    removeSessionHooksBySkillRoot(setAppState, 's', '/plugins/a')

    const cmd = transientHooksFor(appState, 's', 'PreToolUse').get('PreToolUse') ?? []
    const roots = cmd.map(m => m.skillRoot)
    expect(roots).toContain('/plugins/b')
    expect(roots).not.toContain('/plugins/a')
    // The function hook (no skillRoot) survives.
    const fns = inProcessHooksFor(appState, 's', 'PreToolUse').get('PreToolUse') ?? []
    expect(fns.length).toBeGreaterThan(0)
  })
})

function stubHostBridge(): BrowserHostBridge {
  return {} as unknown as BrowserHostBridge
}

function makeContext(at: { cwd?: string; projectRoot?: string } = {}) {
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sess',
    cwd: at.cwd ?? '/w',
    projectRoot: at.projectRoot ?? '/w',
    commands: [],
  })
}

function plugin(name: string, enabled: boolean): ActivePlugin {
  return {
    name,
    manifest: { name, description: `${name} desc` },
    path: `/w/.velloc/plugins/${name}`,
    source: `project:/w/.velloc/plugins/${name}`,
    enabled,
  }
}

describe('processUserInput — /plugins enable|disable', () => {
  const runtimeConfig = new BrowserRuntimeConfig()

  it('enables a disabled plugin: persists and requests a reload', async () => {
    installProcessFs(makeWritableFs())
    // Enable/disable now PATCHES the on-disk store (read-modify-write), so
    // seed the prior state instead of relying on a full overwrite.
    await saveEnabledPlugins('/w', ['alpha'])
    const result: PluginScan = {
      enabled: [plugin('alpha', true)],
      disabled: [plugin('beta', false)],
      errors: [],
    }
    const out = await processUserInput(
      { input: '/plugins enable beta', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: result,
      },
    )
    expect(out.action).toBe('reload-plugins')
    expect(out.enabledPlugins).toEqual(['alpha', 'beta'])
    expect(out.shouldQuery).toBe(false)
    expect(await loadEnabledPlugins('/w')).toEqual(['alpha', 'beta'])
  })

  it('runs `/claude plugins enable` as `/plugins enable`', async () => {
    installProcessFs(makeWritableFs())
    await saveEnabledPlugins('/w', ['alpha'])
    const result: PluginScan = {
      enabled: [plugin('alpha', true)],
      disabled: [plugin('beta', false)],
      errors: [],
    }
    const out = await processUserInput(
      { input: '/claude plugins enable beta', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: result,
      },
    )
    expect(out.action).toBe('reload-plugins')
    expect(out.enabledPlugins).toEqual(['alpha', 'beta'])
    expect(await loadEnabledPlugins('/w')).toEqual(['alpha', 'beta'])
  })

  // A folder copied in after the session loaded is not in its snapshot: the
  // command looks on disk again before calling the name unknown.
  it('enables a plugin the snapshot lacks after rescanning the disk', async () => {
    installProcessFs(makeWritableFs())
    await saveEnabledPlugins('/w', ['alpha'])
    const snapshot: PluginScan = { enabled: [plugin('alpha', true)], disabled: [], errors: [] }
    let rescans = 0
    const out = await processUserInput(
      { input: '/plugins enable fresh', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: snapshot,
        rescanPlugins: async () => {
          rescans += 1
          return { enabled: [plugin('alpha', true)], disabled: [plugin('fresh', false)], errors: [] }
        },
      },
    )
    expect(rescans).toBe(1)
    expect(out.action).toBe('reload-plugins')
    expect(out.enabledPlugins).toEqual(['alpha', 'fresh'])
    expect(await loadEnabledPlugins('/w')).toEqual(['alpha', 'fresh'])
  })

  it('a name still missing after the rescan is unknown, and a known one does not rescan', async () => {
    installProcessFs(makeWritableFs())
    await saveEnabledPlugins('/w', [])
    const snapshot: PluginScan = { enabled: [], disabled: [plugin('beta', false)], errors: [] }
    let rescans = 0
    const options = {
      hostBridge: stubHostBridge(),
      runtimeConfig,
      supportedSlashCommands: ['plugins'],
      pluginLoadResult: snapshot,
      rescanPlugins: async () => {
        rescans += 1
        return snapshot
      },
    }
    const missing = await processUserInput({ input: '/plugins enable ghost', context: makeContext() }, options)
    expect(missing.action).toBeUndefined()
    expect(JSON.stringify(missing.messages)).toContain('Unknown plugin')
    expect(rescans).toBe(1)
    const known = await processUserInput({ input: '/plugins enable beta', context: makeContext() }, options)
    expect(known.action).toBe('reload-plugins')
    expect(rescans).toBe(1)
  })

  it('disabling removes from the persisted list', async () => {
    installProcessFs(makeWritableFs())
    // Patch semantics: seed both, then disabling alpha leaves ['beta'].
    await saveEnabledPlugins('/w', ['alpha', 'beta'])
    const result: PluginScan = {
      enabled: [plugin('alpha', true), plugin('beta', true)],
      disabled: [],
      errors: [],
    }
    const out = await processUserInput(
      { input: '/plugins disable alpha', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: result,
      },
    )
    expect(out.action).toBe('reload-plugins')
    expect(out.enabledPlugins).toEqual(['beta'])
  })

  // A worktree-isolated sub-agent runs in its worktree, but the plugins are
  // the project's: the loader reads `<projectRoot>/.velloc/`, so the switch
  // writes there — never a file in the worktree no loader reads.
  it('writes the project folder list, not the cwd one', async () => {
    installProcessFs(makeWritableFs())
    await saveEnabledPlugins('/w', ['alpha'])
    const out = await processUserInput(
      {
        input: '/plugins enable beta',
        context: makeContext({ cwd: '/w/.claude/worktrees/agent-1', projectRoot: '/w' }),
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: { enabled: [plugin('alpha', true)], disabled: [plugin('beta', false)], errors: [] },
      },
    )
    expect(out.enabledPlugins).toEqual(['alpha', 'beta'])
    expect(await loadEnabledPlugins('/w')).toEqual(['alpha', 'beta'])
    expect(await loadEnabledPlugins('/w/.claude/worktrees/agent-1')).toBeNull()
  })

  it('rejects an unknown plugin without requesting a reload', async () => {
    installProcessFs(makeWritableFs())
    const out = await processUserInput(
      { input: '/plugins enable ghost', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: { enabled: [], disabled: [plugin('beta', false)], errors: [] },
      },
    )
    expect(out.action).toBeUndefined()
    expect(out.shouldQuery).toBe(false)
  })

  it('is a no-op when already in the requested state', async () => {
    installProcessFs(makeWritableFs())
    const out = await processUserInput(
      { input: '/plugins enable alpha', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: { enabled: [plugin('alpha', true)], disabled: [], errors: [] },
      },
    )
    expect(out.action).toBeUndefined()
  })
})

describe('processUserInput — a directory plugin is enabled by its folder', () => {
  const runtimeConfig3 = new BrowserRuntimeConfig()
  // `/plugins install <url>` names the folder after the URL; the manifest may
  // name the plugin otherwise (`compact-on-idle/` → `idle-compact`). The
  // loader matches the allowlist against FOLDERS.
  function renamed(enabled: boolean): ActivePlugin {
    return {
      name: 'idle-compact',
      manifest: { name: 'idle-compact' },
      path: '/w/.velloc/plugins/compact-on-idle',
      source: 'project:/w/.velloc/plugins/compact-on-idle',
      enabled,
    }
  }
  const run = (input: string, result: PluginScan, supported = 'plugins') =>
    processUserInput(
      { input, context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig: runtimeConfig3,
        supportedSlashCommands: [supported],
        pluginLoadResult: result,
        settingsHomeDir: '/home/user',
      },
    )

  it('enabling another plugin keeps it on the reload allowlist', async () => {
    installProcessFs(makeWritableFs())
    await saveEnabledPlugins('/w', ['compact-on-idle'])
    const out = await run('/plugins enable beta', {
      enabled: [renamed(true)],
      disabled: [plugin('beta', false)],
      errors: [],
    })
    expect(out.enabledPlugins).toEqual(['compact-on-idle', 'beta'])
    expect(out.enabledPlugins).not.toContain('idle-compact')
  })

  it('enabling and disabling it by its manifest name write its folder', async () => {
    installProcessFs(makeWritableFs())
    await saveEnabledPlugins('/w', ['alpha'])
    const enabled = await run('/plugins enable idle-compact', {
      enabled: [plugin('alpha', true)],
      disabled: [renamed(false)],
      errors: [],
    })
    expect(enabled.enabledPlugins).toContain('compact-on-idle')
    expect(await loadEnabledPlugins('/w')).toEqual(['alpha', 'compact-on-idle'])
    const disabled = await run('/plugins disable idle-compact', {
      enabled: [plugin('alpha', true), renamed(true)],
      disabled: [],
      errors: [],
    })
    expect(disabled.enabledPlugins).toEqual(['alpha'])
    expect(await loadEnabledPlugins('/w')).toEqual(['alpha'])
  })

  it('uninstalling it drops its folder and keeps what this boot did not discover', async () => {
    const fs = makeWritableFs()
    installProcessFs({ ...fs, async rm() {} } as RuntimeFs)
    await saveEnabledPlugins('/w', ['alpha', 'compact-on-idle', 'gamma'])
    const out = await run('/plugins uninstall idle-compact', {
      enabled: [plugin('alpha', true), renamed(true)],
      disabled: [],
      errors: [],
    })
    expect(out.enabledPlugins).toEqual(['alpha'])
    expect(await loadEnabledPlugins('/w')).toEqual(['alpha', 'gamma'])
  })

  it('a /plugin change reloads with it still enabled', async () => {
    wipeSettingsMemos()
    installProcessFs(makeWritableFs())
    const out = await run('/plugin disable cool@my-mkt', {
      enabled: [renamed(true)],
      disabled: [],
      errors: [],
    }, 'plugin')
    expect(out.action).toBe('reload-plugins')
    expect(out.enabledPlugins).toEqual(['compact-on-idle'])
  })
})

describe('processUserInput — /plugins enable|disable routing + patch', () => {
  const runtimeConfig2 = new BrowserRuntimeConfig()

  function marketplacePlugin(
    name: string,
    identifier: string,
    enabled: boolean,
  ): ActivePlugin {
    return {
      name,
      manifest: { name, description: `${name} desc` },
      path: `/install/${name}`,
      source: `marketplace:${identifier}`,
      enabled,
      installIdentifier: identifier,
    }
  }

  it('disabling a marketplace plugin flips the SETTINGS map, not the legacy store', async () => {
    wipeSettingsMemos()
    const files = new Map<string, string>()
    installProcessFs({
      ...unconfiguredFs,
      async mkdir() {},
      async writeFile(path: string, data: string | Uint8Array) {
        files.set(String(path).replace(/\\/g, '/'), String(data))
      },
      async readFile(path: string) {
        const v = files.get(String(path).replace(/\\/g, '/'))
        if (v === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return v
      },
    } as RuntimeFs)
    const result: PluginScan = {
      enabled: [marketplacePlugin('cool', 'cool@my-mkt', true)],
      disabled: [],
      errors: [],
    }
    const out = await processUserInput(
      { input: '/plugins disable cool', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig: runtimeConfig2,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: result,
        settingsHomeDir: '/home/user',
      },
    )
    expect(out.action).toBe('reload-plugins')
    // The settings map (NOT the legacy enabled-plugins.json) records the
    // explicit disable, keyed by the FULL identifier.
    const settingsRaw = [...files.entries()].find(([k]) =>
      k.endsWith('settings.json'),
    )?.[1]
    expect(settingsRaw).toBeDefined()
    expect(JSON.parse(settingsRaw!).enabledPlugins['cool@my-mkt']).toBe(false)
    // The legacy store must NOT have been written for a marketplace plugin.
    expect(await loadEnabledPlugins('/w')).toBeNull()
  })

  it('toggling one legacy plugin PRESERVES an undiscovered plugin in the store', async () => {
    installProcessFs(makeWritableFs())
    // Prior session enabled both alpha and gamma; gamma is NOT discovered now.
    await saveEnabledPlugins('/w', ['alpha', 'gamma'])
    const result: PluginScan = {
      enabled: [plugin('alpha', true)],
      disabled: [plugin('beta', false)],
      errors: [],
    }
    const out = await processUserInput(
      { input: '/plugins enable beta', context: makeContext() },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig: runtimeConfig2,
        supportedSlashCommands: ['plugins'],
        pluginLoadResult: result,
      },
    )
    expect(out.action).toBe('reload-plugins')
    // gamma (undiscovered this boot) survives the patch; beta is added.
    const persisted = await loadEnabledPlugins('/w')
    expect(persisted).toContain('gamma')
    expect(persisted).toContain('alpha')
    expect(persisted).toContain('beta')
  })

  it('singular /plugin mutating subcommand emits a live reload; /plugin list does not', async () => {
    wipeSettingsMemos()
    installProcessFs(makeWritableFs())
    const base = {
      hostBridge: stubHostBridge(),
      runtimeConfig: runtimeConfig2,
      supportedSlashCommands: ['plugin'],
      settingsHomeDir: '/home/user',
    }
    // A mutating subcommand reloads (the marketplace state changed on disk);
    // detection is by the leading verb, so it fires even if the op reports an
    // error — onReloadPlugins re-reads disk state idempotently.
    const disabled = await processUserInput(
      { input: '/plugin disable cool@my-mkt', context: makeContext() },
      base,
    )
    expect(disabled.action).toBe('reload-plugins')
    // A read-only subcommand must NOT trigger a reload.
    const listed = await processUserInput(
      { input: '/plugin list', context: makeContext() },
      base,
    )
    expect(listed.action).toBeUndefined()
  })
})
