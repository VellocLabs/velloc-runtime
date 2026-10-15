import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'
import { SYSTEM_SUBTYPE_COMPACT_BOUNDARY } from '../runtime/VercelModelConstants'
import {
  type RuntimeFs,
  installProcessFs,
  resetProcessFs,
} from '../utils/fs/runtimeFs'
import { wipeSettingsMemos } from '../settings/settingsStore'
import {
  disableDebugLogging,
  startTraceCapture,
  isTraceCapturing,
} from '../utils/debugLog'
import {
  getProductName,
  getProductNameOverride,
  setProductNameOverride,
} from '../branding/productName'
import {
  _resetInternalUserForTests,
  applyPersistedInternalUser,
  isInternalUser,
  setInternalUser,
} from '../utils/internalUser'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'
import type { NoticeRow } from '../runtime/RuntimeTypes'
import { formatSystemMessage } from '../browser/webview/assistantUiAdapterParts'
import { createTranslate } from '../browser/webview/i18n/translate'
import { en } from '../browser/webview/i18n/messages/en'
import { ja } from '../browser/webview/i18n/messages/ja'
import { zh } from '../browser/webview/i18n/messages/zh'

function stubHostBridge(): BrowserHostBridge {
  return {} as unknown as BrowserHostBridge
}

/** Host bridge stub exposing the `ui` inspect-menu pref methods, recording
 *  calls the way the C++ `NexusUiBridgeAdapter` would receive them. */
function stubInspectHostBridge(initial: boolean): BrowserHostBridge & {
  setCalls: boolean[]
} {
  const state = { enabled: initial }
  const setCalls: boolean[] = []
  return {
    setCalls,
    ui: {
      getInspectMenuEnabled: async () => ({ enabled: state.enabled }),
      setInspectMenuEnabled: async (payload: { enabled: boolean }) => {
        state.enabled = payload.enabled
        setCalls.push(payload.enabled)
        return { ok: true as const, enabled: payload.enabled }
      },
    },
  } as unknown as BrowserHostBridge & { setCalls: boolean[] }
}

function assistantWithRead(id: string, path: string): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        {
          type: 'tool-call',
          toolCallId: id,
          toolName: 'Read',
          args: { file_path: path },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  }
}

function toolResult(id: string, name: string, size: number): Message {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: name,
          result: 'x'.repeat(size),
        },
      ],
    },
  }
}

function boundary(): Message {
  return { type: 'system', subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY, message: '' }
}

/** Install an fs stub whose readFile returns `text` (or throws when null). */
function stubReadFile(text: string | null): void {
  installProcessFs({
    async readFile() {
      if (text === null) throw new Error('ENOENT')
      return text
    },
  } as unknown as RuntimeFs)
}

/** Fs stub for the settings write path: readFile serves `settingsText`
 *  (throws when null → load falls back to defaults), writeFile captures. */
function stubSettingsFs(settingsText: string | null): {
  writes: Array<{ path: string; content: string }>
} {
  const writes: Array<{ path: string; content: string }> = []
  installProcessFs({
    async readFile() {
      if (settingsText === null) throw new Error('ENOENT')
      return settingsText
    },
    async mkdir() {},
    async writeFile(path: string, content: string) {
      writes.push({ path, content })
    },
  } as unknown as RuntimeFs)
  return { writes }
}

function jsonl(messages: Message[]): string {
  return messages.map(m => JSON.stringify(m)).join('\n') + '\n'
}

function makeDebugSkill(
  overrides: Partial<ChromiumPromptCommand> = {},
): ChromiumPromptCommand {
  return {
    type: 'prompt',
    name: 'debug',
    description: 'Diagnose issues inside the nexus runtime',
    content: 'Debug the nexus runtime. Issue: $ARGUMENTS',
    path: '/skills/debug/SKILL.md',
    loadedFrom: 'bundled',
    source: 'bundled',
    baseDir: '/skills/debug',
    ...overrides,
  }
}

function makeContext(
  messages: Message[],
  commands: ChromiumPromptCommand[] = [],
): ToolCallContext {
  const context = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'sess',
    cwd: '/w',
    projectRoot: '/proj/root',
    commands,
  })
  context.options.homeDir = '/home/u'
  context.messages = messages
  return context
}

