// Auto-compact window settings: `/autocompact [size|auto]`, the
// `autoCompaction` / `autoCompactWindow` / `modelSettings` keys, and how
// the trigger and its threshold follow them. Behaviour spec:
// F-3.
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'
import { readUserLayer, wipeSettingsMemos } from '../settings/settingsStore'
import type { NexusSettingsV1 } from '../settings/settingsTypes'
import {
  chooseAutoCompactWindow,
  createAutoCompactWindowSettings,
  parseAutoCompactWindowInput,
} from '../context/compaction/windowSettings'
import { foldTriggerTokens } from '../context/compaction/triggerThreshold'
import { createBrowserAutoCompact } from '../context/compaction/autoTrigger'
import {
  recordEntryResolution,
  resetEntryResolutions,
} from '../config/nexusModelConfig/modelEntryResolution'

const ONE_M = 'claude-opus[1m]' // 1M window, uncatalogued output → 20K reserve
const HOME = '/home/u'

/** A tiny in-memory fs: files persist across reads and writes. */
function memoryFs(initial: Record<string, string> = {}) {
  // The settings layer memoizes per file path; a fresh fs needs a fresh memo.
  wipeSettingsMemos()
  const files = new Map(Object.entries(initial))
  const fs = {
    async readFile(path: string) {
      const hit = files.get(path.replace(/\\/g, '/'))
      if (hit === undefined) throw new Error('ENOENT')
      return hit
    },
    async mkdir() {},
    async writeFile(path: string, content: string) {
      files.set(path.replace(/\\/g, '/'), content)
    },
    async rename(from: string, to: string) {
      const v = files.get(from.replace(/\\/g, '/'))
      if (v !== undefined) files.set(to.replace(/\\/g, '/'), v)
      files.delete(from.replace(/\\/g, '/'))
    },
  } as unknown as RuntimeFs
  return { fs, files }
}

function userSettingsOf(files: Map<string, string>): NexusSettingsV1 | undefined {
  for (const [path, text] of files) {
    if (path.startsWith(HOME) && path.endsWith('settings.json')) {
      return JSON.parse(text) as NexusSettingsV1
    }
  }
  return undefined
}

function userSettingsPathSeed(settings: object): Record<string, string> {
  return { [`${HOME}/.velloc/settings.json`]: JSON.stringify({ version: 1, ...settings }) }
}

afterEach(() => {
  wipeSettingsMemos()
})

describe('parseAutoCompactWindowInput', () => {
  it.each([
    ['auto', { kind: 'auto' }],
    ['AUTO', { kind: 'auto' }],
    ['400k', { kind: 'tokens', tokens: 400_000 }],
    ['400K', { kind: 'tokens', tokens: 400_000 }],
    ['1M', { kind: 'tokens', tokens: 1_000_000 }],
    ['0.5m', { kind: 'tokens', tokens: 500_000 }],
    ['200000', { kind: 'tokens', tokens: 200_000 }],
    ['300', { kind: 'tokens', tokens: 300_000 }],
    ['1000', { kind: 'tokens', tokens: 1_000_000 }],
    ['100', { kind: 'tokens', tokens: 100_000 }],
  ])('%s → %o', (input, expected) => {
    expect(parseAutoCompactWindowInput(input)).toEqual(expected)
  })

  it.each(['50k', '99999', '2M', '1.5m', '99', 'abc', '400 tokens', '-400k', ''])(
    'rejects %s',
    input => {
      expect(parseAutoCompactWindowInput(input)).toEqual({ kind: 'invalid' })
    },
  )
})

describe('chooseAutoCompactWindow', () => {
  const file = (source: 'userSettings' | 'projectSettings' | 'localSettings', s: object) => ({
    source,
    settings: { version: 1, ...s } as NexusSettingsV1,
  })

  it('defaults to on with no window', () => {
    expect(chooseAutoCompactWindow([], 'm')).toEqual({ enabled: true })
  })

  it("a model's own entry beats the every-model key in the same file", () => {
    const choice = chooseAutoCompactWindow(
      [file('userSettings', { autoCompactWindow: 200_000, modelSettings: { m: { autoCompactWindow: 400_000 } } })],
      'm',
    )
    expect(choice).toMatchObject({ windowTokens: 400_000, windowScope: 'model', windowSource: 'userSettings' })
  })

  it('the every-model key applies to a model without its own entry', () => {
    const choice = chooseAutoCompactWindow(
      [file('userSettings', { autoCompactWindow: 200_000, modelSettings: { other: { autoCompactWindow: 400_000 } } })],
      'm',
    )
    expect(choice).toMatchObject({ windowTokens: 200_000, windowScope: 'allModels' })
  })

  it('a higher file decides even with only an every-model key', () => {
    const choice = chooseAutoCompactWindow(
      [
        file('projectSettings', { autoCompactWindow: 150_000 }),
        file('userSettings', { modelSettings: { m: { autoCompactWindow: 400_000 } } }),
      ],
      'm',
    )
    expect(choice).toMatchObject({ windowTokens: 150_000, windowSource: 'projectSettings' })
  })

  it('autoCompaction comes from the highest file that sets it', () => {
    expect(
      chooseAutoCompactWindow(
        [file('localSettings', {}), file('projectSettings', { autoCompaction: true }), file('userSettings', { autoCompaction: false })],
        'm',
      ).enabled,
    ).toBe(true)
    expect(chooseAutoCompactWindow([file('userSettings', { autoCompaction: false })], 'm').enabled).toBe(false)
  })
})

