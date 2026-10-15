import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  BROWSER_SLASH_COMMANDS,
  BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS,
  HIDDEN_BROWSER_SLASH_COMMANDS,
  HIDDEN_BROWSER_SLASH_COMMAND_SET,
  HIDDEN_SLASH_COMMAND_DESCRIPTION_KEYS,
  NEXUS_SLASH_COMMANDS,
  splitCommandWord,
  resolveSupportedSlashCommands,
  COMMAND_PREFIX_ALIAS,
} from '../input/slashCommandCatalog'
import { en } from '../browser/webview/i18n/messages/en'

/**
 * Guards for the module splits of `processUserInput.ts`, `attachments.ts` and `assistantUiAdapter.ts`: the
 * dependency graph stays a DAG with the leaf modules genuinely leaves, plus coverage of the two exported catalog
 * helpers. Behaviour is pinned by the suites that drive the public entry points.
 */

const SRC = join(__dirname, '..')

const read = (...segments: string[]): string =>
  readFileSync(join(SRC, ...segments), 'utf8')

/** Named import specifiers a module pulls from a given relative path. */
const importsFrom = (source: string, modulePath: string): boolean =>
  new RegExp(`from\\s+'${modulePath.replace(/[/.]/g, '\\$&')}'`).test(source)

describe('processUserInput/ split', () => {
  const dir = ['input']

  it('keeps the slash-command catalog free of RUNTIME dependencies', () => {
    // The catalog names the built-in commands without importing the dispatcher (and its graphs). `import type` is
    // exempt: TypeScript erases it.
    const source = read(...dir, 'slashCommandCatalog.ts')
    const valueImports = source
      .split('\n')
      .filter(line => /^\s*import\s/.test(line) && !/^\s*import\s+type\s/.test(line))
    expect(
      valueImports,
      'slashCommandCatalog.ts must stay free of value imports — it is the '
      + 'leaf every catalog consumer depends on. Type-only imports are fine.',
    ).toEqual([])
  })

  it('keeps the supporting modules from importing the dispatcher', () => {
    // The dispatcher depends on all four; none may depend back. The natural
    // way to break this is to add a command that reaches into
    // runSlashCommand for a shared helper — which compiles, runs, and
    // leaves an import cycle behind.
    for (const name of [
      'slashCommandCatalog',
      'skillSlashCommand',
      'pluginInstallCommands',
      'debugCommands',
    ]) {
      const source = read(...dir, `${name}.ts`)
      expect(
        importsFrom(source, './runSlashCommand'),
        `${name}.ts must not import runSlashCommand — the dispatcher `
        + 'depends on it, and the reverse edge is an import cycle.',
      ).toBe(false)
      expect(
        importsFrom(source, './submitUserInput'),
        `${name}.ts must not import submitUserInput — the pipeline is the `
        + 'entry point, not a shared utility.',
      ).toBe(false)
    }
  })

  it('leaves the pipeline module free of command-handling code', () => {
    const source = read(...dir, 'submitUserInput.ts')
    expect(importsFrom(source, './runSlashCommand')).toBe(true)
    expect(
      source,
      'submitUserInput.ts must not re-absorb the /debug family or the '
      + 'plugin-install primitives.',
    ).not.toMatch(/handleDebug|buildPluginsListing|copyLocalPluginDirectory/)
  })
})

describe('attachments/ split', () => {
  it('keeps collectors and renderers as peers', () => {
    // contextAttachments.ts produces AttachmentMessages; renderAttachments.ts turns
    // them into model-visible text. Neither may import the other —
    // prepareModelHistory.ts is the one module that joins them. A collector
    // reaching for a renderer is how the two concerns fuse back together.
    const collectors = read('messages', 'contextAttachments.ts')
    const renderers = read('messages', 'renderAttachments.ts')

    expect(
      importsFrom(collectors, './renderAttachments'),
      'contextAttachments.ts must not import renderAttachments — collecting and '
      + 'rendering are peers.',
    ).toBe(false)
    expect(
      importsFrom(renderers, './contextAttachments'),
      'renderAttachments.ts must not import contextAttachments — it renders what it '
      + 'is handed, and knows nothing about how it was collected.',
    ).toBe(false)
    expect(
      importsFrom(renderers, './prepareModelHistory'),
      'renderAttachments.ts must not import prepareModelHistory — normalization '
      + 'is its caller.',
    ).toBe(false)
  })

  it('routes attachment expansion through the renderer module', () => {
    const normalize = read('messages', 'prepareModelHistory.ts')
    expect(importsFrom(normalize, './renderAttachments')).toBe(true)
    expect(
      normalize,
      'prepareModelHistory.ts must not import the collectors — it normalizes '
      + 'history, it does not gather attachments.',
    ).not.toMatch(/from '\.\/contextAttachments'/)
  })

  it('keeps history normalization out of contextAttachments.ts', () => {
    // These moved out because none of them is about attachments. Their
    // reappearance here means the file is re-accreting unrelated concerns.
    expect(read('messages', 'contextAttachments.ts')).not.toMatch(
      /function (matchCallsToAnswers|foldUserTurns|prepareHistoryForModel)\b/,
    )
  })
})