const runtimeConfig = new BrowserRuntimeConfig()

function run(
  input: string,
  context: ToolCallContext,
  options: {
    hostBridge?: BrowserHostBridge
    settingsHomeDir?: string
  } = {},
) {
  return processUserInput(
    { input, context },
    {
      hostBridge: options.hostBridge ?? stubHostBridge(),
      runtimeConfig,
      // `debug` is a hidden command — deliberately NOT in the supported set.
      supportedSlashCommands: ['help', 'model'],
      settingsHomeDir: options.settingsHomeDir,
    },
  )
}

type SlashMessage = {
  type: string
  message: string | { content: string | Array<{ text: string }> }
  isMeta?: boolean
}

/** The system-message payload emitted after the visible user echo. */
function reportOf(out: { messages: Message[] }): string {
  return (out.messages[1] as unknown as { message: string }).message
}

/** The meta user message carrying an expanded skill body, if any. */
function metaUserTextOf(out: { messages: Message[] }): string | undefined {
  const meta = (out.messages as unknown as SlashMessage[]).find(
    m => m.type === 'user' && m.isMeta === true,
  )
  if (!meta) return undefined
  const content = (meta.message as { content: string | Array<{ text: string }> })
    .content
  return typeof content === 'string' ? content : content[0]!.text
}

afterEach(() => {
  resetProcessFs()
  // The settings layer caches per-source loads (dropped only on write);
  // reset so each test's fs stub is actually consulted.
  wipeSettingsMemos()
  // The debug-capture switch is module-global — don't leak it across tests.
  disableDebugLogging()
  // So is the product-name override.
  setProductNameOverride(undefined)
  // And the internal-user mode flag.
  setInternalUser(false)
})

describe('processUserInput — /debug transcript (deterministic diagnostics)', () => {
  it('reads the transcript from disk and reports per-segment stats', async () => {
    const onDisk: Message[] = [
      assistantWithRead('t1', '/a.ts'),
      toolResult('t1', 'Read', 500),
      boundary(),
      assistantWithRead('t2', '/b.ts'),
      toolResult('t2', 'Grep', 300),
    ]
    stubReadFile(jsonl(onDisk))
    // Context messages are intentionally EMPTY — the report must come from disk.
    const out = await run('/debug transcript', makeContext([]))
    expect(out.shouldQuery).toBe(false)
    expect(out.messages).toHaveLength(2)
    expect(out.messages[0]!.type).toBe('user')
    const report = reportOf(out)
    expect(report).toContain('| Source | disk |')
    expect(report).toContain('| File size |')
    expect(report).toContain('2 compaction segment(s)')
    expect(report).toContain('Read 500 B')
    expect(report).toContain('Grep 300 B')
    // Transcript path (its old /localpath job) rides in the header.
    expect(report).toContain('/home/u')
    expect(report).toContain('transcript.jsonl')
  })

  it('falls back to the in-memory transcript when the file is unreadable', async () => {
    stubReadFile(null) // readFile throws → fall back to context.messages
    const inMemory: Message[] = [
      assistantWithRead('t1', '/a.ts'),
      toolResult('t1', 'Read', 999),
    ]
    const out = await run('/debug transcript', makeContext(inMemory))
    const report = reportOf(out)
    expect(report).toContain('| Source | in-memory')
    expect(report).toContain('Read 999 B')
  })

  it('dispatches even though it is not in the supported (visible) set', async () => {
    stubReadFile(null)
    const out = await run('/debug transcript', makeContext([]))
    expect(reportOf(out)).not.toContain('Unknown')
  })

  it('handles an empty transcript gracefully', async () => {
    stubReadFile('')
    const out = await run('/debug transcript', makeContext([]))
    expect(reportOf(out)).toContain('No messages in this session yet')
  })
})