describe('threshold with a user window', () => {
  it('compacts at the window itself', () => {
    expect(foldTriggerTokens(ONE_M, undefined, 400_000)).toBe(400_000)
    // no window = the model's own (1M − 20K reserve − 13K headroom)
    expect(foldTriggerTokens(ONE_M)).toBe(967_000)
  })

  it("never exceeds the model's own threshold", () => {
    // 200K fallback model: a 500K window is capped at its 167K.
    expect(foldTriggerTokens('uncatalogued-model', undefined, 500_000)).toBe(
      foldTriggerTokens('uncatalogued-model'),
    )
    expect(foldTriggerTokens(ONE_M, undefined, 1_000_000)).toBe(967_000)
  })
})

describe('settings.json keys', () => {
  it('keeps valid values and drops invalid ones', async () => {
    const { fs } = memoryFs(userSettingsPathSeed({
      autoCompaction: false,
      autoCompactWindow: 50_000,
      modelSettings: {
        a: { autoCompactWindow: 400_000 },
        b: { autoCompactWindow: 2_000_000 },
        c: { autoCompactWindow: '300k' },
        d: 'nope',
      },
    }))
    const { settings: out } = await readUserLayer(HOME, fs)
    expect(out.autoCompaction).toBe(false)
    expect(out.autoCompactWindow).toBeUndefined()
    expect(out.modelSettings).toEqual({ a: { autoCompactWindow: 400_000 } })
  })

  it('drops modelSettings entirely when nothing valid is left', async () => {
    const { fs } = memoryFs(userSettingsPathSeed({ modelSettings: { a: {} } }))
    const { settings: out } = await readUserLayer(HOME, fs)
    expect(out.modelSettings).toBeUndefined()
  })
})

describe('reader: save and clear per model', () => {
  it('saves a window under modelSettings and clears it sparsely with auto', async () => {
    const { fs, files } = memoryFs(userSettingsPathSeed({ autoMemoryEnabled: true }))
    const reader = createAutoCompactWindowSettings({ homeDir: HOME, projectRoot: () => undefined, fs: () => fs })

    const saved = await reader.saveForModel(ONE_M, undefined, 400_000)
    expect(saved).toMatchObject({ windowTokens: 400_000, windowScope: 'model' })
    expect(userSettingsOf(files)?.modelSettings).toEqual({ [ONE_M]: { autoCompactWindow: 400_000 } })
    expect(userSettingsOf(files)?.autoMemoryEnabled).toBe(true)
    expect(reader.current(ONE_M).windowTokens).toBe(400_000)
    expect(reader.current('another-model').windowTokens).toBeUndefined()

    const cleared = await reader.saveForModel(ONE_M, undefined, 'auto')
    expect(cleared.windowTokens).toBeUndefined()
    expect(userSettingsOf(files)?.modelSettings).toBeUndefined()
    expect(userSettingsOf(files)?.autoMemoryEnabled).toBe(true)
  })

  it('load() makes current() reflect the files without a resolve()', async () => {
    const { fs } = memoryFs(userSettingsPathSeed({
      autoCompaction: false,
      modelSettings: { [ONE_M]: { autoCompactWindow: 400_000 } },
    }))
    const reader = createAutoCompactWindowSettings({ homeDir: HOME, projectRoot: () => undefined, fs: () => fs })
    // Before any read the reader knows nothing (defaults).
    expect(reader.current(ONE_M)).toEqual({ enabled: true })
    await reader.load()
    expect(reader.current(ONE_M)).toMatchObject({ enabled: false, windowTokens: 400_000 })
  })

  it('cannot save without a settings home', async () => {
    const { fs } = memoryFs()
    const reader = createAutoCompactWindowSettings({ homeDir: null, projectRoot: () => undefined, fs: () => fs })
    expect(reader.canSave).toBe(false)
    await expect(reader.saveForModel('m', undefined, 200_000)).rejects.toThrow()
    expect(await reader.resolve('m')).toEqual({ enabled: true })
  })
})