describe('assistantUiAdapter/ split', () => {
  const dir = ['browser', 'webview']

  it('keeps the primitives module a leaf', () => {
    // assistantUiAdapterParts.ts is imported by all three siblings. Any edge
    // back out of it makes the whole adapter graph cyclic.
    const parts = read(...dir, 'assistantUiAdapterParts.ts')
    for (const sibling of [
      './assistantUiAdapter',
      './assistantUiAdapterContent',
      './assistantUiAdapterCards',
    ]) {
      expect(
        importsFrom(parts, sibling),
        `assistantUiAdapterParts.ts must not import ${sibling} — it is the `
        + 'leaf every other adapter module depends on.',
      ).toBe(false)
    }
  })

  it('keeps content conversion and card builders independent of each other', () => {
    // They are siblings at the same layer: both build on the primitives,
    // neither on the other, and neither on the top-level adapter.
    const content = read(...dir, 'assistantUiAdapterContent.ts')
    const cards = read(...dir, 'assistantUiAdapterCards.ts')

    expect(importsFrom(content, './assistantUiAdapterCards')).toBe(false)
    expect(importsFrom(cards, './assistantUiAdapterContent')).toBe(false)
    for (const source of [content, cards]) {
      expect(
        importsFrom(source, './assistantUiAdapter'),
        'adapter sub-modules must not import the top-level adapter — it is '
        + 'their caller.',
      ).toBe(false)
    }
  })

  it('keeps the card builder and its predicate in the same module', () => {
    // A card is written by a builder and recognised again by a predicate;
    // they encode the same identity twice. Splitting them across modules is
    // how a card silently stops being recognised on the way back in.
    const cards = read(...dir, 'assistantUiAdapterCards.ts')
    for (const [builder, predicate] of [
      ['compactBoundaryThreadMessage', 'isCompactBoundaryThreadMessage'],
      ['compactProgressThreadMessage', 'isCompactProgressThreadMessage'],
      ['backgroundResultsThreadMessage', 'isBackgroundResultsThreadMessage'],
    ]) {
      expect(cards).toMatch(new RegExp(`function ${builder}\\b`))
      expect(cards).toMatch(new RegExp(`function ${predicate}\\b`))
    }
  })
})

describe('AssistantUiThread/ split', () => {
  const dir = ['browser', 'webview']

  it('keeps the extracted components from importing their old host', () => {
    // Sidebar, the composer-sync effects and the dialogs were lifted out of
    // AssistantUiThread.tsx. It imports them; none may import it back.
    for (const name of ['Sidebar.tsx', 'ThreadComposerSync.tsx', 'ThreadDialogs.tsx']) {
      expect(
        importsFrom(read(...dir, name), './AssistantUiThread'),
        `${name} must not import AssistantUiThread — it is their host.`,
      ).toBe(false)
    }
    expect(importsFrom(read(...dir, 'AssistantUiThread.tsx'), './Sidebar')).toBe(true)
  })

  it('keeps the startup bypass gate a single module-global', () => {
    // `startupBypassGatedSessions` is keyed by sessionId and fires the
    // bypass warning at most once per session. A copy in a second module
    // would be a second, independent gate — the warning would fire twice and
    // nothing would fail. It must exist in exactly one file.
    const owners = ['AssistantUiThread.tsx', 'Sidebar.tsx', 'ThreadComposerSync.tsx',
      'ThreadDialogs.tsx', 'MultiSessionShell.tsx']
      .filter(name => /const startupBypassGatedSessions\b/.test(read(...dir, name)))

    expect(
      owners,
      'startupBypassGatedSessions must be declared exactly once — a duplicate '
      + 'is a second independent once-per-session gate.',
    ).toEqual(['AssistantUiThread.tsx'])
  })
})

