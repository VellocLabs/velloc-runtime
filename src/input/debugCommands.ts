/**
 * The hidden `/debug` command family (see {@link HIDDEN_BROWSER_SLASH_COMMANDS}):
 * the bundled `debug` skill by default, plus reserved diagnostic subcommands.
 */

import type { ToolCallContext } from '../toolkit/toolCallContext'
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
} from '../runtime/interfaces/UserInputPipeline'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { Message, SystemMessagePart } from '../runtime/RuntimeTypes'
import type { MessageKey } from '../browser/webview/i18n/messages/en'
import { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import {
  getProductName,
  getProductNameOverride,
  setProductNameOverride,
} from '../branding/productName'
import {
  createLocalizedSystemMessage,
  makeNoticeRow,
} from '../messages/messageFactories'
import {
  getConversationTranscriptPath,
  resolveSessionStorageBase,
} from '../utils/conversationStoragePaths'
import {
  formatTranscriptDebugReport,
  parseTranscriptFile,
} from '../utils/transcriptDebug'
import {
  disableDebugLogging,
  startTraceCapture,
  isTraceCapturing,
} from '../utils/debugLog'
import { getWorkerLogBuffer } from '../utils/workerLogBuffer'
import { isInternalUser, setInternalUser } from '../utils/internalUser'
import { fsForContext, type RuntimeFs } from '../utils/fs/runtimeFs'
import { readUserLayer, updateAgentSettings } from '../settings/settingsStore'
import { dispatchSkillSlashCommand } from './skillSlashCommand'
import type { HiddenBrowserSlashCommand } from './slashCommandCatalog'
import { key, text, title } from './systemMessageParts'

/** Shared shape for every `/debug` entry point that needs host capabilities. */
export type DebugCommandOptions = {
  hostBridge: BrowserHostBridge
  runtimeConfig: RuntimeConfig
  settingsHomeDir?: string
}

/**
 * Resolve the on-disk transcript path for the current session, mirroring the
 * storage layer's routing (`resolveSessionStorageBase`: the routed base the
 * session was booted with — nested for a teammate / sub-agent — else
 * `projectHomeFor(homeDir, projectRoot)`) → `getConversationTranscriptPath`.
 * Returns null when neither is resolved (mock / dev hosts), where the session
 * isn't persisted to a stable project-grouped path.
 */
function resolveTranscriptPath(context: ToolCallContext): string | null {
  const { sessionId, homeDir, projectRoot, sessionStorageBase } =
    context.options
  if (!sessionId) return null
  const base = resolveSessionStorageBase({
    storageBase: sessionStorageBase,
    homeDir,
    projectRoot,
  })
  return base ? getConversationTranscriptPath(base, sessionId) : null
}

/**
 * `/debug transcript` — the deterministic transcript analyzer. Produces a
 * per-compaction-segment size/tool/token report with NO model turn; the
 * whole "why is my context heavy" answer is computed locally.
 */
async function handleDebugTranscriptSubcommand(
  rawInput: string,
  params: ProcessUserInputParams,
  runtimeConfig: RuntimeConfig,
): Promise<ProcessUserInputResult> {
  // Read the transcript from disk (`transcript.jsonl`) so the scan covers
  // the FULL on-disk history — not just what's currently in memory. The
  // in-memory transcript (`context.messages`, the source `/cost` reads) is
  // the fallback when the file can't be read (a brand-new session not yet
  // flushed, or a mock / dev host with no project-grouped store).
  const transcriptPath = resolveTranscriptPath(params.context)
  let messages: readonly Message[] | undefined
  let source: string | undefined
  let fileBytes: number | undefined
  let duplicateCount: number | undefined
  let malformedLines: number | undefined
  if (transcriptPath) {
    try {
      const text = await fsForContext(params.context).readFile(transcriptPath, {
        encoding: 'utf-8',
      })
      const raw = typeof text === 'string' ? text : ''
      const parsed = parseTranscriptFile(raw)
      messages = parsed.messages
      duplicateCount = parsed.duplicateCount
      malformedLines = parsed.malformedLines
      // Exact on-disk size, measured from the bytes we already read — no
      // extra stat round-trip, and it captures what parsing skipped.
      fileBytes = new TextEncoder().encode(raw).length
      source = 'disk'
    } catch {
      // File missing / unreadable — fall through to the in-memory tail.
    }
  }
  if (messages === undefined) {
    messages = params.context.messages ?? params.messages ?? []
    source = transcriptPath
      ? 'in-memory (transcript file not readable yet)'
      : 'in-memory (no on-disk store on this host)'
  }
  const report = formatTranscriptDebugReport(messages, {
    sessionId: params.context.options.sessionId,
    transcriptPath,
    source,
    fileBytes,
    duplicateCount,
    malformedLines,
  })
  return {
    messages: [makeNoticeRow(runtimeConfig, report)],
    shouldQuery: false,
    resultText: rawInput,
  }
}

/** The two developer flags `/debug` can toggle, keyed by subcommand name. */
const DEBUG_FLAG_SUBCOMMANDS = {
  verbose: {
    field: 'log',
    label: 'Verbose logging (agent.log)',
    detail: 'model request/response logging to the console',
  },
  trace: {
    field: 'trace',
    label: 'Trace overlay (agent.trace)',
    detail: 'the in-page model-upload trace view',
  },
} as const

type DebugFlagSubcommand = keyof typeof DEBUG_FLAG_SUBCOMMANDS

/**
 * `/debug verbose [on|off]` / `/debug trace [on|off]`: show or persist the
 * developer flags in the `agent` section of settings.json; effective on the
 * next reload (explicit `?log=1` / `?trace=1` URL params still win).
 */
async function handleDebugFlagSubcommand(
  flag: DebugFlagSubcommand,
  value: 'on' | 'off' | undefined,
  rawInput: string,
  runtimeConfig: RuntimeConfig,
  settingsHomeDir: string | undefined,
  fs: RuntimeFs,
): Promise<ProcessUserInputResult> {
  const { field, label, detail } = DEBUG_FLAG_SUBCOMMANDS[flag]
  const reply = (text: string): ProcessUserInputResult => ({
    messages: [makeNoticeRow(runtimeConfig, text)],
    shouldQuery: false,
    resultText: rawInput,
  })

  if (!settingsHomeDir) {
    return reply(
      `Cannot resolve the settings home directory on this host — `
      + `/debug ${flag} needs a persistent settings.json.`,
    )
  }

  try {
    if (value === undefined) {
      const { settings } = await readUserLayer(settingsHomeDir, fs)
      const enabled = settings.agent?.[field] === true
      return reply(
        `${label} is ${enabled ? 'on' : 'off'} (${detail}).\n`
        + `Use /debug ${flag} on|off to change it; applies on the next reload.`,
      )
    }
    const next = value === 'on'
    await updateAgentSettings(settingsHomeDir, fs, prev => ({
      ...(prev ?? {}),
      [field]: next,
    }))
    return reply(
      `${label} ${next ? 'enabled' : 'disabled'} (${detail}).\n`
      + `Takes effect on the next reload.`,
    )
  } catch (error) {
    return reply(
      `Failed to ${value === undefined ? 'read' : 'update'} ${label}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * `/debug inspect [on|off]`: show or persist the C++-owned
 * `nexus.inspect_menu_enabled` pref (over the `ui` bridge). On, right-click
 * offers "Inspect" for the guest; off (default), no context menu. Immediate.
 */
async function handleDebugInspectSubcommand(
  value: 'on' | 'off' | undefined,
  rawInput: string,
  options: {
    runtimeConfig: RuntimeConfig
    hostBridge: BrowserHostBridge
  },
): Promise<ProcessUserInputResult> {
  const reply = (text: string): ProcessUserInputResult => ({
    messages: [makeNoticeRow(options.runtimeConfig, text)],
    shouldQuery: false,
    resultText: rawInput,
  })

  // Mock / dev hosts stub the bridge without the `ui` capability methods —
  // degrade to an explanatory message rather than a thrown TypeError.
  const ui = (options.hostBridge as Partial<BrowserHostBridge>).ui
  if (
    typeof ui?.getInspectMenuEnabled !== 'function'
    || typeof ui.setInspectMenuEnabled !== 'function'
  ) {
    return reply(
      '/debug inspect is unavailable on this host (no ui bridge capability).',
    )
  }

  try {
    if (value === undefined) {
      const { enabled } = await ui.getInspectMenuEnabled()
      return reply(
        `Inspect context menu is ${enabled ? 'on' : 'off'} `
        + `(right-click the panel → "Inspect" opens DevTools).\n`
        + `Use /debug inspect on|off to change it; applies immediately.`,
      )
    }
    const next = value === 'on'
    await ui.setInspectMenuEnabled({ enabled: next })
    return reply(
      next
        ? 'Inspect context menu enabled — right-click the panel and choose '
          + '"Inspect" to open DevTools. Applies immediately.'
        : 'Inspect context menu disabled — the panel shows no context menu '
          + 'again. Applies immediately.',
    )
  } catch (error) {
    return reply(
      `Failed to ${value === undefined ? 'read' : 'update'} the inspect `
      + `context menu setting: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * `/debug log [on|off]`: the live debug-capture switch for the worker log ring.
 * With every capture source off the ring collects nothing. In-memory and
 * session-lifetime, never persisted; effective on the next instrumented call.
 */
function handleDebugLogSubcommand(
  value: 'on' | 'off' | undefined,
  rawInput: string,
  runtimeConfig: RuntimeConfig,
): ProcessUserInputResult {
  const reply = (text: string): ProcessUserInputResult => ({
    messages: [makeNoticeRow(runtimeConfig, text)],
    shouldQuery: false,
    resultText: rawInput,
  })

  if (value === undefined) {
    const entries = getWorkerLogBuffer().drain()
    return reply(
      `Debug capture is ${isTraceCapturing() ? 'on' : 'off'} `
      + `(${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in the `
      + `worker log ring; nothing is collected while capture is off).\n`
      + `Use /debug log on|off to change it — takes effect immediately, `
      + `this session only.`,
    )
  }

  if (value === 'on') {
    const wasActive = startTraceCapture()
    return reply(
      wasActive
        ? 'Debug capture was already on.'
        : 'Debug capture enabled — [tool]/[query]/[mcp] instrumentation now '
          + 'lands in the worker log ring. Reproduce the issue, then run '
          + '/debug to diagnose. Turn off with /debug log off.',
    )
  }

  disableDebugLogging()
  return reply(
    'Debug capture disabled — the worker log ring stops collecting (and '
    + 'clears, unless the trace overlay is holding it open).',
  )
}

/** Parsed `/debug name …` action, or `undefined` when the tail doesn't match
 *  the subcommand grammar (unquoted multi-word text → fall through to the
 *  debug skill so issue descriptions like `/debug name resolution is broken`
 *  never get eaten — same philosophy as the other reserved subcommands). */
type DebugNameAction = { kind: 'clear' } | { kind: 'set'; name: string }

function parseDebugNameSubcommand(rest: string): DebugNameAction | undefined {
  // Bare `/debug name` (and the `reset` alias) cancel the override.
  if (rest === '' || rest === 'reset') return { kind: 'clear' }
  // Quoted form — required for names with spaces: /debug name "Velloc abc".
  // An empty quoted string (`/debug name ""`) also cancels. The body class
  // excludes the quote character itself so an odd tail like
  // `/debug name "a" "b"` does NOT greedily parse as `a" "b` — it falls
  // through to the debug skill, same as unquoted multi-word text.
  const quoted = /^"([^"]*)"$/s.exec(rest) ?? /^'([^']*)'$/s.exec(rest)
  if (quoted) {
    const name = quoted[1]!.trim()
    return name ? { kind: 'set', name } : { kind: 'clear' }
  }
  // Bare single token: /debug name Foo.
  if (!/\s/.test(rest)) return { kind: 'set', name: rest }
  return undefined
}

/**
 * `/debug name ["<name>"]`: override the product name the MODEL sees from the
 * next turn (bare, `""` or `reset` cancels). Persisted to
 * `agent.productNameOverride` and re-applied at boot. Page UI, host-side prose
 * and the runtime directory name are unaffected.
 */
async function handleDebugNameSubcommand(
  action: DebugNameAction,
  rawInput: string,
  runtimeConfig: RuntimeConfig,
  settingsHomeDir: string | undefined,
  fs: RuntimeFs,
): Promise<ProcessUserInputResult> {
  const reply = (text: string): ProcessUserInputResult => ({
    messages: [makeNoticeRow(runtimeConfig, text)],
    shouldQuery: false,
    resultText: rawInput,
  })

  // Persist to `agent.productNameOverride` (sparse: cleared = key removed).
  // Returns a suffix for the reply — empty on success, a note when the
  // change could not be saved and therefore lives only in this worker.
  const persist = async (name: string | undefined): Promise<string> => {
    if (!settingsHomeDir) {
      return '\nNote: no settings home directory on this host — the change '
        + 'is not persisted and lasts only until the next reload.'
    }
    try {
      await updateAgentSettings(settingsHomeDir, fs, prev => {
        const next = { ...(prev ?? {}) }
        if (name === undefined) delete next.productNameOverride
        else next.productNameOverride = name
        return next
      })
      return ''
    } catch (error) {
      return '\nWarning: failed to persist to settings.json ('
        + `${error instanceof Error ? error.message : String(error)}) — `
        + 'the change lasts only until the next reload.'
    }
  }

  if (action.kind === 'clear') {
    const hadOverride = getProductNameOverride() !== undefined
    setProductNameOverride(undefined)
    const note = await persist(undefined)
    return reply(
      hadOverride
        ? `Product-name override cleared — back to "${getProductName()}" `
          + `from the next turn.${note}`
        : `No product-name override was active — the name is `
          + `"${getProductName()}".${note}`,
    )
  }

  setProductNameOverride(action.name)
  const note = await persist(action.name)
  return reply(
    `Product name overridden to "${action.name}" — the model is called that `
    + `everywhere the brand appears in its prompts, starting next turn. `
    + `Saved to settings.json; cancel with /debug name (or /debug name "").${note}`,
  )
}

/**
 * `/debug internal [on|off]`: internal-user mode, which decides whether
 * sub-agents may spawn nested agents (bounded by MAX_SUBAGENT_DEPTH; off by
 * default). Immediate and persisted to `agent.internalUser` (off removes it).
 */
async function handleDebugInternalSubcommand(
  value: 'on' | 'off' | undefined,
  rawInput: string,
  runtimeConfig: RuntimeConfig,
  settingsHomeDir: string | undefined,
  fs: RuntimeFs,
): Promise<ProcessUserInputResult> {
  // Translatable parts: the transcript shows these in the user's language,
  // the model reads the English rendering (see ./systemMessageParts.ts).
  const reply = (parts: SystemMessagePart[]): ProcessUserInputResult => ({
    messages: [createLocalizedSystemMessage(runtimeConfig, parts)],
    shouldQuery: false,
    resultText: rawInput,
  })

  if (value === undefined) {
    return reply([
      key(
        isInternalUser()
          ? 'slash.out.debug.internal.statusOn'
          : 'slash.out.debug.internal.statusOff',
      ),
      text('\n'),
      key('slash.out.debug.internal.statusHint'),
    ])
  }

  const next = value === 'on'
  setInternalUser(next)

  // Persist to `agent.internalUser` (sparse: off = key removed). Leaves a
  // note for the reply only when the change could not be saved and therefore
  // lives only in this worker realm.
  let note: SystemMessagePart | undefined
  if (!settingsHomeDir) {
    note = key('slash.out.debug.notPersisted')
  } else {
    try {
      await updateAgentSettings(settingsHomeDir, fs, prev => {
        const updated = { ...(prev ?? {}) }
        if (next) updated.internalUser = true
        else delete updated.internalUser
        return updated
      })
      // Saved: the boot overlay now agrees with this value.
      setInternalUser(next, true)
    } catch (error) {
      note = key('slash.out.debug.persistFailed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return reply([
    key(
      next
        ? 'slash.out.debug.internal.enabled'
        : 'slash.out.debug.internal.disabled',
    ),
    ...(note ? [text('\n'), note] : []),
  ])
}

/**
 * `/debug status` — a one-glance summary of every debug-related switch and
 * the worker log ring state. Answers "is debug capture on?" without having to
 * remember which subcommand reports what.
 */
async function handleDebugStatusSubcommand(
  rawInput: string,
  options: DebugCommandOptions,
  fs: RuntimeFs,
): Promise<ProcessUserInputResult> {
  // Markdown, like every other slash listing: the transcript renders this
  // through the markdown renderer, where the old column-aligned lines
  // collapsed onto one (see systemMessageParts.ts, "Markdown layout").
  const lines: string[] = ['### Debug status', '']

  // 1. Live debug capture (the /debug log switch)
  const captureOn = isTraceCapturing()
  const entries = getWorkerLogBuffer().drain()
  lines.push(
    `- **log capture:** ${captureOn ? 'ON' : 'off'} (${entries.length} entries in ring)`,
  )

  // 2. Verbose + trace (settings.json, next reload)
  if (options.settingsHomeDir) {
    try {
      const { settings } = await readUserLayer(
        options.settingsHomeDir,
        fs,
      )
      lines.push(
        `- **verbose (log):** ${settings.agent?.log === true ? 'ON' : 'off'} (next reload)`,
        `- **trace overlay:** ${settings.agent?.trace === true ? 'ON' : 'off'} (next reload)`,
      )
    } catch {
      lines.push('- **verbose / trace:** (settings.json unreadable)')
    }
  } else {
    lines.push('- **verbose / trace:** (no settings home dir)')
  }

  // 2b. Internal-user mode (module flag + settings.json, immediate)
  lines.push(
    `- **internal user:** ${isInternalUser() ? 'ON (sub-agent nesting allowed)' : 'off (sub-agent nesting blocked)'} (immediate)`,
  )

  // 3. Inspect menu (C++ pref, immediate)
  const ui = (options.hostBridge as Partial<BrowserHostBridge>).ui
  if (typeof ui?.getInspectMenuEnabled === 'function') {
    try {
      const { enabled } = await ui.getInspectMenuEnabled()
      lines.push(`- **inspect menu:** ${enabled ? 'ON' : 'off'} (immediate)`)
    } catch {
      lines.push('- **inspect menu:** (read failed)')
    }
  } else {
    lines.push('- **inspect menu:** (unavailable on this host)')
  }

  // 4. Ring buffer time range
  if (entries.length > 0) {
    const oldest = new Date(entries[0]!.timeMs).toLocaleTimeString()
    const newest = new Date(entries[entries.length - 1]!.timeMs).toLocaleTimeString()
    lines.push(`- **ring time range:** ${oldest} – ${newest}`)
  }

  lines.push('')
  lines.push(
    captureOn
      ? 'Capture is ON — reproduce the issue, then run /debug to diagnose.'
      : 'Capture is off — run /debug log on to start collecting [tool]/[query] instrumentation.',
  )

  return {
    messages: [makeNoticeRow(options.runtimeConfig, lines.join('\n'))],
    shouldQuery: false,
    resultText: rawInput,
  }
}

/**
 * The `/debug` subcommands the usage listing names, in display order: the
 * literal syntax (protocol — never translated) and the catalog key for what
 * it does. The bare form's `[issue description]` argument is prose, so it is
 * composed separately in {@link debugUsageParts}.
 */
const DEBUG_USAGE_ROWS: ReadonlyArray<readonly [syntax: string, description: MessageKey]> = [
  ['/debug transcript', 'slash.out.debug.usage.transcript'],
  ['/debug status', 'slash.out.debug.usage.status'],
  ['/debug log [on|off]', 'slash.out.debug.usage.log'],
  ['/debug name ["<name>"]', 'slash.out.debug.usage.name'],
  ['/debug verbose [on|off]', 'slash.out.debug.usage.verbose'],
  ['/debug trace [on|off]', 'slash.out.debug.usage.trace'],
  ['/debug inspect [on|off]', 'slash.out.debug.usage.inspect'],
  ['/debug internal [on|off]', 'slash.out.debug.usage.internal'],
]

/** Usage listing shown when `/debug` can't dispatch (skill unavailable). */
function debugUsageParts(): SystemMessagePart[] {
  const parts: SystemMessagePart[] = [
    ...title(key('slash.out.debug.usage.title', { command: '/debug' })),
    text('\n\n- `/debug ['),
    key('slash.out.debug.usage.issueArg'),
    text(']` — '),
    key('slash.out.debug.usage.issue'),
  ]
  for (const [syntax, description] of DEBUG_USAGE_ROWS) {
    parts.push(text(`\n- \`${syntax}\` — `), key(description))
  }
  return parts
}

/**
 * `/debug` dispatcher: expands the bundled `debug` skill with the trailing text
 * as the issue, unless the text EXACTLY matches a reserved subcommand.
 */
async function handleDebugSlashCommand(
  args: string,
  rawInput: string,
  params: ProcessUserInputParams,
  options: DebugCommandOptions,
): Promise<ProcessUserInputResult> {
  const tokens = args.split(/\s+/).filter(Boolean)
  const [first, second] = tokens
  // THIS session's fs — never the realm-global slot (last writer wins).
  const fs = fsForContext(params.context)

  if (first === 'status' && tokens.length === 1) {
    return await handleDebugStatusSubcommand(rawInput, options, fs)
  }

  if (first === 'transcript' && tokens.length === 1) {
    return await handleDebugTranscriptSubcommand(
      rawInput,
      params,
      options.runtimeConfig,
    )
  }

  if (
    (first === 'verbose' || first === 'trace')
    && tokens.length <= 2
    && (second === undefined || second === 'on' || second === 'off')
  ) {
    return await handleDebugFlagSubcommand(
      first,
      second as 'on' | 'off' | undefined,
      rawInput,
      options.runtimeConfig,
      options.settingsHomeDir,
      fs,
    )
  }

  if (
    first === 'log'
    && tokens.length <= 2
    && (second === undefined || second === 'on' || second === 'off')
  ) {
    return handleDebugLogSubcommand(
      second as 'on' | 'off' | undefined,
      rawInput,
      options.runtimeConfig,
    )
  }

  if (first === 'name') {
    // Everything after the `name` token, quotes intact ("Velloc abc" keeps
    // its spaces). Non-matching tails (unquoted multi-word) return undefined
    // and fall through to the skill as an issue description.
    const rest = args.trim().slice('name'.length).trim()
    const nameAction = parseDebugNameSubcommand(rest)
    if (nameAction) {
      return await handleDebugNameSubcommand(
        nameAction,
        rawInput,
        options.runtimeConfig,
        options.settingsHomeDir,
        fs,
      )
    }
  }

  if (
    first === 'internal'
    && tokens.length <= 2
    && (second === undefined || second === 'on' || second === 'off')
  ) {
    return await handleDebugInternalSubcommand(
      second as 'on' | 'off' | undefined,
      rawInput,
      options.runtimeConfig,
      options.settingsHomeDir,
      fs,
    )
  }

  if (
    first === 'inspect'
    && tokens.length <= 2
    && (second === undefined || second === 'on' || second === 'off')
  ) {
    return await handleDebugInspectSubcommand(
      second as 'on' | 'off' | undefined,
      rawInput,
      options,
    )
  }

  // Default: the bundled `debug` skill (registered in
  // `src/skillLibrary/builtin/debugSkill.ts`; slash-only, so it is always available
  // when bundled skills are loaded). Shares `dispatchSkillSlashCommand`
  // with every other `/<skill-name>` so hooks / dynamic body / invoked-skill
  // accounting behave identically.
  const skillResult = await dispatchSkillSlashCommand({
    command: 'debug',
    args,
    rawInput,
    context: params.context,
    runtimeConfig: options.runtimeConfig,
  })
  if (skillResult) {
    return skillResult
  }

  return {
    messages: [
      createLocalizedSystemMessage(options.runtimeConfig, [
        key('slash.out.debug.skillUnavailable'),
        text('\n'),
        ...debugUsageParts(),
      ]),
    ],
    shouldQuery: false,
    resultText: rawInput,
  }
}

/**
 * Dispatch a hidden built-in slash command (see
 * {@link HIDDEN_BROWSER_SLASH_COMMANDS}). Kept separate from the visible-command
 * switch so hidden commands never leak into `/help` (which iterates the visible
 * supported set) — the only way to reach one is to type its full name.
 */
export async function handleHiddenSlashCommand(
  command: HiddenBrowserSlashCommand,
  args: string,
  rawInput: string,
  params: ProcessUserInputParams,
  options: DebugCommandOptions,
): Promise<ProcessUserInputResult> {
  switch (command) {
    case 'debug':
      return await handleDebugSlashCommand(args, rawInput, params, options)
    default:
      return {
        messages: [
          makeNoticeRow(
            options.runtimeConfig,
            `Unknown command: /${command}`,
          ),
        ],
        shouldQuery: false,
        resultText: rawInput,
      }
  }
}
