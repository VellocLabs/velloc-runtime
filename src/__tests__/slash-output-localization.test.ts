import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'
import { formatSystemMessage } from '../browser/webview/assistantUiAdapterParts'
import {
  combineThreadMessages,
  convertBrowserRuntimeStateToThreadMessages,
  convertTranscriptToThreadMessages,
} from '../browser/webview/assistantUiAdapter'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { BrowserRuntimeClientState } from '../browser/webview/BrowserRuntimeClient'
import {
  createTranslate,
  resetCatalogs,
  setCatalog,
} from '../browser/webview/i18n/translate'
import { slashCommandDescription } from '../components/assistant-ui/slash-command-picker'
import { en } from '../browser/webview/i18n/messages/en'
import { zh } from '../browser/webview/i18n/messages/zh'
import type { NoticeRow } from '../runtime/RuntimeTypes'

/**
 * Slash-command output: the model reads `message` (protocol, stays English); the user reads the same content
 * translated from `i18nContent`. Pins both halves and that they say the same thing.
 */

function stubHostBridge(): BrowserHostBridge {
  return {
    describeHostSession: async () => ({
      browserName: 'Chrome',
      browserVersion: '140.0',
      tabCount: 3,
      activeTabId: 'tab-7',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    }),
  } as unknown as BrowserHostBridge
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

function run(input: string, commands: string[]) {
  return processUserInput(
    { input, context: makeContext() },
    {
      hostBridge: stubHostBridge(),
      runtimeConfig,
      supportedSlashCommands: commands,
    },
  )
}

async function systemMessage(
  input: string,
  commands: string[],
): Promise<NoticeRow> {
  const out = await run(input, commands)
  const system = out.messages.find(m => m.type === 'system')
  expect(system, `no system message for ${input}`).toBeTruthy()
  return system as NoticeRow
}

/** What the user sees, in one locale. */
function rendered(message: NoticeRow, locale: 'en' | 'zh'): string {
  return formatSystemMessage(message, createTranslate(locale)) ?? ''
}

/** Newline / markdown block separator, named so the assertions below read. */
const NL = String.fromCharCode(10)
const BLANK = NL + NL

describe('slash output — the model-facing half stays English', () => {
  it('keeps /help English on `message` even though the UI is translatable', async () => {
    const message = await systemMessage('/help', ['help', 'clear'])

    expect(message.message).toContain('slash commands')
    expect(message.message).toContain('#### /help')
    expect(message.message).toContain('#### /clear')
    // The hint under each name is the same string the composer picker shows.
    expect(message.message).toContain(en['slash.builtin.help'])
    expect(message.message).toContain(en['slash.builtin.clear'])
  })

  it('keeps the unknown-command error English on `message`', async () => {
    // Pinned by slash-skill-dispatch.test.ts too — this is the wire text.
    const message = await systemMessage('/nope', ['help'])

    expect(message.message).toContain('Unknown slash command: /nope')
    expect(message.message).toContain('Available: /help')
  })

  it('renders `message` from the same catalog the UI uses, not a second copy', async () => {
    const message = await systemMessage('/clear', ['clear'])

    expect(message.message).toBe(en['slash.out.cleared'])
  })
})

describe('slash output — the user-facing half follows the locale', () => {
  it('translates /clear', async () => {
    const message = await systemMessage('/clear', ['clear'])

    expect(rendered(message, 'zh')).toBe(zh['slash.out.cleared'])
    expect(rendered(message, 'en')).toBe(en['slash.out.cleared'])
  })

  it('translates the unknown-command error while keeping the command name', async () => {
    const message = await systemMessage('/nope', ['help'])
    const zhText = rendered(message, 'zh')

    expect(zhText).toContain('/nope')
    // Command names are protocol: the listing stays ASCII in every locale.
    expect(zhText).toContain('/help')
    expect(zhText).not.toContain('Unknown slash command')
  })

  it('translates /help prose but never the command names', async () => {
    const message = await systemMessage('/help', ['help', 'clear'])
    const zhText = rendered(message, 'zh')

    expect(zhText).toContain('斜杠命令')
    expect(zhText).toContain('#### /help')
    expect(zhText).toContain('#### /clear')
    // The hints follow the locale even though the names never do.
    expect(zhText).toContain(zh['slash.builtin.help'])
    expect(zhText).not.toContain(en['slash.builtin.help'])
  })

  it('gives every command its own heading and hint, not one run-on line', async () => {
    // The regression: the listing was a newline-joined list of names. Slash
    // output renders as MARKDOWN, where a single newline is a SOFT break — so
    // every command collapsed onto one line and none of them said what it did.
    const message = await systemMessage('/help', ['help', 'clear', 'status'])
    const text = message.message as string

    for (const name of ['help', 'clear', 'status']) {
      expect(text).toContain(`${BLANK}#### /${name}${BLANK}`)
    }
    // No entry may be separated from what precedes it by a single newline:
    // that is exactly what collapsed.
    expect(text).not.toMatch(new RegExp(`[^${NL}]${NL}#### `))
  })

  it('lists the hidden commands in their own section', async () => {
    // `/debug` dispatches but is withheld from the composer picker. `/help` is
    // an explicit request for the whole surface, so it says so rather than
    // leaving a working command absent from every list.
    const message = await systemMessage('/help', ['help'])
    const text = message.message as string

    expect(text).toContain(en['slash.out.helpHiddenHeading'])
    expect(text).toContain('#### /debug')
    // The hint itself, not just the name — `{product}` is interpolated, so
    // match the half of the value that carries no placeholder.
    expect(text).toContain('subcommands: transcript')
    // …and it stays BELOW the visible ones, not mixed in with them.
    expect(text.indexOf('#### /help')).toBeLessThan(text.indexOf('#### /debug'))
  })

  it('lists the commands a plugin\'s hooks module registered, under their plugin', async () => {
    // F-25 `$.command.register`: the mod's own description, verbatim, with
    // the plugin named; the name stays protocol in every locale.
    const context = makeContext()
    context.options.mods = {
      listRegisteredCommands: () => [
        { name: 'hello', description: 'Says hi.', argumentHint: '[name]', plugin: 'greeter' },
      ],
    }
    const out = await processUserInput(
      { input: '/help', context },
      { hostBridge: stubHostBridge(), runtimeConfig, supportedSlashCommands: ['help'] },
    )
    const message = out.messages.find(m => m.type === 'system') as NoticeRow
    const text = message.message as string
    expect(text).toContain(en['slash.out.helpModsHeading'])
    expect(text).toContain('#### /hello [name]')
    expect(text).toContain('Says hi. (from the plugin greeter)')
    expect(text.indexOf('#### /help')).toBeLessThan(text.indexOf('#### /hello'))
    expect(rendered(message, 'zh')).toContain('Says hi.（来自插件 greeter）')
    expect(rendered(message, 'zh')).toContain('#### /hello [name]')
  })

  it('translates /status labels while passing host values through verbatim', async () => {
    const message = await systemMessage('/status', ['status'])
    const zhText = rendered(message, 'zh')

    expect(zhText).toContain('宿主环境：Chrome 140.0')
    expect(zhText).toContain('标签页：3')
    expect(zhText).toContain('当前标签页：tab-7')
    // A timezone id is data, not prose.
    expect(zhText).toContain('Asia/Shanghai')
  })

  it('interpolates into the translated sentence, not around it', async () => {
    // `/rename x` must not become the zh "Session renamed to:" + "x" glued on — the
    // placeholder is inside the catalog value and may move for grammar.
    const message = await systemMessage('/rename my-feature', ['rename'])

    expect(rendered(message, 'zh')).toBe(
      zh['slash.out.renamed'].replace('{title}', 'my-feature'),
    )
    expect(message.message).toBe(
      en['slash.out.renamed'].replace('{title}', 'my-feature'),
    )
  })
})

describe('slash output — with no catalog loaded at all', () => {
  // The worker composes `message` from the ENGLISH catalog, and that text is
  // persisted and sent to the model as a `role:"system"` turn. A worker whose
  // init payload carried no `enCatalogUrl` (headless / sub-agent spawn, an
  // embedder building its own payload) or whose fetch failed has no catalog —
  // and must still emit English, never a raw dotted key.
  beforeEach(() => {
    resetCatalogs()
  })

  afterEach(() => {
    setCatalog('en', en)
    setCatalog('zh', zh)
  })

  it('emits English, not a raw key, into the model-facing message', async () => {
    const message = await systemMessage('/clear', ['clear'])

    expect(message.message).toBe(en['slash.out.cleared'])
    expect(message.message).not.toContain('slash.out.')
  })

  it('interpolates into the resident English rather than dropping the value', async () => {
    const message = await systemMessage('/rename my-feature', ['rename'])

    expect(message.message).toBe(
      en['slash.out.renamed'].replace('{title}', 'my-feature'),
    )
  })

  it('keeps every migrated command free of raw keys', async () => {
    for (const [input, commands] of [
      ['/help', ['help']],
      ['/clear', ['clear']],
      ['/mcp', ['mcp']],
      ['/model', ['model']],
      ['/status', ['status']],
      ['/nope', ['help']],
    ] as const) {
      const message = await systemMessage(input, [...commands])
      expect(message.message, `${input} rendered a raw key`).not.toMatch(
        /slash\.(out|builtin)\./,
      )
    }
  })

  it('still shows an English picker hint for a built-in', () => {
    // Built-ins carry a key and no English on the wire, so an unloaded
    // catalog would otherwise render a blank hint.
    const builtin = {
      name: 'help',
      blurbKey: 'slash.builtin.help',
      kind: 'builtin',
    } as const

    expect(slashCommandDescription(builtin, createTranslate('zh'))).toBe(
      en['slash.builtin.help'],
    )
  })
})

describe('slash output — degradation', () => {
  it('falls back to the English message when a key is unknown to this build', async () => {
    // A persisted transcript or a differently-versioned worker can carry a key
    // this build no longer has. Rendering it raw would put a dotted string in
    // the transcript; a half-translated message would read as a bug. Neither:
    // show the English the worker already composed.
    const message = await systemMessage('/clear', ['clear'])
    const stale: NoticeRow = {
      ...message,
      i18nContent: [{ key: 'slash.out.thisKeyIsGone' }],
    }

    expect(rendered(stale, 'zh')).toBe(message.message)
  })

  it('renders the English message when no parts are attached at all', () => {
    const plain = {
      type: 'system',
      subtype: 'informational',
      uuid: 'u1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: 'plain text, no parts',
    } as NoticeRow

    expect(rendered(plain, 'zh')).toBe('plain text, no parts')
  })

  it('carries parts alongside the English text, never instead of it', async () => {
    // `message` must stay a string: serializeMessageForBridge returns null for
    // a non-string, and the message would vanish from the model's request.
    const message = await systemMessage('/status', ['status'])

    expect(typeof message.message).toBe('string')
    expect(Array.isArray(message.i18nContent)).toBe(true)
    expect(message.i18nContent!.length).toBeGreaterThan(0)
  })
})

describe('slash output — the path AssistantUiThread actually renders', () => {
  // Asserted at the threading level, through the exact pair of calls AssistantUiThread makes: fails if `t` is dropped
  // from either.
  function stateWith(
    messages: NoticeRow[],
  ): BrowserRuntimeClientState {
    return {
      status: 'ready',
      snapshot: null,
      transcriptMessages: messages,
      liveEvents: [],
      lastError: null,
      pendingPrompt: null,
      pendingPromptId: null,
    } as unknown as BrowserRuntimeClientState
  }

  function renderedContent(messages: ThreadMessageLike[]): string {
    return messages
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
  }

  it('renders a PERSISTED slash message translated, via the heavy memo', async () => {
    const message = await systemMessage('/clear', ['clear'])
    const state = stateWith([message])

    // Exactly what AssistantUiThread does: heavy transcript conversion, then
    // the cheap combine.
    const transcript = convertTranscriptToThreadMessages(
      state.transcriptMessages,
      undefined,
      createTranslate('zh'),
    )
    const out = combineThreadMessages(transcript, state, createTranslate('zh'))

    expect(renderedContent(out)).toContain(zh['slash.out.cleared'])
    expect(renderedContent(out)).not.toContain(en['slash.out.cleared'])
  })

  it('translates through the whole-state entry point too', async () => {
    const message = await systemMessage('/clear', ['clear'])

    const out = convertBrowserRuntimeStateToThreadMessages(
      stateWith([message]),
      createTranslate('zh'),
    )

    expect(renderedContent(out)).toContain(zh['slash.out.cleared'])
  })

  it('still renders English when no translator is threaded through', async () => {
    // The parameter is optional for non-UI callers; they must keep getting
    // the English `message` rather than nothing.
    const message = await systemMessage('/clear', ['clear'])

    const out = convertBrowserRuntimeStateToThreadMessages(stateWith([message]))

    expect(renderedContent(out)).toContain(en['slash.out.cleared'])
  })

  it('keeps the copy text translated — the copy button reads this output', async () => {
    // assistant-ui derives the clipboard from ThreadMessageLike.content, not
    // the DOM, which is why translation lives in the adapter and not in a
    // component.
    const message = await systemMessage('/rename my-feature', ['rename'])

    const out = convertBrowserRuntimeStateToThreadMessages(
      stateWith([message]),
      createTranslate('zh'),
    )

    expect(renderedContent(out)).toBe(
      zh['slash.out.renamed'].replace('{title}', 'my-feature'),
    )
  })
})

describe('slash output — the call site that actually broke', () => {
  // The adapter tests above pin the CONTRACT (pass `t`, get translation).
  // They cannot see the defect that shipped: `AssistantUiThread` simply did
  // not pass `t` to the heavy transcript memo, so every persisted slash
  // message rendered English while every unit test passed. A source guard is
  // the cheap way to pin a call site no unit test reaches — same technique
  // `module-split-boundaries.test.ts` uses for import edges.
  const source = readFileSync(
    join(__dirname, '..', 'browser', 'webview', 'AssistantUiThread.tsx'),
    'utf8',
  )

  it('threads the translator into the heavy transcript conversion', () => {
    const call = source.match(
      /convertTranscriptToThreadMessages\(([\s\S]{0,200}?)\)/,
    )
    expect(call, 'call not found — was it renamed?').toBeTruthy()
    expect(
      call![1],
      'AssistantUiThread must pass `t` to convertTranscriptToThreadMessages, '
        + 'or persisted slash output renders English in every locale.',
    ).toMatch(/\bt,?\s*$/)
  })

  it('threads the translator into the combine layer', () => {
    expect(
      source,
      'AssistantUiThread must pass `t` to combineThreadMessages.',
    ).toMatch(/combineThreadMessages\(transcriptThreadMessages,\s*state,\s*t\)/)
  })

  it('keys both memos on the translator', () => {
    // `t` is read inside both callbacks; omitting it from the dep arrays
    // leaves a stale-locale render behind a locale change.
    expect(source).toMatch(
      /\[state\.transcriptMessages,\s*liveHaltedToolCallIds,\s*t\]/,
    )
    expect(source).toMatch(
      /\[transcriptThreadMessages,\s*t,\s*\.\.\.combineThreadMessagesDeps\(state\)\]/,
    )
  })
})
