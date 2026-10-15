import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  NEXUS_LOCAL_SETTINGS_FILE_NAME,
  NEXUS_SETTINGS_FILE_NAME,
  NEXUS_SETTINGS_VERSION,
  loadEffectiveSettings,
  mergeSettingsSources,
  wipeSettingsMemos,
  layerMergeRule,
  updateSectionInSource,
} from '../settings/settingsStore'

/**
 * Generic-section updater regressions. The features migration uses
 * `updateFeaturesInSource`; the about-page migration introduces a
 * single generic helper (`updateSectionInSource<K>`) that every later
 * section migration delegates to. These tests pin the helper's
 * semantics so a refactor that breaks the contract trips loudly.
 */

function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
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
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

beforeEach(() => {
  wipeSettingsMemos()
})

describe('updateSectionInSource', () => {
  it('writes a new section into an empty settings file', async () => {
    const { fs, files } = makeMemoryFs()

    const result = await updateSectionInSource(
      'userSettings',
      { homeDir: HOME },
      fs,
      'agent',
      () => ({ log: true, trace: false }),
    )

    expect(result.agent).toEqual({ log: true, trace: false })
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      agent: { log: true, trace: false },
    })
  })

  it('preserves other top-level sections when writing one', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        features: { 'bundled-skills.simplify': false },
      }),
    })

    const result = await updateSectionInSource(
      'userSettings',
      { homeDir: HOME },
      fs,
      'agent',
      () => ({ log: true }),
    )

    expect(result.features).toEqual({ 'bundled-skills.simplify': false })
    expect(result.agent).toEqual({ log: true })
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      features: { 'bundled-skills.simplify': false },
      agent: { log: true },
    })
  })

  it('no-ops the write when the updater returns an equivalent value', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        agent: { log: true },
      }),
    })
    const writeSpy = fs.writeFile as ReturnType<typeof vi.fn>
    writeSpy.mockClear()

    await updateSectionInSource(
      'userSettings',
      { homeDir: HOME },
      fs,
      'agent',
      prev => ({ ...prev }),
    )
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('returning undefined from the updater clears the section', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        features: { a: true },
        agent: { log: true, trace: true },
      }),
    })

    const result = await updateSectionInSource(
      'userSettings',
      { homeDir: HOME },
      fs,
      'agent',
      () => undefined,
    )

    expect(result.agent).toBeUndefined()
    // Other sections survive.
    expect(result.features).toEqual({ a: true })
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      features: { a: true },
    })
  })

  it('updater sees undefined when the section is absent', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        features: { a: true },
      }),
    })

    const captured: Array<unknown> = []
    await updateSectionInSource(
      'userSettings',
      { homeDir: HOME },
      fs,
      'agent',
      prev => {
        captured.push(prev)
        return { log: true }
      },
    )
    expect(captured).toEqual([undefined])
  })

  it("refuses to mutate the 'version' field", async () => {
    const { fs } = makeMemoryFs()
    // `'version'` IS structurally a `keyof NexusSettingsV1` so TS allows
    // the call at the type level; the runtime guard in
    // `updateSectionInSource` is what enforces the rule.
    await expect(
      updateSectionInSource(
        'userSettings',
        { homeDir: HOME },
        fs,
        'version',
        () => 2 as never,
      ),
    ).rejects.toThrow(/version/i)
  })

  it('does not invalidate the cache when no write happens', async () => {
    // Ensures the no-op path stays cheap on the read side as well — a
    // bug that fired wipeSettingsMemos() on every call would silently
    // tank performance under repeated polling.
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        agent: { log: true },
      }),
    })

    // First read populates BOTH the per-source cache (via readUserLayer)
    // AND the parse-file cache (the underlying loadSettingsDoc call).
    const { readUserLayer } = await import('../settings/settingsStore')
    await readUserLayer(HOME, fs)
    const readSpy = fs.readFile as ReturnType<typeof vi.fn>
    expect(readSpy).toHaveBeenCalledTimes(1)

    // No-op updater — no write means no cache invalidation. The
    // update path uses readLayerFresh, which deliberately
    // bypasses the settings caches for the read leg. No write means no
    // invalidation, so the following readUserLayer call still reuses the
    // already-populated per-source cache. Net new disk reads: 1.
    await updateSectionInSource(
      'userSettings',
      { homeDir: HOME },
      fs,
      'agent',
      prev => ({ ...prev }),
    )
    await readUserLayer(HOME, fs)
    expect(readSpy).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Source hierarchy + merge: loadEffectiveSettings + mergeSettingsSources +
