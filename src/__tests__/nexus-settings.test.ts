import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  NEXUS_SETTINGS_FILE_NAME,
  NEXUS_SETTINGS_VERSION,
  readLayer,
  readUserLayer,
  loadSettingsDoc,
  wipeSettingsMemos,
  resolveSettingsHomeDir,
  writeUserLayer,
  updateFeatures,
  updateSessionModelSettings,
} from '../settings/settingsStore'

// Reset the in-memory cache between every test — settings cache state
// is module-global so tests would leak through it otherwise.
beforeEach(() => {
  wipeSettingsMemos()
})

/** Minimal in-memory fs implementation — covers what nexusSettings needs:
 *  readFile, writeFile, mkdir. Other methods throw on accident. */
function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    }),
    writeFile: vi.fn(
      async (path: string, data: string | Uint8Array) => {
        files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
      },
    ),
    mkdir: vi.fn(async (path: string) => {
      dirs.add(path)
    }),
  }
  return { fs: fs as RuntimeFs, files, dirs }
}

describe('readUserLayer', () => {
  it('returns defaults when the file does not exist (no warning, no write)', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await readUserLayer('/home/user', fs)
    expect(result.source).toBe('default')
    expect(result.settings.version).toBe(NEXUS_SETTINGS_VERSION)
    expect(result.settings.features).toBeUndefined()
    // No write side effect on a missing-file load.
    expect(files.size).toBe(0)
  })

  it('parses a valid v1 file', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a': true, 'b': false },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.source).toBe('file')
    expect(result.settings.features).toEqual({ a: true, b: false })
  })

  it('drops non-boolean / non-string keys when normalising', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: {
          'good.entry': true,
          'string.value': 'yes', // dropped — not a boolean
          '': true, // dropped — empty key
          'numeric.value': 1, // dropped — not a boolean
        },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.features).toEqual({ 'good.entry': true })
  })

  it('returns defaults + warns on malformed JSON (does NOT overwrite)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fs, files } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: '{ not valid json',
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.source).toBe('default')
    expect(warn).toHaveBeenCalled()
    // The garbage file is left untouched so the user can fix or delete it.
    expect(files.get(`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)).toBe(
      '{ not valid json',
    )
    warn.mockRestore()
  })

  it('refuses to load a newer-version file (returns defaults, does NOT overwrite)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fs, files } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 2,
        features: { 'a': true },
        futureSection: { foo: 'bar' },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.source).toBe('default')
    expect(warn).toHaveBeenCalled()
    // The future-version file is preserved verbatim — a newer build can
    // still read it.
    expect(JSON.parse(files.get(`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!))
      .toEqual({
        version: 2,
        features: { a: true },
        futureSection: { foo: 'bar' },
      })
    warn.mockRestore()
  })
})

describe('readUserLayer — agent.productNameOverride normalization', () => {
  const PATH = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

  it('keeps a non-empty override (trimmed)', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        agent: { productNameOverride: '  Velloc abc  ' },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.agent?.productNameOverride).toBe('Velloc abc')
  })

  it('drops blank / non-string values (blank means "cleared")', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        agent: { productNameOverride: '   ', log: true },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.agent?.productNameOverride).toBeUndefined()
    expect(result.settings.agent?.log).toBe(true)
  })
})

describe('readUserLayer — mods section', () => {
  const PATH = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

  it('keeps mods.headless (a boolean, false included)', async () => {
    for (const headless of [true, false]) {
      wipeSettingsMemos()
      const { fs } = makeMemoryFs({ [PATH]: JSON.stringify({ version: 1, mods: { headless } }) })
      const result = await readUserLayer('/home/user', fs)
      expect(result.settings.mods).toEqual({ headless })
    }
  })

  it('drops a non-boolean headless and the section with it', async () => {
    const { fs } = makeMemoryFs({ [PATH]: JSON.stringify({ version: 1, mods: { headless: 'yes' } }) })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.mods).toBeUndefined()
  })
})

describe('readUserLayer — catalog section', () => {
  const PATH = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

  it('keeps an http(s) catalog.sourceUrl', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({ version: 1, catalog: { sourceUrl: 'http://127.0.0.1:9/api.json' } }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.catalog).toEqual({ sourceUrl: 'http://127.0.0.1:9/api.json' })
  })

  it('drops a non-http or non-string sourceUrl and the section with it', async () => {
    for (const sourceUrl of ['file:///etc/passwd', 'models.dev', 5, '']) {
      wipeSettingsMemos()
      const { fs } = makeMemoryFs({ [PATH]: JSON.stringify({ version: 1, catalog: { sourceUrl } }) })
      const result = await readUserLayer('/home/user', fs)
      expect(result.settings.catalog).toBeUndefined()
    }
  })
})

