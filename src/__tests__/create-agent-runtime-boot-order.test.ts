/**
 * Boot-order pins for `createBrowserRuntime` (createAgentRuntime.ts), structural because no unit test builds a
 * real runtime: `seedAppStateFromSettings` runs before `loadLocalPromptCommands`, which gets the seeded
 * `appState`; the engine's `sessionStoragePath` reads the caught `settingsHomeDir`, not `settingsHome()` (throws).
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(__dirname, '../browser/runtime/createAgentRuntime.ts'),
  'utf-8',
)

describe('createBrowserRuntime boot order', () => {
  it('seeds appState from settings.json before the boot-time loadLocalPromptCommands, and passes it', () => {
    const seedAt = source.indexOf('await seedAppStateFromSettings(')
    const loadAt = source.indexOf('await loadLocalPromptCommands({')
    expect(seedAt).toBeGreaterThan(-1)
    expect(loadAt).toBeGreaterThan(-1)
    expect(seedAt).toBeLessThan(loadAt)

    // The boot-time call's argument object: from `loadLocalPromptCommands({`
    // to its closing `}))`.
    const callEnd = source.indexOf('}))', loadAt)
    const bootCall = source.slice(loadAt, callEnd)
    expect(bootCall).toMatch(/^\s*appState,\s*$/m)
    expect(bootCall).not.toContain('createInitialBrowserAppState()')
  })

  it("the engine's sessionStoragePath is derived from the caught settingsHomeDir, never a bare settingsHome()", () => {
    const at = source.indexOf('sessionStoragePath: settingsHomeDir')
    expect(at).toBeGreaterThan(-1)
    expect(source).not.toMatch(/sessionStoragePath:\s*settingsHome\(\)/)
    expect(source).not.toContain('projectsHome(settingsHome())')
  })
})