// ── /autocompact ─────────────────────────────────────────────────────────

const runtimeConfig = new BrowserRuntimeConfig()

function contextFor(fs: RuntimeFs, model = ONE_M, withReader = true): ToolCallContext {
  const context = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sess',
    cwd: '/w',
    projectRoot: '/proj/root',
    commands: [],
  })
  context.options.homeDir = HOME
  context.options.mainLoopModel = model
  if (withReader) {
    context.options.autoCompactWindows = createAutoCompactWindowSettings({
      homeDir: HOME,
      projectRoot: () => undefined,
      fs: () => fs,
    })
  }
  return context
}

async function slash(input: string, context: ToolCallContext): Promise<string> {
  const out = await processUserInput(
    { input, context },
    {
      hostBridge: {} as unknown as BrowserHostBridge,
      runtimeConfig,
      supportedSlashCommands: ['help', 'autocompact'],
      settingsHomeDir: HOME,
    },
  )
  expect(out.shouldQuery).toBe(false)
  const notice = out.messages.find(m => (m as { type?: string }).type === 'system') as
    | { message: string }
    | undefined
  return notice?.message ?? ''
}

describe('/autocompact', () => {
  it('sets the window for the current model', async () => {
    const { fs, files } = memoryFs()
    const ctx = contextFor(fs)
    const out = await slash('/autocompact 400k', ctx)
    expect(out).toContain(`Auto-compact window for ${ONE_M} set to 400k tokens`)
    expect(userSettingsOf(files)?.modelSettings?.[ONE_M]?.autoCompactWindow).toBe(400_000)
  })

  it('auto clears the saved window', async () => {
    const { fs, files } = memoryFs(userSettingsPathSeed({ modelSettings: { [ONE_M]: { autoCompactWindow: 300_000 } } }))
    const out = await slash('/autocompact auto', contextFor(fs))
    expect(out).toContain(`Auto-compact window for ${ONE_M} set to auto`)
    expect(userSettingsOf(files)?.modelSettings).toBeUndefined()
  })

  it('reports the current window and threshold with no argument', async () => {
    const { fs } = memoryFs(userSettingsPathSeed({ modelSettings: { [ONE_M]: { autoCompactWindow: 400_000 } } }))
    const out = await slash('/autocompact', contextFor(fs))
    expect(out).toContain(`Auto-compact window for ${ONE_M}: compacts at 400k tokens.`)
    expect(out).not.toContain('can compact at most')
    expect(out).toContain('/autocompact auto')
  })

  it('reports auto at the model window when nothing is set', async () => {
    const { fs } = memoryFs()
    const out = await slash('/autocompact', contextFor(fs))
    expect(out).toContain(`Auto-compact window for ${ONE_M}: auto (compacts at about 967k tokens).`)
  })

  it('rejects an out-of-range size without writing', async () => {
    const { fs, files } = memoryFs()
    const out = await slash('/autocompact 50k', contextFor(fs))
    expect(out).toContain('Invalid auto-compact window "50k"')
    expect(files.size).toBe(0)
  })

  it("notes the cap when the window exceeds the model's own threshold", async () => {
    const { fs } = memoryFs()
    const out = await slash('/autocompact 500k', contextFor(fs, 'uncatalogued-model'))
    expect(out).toContain('set to 500k tokens')
    expect(out).toContain('can compact at most at 167k tokens')
    // The status reports it too.
    const status = await slash('/autocompact', contextFor(fs, 'uncatalogued-model'))
    expect(status).toContain('compacts at 500k tokens.')
    expect(status).toContain('can compact at most at 167k tokens')
  })

  it('says when a higher settings file keeps its window', async () => {
    const { fs } = memoryFs()
    const ctx = contextFor(fs)
    // A project file with an every-model window outranks the user file.
    ctx.options.autoCompactWindows = createAutoCompactWindowSettings({
      homeDir: HOME,
      projectRoot: () => '/proj',
      fs: () => fs,
    })
    await fs.writeFile('/proj/.velloc/settings.json', JSON.stringify({ version: 1, autoCompactWindow: 150_000 }))
    const out = await slash('/autocompact 400k', ctx)
    expect(out).toContain('set to 400k tokens')
    expect(out).toContain('Another settings file sets the window for this model to 150k tokens')
  })

  it('mentions that auto-compact is off', async () => {
    const { fs } = memoryFs(userSettingsPathSeed({ autoCompaction: false }))
    const out = await slash('/autocompact', contextFor(fs))
    expect(out).toContain('Auto-compact is turned off in settings')
  })

  it('degrades without a settings reader', async () => {
    const { fs } = memoryFs()
    const out = await slash('/autocompact 400k', contextFor(fs, ONE_M, false))
    expect(out).toContain('cannot be saved')
  })

  it('is listed by /help', async () => {
    const { fs } = memoryFs()
    const out = await slash('/help', contextFor(fs))
    expect(out).toContain('/autocompact')
  })
})