describe('readUserLayer — agent.internalUser normalization', () => {
  const PATH = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

  it('keeps a literal true', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        agent: { internalUser: true },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.agent?.internalUser).toBe(true)
  })

  it('normalizes false and non-boolean values to the absent-means-external default', async () => {
    // Sparse-key contract: only `true` is ever stored; a hand-edited `false`
    // or garbage value reads back as absent (external), keeping siblings.
    for (const bad of [false, 'true', 1, null]) {
      const { fs } = makeMemoryFs({
        [PATH]: JSON.stringify({
          version: 1,
          agent: { internalUser: bad, log: true },
        }),
      })
      const result = await readUserLayer('/home/user', fs)
      expect(result.settings.agent?.internalUser).toBeUndefined()
      expect(result.settings.agent?.log).toBe(true)
    }
  })
})

describe('readUserLayer — flat auto-memory key normalization', () => {
  const PATH = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

  it('keeps boolean toggles + a non-empty directory', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        autoMemoryEnabled: false,
        memoryRecallEnabled: true,
        memoryMaintenance: 'dailyLog',
        autoExtractEnabled: true,
        autoMemoryDirectory: '/var/mem',
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.autoMemoryEnabled).toBe(false)
    expect(result.settings.memoryRecallEnabled).toBe(true)
    expect(result.settings.memoryMaintenance).toBe('dailyLog')
    expect(result.settings.autoExtractEnabled).toBe(true)
    expect(result.settings.autoMemoryDirectory).toBe('/var/mem')
  })

  it('preserves an explicit false (memory off is a real override)', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({ version: 1, autoMemoryEnabled: false }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.autoMemoryEnabled).toBe(false)
  })

  it('drops non-boolean toggles + an empty directory', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        autoMemoryEnabled: 'yes', // dropped — not a boolean
        memoryRecallEnabled: 1, // dropped — not a boolean
        autoMemoryDirectory: '', // dropped — empty
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.autoMemoryEnabled).toBeUndefined()
    expect(result.settings.memoryRecallEnabled).toBeUndefined()
    expect(result.settings.autoMemoryDirectory).toBeUndefined()
  })
})