describe('turn module layering', () => {
  it('the modules under engine/turn/ import each other without a cycle', () => {
    const dir = join(__dirname, '..', 'engine', 'turn')
    const modules = readdirSync(dir).filter(name => name.endsWith('.ts')).map(name => name.slice(0, -3))
    const edges = new Map<string, string[]>()
    for (const name of modules) {
      const source = readFileSync(join(dir, `${name}.ts`), 'utf8')
      const targets = [...source.matchAll(/from\s+['"]\.\/([\w.-]+)['"]/g)].map(m => m[1]!).filter(t => modules.includes(t))
      edges.set(name, targets)
    }
    const cycles: string[] = []
    const state = new Map<string, 'open' | 'done'>()
    const visit = (name: string, path: string[]) => {
      if (state.get(name) === 'done') return
      if (state.get(name) === 'open') {
        cycles.push([...path.slice(path.indexOf(name)), name].join(' -> '))
        return
      }
      state.set(name, 'open')
      for (const next of edges.get(name)!) visit(next, [...path, name])
      state.set(name, 'done')
    }
    for (const name of modules) visit(name, [])
    expect(cycles).toEqual([])
  })
})

describe('query transport modules', () => {
  // The model transport is split into small modules (ids, trace,
  // serialization, error messages) under deps.ts. What matters is that each
  // one works when it is the first module of the stack a realm loads — a
  // cycle back up the stack would hand it an uninitialised binding. The
  // transport's behaviour as a whole is pinned by the engine replay
  // fixtures (src/__tests__/engine-replay).
  const fresh = async <T>(path: string): Promise<T> => {
    vi.resetModules()
    return (await import(path)) as T
  }

  it('mints ids and timestamps when loaded first', async () => {
    const ids = await fresh<typeof import('../engine/turn/runtimeIds')>('../engine/turn/runtimeIds')
    expect(ids.createUUID()).toMatch(/^[0-9a-f-]{36}$|^uuid-/)
    expect(Number.isNaN(Date.parse(ids.createTimestamp()))).toBe(false)
  })

  it('sanitizes trace values when loaded first', async () => {
    const trace = await fresh<typeof import('../engine/turn/modelTrace')>('../engine/turn/modelTrace')
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => JSON.stringify(trace.sanitizeModelTraceValue(cyclic))).not.toThrow()
  })

  it('serializes a conversation for the bridge when loaded first', async () => {
    const serialization = await fresh<typeof import('../engine/turn/bridgeSerialization')>('../engine/turn/bridgeSerialization')
    const out = serialization.serializeMessagesForBridge(
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] as never,
      [],
    )
    expect(out).toHaveLength(1)
    expect(JSON.stringify(out)).toContain('hello')
  })

  it('builds the prompt-too-long answer when loaded first', async () => {
    const errors = await fresh<typeof import('../engine/turn/modelErrorMessages')>('../engine/turn/modelErrorMessages')
    const message = errors.makePromptTooLongAssistant(undefined, 'model-a')
    expect(message.apiError).toBe('prompt_too_long')
    expect(message.message.model).toBe('model-a')
  })
})

describe('SKILL_TOOL_NAME stays reachable without entering the SkillRunTool cycle', () => {
  // `toolkit/builtin/skill.ts` is in an import cycle where `batchSkill.ts` reads SKILL_TOOL_NAME at module level, so
  // entry order decides the TDZ. Structural, because vitest does not reproduce browser ESM evaluation order.

  it('defines the constant in a module with no imports', () => {
    const leaf = read('prompting', 'skillToolName.ts')
    expect(
      leaf.match(/^\s*import\s/m),
      'prompting/skillToolName.ts must stay import-free — a leaf inside no '
      + 'cycle is the whole reason it exists.',
    ).toBeNull()
    expect(leaf).toMatch(/export const SKILL_TOOL_NAME\b/)
  })

  it('keeps name-only consumers off tools/SkillTool', () => {
    // Each of these needs the NAME, not the tool. Importing it from
    // tools/SkillTool drags the skills registry into their module graph and
    // re-arms the dead-zone crash from whichever one is evaluated first.
    for (const segments of [
      ['skillLibrary', 'builtin', 'batchSkill.ts'],
      ['messages', 'contextAttachments.ts'],
      ['messages', 'renderAttachments.ts'],
      ['permissions', 'planMode.ts'],
    ]) {
      expect(
        read(...segments),
        `${segments.join('/')} must import SKILL_TOOL_NAME from `
        + 'prompting/skillToolName, not from toolkit/builtin/skill.',
      ).not.toMatch(/SKILL_TOOL_NAME\s*}\s*from\s+'[^']*toolkit\/builtin\/skill'/)
    }
  })

  it('keeps the skill tool re-exporting the name so its surface is unchanged', () => {
    expect(read('toolkit', 'builtin', 'skill.ts')).toMatch(
      /export\s*{\s*SKILL_TOOL_NAME\s*}\s*from\s+'\.\.\/\.\.\/prompting\/skillToolName'/,
    )
  })
})