describe('processUserInput — /debug (bundled skill by default)', () => {
  it('dispatches the bundled debug skill when no subcommand is given', async () => {
    stubReadFile(null)
    const out = await run('/debug', makeContext([], [makeDebugSkill()]))
    // Skill dispatch = meta user message with the expanded body + a model turn.
    expect(out.shouldQuery).toBe(true)
    const body = metaUserTextOf(out)
    expect(body).toBeDefined()
    expect(body).toContain('Debug the nexus runtime')
  })

  it('passes trailing text to the skill as the issue description', async () => {
    stubReadFile(null)
    const out = await run(
      '/debug the worker keeps hanging',
      makeContext([], [makeDebugSkill()]),
    )
    expect(out.shouldQuery).toBe(true)
    expect(metaUserTextOf(out)).toContain('the worker keeps hanging')
  })

  it('routes near-miss subcommand phrases to the skill, not the subcommand', async () => {
    stubReadFile(null)
    // `trace overlay is broken` starts with the reserved word `trace` but has
    // extra tokens — it must reach the skill as an issue description.
    const out = await run(
      '/debug trace overlay is broken',
      makeContext([], [makeDebugSkill()]),
    )
    expect(out.shouldQuery).toBe(true)
    expect(metaUserTextOf(out)).toContain('trace overlay is broken')
  })

  it('falls back to a usage message when the skill is not registered', async () => {
    stubReadFile(null)
    const out = await run('/debug', makeContext([], []))
    expect(out.shouldQuery).toBe(false)
    const report = reportOf(out)
    expect(report).toContain('### /debug usage')
    expect(report).toContain('/debug transcript')
    expect(report).toContain('/debug log [on|off]')
    expect(report).toContain('/debug name ["<name>"]')
    expect(report).toContain('/debug verbose [on|off]')
    expect(report).toContain('/debug inspect [on|off]')
  })
})