// Regression: the real FS bridge surfaces host errors as
// `new Error("FS_ERROR: <message>")` with no `code` property — NOT the
// Node-style `{ code: 'ENOENT' }` the in-memory mock above produces.
// Before the host fix, a missing file came back as
// "FS_ERROR: Failed to read file", which isMissingFileError() did not
// recognize, so a fresh install logged a spurious warning. These tests
// pin the contract against the actual bridge wire shape.
describe('readUserLayer — sub-session model routing normalization', () => {
  const PATH = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

  it('keeps valid tier pins + policies and round-trips an explicit default mode', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        modelTiers: {
          fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
          best: {
            providerId: 'anthropic',
            modelId: 'claude-fable-5',
            thinkingTier: 'max',
          },
        },
        sessionModelPolicy: {
          compact: { mode: 'specific', providerId: 'openai', modelId: 'gpt-5.4-mini' },
          memory_recall: { mode: 'tier', tier: 'fast' },
          session_title: { mode: 'same-as-parent' },
          memory_extract: { mode: 'default' },
        },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.modelTiers).toEqual({
      fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      best: {
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        thinkingTier: 'max',
      },
    })
    expect(result.settings.sessionModelPolicy).toEqual({
      compact: { mode: 'specific', providerId: 'openai', modelId: 'gpt-5.4-mini' },
      memory_recall: { mode: 'tier', tier: 'fast' },
      session_title: { mode: 'same-as-parent' },
      // An explicit user reset survives (like explicit false booleans do).
      memory_extract: { mode: 'default' },
    })
  })

  it('drops invalid slots/kinds/modes without poisoning the valid rest', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        modelTiers: {
          fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
          turbo: { providerId: 'x', modelId: 'y' }, // unknown slot
          balanced: { providerId: '', modelId: 'y' }, // empty providerId
          best: { providerId: 'x' }, // missing modelId
        },
        sessionModelPolicy: {
          compact: { mode: 'tier', tier: 'hyper' }, // unknown tier
          web_fetch: { mode: 'specific', providerId: 'openai' }, // missing modelId
          session_title: { mode: 'pin-it' }, // unknown mode
          bash_analysis: { mode: 'same-as-parent' }, // unknown kind
          prompt_hook: { mode: 'same-as-parent' }, // valid — must survive
        },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.modelTiers).toEqual({
      fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    })
    expect(result.settings.sessionModelPolicy).toEqual({
      prompt_hook: { mode: 'same-as-parent' },
    })
  })

  it('strips sections entirely when nothing valid survives (sparse on disk)', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        modelTiers: { turbo: { providerId: 'x', modelId: 'y' } },
        sessionModelPolicy: 'not-an-object',
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.modelTiers).toBeUndefined()
    expect(result.settings.sessionModelPolicy).toBeUndefined()
  })

  it('updateSessionModelSettings merges, clears with null, and no-ops on no change', async () => {
    const { fs, files } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        modelTiers: {
          fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        },
        sessionModelPolicy: { compact: { mode: 'same-as-parent' } },
      }),
    })
    // Merge: add a pin, reroute a kind, clear the existing compact policy.
    const next = await updateSessionModelSettings('/home/user', fs, {
      modelTiers: {
        best: { providerId: 'anthropic', modelId: 'claude-fable-5' },
      },
      sessionModelPolicy: {
        compact: null,
        session_title: { mode: 'tier', tier: 'balanced' },
      },
    })
    expect(next.modelTiers).toEqual({
      fast: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      best: { providerId: 'anthropic', modelId: 'claude-fable-5' },
    })
    expect(next.sessionModelPolicy).toEqual({
      session_title: { mode: 'tier', tier: 'balanced' },
    })
    // Clearing the last entries deletes the sections from disk (sparse).
    wipeSettingsMemos()
    const cleared = await updateSessionModelSettings('/home/user', fs, {
      modelTiers: { fast: null, best: null },
      sessionModelPolicy: { session_title: null },
    })
    expect(cleared.modelTiers).toBeUndefined()
    expect(cleared.sessionModelPolicy).toBeUndefined()
    const onDisk = JSON.parse(files.get(PATH) ?? '{}') as Record<string, unknown>
    expect('modelTiers' in onDisk).toBe(false)
    expect('sessionModelPolicy' in onDisk).toBe(false)
    // No-op patch → no write (same contract as updateMemorySettings).
    wipeSettingsMemos()
    const writes = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.length
    await updateSessionModelSettings('/home/user', fs, {})
    expect((fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writes)
  })
})

describe('readUserLayer — FS bridge error shapes', () => {
  function makeRejectingFs(message: string) {
    const fs: Partial<RuntimeFs> = {
      // No `code` — matches BrowserHostBridge's `${code}: ${message}` throw.
      readFile: vi.fn(async () => {
        throw new Error(message)
      }),
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
    }
    return fs as RuntimeFs
  }

  it('treats a missing-file bridge error (ENOENT wording) as defaults — no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fs = makeRejectingFs('FS_ERROR: ENOENT: no such file or directory')
    const result = await readUserLayer('/home/user', fs)
    expect(result.source).toBe('default')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns on a genuine read error (present but unreadable)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fs = makeRejectingFs('FS_ERROR: Failed to read file')
    const result = await readUserLayer('/home/user', fs)
    expect(result.source).toBe('default')
    // A real read failure is NOT silenced — the user still sees it.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('readUserLayer — hooks section', () => {
  it('parses a settings.json hooks block into settings.hooks', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
          ],
        },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.hooks).toEqual({
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
      ],
    })
  })

  it('drops invalid hook entries and omits the section when nothing survives', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        hooks: {
          // Not a real hook event → dropped wholesale.
          NotAnEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
          // Command hook missing `command` → the hook is dropped, leaving the
          // matcher empty → the matcher is dropped → the event has no valid
          // matchers → the whole hooks section is omitted.
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' }] }],
        },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.hooks).toBeUndefined()
  })
})

describe('readUserLayer — permissions section', () => {
  it('parses allow/deny/ask, defaultMode, additionalDirectories and the bypass killswitch', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        permissions: {
          allow: ['Bash(npm test:*)'],
          deny: ['Bash(rm:*)'],
          ask: ['Write'],
          defaultMode: 'acceptEdits',
          additionalDirectories: ['D:/shared', ''],
          disableBypassPermissionsMode: 'disable',
        },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(result.settings.permissions).toEqual({
      allow: ['Bash(npm test:*)'],
      deny: ['Bash(rm:*)'],
      ask: ['Write'],
      defaultMode: 'acceptEdits',
      // Empty entries are dropped.
      additionalDirectories: ['D:/shared'],
      disableBypassPermissionsMode: 'disable',
    })
  })

  it('ignores a non-"disable" killswitch value (only the literal counts)', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        permissions: { deny: ['Bash'], disableBypassPermissionsMode: true },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    expect(
      result.settings.permissions?.disableBypassPermissionsMode,
    ).toBeUndefined()
  })
})