describe('slashCommandCatalog — splitCommandWord', () => {
  // Previously a private helper inside processUserInput.ts with no direct
  // coverage; exported by the split, so it gets pinned here.
  it('splits a bare command from its arguments', () => {
    expect(splitCommandWord('/help')).toEqual({ command: 'help', args: '' })
    expect(splitCommandWord('/model gpt-5')).toEqual({
      command: 'model',
      args: 'gpt-5',
    })
  })

  it('keeps everything after the first space as a single arg string', () => {
    expect(splitCommandWord('/model openai gpt-5')).toEqual({
      command: 'model',
      args: 'openai gpt-5',
    })
    expect(splitCommandWord('/compact  focus on the bug  ')).toEqual({
      command: 'compact',
      args: 'focus on the bug',
    })
  })

  it('tolerates surrounding whitespace and a hyphenated command', () => {
    expect(splitCommandWord('  /exit-plan  ship it ')).toEqual({
      command: 'exit-plan',
      args: 'ship it',
    })
  })
})

describe('slashCommandCatalog — command prefix alias', () => {
  const alias = `/${COMMAND_PREFIX_ALIAS}`

  it('runs `<alias> <name> …` as `/<name> …`', () => {
    expect(splitCommandWord(`${alias} plugin marketplace add owner/repo`)).toEqual({
      command: 'plugin',
      args: 'marketplace add owner/repo',
    })
    expect(splitCommandWord(`${alias} plugin`)).toEqual({
      command: 'plugin',
      args: '',
    })
    expect(splitCommandWord(`  ${alias}   help `)).toEqual({
      command: 'help',
      args: '',
    })
  })

  it('leaves the bare alias and a longer word alone', () => {
    expect(splitCommandWord(alias)).toEqual({ command: COMMAND_PREFIX_ALIAS, args: '' })
    expect(splitCommandWord(`${alias}x list`)).toEqual({
      command: `${COMMAND_PREFIX_ALIAS}x`,
      args: 'list',
    })
  })
})

describe('slashCommandCatalog — catalog integrity', () => {
  it('describes every visible built-in exactly once, with a real catalog key', () => {
    // The picker iterates the command list and looks the description key up
    // by name; a missing entry renders as `undefined`, and a key absent from
    // the catalog renders as the raw dotted string.
    expect(Object.keys(BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS).sort()).toEqual(
      [...BROWSER_SLASH_COMMANDS].sort(),
    )
    for (const key of Object.values(BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS)) {
      expect(en[key]).toBeTruthy()
    }
  })

  it('keeps the nexus command set a subset of the browser set', () => {
    // `resolveSupportedSlashCommands` filters against the browser set, so a
    // nexus-only name would be silently dropped rather than surfaced.
    for (const command of NEXUS_SLASH_COMMANDS) {
      expect(BROWSER_SLASH_COMMANDS).toContain(command)
    }
    expect(resolveSupportedSlashCommands(NEXUS_SLASH_COMMANDS)).toEqual([
      ...NEXUS_SLASH_COMMANDS,
    ])
  })

  it('keeps hidden commands out of the visible set and describes each', () => {
    // A hidden name that also appears in the visible set would be listed in
    // `/help` and the picker — the exact thing `isHidden` exists to prevent.
    for (const command of HIDDEN_BROWSER_SLASH_COMMANDS) {
      expect(BROWSER_SLASH_COMMANDS).not.toContain(command)
      expect(en[HIDDEN_SLASH_COMMAND_DESCRIPTION_KEYS[command]]).toBeTruthy()
      expect(HIDDEN_BROWSER_SLASH_COMMAND_SET.has(command)).toBe(true)
    }
    // The dispatcher checks the hidden set before the visible guard; a stale
    // set would route the command to the skill registry instead.
    expect(HIDDEN_BROWSER_SLASH_COMMAND_SET.size).toBe(
      HIDDEN_BROWSER_SLASH_COMMANDS.length,
    )
  })
})