describe('processUserInput — /debug verbose|trace (settings.json flags)', () => {
  it('persists agent.log via /debug verbose on', async () => {
    const { writes } = stubSettingsFs(null)
    const out = await run('/debug verbose on', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(out.shouldQuery).toBe(false)
    expect(reportOf(out)).toContain('Verbose logging (agent.log) enabled')
    expect(reportOf(out)).toContain('next reload')
    expect(writes).toHaveLength(1)
    const settings = JSON.parse(writes[0]!.content) as {
      agent?: { log?: boolean }
    }
    expect(settings.agent?.log).toBe(true)
  })

  it('persists agent.trace via /debug trace off, preserving other keys', async () => {
    const { writes } = stubSettingsFs(
      JSON.stringify({ version: 1, agent: { log: true, trace: true } }),
    )
    const out = await run('/debug trace off', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('Trace overlay (agent.trace) disabled')
    expect(writes).toHaveLength(1)
    const settings = JSON.parse(writes[0]!.content) as {
      agent?: { log?: boolean; trace?: boolean }
    }
    expect(settings.agent?.trace).toBe(false)
    expect(settings.agent?.log).toBe(true)
  })

  it('reports the current value when no on|off is given', async () => {
    stubSettingsFs(JSON.stringify({ version: 1, agent: { log: true } }))
    const out = await run('/debug verbose', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('Verbose logging (agent.log) is on')
  })

  it('defaults to off when settings.json is missing', async () => {
    stubSettingsFs(null)
    const out = await run('/debug trace', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('Trace overlay (agent.trace) is off')
  })

  it('degrades gracefully without a settings home dir', async () => {
    stubSettingsFs(null)
    const out = await run('/debug verbose on', makeContext([]))
    expect(reportOf(out)).toContain('settings home directory')
  })
})

describe('processUserInput — /debug log (live debug-capture switch)', () => {
  it('enables the capture switch via /debug log on', async () => {
    stubReadFile(null)
    disableDebugLogging()
    const out = await run('/debug log on', makeContext([]))
    expect(out.shouldQuery).toBe(false)
    expect(isTraceCapturing()).toBe(true)
    expect(reportOf(out)).toContain('Debug capture enabled')
    expect(reportOf(out)).toContain('/debug log off')
  })

  it('reports already-on without flipping anything', async () => {
    stubReadFile(null)
    startTraceCapture()
    const out = await run('/debug log on', makeContext([]))
    expect(reportOf(out)).toContain('already on')
    expect(isTraceCapturing()).toBe(true)
  })

  it('disables the capture switch via /debug log off', async () => {
    stubReadFile(null)
    startTraceCapture()
    const out = await run('/debug log off', makeContext([]))
    expect(isTraceCapturing()).toBe(false)
    expect(reportOf(out)).toContain('Debug capture disabled')
  })

  it('reports the current state when no on|off is given', async () => {
    stubReadFile(null)
    startTraceCapture()
    const out = await run('/debug log', makeContext([]))
    expect(reportOf(out)).toContain('Debug capture is on')
    disableDebugLogging()
    const off = await run('/debug log', makeContext([]))
    expect(reportOf(off)).toContain('Debug capture is off')
  })
})

describe('processUserInput — /debug status (one-glance switch summary)', () => {
  it('reports capture ON with a reproduce-then-diagnose hint', async () => {
    stubSettingsFs(JSON.stringify({ version: 1, agent: { log: true, trace: false } }))
    startTraceCapture()
    const out = await run('/debug status', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(out.shouldQuery).toBe(false)
    const report = reportOf(out)
    expect(report).toContain('### Debug status')
    expect(report).toContain('- **log capture:** ON')
    expect(report).toContain('- **verbose (log):** ON')
    expect(report).toContain('- **trace overlay:** off')
    expect(report).toContain('Capture is ON')
  })

  it('reports capture OFF with a hint to turn it on', async () => {
    stubSettingsFs(null)
    disableDebugLogging()
    const out = await run('/debug status', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    const report = reportOf(out)
    expect(report).toContain('- **log capture:** off')
    expect(report).toContain('- **verbose (log):** off')
    expect(report).toContain('Capture is off')
    expect(report).toContain('/debug log on')
  })

  it('reports the inspect-menu pref when the ui bridge is present', async () => {
    stubSettingsFs(null)
    disableDebugLogging()
    const out = await run('/debug status', makeContext([]), {
      hostBridge: stubInspectHostBridge(true),
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('- **inspect menu:** ON')
  })
})

describe('processUserInput — /debug name (persistent product-name override)', () => {
  it('sets a quoted multi-word override, applies it, and persists it', async () => {
    const { writes } = stubSettingsFs(null)
    const out = await run('/debug name "Velloc abc"', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(out.shouldQuery).toBe(false)
    expect(reportOf(out)).toContain('overridden to "Velloc abc"')
    expect(getProductNameOverride()).toBe('Velloc abc')
    expect(getProductName()).toBe('Velloc abc')
    expect(writes).toHaveLength(1)
    const settings = JSON.parse(writes[0]!.content) as {
      agent?: { productNameOverride?: string }
    }
    expect(settings.agent?.productNameOverride).toBe('Velloc abc')
  })

  it('sets a bare single-token override', async () => {
    stubSettingsFs(null)
    await run('/debug name Nexus', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(getProductName()).toBe('Nexus')
  })

  it('bare /debug name cancels the override and removes the persisted key', async () => {
    const { writes } = stubSettingsFs(
      JSON.stringify({
        version: 1,
        agent: { log: true, productNameOverride: 'Velloc abc' },
      }),
    )
    setProductNameOverride('Velloc abc')
    const out = await run('/debug name', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('override cleared')
    expect(getProductNameOverride()).toBeUndefined()
    expect(getProductName()).toBe('Velloc Code')
    expect(writes).toHaveLength(1)
    const settings = JSON.parse(writes[0]!.content) as {
      agent?: { log?: boolean; productNameOverride?: string }
    }
    expect(settings.agent).not.toHaveProperty('productNameOverride')
    // Sibling agent keys survive the read-modify-write.
    expect(settings.agent?.log).toBe(true)
  })

  it('/debug name "" (empty quoted) also cancels', async () => {
    stubSettingsFs(null)
    setProductNameOverride('Velloc abc')
    const out = await run('/debug name ""', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('override cleared')
    expect(getProductNameOverride()).toBeUndefined()
  })

  it('the reset alias still cancels', async () => {
    stubSettingsFs(null)
    setProductNameOverride('Velloc abc')
    const out = await run('/debug name reset', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('override cleared')
    expect(getProductNameOverride()).toBeUndefined()
  })

  it('cancelling when nothing is active says so', async () => {
    stubSettingsFs(null)
    const out = await run('/debug name', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('No product-name override was active')
  })

  it('degrades to worker-session-only without a settings home dir', async () => {
    stubReadFile(null)
    const out = await run('/debug name "Velloc abc"', makeContext([]))
    expect(getProductName()).toBe('Velloc abc')
    expect(reportOf(out)).toContain('not persisted')
  })

  it('routes unquoted multi-word text to the skill as an issue description', async () => {
    stubReadFile(null)
    const out = await run(
      '/debug name resolution keeps failing',
      makeContext([], [makeDebugSkill()]),
    )
    expect(out.shouldQuery).toBe(true)
    expect(metaUserTextOf(out)).toContain('name resolution keeps failing')
    expect(getProductNameOverride()).toBeUndefined()
  })

  it('routes an odd quoted tail to the skill instead of greedily parsing it as a name', async () => {
    stubReadFile(null)
    // Regression: /^"(.*)"$/ was greedy, so `"a" "b"` parsed as the name
    // `a" "b`. The quote-free body class makes it fall through to the skill,
    // consistent with the unquoted-multi-word philosophy.
    const out = await run(
      '/debug name "a" "b"',
      makeContext([], [makeDebugSkill()]),
    )
    expect(out.shouldQuery).toBe(true)
    expect(metaUserTextOf(out)).toContain('name "a" "b"')
    expect(getProductNameOverride()).toBeUndefined()
  })
})

describe('processUserInput — /debug internal (sub-agent nesting mode)', () => {
  it('reports off by default', async () => {
    stubReadFile(null)
    const out = await run('/debug internal', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(out.shouldQuery).toBe(false)
    expect(reportOf(out)).toContain('Internal-user mode is off')
    expect(reportOf(out)).toContain('cannot spawn nested agents')
    expect(isInternalUser()).toBe(false)
  })

  it('on: flips the module flag immediately AND persists agent.internalUser', async () => {
    const { writes } = stubSettingsFs(null)
    const out = await run('/debug internal on', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('Internal-user mode enabled')
    expect(isInternalUser()).toBe(true)
    expect(writes).toHaveLength(1)
    const settings = JSON.parse(writes[0]!.content) as {
      agent?: { internalUser?: boolean }
    }
    expect(settings.agent?.internalUser).toBe(true)
  })

  it('off: clears the flag and REMOVES the persisted key (sparse), keeping sibling agent keys', async () => {
    const { writes } = stubSettingsFs(
      JSON.stringify({
        version: 1,
        agent: { log: true, internalUser: true },
      }),
    )
    setInternalUser(true)
    const out = await run('/debug internal off', makeContext([]), {
      settingsHomeDir: '/home/u',
    })
    expect(reportOf(out)).toContain('Internal-user mode disabled')
    expect(isInternalUser()).toBe(false)
    expect(writes).toHaveLength(1)
    const settings = JSON.parse(writes[0]!.content) as {
      agent?: { log?: boolean; internalUser?: boolean }
    }
    expect(settings.agent).not.toHaveProperty('internalUser')
    // Sibling agent keys survive the read-modify-write.
    expect(settings.agent?.log).toBe(true)
  })

  it('degrades to worker-session-only without a settings home dir', async () => {
    stubReadFile(null)
    const out = await run('/debug internal on', makeContext([]))
    expect(isInternalUser()).toBe(true)
    expect(reportOf(out)).toContain('not persisted')
  })

  it('an unsaved flip survives the next runtime boot; a settings change still lands', async () => {
    // Every runtime boot (each background sub-agent included) runs the
    // settings overlay. Assigning unconditionally reverted an unsaved flip at
    // the next agent spawn — the moment the flip exists for.
    _resetInternalUserForTests()
    applyPersistedInternalUser(false) // the session's own boot: key absent
    stubReadFile(null)
    await run('/debug internal on', makeContext([])) // no settings home
    expect(isInternalUser()).toBe(true)
    applyPersistedInternalUser(false) // a sub-agent boots; settings unchanged
    expect(isInternalUser()).toBe(true)
    // The key appearing in settings.json, then being cleared, still applies.
    applyPersistedInternalUser(true)
    expect(isInternalUser()).toBe(true)
    applyPersistedInternalUser(false)
    expect(isInternalUser()).toBe(false)
    _resetInternalUserForTests()
  })

  it('routes non-grammar tails to the skill as an issue description', async () => {
    stubReadFile(null)
    const out = await run(
      '/debug internal user mode seems broken',
      makeContext([], [makeDebugSkill()]),
    )
    expect(out.shouldQuery).toBe(true)
    expect(metaUserTextOf(out)).toContain('internal user mode seems broken')
    expect(isInternalUser()).toBe(false)
  })

  it('/debug status shows the internal-user row', async () => {
    stubReadFile(null)
    const off = await run('/debug status', makeContext([]))
    expect(reportOf(off)).toContain('**internal user:** off (sub-agent nesting blocked)')
    setInternalUser(true)
    const on = await run('/debug status', makeContext([]))
    expect(reportOf(on)).toContain('**internal user:** ON (sub-agent nesting allowed)')
  })
})

describe('processUserInput — /debug inspect (browser-pref via ui bridge)', () => {
  it('enables the inspect menu via /debug inspect on', async () => {
    stubReadFile(null)
    const hostBridge = stubInspectHostBridge(false)
    const out = await run('/debug inspect on', makeContext([]), { hostBridge })
    expect(out.shouldQuery).toBe(false)
    expect(hostBridge.setCalls).toEqual([true])
    expect(reportOf(out)).toContain('Inspect context menu enabled')
    expect(reportOf(out)).toContain('DevTools')
  })

  it('disables the inspect menu via /debug inspect off', async () => {
    stubReadFile(null)
    const hostBridge = stubInspectHostBridge(true)
    const out = await run('/debug inspect off', makeContext([]), { hostBridge })
    expect(hostBridge.setCalls).toEqual([false])
    expect(reportOf(out)).toContain('Inspect context menu disabled')
  })

  it('reports the current pref value when no on|off is given', async () => {
    stubReadFile(null)
    const hostBridge = stubInspectHostBridge(true)
    const out = await run('/debug inspect', makeContext([]), { hostBridge })
    expect(hostBridge.setCalls).toEqual([])
    expect(reportOf(out)).toContain('Inspect context menu is on')
  })

  it('degrades gracefully when the host bridge lacks the ui capability', async () => {
    stubReadFile(null)
    const out = await run('/debug inspect on', makeContext([]))
    expect(reportOf(out)).toContain('unavailable on this host')
  })
})

describe('/debug internal and the usage listing — catalog text', () => {
  // The model reads `message` (English, rendered from the catalog); the
  // transcript renders `i18nContent` in the user's locale. Pin both halves to
  // the catalog so neither can drift back to an inline literal.
  function noticeOf(out: { messages: Message[] }): NoticeRow {
    return out.messages[1] as unknown as NoticeRow
  }

  function keysOf(row: NoticeRow): string[] {
    return (row.i18nContent ?? []).flatMap(part => ('key' in part ? [part.key] : []))
  }

  afterEach(() => {
    _resetInternalUserForTests()
  })

  it('reports the mode from catalog keys, English to the model and translated in the UI', async () => {
    _resetInternalUserForTests()
    stubReadFile(null)
    const off = noticeOf(await run('/debug internal', makeContext([])))
    expect(off.message).toBe(
      `${en['slash.out.debug.internal.statusOff']}\n${en['slash.out.debug.internal.statusHint']}`,
    )
    expect(keysOf(off)).toEqual([
      'slash.out.debug.internal.statusOff',
      'slash.out.debug.internal.statusHint',
    ])
    expect(formatSystemMessage(off, createTranslate('zh'))).toBe(
      `${zh['slash.out.debug.internal.statusOff']}\n${zh['slash.out.debug.internal.statusHint']}`,
    )

    setInternalUser(true)
    const on = noticeOf(await run('/debug internal', makeContext([])))
    expect(on.message.startsWith(en['slash.out.debug.internal.statusOn'])).toBe(true)
  })

  it('confirms a saved change with one sentence and no note', async () => {
    stubSettingsFs(null)
    const on = noticeOf(
      await run('/debug internal on', makeContext([]), { settingsHomeDir: '/home/u' }),
    )
    expect(on.message).toBe(en['slash.out.debug.internal.enabled'])

    stubSettingsFs(null)
    const off = noticeOf(
      await run('/debug internal off', makeContext([]), { settingsHomeDir: '/home/u' }),
    )
    expect(off.message).toBe(en['slash.out.debug.internal.disabled'])
    expect(keysOf(off)).toEqual(['slash.out.debug.internal.disabled'])
  })

  it('appends the not-persisted note when there is no settings home', async () => {
    stubReadFile(null)
    const row = noticeOf(await run('/debug internal on', makeContext([])))
    expect(row.message).toBe(
      `${en['slash.out.debug.internal.enabled']}\n${en['slash.out.debug.notPersisted']}`,
    )
    expect(formatSystemMessage(row, createTranslate('ja'))).toBe(
      `${ja['slash.out.debug.internal.enabled']}\n${ja['slash.out.debug.notPersisted']}`,
    )
  })

  it('interpolates the write error into the persist-failed warning', async () => {
    installProcessFs({
      async readFile() {
        throw new Error('ENOENT')
      },
      async mkdir() {},
      async writeFile() {
        throw new Error('disk full')
      },
    } as unknown as RuntimeFs)
    const row = noticeOf(
      await run('/debug internal on', makeContext([]), { settingsHomeDir: '/home/u' }),
    )
    expect(row.message).toBe(
      `${en['slash.out.debug.internal.enabled']}\n`
      + en['slash.out.debug.persistFailed'].replace('{error}', 'disk full'),
    )
  })

  it('renders the usage listing from catalog keys, keeping command syntax verbatim', async () => {
    stubReadFile(null)
    const row = noticeOf(await run('/debug', makeContext([], [])))
    const usageKeys = [
      'slash.out.debug.usage.transcript',
      'slash.out.debug.usage.status',
      'slash.out.debug.usage.log',
      'slash.out.debug.usage.name',
      'slash.out.debug.usage.verbose',
      'slash.out.debug.usage.trace',
      'slash.out.debug.usage.inspect',
      'slash.out.debug.usage.internal',
    ] as const
    const product = getProductName()
    expect(row.message).toBe(
      [
        en['slash.out.debug.skillUnavailable'],
        `### ${en['slash.out.debug.usage.title'].replace('{command}', '/debug')}`,
        '',
        `- \`/debug [${en['slash.out.debug.usage.issueArg']}]\` — `
          + en['slash.out.debug.usage.issue'].replace('{product}', product),
        `- \`/debug transcript\` — ${en['slash.out.debug.usage.transcript']}`,
        `- \`/debug status\` — ${en['slash.out.debug.usage.status']}`,
        `- \`/debug log [on|off]\` — ${en['slash.out.debug.usage.log']}`,
        `- \`/debug name ["<name>"]\` — ${en['slash.out.debug.usage.name']}`,
        `- \`/debug verbose [on|off]\` — ${en['slash.out.debug.usage.verbose']}`,
        `- \`/debug trace [on|off]\` — ${en['slash.out.debug.usage.trace']}`,
        `- \`/debug inspect [on|off]\` — ${en['slash.out.debug.usage.inspect']}`,
        `- \`/debug internal [on|off]\` — ${en['slash.out.debug.usage.internal']}`,
      ].join('\n'),
    )
    expect(keysOf(row)).toEqual([
      'slash.out.debug.skillUnavailable',
      'slash.out.debug.usage.title',
      'slash.out.debug.usage.issueArg',
      'slash.out.debug.usage.issue',
      ...usageKeys,
    ])

    const zhText = formatSystemMessage(row, createTranslate('zh')) ?? ''
    expect(zhText).toContain(zh['slash.out.debug.usage.internal'])
    expect(zhText).toContain('`/debug internal [on|off]`')
    expect(zhText).not.toContain(en['slash.out.debug.usage.internal'])
  })
})