// layerMergeRule. The multi-source merge has precedence user <
// project < local; arrays concat+dedupe (by reference identity), objects
// deep-merge, scalars last-wins.
// ---------------------------------------------------------------------------
describe('settings source hierarchy + merge', () => {
  const PROJ = '/proj/root'
  const USER_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
  const PROJECT_PATH = `${PROJ}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
  const LOCAL_PATH = `${PROJ}/.velloc/${NEXUS_LOCAL_SETTINGS_FILE_NAME}`
  const json = (obj: Record<string, unknown>) =>
    JSON.stringify({ version: NEXUS_SETTINGS_VERSION, ...obj })

  describe('layerMergeRule (array dedup by identity)', () => {
    it('concatenates and Set-dedupes scalar arrays', () => {
      expect(layerMergeRule([1, 2], [2, 3])).toEqual([1, 2, 3])
    })
    it('returns undefined for non-array pairs (falls through to deep/last-wins)', () => {
      expect(layerMergeRule('a', 'b')).toBeUndefined()
      expect(layerMergeRule({ a: 1 }, { b: 2 })).toBeUndefined()
    })
    it('keeps distinct object references from different sources (no value-dedup)', () => {
      // Dedup is by identity, not deep value — two equal-but-distinct objects
      // both survive; the same reference collapses.
      const distinct = layerMergeRule([{ a: 1 }], [{ a: 1 }]) as unknown[]
      expect(distinct).toHaveLength(2)
      const shared = { a: 1 }
      const same = layerMergeRule([shared], [shared]) as unknown[]
      expect(same).toHaveLength(1)
    })
  })

  describe('mergeSettingsSources', () => {
    it('scalar last-wins (later source overrides)', () => {
      const merged = mergeSettingsSources([
        { version: NEXUS_SETTINGS_VERSION, agent: { maxTurns: 5 } },
        { version: NEXUS_SETTINGS_VERSION, agent: { maxTurns: 10 } },
      ])
      expect(merged.agent?.maxTurns).toBe(10)
    })
    it('deep-merges objects by key and overrides per-key', () => {
      const merged = mergeSettingsSources([
        { version: NEXUS_SETTINGS_VERSION, features: { x: true } },
        { version: NEXUS_SETTINGS_VERSION, features: { y: true } },
      ])
      expect(merged.features).toEqual({ x: true, y: true })
      const overridden = mergeSettingsSources([
        { version: NEXUS_SETTINGS_VERSION, features: { x: true } },
        { version: NEXUS_SETTINGS_VERSION, features: { x: false } },
      ])
      expect(overridden.features?.x).toBe(false)
    })
    it('precedence chain — highest (last) source wins', () => {
      const merged = mergeSettingsSources([
        { version: NEXUS_SETTINGS_VERSION, agent: { maxTurns: 5 } }, // user
        { version: NEXUS_SETTINGS_VERSION, agent: { maxTurns: 10 } }, // project
        { version: NEXUS_SETTINGS_VERSION, agent: { maxTurns: 20 } }, // local
      ])
      expect(merged.agent?.maxTurns).toBe(20)
    })
    it('always force-sets the build version', () => {
      const merged = mergeSettingsSources([
        { version: 999 as never, features: { a: true } },
      ])
      expect(merged.version).toBe(NEXUS_SETTINGS_VERSION)
    })
  })

  describe('loadEffectiveSettings', () => {
    it('merges user + project + local by precedence and lists file-backed sources', async () => {
      const { fs, files } = makeMemoryFs({
        [USER_PATH]: json({ features: { u: true }, agent: { maxTurns: 5 } }),
        [PROJECT_PATH]: json({ features: { p: true }, agent: { maxTurns: 10 } }),
        [LOCAL_PATH]: json({ features: { l: true }, agent: { maxTurns: 20 } }),
      })
      const { settings, sources } = await loadEffectiveSettings(
        { homeDir: HOME, projectRoot: PROJ },
        fs,
      )
      expect(settings.features).toEqual({ u: true, p: true, l: true })
      expect(settings.agent?.maxTurns).toBe(20) // local wins
      expect(sources).toEqual(['userSettings', 'projectSettings', 'localSettings'])
      // One read per distinct path (per-path parse cache).
      expect((fs.readFile as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3)
      expect(files.size).toBe(3)
    })

    it('is robust when project/local files are absent (user-only result)', async () => {
      const { fs } = makeMemoryFs({
        [USER_PATH]: json({ features: { u: true } }),
      })
      const { settings, sources } = await loadEffectiveSettings(
        { homeDir: HOME, projectRoot: PROJ },
        fs,
      )
      expect(settings.features).toEqual({ u: true })
      expect(sources).toEqual(['userSettings'])
    })

    it('normalizes + merges the outputStyle scalar (project overrides user)', async () => {
      const { fs } = makeMemoryFs({
        [USER_PATH]: json({ outputStyle: 'Explanatory' }),
        [PROJECT_PATH]: json({ outputStyle: 'Learning' }),
      })
      const { settings } = await loadEffectiveSettings(
        { homeDir: HOME, projectRoot: PROJ },
        fs,
      )
      expect(settings.outputStyle).toBe('Learning') // project wins
    })

    it('normalizes + concatenates permission rule lists across sources', async () => {
      const { fs } = makeMemoryFs({
        [USER_PATH]: json({
          permissions: { allow: ['Read'], deny: ['Bash(rm:*)'], defaultMode: 'default' },
        }),
        [PROJECT_PATH]: json({
          permissions: { allow: ['Glob'], ask: ['Bash(git push:*)'], defaultMode: 'acceptEdits' },
        }),
      })
      const { settings } = await loadEffectiveSettings(
        { homeDir: HOME, projectRoot: PROJ },
        fs,
      )
      // allow lists concat across user + project (array merge).
      expect(settings.permissions?.allow?.sort()).toEqual(['Glob', 'Read'])
      expect(settings.permissions?.deny).toEqual(['Bash(rm:*)'])
      expect(settings.permissions?.ask).toEqual(['Bash(git push:*)'])
      // defaultMode is a scalar → project (higher precedence) wins.
      expect(settings.permissions?.defaultMode).toBe('acceptEdits')
    })

    it('persists an always-allow rule to localSettings and reads it back', async () => {
      // Mirrors the ask-modal "Always allow" path: it writes to localSettings
      // (`<projectRoot>/.velloc/settings.local.json`), which the merge layer
      // then folds back into the effective allow list on the next boot.
      const { fs, files } = makeMemoryFs()
      await updateSectionInSource(
        'localSettings',
        { homeDir: HOME, projectRoot: PROJ },
        fs,
        'permissions',
        prev => ({
          ...(prev ?? {}),
          allow: [...(prev?.allow ?? []), 'Bash(npm install)'],
        }),
      )
      // Lands in settings.local.json, NOT the project settings.json.
      expect(files.has(LOCAL_PATH)).toBe(true)
      expect(files.has(PROJECT_PATH)).toBe(false)
      // And is read back through the merge.
      const { settings } = await loadEffectiveSettings(
        { homeDir: HOME, projectRoot: PROJ },
        fs,
      )
      expect(settings.permissions?.allow).toContain('Bash(npm install)')
    })

    it('drops malformed permission entries (non-string rules, bad mode)', async () => {
      const { fs } = makeMemoryFs({
        [USER_PATH]: JSON.stringify({
          version: NEXUS_SETTINGS_VERSION,
          permissions: { allow: ['Read', 42, ''], deny: 'oops', defaultMode: 'bogus' },
        }),
      })
      const { settings } = await loadEffectiveSettings({ homeDir: HOME }, fs)
      expect(settings.permissions?.allow).toEqual(['Read'])
      expect(settings.permissions?.deny).toBeUndefined()
      expect(settings.permissions?.defaultMode).toBeUndefined()
    })

    it('reads localSettings from settings.local.json (not settings.json)', async () => {
      const { fs } = makeMemoryFs({
        [LOCAL_PATH]: json({ features: { onlyLocal: true } }),
      })
      const { settings, sources } = await loadEffectiveSettings(
        { homeDir: HOME, projectRoot: PROJ },
        fs,
      )
      expect(settings.features).toEqual({ onlyLocal: true })
      expect(sources).toEqual(['localSettings'])
    })

    it('concatenates hooks across sources (array merge of the real hooks field)', async () => {
      // hooks is the one NexusSettingsV1 field whose values are arrays, so it
      // exercises the array-concat customizer end-to-end. User + project each
      // contribute a matcher for the same event; both must survive (dedup is
      // by identity, and these are distinct objects from distinct files).
      const { fs } = makeMemoryFs({
        [USER_PATH]: json({
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] },
            ],
          },
        }),
        [PROJECT_PATH]: json({
          hooks: {
            PreToolUse: [
              { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo project' }] },
            ],
          },
        }),
      })
      const { settings } = await loadEffectiveSettings(
        { homeDir: HOME, projectRoot: PROJ },
        fs,
      )
      const matchers = settings.hooks?.PreToolUse ?? []
      expect(matchers).toHaveLength(2)
      expect(matchers.map(m => m.matcher).sort()).toEqual(['Bash', 'Edit'])
    })

    it('skips project/local entirely when projectRoot is absent (inert for existing callers)', async () => {
      const { fs } = makeMemoryFs({
        [USER_PATH]: json({ features: { u: true } }),
        // Present but must be ignored without a projectRoot:
        [PROJECT_PATH]: json({ features: { p: true } }),
        [LOCAL_PATH]: json({ features: { l: true } }),
      })
      const { settings, sources } = await loadEffectiveSettings({ homeDir: HOME }, fs)
      expect(settings.features).toEqual({ u: true })
      expect(sources).toEqual(['userSettings'])
      // Only the user file is read; project/local are never touched.
      expect((fs.readFile as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })
  })
})