describe('writeUserLayer', () => {
  it('ensures the .velloc directory exists then writes the file', async () => {
    const { fs, files, dirs } = makeMemoryFs()
    await writeUserLayer('/home/user', fs, {
      version: 1,
      features: { 'a': true },
    })
    expect(dirs.has('/home/user/.velloc')).toBe(true)
    const written = files.get(`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)
    expect(written).toBeDefined()
    expect(JSON.parse(written!)).toEqual({
      version: 1,
      features: { a: true },
    })
    // Pretty-printed with trailing newline (so the file diffs cleanly).
    expect(written!.endsWith('\n')).toBe(true)
    expect(written).toContain('\n  ') // 2-space indent
  })
})

describe('resolveSettingsHomeDir', () => {
  function fakeRuntimeConfig(env: Record<string, string>): RuntimeConfig {
    return {
      getEnv: (name: string) => env[name],
    } as never as RuntimeConfig
  }

  it('returns HOME on POSIX', () => {
    const cfg = fakeRuntimeConfig({ HOME: '/home/alice' })
    expect(resolveSettingsHomeDir(cfg)).toBe('/home/alice')
  })

  it('falls back to USERPROFILE on Windows when HOME is unset', () => {
    const cfg = fakeRuntimeConfig({ USERPROFILE: 'C:\\Users\\alice' })
    expect(resolveSettingsHomeDir(cfg)).toBe('C:\\Users\\alice')
  })

  it('prefers HOME over USERPROFILE when both are set', () => {
    const cfg = fakeRuntimeConfig({
      HOME: '/home/alice',
      USERPROFILE: 'C:\\Users\\alice',
    })
    expect(resolveSettingsHomeDir(cfg)).toBe('/home/alice')
  })

  it('throws when neither HOME nor USERPROFILE is set', () => {
    const cfg = fakeRuntimeConfig({})
    expect(() => resolveSettingsHomeDir(cfg)).toThrow(
      /HOME \/ USERPROFILE not set/,
    )
  })
})

describe('updateFeatures', () => {
  it('applies an updater and writes the result', async () => {
    const { fs, files } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a': true },
      }),
    })
    const after = await updateFeatures('/home/user', fs, prev => ({
      ...prev,
      b: false,
    }))
    expect(after.features).toEqual({ a: true, b: false })
    expect(
      JSON.parse(files.get(`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!),
    ).toEqual({ version: 1, features: { a: true, b: false } })
  })

  it('is a no-op when the updater returns an equivalent map (no write)', async () => {
    const { fs, files } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a': true },
      }),
    })
    const writeSpy = fs.writeFile as ReturnType<typeof vi.fn>
    writeSpy.mockClear()
    await updateFeatures('/home/user', fs, prev => ({ ...prev }))
    expect(writeSpy).not.toHaveBeenCalled()
    // File on disk unchanged.
    expect(
      JSON.parse(files.get(`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!),
    ).toEqual({ version: 1, features: { a: true } })
  })

  it('starts from an empty map when no file exists', async () => {
    const { fs } = makeMemoryFs()
    const after = await updateFeatures('/home/user', fs, prev => ({
      ...prev,
      'first.entry': true,
    }))
    expect(after.features).toEqual({ 'first.entry': true })
  })

  // Regression: the hand-rolled `updateFeaturesInSource` body used to build
  // `{version, features}` from scratch and write that, wiping every other
  // section. A provider configured in Settings → Models vanished the moment
  // any feature flag toggled — `TeamProviders` then reported "No providers
  // are configured." Now it delegates to `updateSectionInSource`, which
  // preserves every other section verbatim.
  it('preserves other sections (providers, mcp, agent…) across the write', async () => {
    const { fs, files } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'existing.flag': true },
        providers: {
          activeProviderId: 'anthropic',
          configs: {
            anthropic: { model: 'claude-opus-4-5', enabledModels: ['claude-opus-4-5'] },
          },
        },
        mcp: { servers: { filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] } } },
      }),
    })

    await updateFeatures('/home/user', fs, prev => ({ ...prev, 'new.flag': false }))

    const onDisk = JSON.parse(files.get(`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!)
    expect(onDisk.features).toEqual({ 'existing.flag': true, 'new.flag': false })
    // The two sections must survive verbatim.
    expect(onDisk.providers).toEqual({
      activeProviderId: 'anthropic',
      configs: {
        anthropic: { model: 'claude-opus-4-5', enabledModels: ['claude-opus-4-5'] },
      },
    })
    expect(onDisk.mcp).toEqual({
      servers: { filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] } },
    })
  })
})