describe('/autocompact on a model entry', () => {
  afterEach(() => resetEntryResolutions())

  it('keys the window by the concrete model the entry resolves to', async () => {
    recordEntryResolution('openai', 'gpt-*-mini@latest', { id: 'gpt-5.4-mini' } as never)
    const { fs, files } = memoryFs()
    const ctx = contextFor(fs, 'gpt-*-mini@latest')
    ctx.options.mainLoopProviderId = 'openai'
    await slash('/autocompact 300k', ctx)
    expect(userSettingsOf(files)?.modelSettings).toEqual({
      'gpt-5.4-mini': { autoCompactWindow: 300_000 },
    })
    // The entry and an explicit pin of the same model read one window.
    const reader = ctx.options.autoCompactWindows!
    expect(reader.current('gpt-*-mini@latest', 'openai').windowTokens).toBe(300_000)
    expect(reader.current('gpt-5.4-mini', 'openai').windowTokens).toBe(300_000)
  })
})

// ── The trigger follows the settings ─────────────────────────────────────

function assistantWithContext(tokens: number): Message {
  return {
    type: 'assistant',
    uuid: 'anchor',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'prior' }],
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: tokens,
        output_tokens: 50,
      },
    },
  } as Message
}

/** Run one gate attempt; "fired" = it reached the summarizer (which fails
 *  here, so a fired attempt comes back as one failure). */
async function gateFires(settingsSeed: object, contextTokens: number): Promise<boolean> {
  const { fs } = memoryFs(userSettingsPathSeed(settingsSeed))
  let summarizerCalls = 0
  const bridge = {
    servesModelRoutes: true,
    request: async () => {
      summarizerCalls += 1
      return { ok: false as const, error: { code: 'x', message: 'summarizer unavailable' } }
    },
  } as unknown as Parameters<typeof createBrowserAutoCompact>[0]
  const reader = createAutoCompactWindowSettings({ homeDir: HOME, projectRoot: () => undefined, fs: () => fs })
  const autocompact = createBrowserAutoCompact(bridge, runtimeConfig as never, {}, reader)
  const callContext = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  callContext.options.mainLoopModel = ONE_M
  callContext.options.sessionId = '' // no hooks
  const result = await autocompact(
    [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'task' } } as Message,
      assistantWithContext(contextTokens),
    ],
    callContext,
    { callContext } as never,
    'test' as never,
  )
  // Below the threshold / switched off the gate returns {}; past it, the
  // failed summarizer comes back as a failure (or a fake success).
  return summarizerCalls > 0 || Object.keys(result).length > 0
}

describe('autocompact trigger and the window settings', () => {
  it('fires at the per-model window, far below the model window', async () => {
    // 1M model: default threshold 967K; a 400K window compacts at 400K.
    expect(await gateFires({}, 400_000)).toBe(false)
    expect(await gateFires({ modelSettings: { [ONE_M]: { autoCompactWindow: 400_000 } } }, 399_000)).toBe(false)
    expect(await gateFires({ modelSettings: { [ONE_M]: { autoCompactWindow: 400_000 } } }, 400_000)).toBe(true)
  })

  it('fires at the every-model window', async () => {
    expect(await gateFires({ autoCompactWindow: 300_000 }, 300_000)).toBe(true)
    expect(await gateFires({ autoCompactWindow: 300_000 }, 290_000)).toBe(false)
  })

  it('never fires when autoCompaction is false', async () => {
    expect(await gateFires({ autoCompaction: false }, 990_000)).toBe(false)
    expect(await gateFires({}, 990_000)).toBe(true)
  })

  it('reads the user file freshly for each attempt (sees a later save)', async () => {
    const { fs } = memoryFs()
    const reader = createAutoCompactWindowSettings({ homeDir: HOME, projectRoot: () => undefined, fs: () => fs })
    expect((await reader.resolve(ONE_M)).windowTokens).toBeUndefined()
    await reader.saveForModel(ONE_M, undefined, 250_000)
    expect((await reader.resolve(ONE_M)).windowTokens).toBe(250_000)
    const { settings } = await readUserLayer(HOME, fs)
    expect(settings.modelSettings?.[ONE_M]?.autoCompactWindow).toBe(250_000)
  })
})