describe('cache behavior', () => {
  // The per-source cache is keyed by (source, resolved path). Source alone is
  // NOT enough: one SharedWorker realm hosts several sessions, and
  // `projectSettings` resolves to a different file per bound project root — so
  // a source-only key let project F1's rules leak into a session bound to F2
  // (and into the same session across `reinitWithProjectRoot`, which is how a
  // folder binding takes effect).
  it('does not leak one project root\'s settings into another', async () => {
    const { fs } = makeMemoryFs({
      [`/proj/f1/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        permissions: { deny: ['Bash(rm:*)'] },
      }),
      [`/proj/f2/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        permissions: { deny: ['Write'] },
      }),
    })

    const f1 = await readLayer(
      'projectSettings',
      { homeDir: '/home/user', projectRoot: '/proj/f1' },
      fs,
    )
    const f2 = await readLayer(
      'projectSettings',
      { homeDir: '/home/user', projectRoot: '/proj/f2' },
      fs,
    )

    expect(f1.settings.permissions?.deny).toEqual(['Bash(rm:*)'])
    expect(f2.settings.permissions?.deny, 'F2 must not read F1\'s cached entry')
      .toEqual(['Write'])
  })

  it('still serves a repeat read of the SAME source+path from cache', async () => {
    const { fs } = makeMemoryFs({
      [`/proj/f1/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        permissions: { deny: ['Bash'] },
      }),
    })
    const readSpy = fs.readFile as ReturnType<typeof vi.fn>
    const ctx = { homeDir: '/home/user', projectRoot: '/proj/f1' }
    await readLayer('projectSettings', ctx, fs)
    await readLayer('projectSettings', ctx, fs)
    expect(readSpy).toHaveBeenCalledTimes(1)
  })

  it('serves repeated readUserLayer from cache after the first disk read', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'cached.entry': true },
      }),
    })
    const readSpy = fs.readFile as ReturnType<typeof vi.fn>

    const first = await readUserLayer('/home/user', fs)
    const second = await readUserLayer('/home/user', fs)
    const third = await readUserLayer('/home/user', fs)

    expect(first.settings.features).toEqual({ 'cached.entry': true })
    expect(second.settings.features).toEqual({ 'cached.entry': true })
    expect(third.settings.features).toEqual({ 'cached.entry': true })
    // Three reads, one disk hit: the per-source cache serves the repeats.
    expect(readSpy).toHaveBeenCalledTimes(1)
  })

  it('caches the "default" result for a missing file (does NOT retry on every read)', async () => {
    const { fs } = makeMemoryFs() // no file present
    const readSpy = fs.readFile as ReturnType<typeof vi.fn>

    const first = await readUserLayer('/home/user', fs)
    const second = await readUserLayer('/home/user', fs)

    expect(first.source).toBe('default')
    expect(second.source).toBe('default')
    // ENOENT shouldn't trigger a re-read either — the cache stores the
    // fallback so we don't pay the disk round-trip per call.
    expect(readSpy).toHaveBeenCalledTimes(1)
  })

  // A read that FAILED says nothing about the file. At boot a reader running
  // before the process fs adapter is installed gets "readFile is not
  // configured", and caching that as defaults hid `providers.order` from the
  // shell's one boot read — the quick picker ignored the stored order until
  // the user reordered again.
  it('does NOT cache a failed read: the next reader, with a working fs, reads the file', async () => {
    const path = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
    const { fs } = makeMemoryFs({
      [path]: JSON.stringify({
        version: 1,
        providers: { configs: {}, order: ['anthropic', 'openai'] },
      }),
    })
    const unconfigured = {
      ...fs,
      readFile: vi.fn(async () => {
        throw new Error(
          'RuntimeFs method "readFile" is not configured in chromium-runtime.',
        )
      }),
    } as RuntimeFs
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const early = await readUserLayer('/home/user', unconfigured)
      expect(early.source).toBe('default')
      const earlyParsed = await loadSettingsDoc(path, unconfigured)
      expect(earlyParsed.source).toBe('default')
    } finally {
      warn.mockRestore()
    }

    const later = await readUserLayer('/home/user', fs)
    expect(later.source).toBe('file')
    expect(later.settings.providers?.order).toEqual(['anthropic', 'openai'])
    expect((await loadSettingsDoc(path, fs)).source).toBe('file')
  })

  it('writeUserLayer invalidates the cache so the next load reflects the write', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'before': true },
      }),
    })
    const readSpy = fs.readFile as ReturnType<typeof vi.fn>

    const before = await readUserLayer('/home/user', fs)
    expect(before.settings.features).toEqual({ 'before': true })
    expect(readSpy).toHaveBeenCalledTimes(1)

    await writeUserLayer('/home/user', fs, {
      version: 1,
      features: { 'after': true },
    })

    // Post-write load must NOT see the stale cache entry.
    const after = await readUserLayer('/home/user', fs)
    expect(after.settings.features).toEqual({ 'after': true })
    // Second read happened because the write invalidated the cache.
    expect(readSpy).toHaveBeenCalledTimes(2)
  })

  it('updateFeatures invalidates the cache (read-modify-write surfaces fresh on next load)', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a': true },
      }),
    })
    const readSpy = fs.readFile as ReturnType<typeof vi.fn>

    // Warm the cache.
    await readUserLayer('/home/user', fs)
    expect(readSpy).toHaveBeenCalledTimes(1)

    await updateFeatures('/home/user', fs, prev => ({ ...prev, b: false }))

    const after = await readUserLayer('/home/user', fs)
    expect(after.settings.features).toEqual({ a: true, b: false })
    // Read count: 1 initial readUserLayer + 1 uncached read inside
    // updateFeatures + 1 fresh re-read after the post-write invalidation
    // = 3 total. The write path correctly clears both caches.
    expect(readSpy).toHaveBeenCalledTimes(3)
  })

  it('mutating a returned settings object does NOT poison the cache', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a': true },
      }),
    })

    const first = await readUserLayer('/home/user', fs)
    expect(first.settings.features).toEqual({ a: true })

    // Tamper with the returned object — should not leak into the cache.
    first.settings.features!['injected'] = true

    const second = await readUserLayer('/home/user', fs)
    expect(second.settings.features).toEqual({ a: true })
    expect(second.settings.features).not.toHaveProperty('injected')
  })

  it('wipeSettingsMemos forces the next read to hit disk again', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a': true },
      }),
    })
    const readSpy = fs.readFile as ReturnType<typeof vi.fn>

    await readUserLayer('/home/user', fs)
    await readUserLayer('/home/user', fs)
    expect(readSpy).toHaveBeenCalledTimes(1)

    wipeSettingsMemos()

    await readUserLayer('/home/user', fs)
    expect(readSpy).toHaveBeenCalledTimes(2)
  })

  it('loadSettingsDoc is independently cached by path', async () => {
    const { fs } = makeMemoryFs({
      [`/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`]: JSON.stringify({
        version: 1,
        features: { 'a': true },
      }),
    })
    const readSpy = fs.readFile as ReturnType<typeof vi.fn>

    const path = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
    await loadSettingsDoc(path, fs)
    await loadSettingsDoc(path, fs)
    await loadSettingsDoc(path, fs)

    // Three calls, one disk hit: the path-keyed cache serves the repeats.
    expect(readSpy).toHaveBeenCalledTimes(1)
  })
})

describe('readUserLayer — providers.configs.documentInput', () => {
  const PATH = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

  it('keeps the three known modes and drops anything else', async () => {
    const { fs } = makeMemoryFs({
      [PATH]: JSON.stringify({
        version: 1,
        providers: {
          configs: {
            openai: { baseUrl: 'https://relay.example.test/v1', documentInput: 'native' },
            kimi: { apiKey: 'k', documentInput: 'none' },
            glm: { apiKey: 'k', documentInput: 'pdf' },
          },
        },
      }),
    })
    const result = await readUserLayer('/home/user', fs)
    const configs = result.settings.providers?.configs
    expect(configs?.openai?.documentInput).toBe('native')
    expect(configs?.kimi?.documentInput).toBe('none')
    expect(configs?.glm?.documentInput).toBeUndefined()
    expect(configs?.glm?.apiKey).toBe('k')
  })
})
