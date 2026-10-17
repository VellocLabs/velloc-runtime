/**
 * Contract: `$`, the nouns this engine implements. A `$` call IS an event
 * (`noun.method`), raised through the chain from the top with the calling hook
 * skipped; the noun's implementation is core. What is not implemented is REFUSED BY
 * NAME (`NotSupportedError`), never a silent `undefined`. `e` is the call's argument
 * object. `modAdmission.RAISED_EVENTS` must list every noun (a test checks).
 */

import type { ModDispatcher } from './ModDispatcher'
import type { ModCall } from './ModInstance'
import type { ModFsAncestorsRequest, ModFsHost } from './modFs'
import {
  processRunInput,
  processSpawnInput,
  type ModProcessHost,
  type ModProcessRunInit,
  type ModProcessSpawnChunk,
  type ModProcessSpawnRequest,
  type ModProcessSpawnResult,
} from './modProcess'
import { refusedStream, type DispatchedStream } from './streamChain'
import { checkHttpFetchInput, httpFetchInput, type ModHttpHost } from './modHttp'
import {
  configValueFor,
  isConfigSetResult,
  isConfigValue,
  numberInputHint,
  numberOfInput,
  publicConfigRow,
  type ConfigRowSpec,
  type ConfigSetInput,
  type ConfigSetResult,
  type ConfigValue,
  type ModConfigDescriber,
  type ModConfigHost,
} from './modConfig'
import { modToolSpecOf } from './modRegisteredTools'
import { checkCallInput, checkConnectServer, mcpCallInput, mcpConnectInput, type ModMcpHost } from './modMcp'
import { modAgentSpawnArgsOf, modAgentSpecOf, type ModAgentHost, type ModAgentSpawnArgs, type ModAgentSpec } from './modAgents'
import {
  classifyWith,
  modelClassifyInput,
  modelCompleteInput,
  modelForkInput,
  type ModModelClassifyInput,
  type ModModelCompleteRequest,
  type ModModelCompleteResult,
  type ModModelHost,
} from './modModel'
import {
  isModStateAddress,
  toJsonData,
  type ModStateAddress,
  type ModStateRead,
  type ModStateSetResult,
} from './modState'
import type { ModStoreHost } from './modStore'
import { modCommandSpecOf, type ModCommandInfo, type ModCommandSpec } from './modCommands'
import { uiAskArgsOf, type ModUiAskArgs, type ModUiState } from './modUi'
import {
  uiCopy,
  uiCopyArgsOf,
  uiFocus,
  uiFocusArgsOf,
  uiScroll,
  uiScrollArgsOf,
  type ModPageCall,
  type ModPageHost,
  type UiCopyArgs,
  type UiFocusArgs,
  type UiScrollArgs,
} from './modPage'
import { uiBlit, uiBlitArgsOf, type UiBlitArgs } from './modBlit'
import { isPaneId } from './modRender'
import type { ModPane, ModPaneOpenArgs, ModPaneOpenResult } from './modPanes'
import type { ModToolHost } from './toolCallEvent'
import type { StoredRow } from './sessionAppendEvent'
import {
  audioPlayInput,
  audioSpeakInput,
  checkAudioPlayEvent,
  checkAudioSpeakEvent,
  playClip,
  speakText,
  type ModAudioHost,
} from './modAudio'
import {
  apiMessageRows,
  isSessionMessagesValue,
  isSessionUsage,
  sessionAppendArgsOf,
  sessionCompactArgsOf,
  sessionMessageRows,
  sessionMessagesArgsOf,
  sessionSendArgsOf,
  sessionUsageArgsOf,
  USAGE_BREAKDOWN_REFUSAL,
  type ModConversationHost,
  type ModConversationRaise,
  type ModTranscriptHost,
  type SessionAppendArgs,
  type SessionCompactArgs,
  type SessionSendArgs,
} from './sessionNouns'
import type { DispatchContext } from './modTypes'
import { isUiNotifyResult, uiNotifyArgsOf, uiNotifyCore, type ModNotifyHost } from './modNotify'
import { isUiViewResult, uiViewArgsOf, uiViewCore } from './modAgentView'
import { isSessionIdentity, promptMediaArgsOf, promptMediaOf, sessionIdentityOf, type PromptMediaArgs } from './modManagedReads'
import {
  pluginPromptArgsOf,
  promptComposeArgsOf,
  type ModPromptHost,
  type PluginPromptArgs,
  type PromptComposeArgs,
} from './promptNouns'
import {
  EMPTY_PROMPT_BOX,
  HEADLESS_COMPOSER,
  PROMPT_FILL_MODES,
  isPromptBox,
  promptFillArgsOf,
  promptSuggestArgsOf,
  withoutInvisible,
  type ModComposerHost,
  type PromptBox,
  type PromptFillArgs,
  type PromptFillMode,
  type PromptFillRefusal,
  type PromptFilled,
  type PromptSuggestArgs,
} from './modComposer'

/** `$.session.repo()`'s answer — `SessionRepo` in the declaration. */
export type ModSessionRepo = {
  /** "The repository's root, absolute: the main working tree's for a worktree." */
  root: string
  /** "The `origin` remote's URL as git has it (push URL preferred), or null." */
  remote: string | null
  /** "Whether the remote is one of the repositories this build treats as its
   *  own" — Velloc has no such list: always false. */
  internal: boolean
  /** "The repository the allowlist matched" — null, as `internal` is false. */
  name: string | null
}

/** `$.session.version()`'s answer — `SessionVersion` in the declaration. */
export type ModSessionVersion = {
  version: string
  base?: string
  builtAt?: string
}

/** What `$.settings.read({ source })` takes. */
export type ModSettingsSource = 'user' | 'project' | 'local' | 'flag' | 'policy'

/** `$.env` — "the environment of this process". Velloc's runtime is a guest
 *  with no process environment: see `ModRuntime` for the per-slot map that
 *  stands in, and F-25. */
export type ModEnvHost = {
  get(name: string): string | undefined
  set(name: string, value: string | undefined): void
}

/** What `$.state` needs: `ModStateStore` satisfies it. */
export type ModStateHost = {
  get(address: ModStateAddress): ModStateRead
  previous(address: ModStateAddress): unknown
  set(address: ModStateAddress, value: unknown, ifVersion?: number): ModStateSetResult
}

/** What the nouns need of the session they are served for. Everything beyond
 *  `id` and `cwd` is optional: a host that does not supply it has the noun
 *  refused at the call, by name — never answered with a guess. */
export type ModNounHost = {
  /** The session's id — `$.session.id()`. */
  id(): string
  /** The directory the session runs in, absolute — `$.session.cwd()`. */
  cwd(): string
  /** The project root, absolute — `$.session.root()`. Defaults to `cwd`. */
  root?(): string
  /** "The main loop's model, as `/model` shows it" — `$.session.model()`. */
  model?(): string
  /** "How many prompts the user has sent this session" — `$.session.turns()`. */
  turns?(): number
  /** The engine's version — `$.session.version()`. */
  version?(): ModSessionVersion
  /** The git repository `cwd` is inside, read on each call — `$.session.repo()`. */
  repo?(): Promise<ModSessionRepo | null>
  /** The resolved settings, or one source's — `$.settings.read()`. */
  settings?(args: { source?: ModSettingsSource }): Promise<unknown>
  /** `$.config.list` / `.set` — the enabled plugins' `userConfig` rows and
   *  their writer (`modConfig.ts`); `describe` is `config.describe` over
   *  them, which `ModRuntime` supplies. Absent: the noun is refused. */
  config?: ModConfigHost & { describe?: ModConfigDescriber }
  /** `$.env` — supplied by `ModRuntime` (a per-slot map) when the host has none. */
  env?: ModEnvHost
  /** `$.state` — the slot's versioned values; `ModRuntime` always supplies one. */
  state?: ModStateHost
  /** `$.store` — the calling plugin's own store, across sessions. `ModRuntime`
   *  supplies an in-memory one when the host has none. */
  store?: (plugin: string) => ModStoreHost
  /** The session's tools — `$.tool`. Absent where there is no engine to run
   *  them (a test's bare host): the noun is then refused at the call. */
  tools?: ModToolHost
  /** `$.command` — the slot's registered commands and the engine's own;
   *  supplied by `ModRuntime`. */
  commands?: ModCommandHost
  /** `$.ui.status` / `.toast` / `.notice` — the slot's lines, supplied by
   *  `ModRuntime` (`modUi.ts`); `.ask` — the question raised as `tool.call`
   *  with the slot's dialog as core (`ModRuntime.askPerson`, `modAsk.ts`). */
  ui?: Pick<ModUiState, 'setStatus' | 'toast' | 'setNotice'> & {
    /** `$.ui.view`; absent where nothing draws (the noun is refused). */
    setView?: ModUiState['setView']
    ask?(plugin: string, args: ModUiAskArgs, raise: { context: DispatchContext; signal?: AbortSignal }): Promise<string>
  }
  /** `$.ui.open` / `.close` / `.panes` / `.invalidate` — the slot's panes
   *  and drawings, supplied by `ModRuntime`. */
  panes?: ModPaneHost
  /** `$.ui.copy` / `.focus` / `.scroll` — the clipboards, the focus ring and
   *  the windows of the page drawing the session (`modPage.ts`), supplied by
   *  `ModRuntime`. Absent: the nouns are refused by name. */
  page?: ModPageHost
  /** `$.turn.abort` — the engine's running turn; bound late like
   *  `tools`. Absent where there is no engine. */
  turn?: ModTurnHost
  /** `$.ui.notify` — the session's `Notification` hooks (`modNotify.ts`).
   *  Absent: none run, and the call still resolves. */
  notifications?: ModNotifyHost
  /** `$.fs` — the machine's files through the session's fs bridge (`modFs.ts`). Absent where there is no file system (a test's bare host). */
  fs?: ModFsHost
  /** `$.process.run` — a command on the host through the hosted Bash tool;
   *  `$.process.spawn` — a child streamed through `shell.spawn` (`modProcess.ts`). Absent where the session cannot run commands. */
  process?: ModProcessHost
  /** `$.http.fetch` — the bridge's `network.httpRequest` under the C++
   *  egress policy and the user's WebFetch deny rules (`modHttp.ts`). Absent:
   *  the host has no network route. */
  http?: ModHttpHost
  /** `$.audio.play` / `.speak` — sound through a Velloc window (`modAudio.ts`).
   *  Absent: the nouns are refused by name. */
  audio?: ModAudioHost
  /** `$.model.complete` / `.fork` / `.classify` — completions through the
   *  session's own client (`modModel.ts`); bound late like `tools`.
   *  (`model` is `$.session.model`'s getter above.) */
  completions?: ModModelHost
  /** `$.agent.register` / `.list` / `.spawn` — the Agent tool's types, the
   *  session's subagents, a spawn of the plugin's own (`modAgents.ts`);
   *  bound late like `tools`. */
  agents?: ModAgentHost
  /** `$.session.messages` / `.usage` — the engine's transcript and the
   *  status line's figures (`sessionNouns.ts`); bound late like `tools`. */
  transcript?: ModTranscriptHost
  /** `$.session.compact` / `.send` / `.append` — the plugin's own calls of
   *  the three events, raised by the engine (`sessionNouns.ts`); bound
   *  late like `tools`. */
  conversation?: ModConversationHost
  /** `$.prompt.submit` / `.compose` — a plugin's prompt queued as a turn of
   *  its own, the system prompt composed for nobody (`promptNouns.ts`); bound late like `tools`. */
  prompt?: ModPromptHost
  /** `$.mcp.call` / `.connect` — the engine's MCP servers (`modMcp.ts`). Absent where the session takes no MCP (`safe_code`). */
  mcp?: ModMcpHost
  /** `$.prompt.read` / `.fill` / `.suggest` — the person's prompt box, one
   *  round trip to the page each (`modComposer.ts`). `readsBox`: whether the
   *  plugin's module calls `$.prompt.read`, as scanned — the box a fill hands
   *  back goes to such a plugin alone. Absent: answered as headless. */
  composer?: ModComposerHost & { readsBox?(plugin: string): boolean }
}

/** What `$.turn` needs: "cancels the running model turn: the one whose id
 *  `turn.start` handed this plugin … Rejects, naming both ids, when `turnId`
 *  is not the running turn's". */
export type ModTurnHost = {
  abort(turnId: string): void | Promise<void>
}

/** What `$.ui`'s pane methods need. */
export type ModPaneHost = {
  /** Core of `ui.open`: the pane is open (or retitled), placed or waiting
   *  for a client that places it. */
  open(plugin: string, args: ModPaneOpenArgs): ModPaneOpenResult
  /** Core of `ui.close` for the plugin's own call: true when a pane went. */
  close(plugin: string, id: string): boolean
  /** "This plugin's own open panes." */
  list(plugin: string): ModPane[]
  /** `$.ui.invalidate('ui.render')`: the plugin's drawings are asked for
   *  again. Another event's cached answers: nothing is cached here. */
  invalidate(plugin: string, event: string): void
}

/** What `$.command` needs. */
export type ModCommandHost = {
  /** Register `/<spec.name>` as `plugin`'s. Returns the registered name. */
  register(spec: ModCommandSpec, plugin: string, seat?: string): string
  /** "The slash commands the person can run now, built-in, plugin and MCP
   *  alike, in the order the typeahead lists them." */
  list(): ModCommandInfo[]
  /** `$.command.run({ command, args })`: the event `command.run` as the
   *  plugin's own call. Rejects an unknown name. */
  run(
    input: { command: string; args: string },
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<unknown>
}

type NounContext = {
  call: ModCall
  session: ModNounHost
  report: (line: string) => void
  /** The chain, for a noun whose core is another `$` call (`model.classify`
   *  over `model.complete`). */
  dispatcher: ModDispatcher
}

type NounMethod = {
  /** The event's `e` from the call's positional arguments. Default: the first
   *  argument, or `{}` when there is none. */
  input?: (args: readonly unknown[]) => unknown
  /** The noun's own behaviour: core of its event. `e` is what ARRIVED at
   *  core — a hook above may have rewritten it. */
  run(e: unknown, context: NounContext): unknown
  /**
   * The noun raises its event ITSELF: `run` is called directly, with the
   * caller's context in hand, instead of being wrapped in a dispatch here.
   * `$.tool.call` is the one — its event has a core only the tool path can
   * supply (the permission flow, the tool), so the tool path raises it.
   */
  raisesItself?: true
  /** Whether a hook's answer is one the event takes. Default: not undefined. */
  accepts?: (result: unknown) => boolean
  /**
   * The noun's event STREAMS (`process.spawn`): the call is a stream the
   * caller reads (`serveNounStream`), not a promise. `run` is then core's
   * stream, its pieces and its result as the event's chunks and result.
   */
  streams?: true
}

const VOID: Pick<NounMethod, 'accepts'> = { accepts: () => true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function notSupported(message: string): never {
  const error = new Error(message)
  error.name = 'NotSupportedError'
  throw error
}

/** A host method that is optional: refused by name when the host lacks it. */
function hostMethod<K extends 'model' | 'turns' | 'version' | 'repo' | 'settings'>(
  session: ModNounHost,
  method: K,
  noun: string,
): NonNullable<ModNounHost[K]> {
  const fn = session[method]
  if (!fn) notSupported(`$.${noun} is not available: this session does not supply it`)
  return fn as NonNullable<ModNounHost[K]>
}

/** `{ ms }` from `$.clock.sleep(ms)` / `after(ms, fn)` / `every(ms, fn)`. The
 *  worker already sends `{ ms }`; a bare number is taken too. */
function clockWait(args: readonly unknown[]): { ms: number } {
  const first = args[0]
  const ms = isRecord(first) ? first.ms : first
  return { ms: typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0 }
}

/** The wait behind the three `$.clock` waits: `e.ms`, abandoned with the
 *  call. "A `$.clock` wait is the hook's own time" — ModInstance does not
 *  pause the budget for the `clock` noun. */
function wait(e: unknown, { call }: NounContext): Promise<void> {
  const ms = isRecord(e) && typeof e.ms === 'number' && e.ms > 0 ? e.ms : 0
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      const error = new Error('the wait was abandoned')
      error.name = 'AbortError'
      reject(error)
    }
    if (call.signal?.aborted) {
      abort()
      return
    }
    const timer = setTimeout(() => {
      call.signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    call.signal?.addEventListener('abort', abort, { once: true })
  })
}

function audioHost(session: ModNounHost): ModAudioHost {
  if (!session.audio) notSupported('$.audio is not available: no Velloc window can play sound for this session')
  return session.audio!
}

const SETTINGS_SOURCES: readonly string[] = ['user', 'project', 'local', 'flag', 'policy']

/** `noun` → `method` → implementation. Null-prototype: both names arrive from
 *  a worker. */
const NOUNS: Record<string, Record<string, NounMethod>> = Object.assign(Object.create(null), {
  session: Object.assign(Object.create(null), {
    id: { run: (_e: unknown, { session }: NounContext) => session.id() },
    cwd: { run: (_e: unknown, { session }: NounContext) => session.cwd() },
    // "The session's project root, absolute: where it started, or where
    // `/cd` … took it." Velloc's project root; the cwd where none is set.
    root: { run: (_e: unknown, { session }: NounContext) => session.root?.() ?? session.cwd() },
    model: { run: (_e: unknown, { session }: NounContext) => hostMethod(session, 'model', 'session.model')() },
    turns: { run: (_e: unknown, { session }: NounContext) => hostMethod(session, 'turns', 'session.turns')() },
    version: {
      run: (_e: unknown, { session }: NounContext) =>
        hostMethod(session, 'version', 'session.version')(),
    },
    // "Every surface the session draws on": Velloc draws on `desktop`, and
    // on nothing else — there is no terminal under it and no remote surface
    // that attaches as one (a remote client is the same `desktop` guest).
    surfaces: { run: () => ['desktop'], accepts: (result: unknown) => Array.isArray(result) },
    surface: { run: () => 'desktop', accepts: (result: unknown) => result !== undefined },
    // "To a mod the organization's managed settings install; `{ deny }` to
    // any other. No request is made" (`modManagedReads.ts`). A hook above
    // may answer for core.
    identity: {
      input: () => ({}),
      run: (_e: unknown, { call }: NounContext) => sessionIdentityOf(call.context.origin),
      accepts: isSessionIdentity,
    },
    repo: {
      run: (_e: unknown, { session }: NounContext) => hostMethod(session, 'repo', 'session.repo')(),
      // `null` is an answer: "null when the directory is not inside one".
      accepts: (result: unknown) => result !== undefined,
    },
    // `e` is `{ agentId?, as? }` (`sessionNouns.ts`). A guard above may
    // scrub what it answers, or deny another plugin's read.
    messages: {
      input: (args: readonly unknown[]) => sessionMessagesArgsOf(args[0]),
      run: async (e: unknown, { session }: NounContext) => {
        const { agentId, as } = sessionMessagesArgsOf(e)
        const host = transcriptHost(session, 'messages')
        let rows: readonly StoredRow[]
        if (agentId === undefined) {
          rows = host.rows()
        } else {
          const read = await host.agentRows(agentId)
          // "for an `agentId` the session cannot read, `{ deny }` … never main"
          if (!Array.isArray(read)) return read
          rows = read as readonly StoredRow[]
        }
        return as === 'api' ? apiMessageRows(rows) : sessionMessageRows(rows)
      },
      accepts: isSessionMessagesValue,
    },
    // `e` is `{ breakdown?, columns? }`; a breakdown adds `context.breakdown`.
    usage: {
      input: (args: readonly unknown[]) => sessionUsageArgsOf(args[0]),
      run: async (e: unknown, { session }: NounContext) => {
        const host = transcriptHost(session, 'usage')
        const { breakdown, columns } = sessionUsageArgsOf(e)
        const usage = host.usage()
        if (breakdown === undefined) return usage
        if (!host.breakdown) notSupported(USAGE_BREAKDOWN_REFUSAL)
        const rows = await host.breakdown(columns !== undefined ? { columns } : {})
        return { ...usage, context: { ...usage.context, breakdown: rows } }
      },
      accepts: isSessionUsage,
    },
    // `compact`, `send` and `append` are "the event `session.<x>`" itself,
    // the plugin's own call of it: the engine raises it with the caller's
    // context (the calling hook skipped), as `$.tool.call` raises `tool.call`.
    compact: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => sessionCompactArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) =>
        conversationHost(session, 'compact').compact(e as SessionCompactArgs, raiseOf(call)),
    },
    send: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => sessionSendArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) =>
        conversationHost(session, 'send').send(e as SessionSendArgs, raiseOf(call)),
    },
    append: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => sessionAppendArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) =>
        conversationHost(session, 'append').append(e as SessionAppendArgs, raiseOf(call)),
    },
  }),
  ui: Object.assign(Object.create(null), {
    // `e` is `{ text }`; "`text` undefined clears the line". A hook above may
    // rewrite the text. Shown as the calling plugin's line, whatever a hook
    // does to it.
    status: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        if (args[0] !== undefined && typeof args[0] !== 'string') {
          throw new TypeError('$.ui.status(text): text must be a string, or undefined to clear it')
        }
        return { text: args[0] }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const text = isRecord(e) ? e.text : undefined
        uiHost(session).setStatus(call.plugin, typeof text === 'string' ? text : undefined)
      },
    },
    // `e` is `{ text, timeoutMs? }`.
    toast: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        if (typeof args[0] !== 'string') throw new TypeError('$.ui.toast(text): text must be a string')
        const timeoutMs = isRecord(args[1]) ? args[1].timeoutMs : undefined
        if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
          throw new TypeError('$.ui.toast: timeoutMs must be a number')
        }
        return { text: args[0], ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const text = isRecord(e) && typeof e.text === 'string' ? e.text : ''
        const timeoutMs = isRecord(e) && typeof e.timeoutMs === 'number' ? e.timeoutMs : undefined
        uiHost(session).toast(call.plugin, text, timeoutMs)
      },
    },
    // `e` is `{ text, title? }`: the `Notification` hooks run, then no
    // channel writes on the desktop (`modNotify.ts`).
    notify: {
      input: (args: readonly unknown[]) => uiNotifyArgsOf(args[0], args[1]),
      run: (e: unknown, { call, session }: NounContext) => uiNotifyCore(e, call, session.notifications),
      accepts: isUiNotifyResult,
    },
    // `e` is `{ agentId? }`: the view published on the slot's state for the
    // page; an id that is no agent of this session is answered `{ deny }`
    // (`modAgentView.ts`).
    view: {
      input: (args: readonly unknown[]) => uiViewArgsOf(args[0]),
      run: (e: unknown, { session }: NounContext) => {
        const ui = uiHost(session)
        if (!ui.setView) return notSupported('$.ui.view is not available: this session draws nothing')
        const setView = ui.setView.bind(ui)
        return uiViewCore(e, session.agents, view => setView(view))
      },
      accepts: isUiViewResult,
    },
    // `e` is `{ tool_use_id, text }`; the id is identity, pinned.
    notice: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        if (typeof args[0] !== 'string' || args[0] === '') {
          throw new TypeError('$.ui.notice(tool_use_id, text): tool_use_id must be a non-empty string')
        }
        if (args[1] !== undefined && typeof args[1] !== 'string') {
          throw new TypeError('$.ui.notice(tool_use_id, text): text must be a string, or undefined to remove it')
        }
        return { tool_use_id: args[0], text: args[1] }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const text = isRecord(e) ? e.text : undefined
        uiHost(session).setNotice(call.plugin, call.args[0] as string, typeof text === 'string' ? text : undefined)
      },
    },
    // "Asks the user `question` in the engine's own AskUserQuestion dialog
    // and resolves to the label they chose, or the text typed under
    // 'Other' … A `tool.call` of `AskUserQuestion` through every hook but
    // the calling one." Raised by the host as `tool.call`, not as `ui.ask`
    // (`ModRuntime.askPerson`, `modAsk.ts`).
    ask: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiAskArgsOf(args[0], args[1]),
      run: (e: unknown, { call, session }: NounContext) => {
        const host = uiHost(session)
        if (!host.ask) return notSupported('$.ui.ask is not available: no one to ask in this session')
        return host.ask(call.plugin, e as ModUiAskArgs, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        })
      },
    },
    // "Puts `text` on the clipboard of a surface the session draws on …
    // Raised as `ui.copy` with that target on `e`": an op event whose
    // `{ deny }` is `reason: 'refused'`, so the noun raises it itself
    // (`modPage.ts`).
    copy: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiCopyArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => uiCopy(e as UiCopyArgs, pageCallOf(context, 'copy')),
    },
    // "Moves the focus ring of one of this plugin's sites onto an element it
    // drew there … Raised as `ui.focus`, origin `plugin`."
    focus: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiFocusArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => uiFocus(e as UiFocusArgs, pageCallOf(context, 'focus')),
    },
    // "Scrolls something into view as the DOM's `scrollIntoView` would … A
    // site of this plugin's … moves under the event `ui.scroll`."
    scroll: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiScrollArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => uiScroll(e as UiScrollArgs, pageCallOf(context, 'scroll')),
    },
    // "Repaints a mounted `Raster` … or swaps a keyed `Image`": raised as
    // `ui.blit`, its address and kind pinned; the desktop draws neither, so
    // core answers `{ deny }` (`modBlit.ts`).
    blit: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiBlitArgsOf(args[0]),
      run: (e: unknown, { call, dispatcher }: NounContext) =>
        uiBlit(e as UiBlitArgs, {
          plugin: call.plugin,
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
          dispatcher,
        }),
    },
    // "Show state without starting a turn": a line in the debug log. `e` is
    // `{ text, to }`; `to` is always `debug` here (nothing is drawn on screen
    // for it in Velloc), and a hook rewriting it changes nothing.
    log: {
      ...VOID,
      input: (args: readonly unknown[]) => ({
        text: typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]),
        to: 'debug',
      }),
      run: (e: unknown, { call, report }: NounContext) => {
        const text = isRecord(e) && typeof e.text === 'string' ? e.text : JSON.stringify(e)
        report(`${call.plugin}: ${text}`)
      },
    },
    // `$.ui.open({ id, title, focus, closeOnEscape, holdToasts, rows, columns })`
    // "a hook above the opener may retitle it or refuse it with
    // `{ deny }`, never rename it" — `id` is pinned. Core: the slot's roster.
    open: {
      input: (args: readonly unknown[]) => {
        const pane = args[0]
        if (!isRecord(pane) || !isPaneId(pane.id)) {
          throw new TypeError('$.ui.open(pane): pane.id must be 1-64 of letters, digits, _ and -')
        }
        if (pane.title !== undefined) {
          if (typeof pane.title !== 'string') throw new TypeError('$.ui.open: title must be a string')
          // eslint-disable-next-line no-control-regex
          if (/[\x00-\x1f\x7f]/.test(pane.title)) throw new TypeError('$.ui.open: title holds a control character')
        }
        for (const flag of ['focus', 'closeOnEscape', 'holdToasts'] as const) {
          if (pane[flag] !== undefined && pane[flag] !== true) throw new TypeError(`$.ui.open: ${flag} is true or absent`)
        }
        for (const size of ['rows', 'columns'] as const) {
          const value = pane[size]
          if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
            throw new TypeError(`$.ui.open: ${size} is a whole number of at least 1`)
          }
        }
        return {
          id: pane.id,
          ...(pane.title !== undefined ? { title: pane.title } : {}),
          ...(pane.focus === true ? { focus: true } : {}),
          ...(pane.closeOnEscape === true ? { closeOnEscape: true } : {}),
          ...(pane.holdToasts === true ? { holdToasts: true } : {}),
          ...(pane.rows !== undefined ? { rows: pane.rows } : {}),
          ...(pane.columns !== undefined ? { columns: pane.columns } : {}),
        }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const asked = call.args[0] as { id: string }
        const arrived = isRecord(e) ? e : {}
        const title = typeof arrived.title === 'string' ? arrived.title : undefined
        return paneHost(session).open(call.plugin, {
          ...(arrived as ModPaneOpenArgs),
          ...(title !== undefined ? { title } : {}),
          // Pinned: "`next(e)` passes it on" — a rename is ignored by core.
          id: asked.id,
        })
      },
      accepts: (result: unknown) => isRecord(result) && typeof result.isPlaced === 'boolean',
    },
    // `$.ui.close({ id })`: `e` is `{ id, origin: { kind: 'plugin' } }`; "a hook
    // that answers without `next` keeps the pane open". Core closes it.
    close: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        const pane = args[0]
        if (!isRecord(pane) || !isPaneId(pane.id)) throw new TypeError('$.ui.close(pane): pane.id must be a pane id')
        return { id: pane.id, origin: { kind: 'plugin' } }
      },
      run: (_e: unknown, { call, session }: NounContext) => {
        paneHost(session).close(call.plugin, (call.args[0] as { id: string }).id)
      },
    },
    // `$.ui.panes()`: "this plugin's own open panes … the engine's record".
    panes: {
      run: (_e: unknown, { call, session }: NounContext) =>
        paneHost(session)
          .list(call.plugin)
          .map(pane => ({
            id: pane.id,
            title: pane.title,
            isShown: pane.isShown,
            isFocused: pane.isFocused,
            isPlaced: pane.isPlaced,
          })),
      accepts: (result: unknown) => Array.isArray(result),
    },
    // `$.ui.invalidate(event)`: "re-runs an event whose results the engine
    // caches: `ui.render` draws the instances this plugin may draw again".
    invalidate: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        if (typeof args[0] !== 'string' || args[0] === '') throw new TypeError('$.ui.invalidate(event): event must be a string')
        return { event: args[0] }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const event = isRecord(e) && typeof e.event === 'string' ? e.event : (call.args[0] as string)
        paneHost(session).invalidate(call.plugin, event)
      },
    },
  }),
  // `$.prompt.submit` and `.compose` are "the event `prompt.<x>`" itself, the
  // plugin's own call of it: raised with the caller's context (the calling
  // hook skipped), as `$.tool.call` raises `tool.call`.
  prompt: Object.assign(Object.create(null), {
    submit: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => pluginPromptArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) =>
        promptHost(session, 'submit').submit(e as PluginPromptArgs, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        }),
    },
    // "The engine's own read, no event: no hook answers for it", for a
    // managed install alone (`modManagedReads.ts`).
    media: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => promptMediaArgsOf(args[0]),
      run: (e: unknown, { call }: NounContext) => promptMediaOf(e as PromptMediaArgs, call.context.origin),
    },
    // `read` is an op event: a hook above may scrub the box, or deny it.
    read: {
      input: () => ({}),
      run: (_e: unknown, { call, session }: NounContext) => composerHost(session).read(call.signal),
      accepts: isPromptBox,
    },
    // `fill` and `suggest` are the plugin's own calls of `prompt.fill` /
    // `prompt.suggest`, raised with its context, `origin` pinned.
    fill: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => promptFillArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => promptFill(e as PromptFillArgs, context),
    },
    suggest: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => promptSuggestArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => promptSuggest(e as PromptSuggestArgs, context),
    },
    compose: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => promptComposeArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) =>
        promptHost(session, 'compose').compose(e as PromptComposeArgs, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        }),
    },
  }),
  turn: Object.assign(Object.create(null), {
    // `$.turn.abort({ turnId })`: "the event `turn.abort`, seen by the hooks
    // above"; `turnId` is the question's identity, pinned. Core: the engine.
    abort: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        const input = args[0]
        if (!isRecord(input) || typeof input.turnId !== 'string' || input.turnId === '') {
          throw new TypeError('$.turn.abort({ turnId }): turnId must be a non-empty string')
        }
        return { turnId: input.turnId }
      },
      run: (_e: unknown, { call, session }: NounContext) => {
        if (!session.turn) return notSupported('$.turn.abort is not available: this session has no engine')
        return session.turn.abort((call.args[0] as { turnId: string }).turnId)
      },
    },
  }),
  tool: Object.assign(Object.create(null), {
    list: {
      run: (_e: unknown, { session }: NounContext) => toolHost(session, 'list').list(),
      accepts: (result: unknown) => Array.isArray(result),
    },
    call: {
      raisesItself: true as const,
      run: (e: unknown, { call, session }: NounContext) => {
        const host = toolHost(session, 'call')
        if (
          !isRecord(e) ||
          typeof (e as { tool?: unknown }).tool !== 'string' ||
          (e as { tool: string }).tool === ''
        ) {
          return Promise.reject(
            new TypeError('$.tool.call takes { tool: "<name>", ...arguments }'),
          )
        }
        return host.call(e as Record<string, unknown>, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        })
      },
    },
    // "Declares a tool the model can call from the next prompt on … a name
    // registered again is replaced." `e` is the spec with `inputSchema`
    // filled in; a hook above rewrites the description or the schema, never
    // the name (pinned to the caller's, as `command.register`).
    register: {
      input: (args: readonly unknown[]) => ({ ...modToolSpecOf(args[0]) }),
      run: (e: unknown, { call, session }: NounContext) => {
        const host = toolHost(session, 'register')
        if (!host.register) notSupported('$.tool.register is not available: this session does not list tools')
        const spec = modToolSpecOf({ ...(isRecord(e) ? e : {}), name: (call.args[0] as { name: string }).name })
        return { tool: host.register!(spec, call.plugin) }
      },
      accepts: (result: unknown) => isRecord(result) && typeof result.tool === 'string',
    },
    // "Asks the engine's permission decision for a tool call now: the event
    // `tool.check`, resolved to `{ decision, reason?, rule? }`. The hooks run
    // (the calling hook's own frame skipped, `next.origin` this plugin, no
    // `tool_use_id`); nothing runs, no dialog opens, no PreToolUse hook or
    // classifier is asked." Raised by the tool path, whose verdict is core.
    check: {
      raisesItself: true as const,
      run: (e: unknown, { call, session }: NounContext) => {
        const host = toolHost(session, 'check')
        if (
          !isRecord(e) ||
          typeof (e as { tool?: unknown }).tool !== 'string' ||
          (e as { tool: string }).tool === ''
        ) {
          return Promise.reject(new TypeError('$.tool.check takes { tool: "<name>", input }'))
        }
        return host.check(
          { tool: (e as { tool: string }).tool, input: (e as { input?: unknown }).input ?? {} },
          { context: call.context, ...(call.signal ? { signal: call.signal } : {}) },
        )
      },
    },
  }),
  clock: Object.assign(Object.create(null), {
    now: { run: () => Date.now() },
    // The one `$` wait that counts against the caller's budget (ModInstance
    // does not pause the clock for the `clock` noun). `e` is `{ ms }`; the
    // `signal` option does not cross — the worker abandons the call for it.
    sleep: { ...VOID, input: clockWait, run: wait },
    // "One `clock.after` dispatch: `fn` runs when it resolves, and never when
    // a hook refuses it." The callback lives in the worker; this is the wait.
    after: { ...VOID, input: clockWait, run: wait },
    // "One `clock.every` dispatch per period": the worker asks again after
    // each one resolves; "a refused period ends the interval".
    every: { ...VOID, input: clockWait, run: wait },
  }),
  env: Object.assign(Object.create(null), {
    // `e` is `{ name }`; "`name` is identity, pinned" — a rewrite of it is
    // ignored: core reads the name the call was made with.
    get: {
      input: (args: readonly unknown[]) => ({ name: args[0] }),
      run: (e: unknown, { call, session }: NounContext) => {
        const name = envName(call.args[0] ?? (isRecord(e) ? e.name : undefined), 'get')
        return envHost(session).get(name)
      },
      // `undefined` is the answer for a variable that is unset.
      accepts: (result: unknown) => result === undefined || typeof result === 'string',
    },
    // `e` is `{ name, value? }`; "no `value` unsets". A hook above may rewrite
    // the value (`next({ ...e, value })`); the name is pinned. Resolves `{}`
    // once the write is made, `{ deny }` saying why when it is not.
    set: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => ({
        name: args[0],
        ...(args[1] !== undefined ? { value: args[1] } : {}),
      }),
      run: (e: unknown, context: NounContext) => envSet(e, context),
    },
  }),
  store: Object.assign(Object.create(null), {
    // The calling plugin's own store. `e` is `{ key }` / `{ key, value }`; a
    // hook above may rewrite either — the store is the caller's whatever a
    // hook does (`store.set` on another plugin's store needs that plugin).
    get: {
      input: (args: readonly unknown[]) => ({ key: args[0] }),
      run: (e: unknown, { call, session }: NounContext) =>
        storeHost(session, call.plugin).get(storeKey(e, 'get')),
      // `undefined` is the answer for a key that is unset.
      accepts: () => true,
    },
    set: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        toJsonData(args[1], '$.store.set')
        return { key: args[0], value: args[1] }
      },
      run: (e: unknown, { call, session }: NounContext) =>
        storeHost(session, call.plugin).set(storeKey(e, 'set'), isRecord(e) ? e.value : undefined),
    },
    delete: {
      ...VOID,
      input: (args: readonly unknown[]) => ({ key: args[0] }),
      run: (e: unknown, { call, session }: NounContext) =>
        storeHost(session, call.plugin).delete(storeKey(e, 'delete')),
    },
    keys: {
      run: (_e: unknown, { call, session }: NounContext) => storeHost(session, call.plugin).keys(),
      accepts: (result: unknown) => Array.isArray(result),
    },
  }),
  state: Object.assign(Object.create(null), {
    // `e` is the reference itself, "identity, pinned": core reads the address
    // the call was made with, not what a hook passed on.
    get: {
      input: (args: readonly unknown[]) => ({ ...stateAddress(args[0], 'get') }),
      run: (_e: unknown, { call, session }: NounContext) =>
        stateHost(session).get(stateAddress(call.args[0], 'get')),
      accepts: (result: unknown) => isRecord(result) && typeof result.version === 'number',
    },
    // `e` is `{ plugin, key, id?, value, previous, ifVersion? }`; "`previous`
    // is the host's, put on `e` ahead of every hook". A hook rewrites `value`
    // (how a plugin that does not own a value changes it); the reference and
    // the condition are the caller's. "Raised by the value's owner alone."
    set: {
      input: (args: readonly unknown[]) => {
        const address = stateAddress(args[0], 'set')
        toJsonData(args[1], '$.state.set')
        const options = isRecord(args[2]) ? args[2] : {}
        if (options.ifVersion !== undefined && typeof options.ifVersion !== 'number') {
          throw new TypeError('$.state.set: ifVersion must be a number')
        }
        return {
          ...address,
          value: args[1],
          ...(options.ifVersion !== undefined ? { ifVersion: options.ifVersion } : {}),
        }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const address = stateAddress(call.args[0], 'set')
        const value = toJsonData(isRecord(e) ? e.value : undefined, '$.state.set')
        const options = isRecord(call.args[2]) ? call.args[2] : {}
        return stateHost(session).set(
          address,
          value,
          typeof options.ifVersion === 'number' ? options.ifVersion : undefined,
        )
      },
      accepts: (result: unknown) =>
        isRecord(result) && typeof result.isSet === 'boolean' && typeof result.version === 'number',
    },
  }),
  command: Object.assign(Object.create(null), {
    // `e` is the CommandSpec; "a hook above rewrites any of it; the name
    // stays the caller's" is the `agent.register` rule — here the spec is
    // checked again as it ARRIVED at core, so a hook may rewrite the
    // description or the hint, never the name (pinned).
    register: {
      input: (args: readonly unknown[]) => ({ ...modCommandSpecOf(args[0]) }),
      run: (e: unknown, { call, session }: NounContext) => {
        const spec = modCommandSpecOf({ ...(isRecord(e) ? e : {}), name: (call.args[0] as ModCommandSpec).name })
        return { command: commandHost(session).register(spec, call.plugin, call.seat) }
      },
      accepts: (result: unknown) => isRecord(result) && typeof result.command === 'string',
    },
    list: {
      run: (_e: unknown, { session }: NounContext) => commandHost(session).list(),
      accepts: (result: unknown) => Array.isArray(result),
    },
    // "Runs a slash command as if the person typed `/command args`: the
    // event `command.run`" — raised by the command path itself, with the
    // caller's context, like `$.tool.call`.
    run: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => {
        const first = args[0]
        if (!isRecord(first) || typeof first.command !== 'string' || first.command === '') {
          throw new TypeError('$.command.run takes { command: "<name>", args? }')
        }
        if (first.args !== undefined && typeof first.args !== 'string') {
          throw new TypeError('$.command.run: args must be a string')
        }
        return { command: first.command, args: typeof first.args === 'string' ? first.args : '' }
      },
      run: (e: unknown, { call, session }: NounContext) =>
        commandHost(session).run(e as { command: string; args: string }, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        }),
    },
  }),
  // `$.fs`: each method its own op event — `fs.read`, `fs.write`,
  // `fs.list`, `fs.exists`, `fs.stat`, `fs.ancestors` — so a plugin's guard
  // hooks another plugin's reads and writes the way it hooks a tool call.
  fs: Object.assign(Object.create(null), {
    read: {
      input: (args: readonly unknown[]) => ({
        path: fsPath(args[0], 'read'),
        as: isRecord(args[1]) && args[1].as === 'bytes' ? 'bytes' : 'text',
      }),
      run: (e: unknown, { session }: NounContext) => {
        const { path, as } = e as { path: string; as: 'text' | 'bytes' }
        return fsHost(session).read(fsPath(path, 'read'), as === 'bytes' ? 'bytes' : 'text')
      },
      accepts: (value: unknown) => typeof value === 'string' || isRecord(value),
    },
    write: {
      input: (args: readonly unknown[]) => ({ path: fsPath(args[0], 'write'), text: args[1] }),
      run: (e: unknown, { session }: NounContext) => {
        const { path, text } = e as { path: string; text: unknown }
        if (typeof text !== 'string') throw new TypeError('$.fs.write(path, text): text must be a string')
        return fsHost(session).write(fsPath(path, 'write'), text)
      },
      ...VOID,
    },
    list: {
      input: (args: readonly unknown[]) => (args[0] === undefined ? {} : { path: fsPath(args[0], 'list') }),
      run: (e: unknown, { session }: NounContext) => {
        const path = isRecord(e) && e.path !== undefined ? fsPath(e.path, 'list') : undefined
        return fsHost(session).list(path)
      },
      accepts: Array.isArray,
    },
    exists: {
      input: (args: readonly unknown[]) => ({ path: fsPath(args[0], 'exists') }),
      run: (e: unknown, { session }: NounContext) => fsHost(session).exists(fsPath((e as { path: unknown }).path, 'exists')),
      accepts: (value: unknown) => typeof value === 'boolean',
    },
    stat: {
      input: (args: readonly unknown[]) => ({
        path: fsPath(args[0], 'stat'),
        ...(isRecord(args[1]) && args[1].resolve === true ? { resolve: true } : {}),
      }),
      run: (e: unknown, { session }: NounContext) => {
        const { path, resolve } = e as { path: unknown; resolve?: unknown }
        return fsHost(session).stat(fsPath(path, 'stat'), resolve === true)
      },
      accepts: isRecord,
    },
    ancestors: {
      input: (args: readonly unknown[]) => {
        if (!isRecord(args[0]) || !Array.isArray(args[0].names)) {
          throw new TypeError('$.fs.ancestors({ names, of?, below? }): names must be a list')
        }
        return { ...args[0] }
      },
      run: (e: unknown, { session }: NounContext) => fsHost(session).ancestors(e as ModFsAncestorsRequest),
      accepts: Array.isArray,
    },
  }),
  // `$.agent`: `agent.register` and `agent.list` are op events (the
  // spec rewritten above, never its name — "the name stays the caller's");
  // `agent.spawn` is raised by the Agent tool itself, reached as the plugin's
  // own `tool.call` of it, like `$.tool.call`.
  agent: Object.assign(Object.create(null), {
    register: {
      input: (args: readonly unknown[]) => ({ ...modAgentSpecOf(args[0]) }),
      run: (e: unknown, { call, session }: NounContext) => {
        const spec = modAgentSpecOf({ ...(isRecord(e) ? e : {}), name: (call.args[0] as { name: string }).name })
        return { agent: agentsHost(session).register(spec as ModAgentSpec, call.plugin) }
      },
      accepts: (result: unknown) => isRecord(result) && typeof result.agent === 'string',
    },
    list: {
      run: (_e: unknown, { session }: NounContext) => agentsHost(session).list(),
      accepts: Array.isArray,
    },
    spawn: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => modAgentSpawnArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) =>
        agentsHost(session).spawn(e as ModAgentSpawnArgs, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        }),
    },
  }),
  // `$.mcp`: `mcp.call` and `mcp.connect` are op events — a plugin
  // above denies another plugin's call by its server and tool. No permission
  // prompt: "the plugin's call, seen by the hooks above it, is the grant".
  mcp: Object.assign(Object.create(null), {
    call: {
      input: (args: readonly unknown[]) => mcpCallInput(args),
      run: (e: unknown, { call, session }: NounContext) =>
        mcpHost(session).call(checkCallInput(e), {
          ...(call.signal ? { signal: call.signal } : {}),
        }),
      accepts: (value: unknown) => isRecord(value) && Array.isArray(value.content) && typeof value.isError === 'boolean',
    },
    connect: {
      input: (args: readonly unknown[]) => mcpConnectInput(args),
      // "Connects one of the MCP servers this plugin's own manifest lists":
      // the caller's manifest, whatever plugin a hook above is.
      run: (e: unknown, { call, session }: NounContext) => mcpHost(session).connect(call.plugin, checkConnectServer(e)),
      accepts: (value: unknown) => isRecord(value) && typeof value.isConnected === 'boolean',
    },
  }),
  // `$.model`: `model.complete`, `model.classify` and `model.fork`
  // are op events — a plugin above sees another plugin's request (the
  // model, the prompt), rewrites it or denies it. The signal does not cross:
  // the worker cancels the call for it, which is `call.signal` here.
  model: Object.assign(Object.create(null), {
    complete: {
      input: (args: readonly unknown[]) => modelCompleteInput(args),
      run: (e: unknown, { call, session }: NounContext) =>
        completionsHost(session).complete(e as ModModelCompleteRequest, {
          ...(call.signal ? { signal: call.signal } : {}),
        }),
      accepts: (value: unknown) => isRecord(value) && typeof value.isAnswered === 'boolean',
    },
    classify: {
      input: (args: readonly unknown[]) => modelClassifyInput(args),
      run: (e: unknown, { call, session, dispatcher, report }: NounContext) =>
        classifyWith(
          // The classifier's one completion is a `$.model.complete` of the
          // caller's: the `model.complete` event, same context and signal.
          request => serveNoun({ ...call, noun: 'model', method: 'complete', args: [request] }, dispatcher, session, report) as Promise<ModModelCompleteResult>,
          completionsHost(session).fastModel(),
          e as ModModelClassifyInput,
        ),
      accepts: (value: unknown) => value === undefined || typeof value === 'string',
    },
    fork: {
      input: (args: readonly unknown[]) => modelForkInput(args),
      run: (e: unknown, { call, session }: NounContext) =>
        completionsHost(session).fork(e as { prompt: string }, {
          ...(call.signal ? { signal: call.signal } : {}),
        }),
      accepts: (value: unknown) => isRecord(value) && typeof value.isAnswered === 'boolean',
    },
  }),
  // `$.process`: `process.run` is an op event — `{ argv, init? }` —
  // so a plugin above denies another plugin's command by its argv the way
  // it denies a Bash tool call. `process.spawn` is a streaming event: the
  // request is `e`, the child's pieces its chunks, `{ code, signal }` its
  // result; a hook above refuses a spawn by throwing.
  process: Object.assign(Object.create(null), {
    spawn: {
      streams: true as const,
      input: (args: readonly unknown[]) => processSpawnInput(args),
      run: (e: unknown, { session }: NounContext) => {
        if (!session.process?.spawn) notSupported('$.process.spawn is not available: this session cannot start a child')
        return session.process!.spawn!(processSpawnInput([e]))
      },
      accepts: (value: unknown) =>
        isRecord(value) &&
        (value.code === null || typeof value.code === 'number') &&
        (value.signal === null || typeof value.signal === 'string'),
    },
    run: {
      input: (args: readonly unknown[]) => processRunInput(args),
      run: (e: unknown, { call, session }: NounContext) => {
        const { argv, init } = e as { argv: readonly string[]; init?: ModProcessRunInit }
        if (!session.process) notSupported('$.process is not available: this session cannot run commands')
        return session.process!.run(argv, init ?? {}, call.signal)
      },
      accepts: (value: unknown) => isRecord(value) && typeof value.exitCode === 'number',
    },
  }),
  // `$.http`: `http.fetch` is an op event — `{ url, init? }` — so a
  // plugin above pins another plugin's hosts by its URL.
  http: Object.assign(Object.create(null), {
    fetch: {
      input: (args: readonly unknown[]) => httpFetchInput(args),
      run: (e: unknown, { call, session }: NounContext) => {
        if (!session.http) notSupported('$.http is not available: this session has no network route')
        return session.http!.fetch(checkHttpFetchInput(e), call.signal ? { signal: call.signal } : {})
      },
      accepts: (value: unknown) =>
        isRecord(value) && typeof value.status === 'number' && typeof value.ok === 'boolean' && typeof value.text === 'string',
    },
  }),
  // `$.audio`: each method an op event — `{ clip, shouldLoop, gain }`,
  // `{ text, voice? }` — so a plugin above mutes or rewrites another's sound.
  audio: Object.assign(Object.create(null), {
    play: {
      ...VOID,
      input: (args: readonly unknown[]) => audioPlayInput(args),
      run: (e: unknown, { call, session }: NounContext) =>
        playClip(checkAudioPlayEvent(e), call.plugin, audioHost(session), call.signal),
    },
    speak: {
      input: (args: readonly unknown[]) => audioSpeakInput(args),
      run: (e: unknown, { call, session }: NounContext) =>
        speakText(checkAudioSpeakEvent(e), audioHost(session), call.signal),
      accepts: (value: unknown) => isRecord(value) && value.via === 'system',
    },
  }),
  // `$.config` (plan item 7): `config.list` is an op event — a plugin above
  // rewrites another plugin's view of the rows; the rows themselves are
  // "what the menu would draw now, after every `config.describe` hook".
  // `config.set` is the event itself, the plugin's own call of it: "through
  // the other plugins' hooks, this plugin's own skipped".
  config: Object.assign(Object.create(null), {
    list: {
      input: () => ({}),
      run: async (_e: unknown, { session }: NounContext) => {
        const host = configHost(session, 'list')
        const rows = await host.rows()
        return (host.describe ? await host.describe(rows) : rows).map(publicConfigRow)
      },
      accepts: Array.isArray,
    },
    set: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => configSetArgsOf(args[0]),
      run: (e: unknown, { call, session, dispatcher }: NounContext) =>
        configSet(e as { key: string; value: ConfigValue }, call, session, dispatcher),
    },
  }),
  settings: Object.assign(Object.create(null), {
    // `e` is `{ source? }`: "absent, the settings merged over every source".
    read: {
      input: (args: readonly unknown[]) => (isRecord(args[0]) ? { ...args[0] } : {}),
      run: (e: unknown, { session }: NounContext) => {
        const source = isRecord(e) ? e.source : undefined
        if (source !== undefined && !SETTINGS_SOURCES.includes(source as string)) {
          throw new TypeError(
            `$.settings.read: source must be one of ${SETTINGS_SOURCES.join(', ')}`,
          )
        }
        return hostMethod(session, 'settings', 'settings.read')(
          source !== undefined ? { source: source as ModSettingsSource } : {},
        )
      },
      accepts: isRecord,
    },
  }),
  // `$.telemetry` — the contract: "A plugin's analytics, queued … and sent
  // in batches". Velloc sends no analytics, so core checks the entry —
  // "resolves once queued, rejects a malformed entry" — and queues nothing; the two events are raised, hooked by name alone
  // (`eventPattern.ts`), so a plugin can still read them.
  telemetry: Object.assign(Object.create(null), {
    log: { ...VOID, run: (e: unknown) => void telemetryLogEntry(e) },
    mark: { ...VOID, run: (e: unknown) => void telemetryMarkEntry(e) },
  }),
})

/** "The event's name, a snake_case token". */
const TELEMETRY_TOKEN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
/** A TelemetryChoice member: "a lowercase token of letters, digits, `_` and
 *  `-`, which may start with a digit, at most 32 of them". */
const TELEMETRY_CHOICE = /^[a-z0-9_-]{1,32}$/

/** "A value is a finite number, a boolean or a TelemetryChoice; free text is
 *  refused", by snake_case key. */
function telemetryProps(value: unknown, call: string): void {
  if (value === undefined) return
  if (!isRecord(value)) throw new TypeError(`$.telemetry.${call}: props must be an object`)
  for (const [key, prop] of Object.entries(value)) {
    if (!TELEMETRY_TOKEN.test(key)) {
      throw new TypeError(`$.telemetry.${call}: prop "${key}" is not a snake_case key`)
    }
    if (typeof prop === 'boolean' || (typeof prop === 'number' && Number.isFinite(prop))) continue
    const choice = isRecord(prop) && Array.isArray(prop.of) ? (prop as { value?: unknown; of: unknown[] }) : undefined
    if (
      !choice ||
      !choice.of.every(member => typeof member === 'string' && TELEMETRY_CHOICE.test(member)) ||
      typeof choice.value !== 'string' ||
      !choice.of.includes(choice.value)
    ) {
      throw new TypeError(
        `$.telemetry.${call}: prop "${key}" must be a finite number, a boolean or { value, of } with value one of of — free text is refused`,
      )
    }
  }
}

/** `$.telemetry.log`'s `{ to?, event, props? }`. */
function telemetryLogEntry(e: unknown): void {
  if (!isRecord(e)) throw new TypeError('$.telemetry.log takes { event, props? }')
  if (e.to !== undefined && e.to !== 'anthropic' && e.to !== 'collector') {
    throw new TypeError('$.telemetry.log: to must be "anthropic" or "collector"')
  }
  if (typeof e.event !== 'string' || !TELEMETRY_TOKEN.test(e.event)) {
    throw new TypeError('$.telemetry.log: event must be a snake_case token')
  }
  telemetryProps(e.props, 'log')
}

/** `$.telemetry.mark`'s `{ feature, kind, reason?, props? }`: `reason`
 *  "required there [sad or bad] and refused on ok". */
function telemetryMarkEntry(e: unknown): void {
  if (!isRecord(e)) throw new TypeError('$.telemetry.mark takes { feature, kind, reason?, props? }')
  if (typeof e.feature !== 'string' || !TELEMETRY_TOKEN.test(e.feature)) {
    throw new TypeError('$.telemetry.mark: feature must be a snake_case token')
  }
  if (e.kind !== 'ok' && e.kind !== 'sad' && e.kind !== 'bad') {
    throw new TypeError('$.telemetry.mark: kind must be "ok", "sad" or "bad"')
  }
  if (e.kind === 'ok' ? e.reason !== undefined : typeof e.reason !== 'string' || e.reason === '') {
    throw new TypeError(
      e.kind === 'ok'
        ? '$.telemetry.mark: an ok mark takes no reason'
        : `$.telemetry.mark: a ${e.kind} mark needs a reason`,
    )
  }
  telemetryProps(e.props, 'mark')
}

function fsPath(value: unknown, method: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`$.fs.${method}(path): path must be a non-empty string`)
  }
  return value
}

function configHost(session: ModNounHost, method: string): NonNullable<ModNounHost['config']> {
  if (!session.config) notSupported(`$.config.${method} is not available: this session has no plugin settings`)
  return session.config!
}

/** `$.config.set(args)`'s argument: `{ key, value }`, "`key` (as `list`
 *  names it) and `value` (the row's kind)". */
function configSetArgsOf(value: unknown): { key: string; value: ConfigValue } {
  if (!isRecord(value) || typeof value.key !== 'string' || value.key === '' || !isConfigValue(value.value)) {
    throw new TypeError('$.config.set({ key, value }): key must be a row key and value a boolean, string, number or list of strings')
  }
  return { key: value.key, value: value.value }
}

function sameConfigValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A hook's rewrite of the value, checked: a value
 *  of the wrong kind is refused, a choice must be one of the options as
 *  spelled, a number within the bounds; a text takes a number as its string. */
function configRewriteFor(row: ConfigRowSpec, value: unknown): { value: ConfigValue } | { deny: string } {
  const refused = { deny: `${row.label}: a ${row.kind} row cannot hold that value` }
  if (row.kind === 'boolean') return typeof value === 'boolean' ? { value } : refused
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : undefined
  if (text === undefined) return refused
  if (row.kind === 'choice') {
    return (row.options ?? []).includes(text) ? { value: text } : { deny: `${row.label} doesn't accept "${text}".` }
  }
  if (row.kind === 'number') {
    const number = numberOfInput(text, row.spec)
    return number !== undefined ? { value: number } : { deny: `${row.label} doesn't accept "${text}". ${numberInputHint(row.spec)}` }
  }
  return { value: text }
}

/**
 * `$.config.set`: "changes one row as if the person did in the menu: the
 * event `config.set` with `origin` `{ kind: 'plugin', name }`, then the
 * writer. Through the other plugins' hooks, this plugin's own skipped;
 * `{ deny }` when a hook refused, the value does not fit, a trusted source
 * owns the row or only its dialog changes it. Rejects a key no row has."
 */
async function configSet(
  args: { key: string; value: ConfigValue },
  call: ModCall,
  session: ModNounHost,
  dispatcher: ModDispatcher,
): Promise<ConfigSetResult> {
  const host = configHost(session, 'set')
  // A hidden row "still answers `$.config.set`": the rows before `config.describe`.
  const row = (await host.rows()).find(candidate => candidate.key === args.key)
  if (!row) {
    const error = new Error(`$.config.set: no /config row has the key "${args.key}"`)
    error.name = 'NotFoundError'
    throw error
  }
  if (row.isLocked) return { deny: `${row.label} is set by a trusted source` }
  const fitted = configValueFor(row, args.value)
  if ('deny' in fitted && fitted.deny !== undefined) return { deny: fitted.deny }
  const value = (fitted as { value: ConfigValue }).value
  const input: ConfigSetInput = {
    key: row.key,
    value,
    previous: row.value,
    provider: row.provider,
    origin: { kind: 'plugin', name: call.plugin },
  }
  const result = await dispatcher.dispatch(
    'config.set',
    input,
    async (arrived: unknown) => {
      const down = isRecord(arrived) ? arrived : {}
      // "Pinned: a rewrite is refused" — the key, what it holds, its owner,
      // where the change came from.
      for (const pinned of ['key', 'previous', 'provider', 'origin'] as const) {
        if (!sameConfigValue(down[pinned], input[pinned])) {
          throw new Error(`the rewritten event is refused: ${pinned} is pinned`)
        }
      }
      let written = value
      if (!sameConfigValue(down.value, value)) {
        const rewritten = configRewriteFor(row, down.value)
        if ('deny' in rewritten && rewritten.deny !== undefined) return { deny: rewritten.deny }
        written = (rewritten as { value: ConfigValue }).value
      }
      await host.write(row, written)
      return { value: written }
    },
    {
      // "That plugin's own hooks do not see it."
      context: { ...call.context, skipPlugin: call.plugin },
      scope: call.scope,
      ...(call.signal ? { signal: call.signal } : {}),
      accepts: isConfigSetResult,
    },
  )
  return result as ConfigSetResult
}

function conversationHost(session: ModNounHost, method: string): ModConversationHost {
  if (!session.conversation) notSupported(`$.session.${method} is not available: this session has no conversation to change`)
  return session.conversation!
}

function raiseOf(call: ModCall): ModConversationRaise {
  return { context: call.context, ...(call.signal ? { signal: call.signal } : {}) }
}

function promptHost(session: ModNounHost, method: string): ModPromptHost {
  if (!session.prompt) notSupported(`$.prompt.${method} is not available: this session takes no prompts from plugins`)
  return session.prompt!
}

function composerHost(session: ModNounHost): ModComposerHost {
  return session.composer ?? HEADLESS_COMPOSER
}

function isPinned(arrived: unknown, origin: unknown): boolean {
  const sent = isRecord(arrived) ? arrived.origin : undefined
  return sent === undefined || JSON.stringify(sent) === JSON.stringify(origin)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `$.prompt.fill` raised with the plugin origin; core is the page's box. The box
 * handed back is the caller's own `prompt.read` view. A chain that fails fills as
 * asked.
 */
async function promptFill(args: PromptFillArgs, context: NounContext): Promise<PromptFilled> {
  const { call, session, dispatcher, report } = context
  const host = composerHost(session)
  const origin = { kind: 'plugin' as const, name: call.plugin }
  const e = {
    text: args.text,
    mode: args.mode ?? ('replace' as PromptFillMode),
    origin,
    ...(args.decorations ? { decorations: args.decorations } : {}),
  }
  let core: { isFilled: boolean; refusal?: PromptFillRefusal; box: PromptBox } | undefined
  const runCore = async (arrived: unknown): Promise<{ isFilled: boolean; refusal?: PromptFillRefusal }> => {
    const input = isRecord(arrived) ? arrived : {}
    const text = withoutInvisible(typeof input.text === 'string' ? input.text : e.text)
    const mode = PROMPT_FILL_MODES.includes(input.mode as PromptFillMode) ? (input.mode as PromptFillMode) : e.mode
    core = await host.fill({ text, mode }, call.signal)
    return { isFilled: core.isFilled, ...(core.refusal ? { refusal: core.refusal } : {}) }
  }
  let result: { isFilled?: unknown; refusal?: unknown }
  if (!dispatcher.hasHooksFor('prompt.fill')) {
    result = await runCore(e)
  } else {
    try {
      result = (await dispatcher.dispatch(
        'prompt.fill',
        e,
        async arrived => {
          if (!isPinned(arrived, origin)) throw new Error('the rewritten event is refused: origin is pinned')
          return runCore(arrived)
        },
        {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
          accepts: r => isRecord(r) && typeof r.isFilled === 'boolean',
        },
      )) as { isFilled?: unknown; refusal?: unknown }
    } catch (error) {
      if (call.signal?.aborted) throw error
      if (core) {
        result = { isFilled: core.isFilled, refusal: core.refusal }
      } else {
        report(`mods: prompt.fill (${call.plugin}) failed: ${messageOf(error)}; the box is filled as asked`)
        result = await runCore(e)
      }
    }
  }
  const filled = core as { isFilled: boolean; refusal?: PromptFillRefusal; box: PromptBox } | undefined
  const isFilled = result.isFilled === true && filled?.isFilled === true
  const refusal =
    !isFilled && filled && !filled.isFilled && filled.refusal !== undefined && result.refusal === filled.refusal
      ? filled.refusal
      : undefined
  const outcome = { isFilled, ...(refusal ? { refusal } : {}) }
  if (!session.composer?.readsBox?.(call.plugin)) return { ...outcome, ...EMPTY_PROMPT_BOX }
  return { ...outcome, ...(await boxAsRead(filled?.box, context)) }
}

/** The box as the caller's `$.prompt.read()` would read it: `prompt.read`
 *  with the caller's context, core the box already known (or one read). A
 *  denial is the empty box. */
async function boxAsRead(known: PromptBox | undefined, { call, session, dispatcher, report }: NounContext): Promise<PromptBox> {
  const core = async (): Promise<PromptBox> => known ?? (await composerHost(session).read(call.signal))
  if (!dispatcher.hasHooksFor('prompt.read')) return core()
  try {
    const result = (await dispatcher.dispatch('prompt.read', {}, async () => ({ value: await core() }), {
      context: call.context,
      ...(call.signal ? { signal: call.signal } : {}),
      accepts: r => isOpResult(r, isPromptBox),
    })) as OpResult
    return typeof result.deny === 'string' ? { ...EMPTY_PROMPT_BOX } : (result.value as PromptBox)
  } catch (error) {
    if (call.signal?.aborted) throw error
    report(`mods: prompt.read (${call.plugin}) failed: ${messageOf(error)}; the box is the empty box`)
    return { ...EMPTY_PROMPT_BOX }
  }
}

/**
 * `$.prompt.suggest`: `prompt.suggest` with `origin: { kind: 'plugin', name }`,
 * core the page — which shows it while the box is empty and no turn runs. A
 * blank text is not shown, asked of no page. A chain that fails proposes the
 * text as the plugin wrote it.
 */
async function promptSuggest(args: PromptSuggestArgs, { call, session, dispatcher, report }: NounContext): Promise<{ isShown: boolean }> {
  const host = composerHost(session)
  const origin = { kind: 'plugin' as const, name: call.plugin }
  const e = { text: args.text, origin }
  const core = async (arrived: unknown): Promise<{ isShown: boolean }> => {
    const input = isRecord(arrived) ? arrived : {}
    const text = withoutInvisible(typeof input.text === 'string' ? input.text : e.text)
    if (text.trim() === '') return { isShown: false }
    return host.suggest({ text }, call.signal)
  }
  if (!dispatcher.hasHooksFor('prompt.suggest')) return core(e)
  try {
    const result = (await dispatcher.dispatch(
      'prompt.suggest',
      e,
      async arrived => {
        if (!isPinned(arrived, origin)) throw new Error('the rewritten event is refused: origin is pinned')
        return core(arrived)
      },
      {
        context: call.context,
        ...(call.signal ? { signal: call.signal } : {}),
        accepts: r => isRecord(r) && typeof r.isShown === 'boolean',
      },
    )) as { isShown?: unknown }
    return { isShown: result.isShown === true }
  } catch (error) {
    if (call.signal?.aborted) throw error
    report(`mods: prompt.suggest (${call.plugin}) failed: ${messageOf(error)}; the text is proposed as written`)
    return core(e)
  }
}

function transcriptHost(session: ModNounHost, method: string): ModTranscriptHost {
  if (!session.transcript) notSupported(`$.session.${method} is not available: this session has no transcript to read`)
  return session.transcript!
}

function agentsHost(session: ModNounHost): ModAgentHost {
  if (!session.agents) notSupported('$.agent is not available: this session has no Agent tool')
  return session.agents!
}

function mcpHost(session: ModNounHost): ModMcpHost {
  if (!session.mcp) notSupported('$.mcp is not available: this session takes no MCP servers')
  return session.mcp!
}

function completionsHost(session: ModNounHost): ModModelHost {
  if (!session.completions) notSupported('$.model is not available: this session has no model transport')
  return session.completions!
}

function fsHost(session: ModNounHost): ModFsHost {
  if (!session.fs) notSupported('$.fs is not available: this session has no file system')
  return session.fs!
}

function storeKey(e: unknown, method: string): string {
  const key = isRecord(e) ? e.key : undefined
  if (typeof key !== 'string' || key === '') {
    throw new TypeError(`$.store.${method}(key): key must be a non-empty string`)
  }
  return key
}

function storeHost(session: ModNounHost, plugin: string): ModStoreHost {
  if (session.store) return session.store(plugin)
  return notSupported('$.store is not available: this session has no store')
}

function stateAddress(ref: unknown, method: string): ModStateAddress {
  if (!isModStateAddress(ref)) {
    throw new TypeError(
      `$.state.${method}(ref): ref must be { plugin, key } (with id for a StateFamily key)`,
    )
  }
  return { plugin: ref.plugin, key: ref.key, ...(ref.id !== undefined ? { id: ref.id } : {}) }
}

function stateHost(session: ModNounHost): ModStateHost {
  if (session.state) return session.state
  return notSupported('$.state is not available: this session holds no state')
}

function envName(name: unknown, method: string): string {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`$.env.${method}(name): name must be a non-empty string`)
  }
  return name
}

export type EnvSetResult = { deny?: string }

function isEnvSetResult(value: unknown): value is EnvSetResult {
  return isRecord(value) && (value.deny === undefined || (typeof value.deny === 'string' && value.deny !== ''))
}

/** `$.env.set`: `env.set` raised with the caller's context; core writes the
 *  slot's variable. A write that was made answers `{}` whatever a hook said
 *  after it; a hook's `{ deny }` before it answers `{ deny }`, and a hook's
 *  own `{ value }` is the answer. */
async function envSet(e: unknown, { call, session, dispatcher }: NounContext): Promise<EnvSetResult> {
  const name = envName(call.args[0], 'set')
  const host = envHost(session)
  let wrote = false
  const core = (arrived: unknown): EnvSetResult => {
    const value = isRecord(arrived) ? arrived.value : undefined
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError('$.env.set(name, value): value must be a string, or undefined to unset')
    }
    host.set(name, value)
    wrote = true
    return {}
  }
  if (!dispatcher.hasHooksFor('env.set')) return core(e)
  const result = (await dispatcher.dispatch('env.set', e, async arrived => ({ value: core(arrived) }), {
    context: call.context,
    ...(call.signal ? { signal: call.signal } : {}),
    accepts: r =>
      isRecord(r) &&
      (typeof r.deny === 'string' ? r.deny !== '' && r.value === undefined : r.deny === undefined && isEnvSetResult(r.value)),
  })) as { value?: EnvSetResult; deny?: string }
  if (wrote) return {}
  if (typeof result.deny === 'string') return { deny: result.deny }
  return typeof result.value?.deny === 'string' ? { deny: result.value.deny } : {}
}

function envHost(session: ModNounHost): ModEnvHost {
  if (session.env) return session.env
  return notSupported('$.env is not available: this session has no environment')
}

function paneHost(session: ModNounHost): ModPaneHost {
  if (session.panes) return session.panes
  return notSupported('$.ui.open is not available: this session draws no panes')
}

/** What `$.ui.copy` / `.focus` / `.scroll` run with; refused by name where
 *  the slot supplies no page host. */
function pageCallOf({ call, session, dispatcher, report }: NounContext, method: string): ModPageCall {
  if (!session.page) notSupported(`$.ui.${method} is not available: this session has no page to draw on`)
  return {
    plugin: call.plugin,
    context: call.context,
    ...(call.signal ? { signal: call.signal } : {}),
    host: session.page!,
    dispatcher,
    report,
  }
}

function uiHost(session: ModNounHost): NonNullable<ModNounHost['ui']> {
  if (session.ui) return session.ui
  return notSupported('$.ui is not available: this session draws nothing')
}

function commandHost(session: ModNounHost): ModCommandHost {
  if (session.commands) return session.commands
  return notSupported('$.command is not available: this session has no command roster')
}

function toolHost(session: ModNounHost, method: string): ModToolHost {
  if (session.tools) return session.tools
  return notSupported(`$.tool.${method} is not available: this session has no tools to run`)
}

/**
 * How the hooks on a `$` call's event see its result: "`{ value }`, the
 * call's answer, or `{ deny }`, the reason the caller's promise rejects"
 * (`ValueOrDeny`, `OpEventResult`). Core answers `{ value }`; a hook's
 * `{ deny: reason }` makes the call reject with a `DeniedError` naming it.
 */
export type OpResult = { value: unknown; deny?: undefined } | { deny: string; value?: undefined }

export function isOpResult(result: unknown, acceptsValue: ((value: unknown) => boolean) | undefined): boolean {
  if (!isRecord(result)) return false
  if (typeof result.deny === 'string') return result.deny !== '' && result.value === undefined
  if (result.deny !== undefined) return false
  return acceptsValue ? acceptsValue(result.value) : result.value !== undefined
}

/** Every `noun.method` implemented, sorted. */
export function implementedNouns(): string[] {
  return Object.keys(NOUNS)
    .flatMap(noun => Object.keys(NOUNS[noun]!).map(method => `${noun}.${method}`))
    .sort()
}

function notImplemented(call: Pick<ModCall, 'noun' | 'method'>): Error {
  const error = new Error(
    `$.${call.noun}.${call.method} is not implemented by this engine`,
  )
  error.name = 'NotSupportedError'
  return error
}

/**
 * Serve one `$` call whose event streams (`process.spawn`): raise it, with
 * the noun's stream as core, and hand back the stream that leaves the
 * outermost hook. Nothing runs before its first pull; closing it closes
 * core. A refusal — no such noun, a bad argument — rejects the first pull.
 * Each hook's budget is per piece.
 */
export function serveNounStream(
  call: ModCall,
  dispatcher: ModDispatcher,
  session: ModNounHost,
  report: (line: string) => void,
): DispatchedStream<unknown, unknown> {
  const method = NOUNS[call.noun]?.[call.method]
  if (!method) return refusedStream(notImplemented(call))
  if (!method.streams) return refusedStream(new TypeError(`$.${call.noun}.${call.method} is not a stream`))
  let e: unknown
  try {
    e = method.input ? method.input(call.args) : call.args[0]
  } catch (error) {
    return refusedStream(error)
  }
  return dispatcher.dispatchStream(
    `${call.noun}.${call.method}`,
    e,
    arrived => method.run(arrived, { call, session, report, dispatcher }) as AsyncIterator<unknown, unknown>,
    {
      context: call.context,
      scope: call.scope,
      budgetPer: 'pull',
      ...(call.signal ? { signal: call.signal } : {}),
      accepts: result => (method.accepts ? method.accepts(result) : result !== undefined),
    },
  )
}

/** The pieces and result of `$.process.spawn`, as its stream carries them. */
export type ProcessSpawnStream = DispatchedStream<ModProcessSpawnChunk, ModProcessSpawnResult>
export type { ModProcessSpawnRequest }

/** Serve one `$` call: raise its event, with the noun as core. */
export function serveNoun(
  call: ModCall,
  dispatcher: ModDispatcher,
  session: ModNounHost,
  report: (line: string) => void,
): Promise<unknown> {
  const method = NOUNS[call.noun]?.[call.method]
  if (!method) return Promise.reject(notImplemented(call))
  if (method.streams) {
    return Promise.reject(new TypeError(`$.${call.noun}.${call.method} is a stream: read it with for await`))
  }
  // The event's `e`. A noun takes one argument by default; a call with none
  // carries an empty object, so a hook on the event can still pass it to `next`.
  let e: unknown
  try {
    e = method.input ? method.input(call.args) : call.args.length > 0 ? call.args[0] : {}
    if (call.noun === 'state' && call.method === 'set') {
      // "`ref` … must be this plugin's own" — refused before any hook sees
      // it, and `previous` put on `e` ahead of every hook.
      const address = e as ModStateAddress
      if (address.plugin !== call.plugin) {
        const error = new Error(
          `$.state.set: { plugin: "${address.plugin}" } is another plugin's value; ` +
            `hook its state.set and rewrite e.value instead`,
        )
        error.name = 'NotAllowedError'
        throw error
      }
      const previous = stateHost(session).previous(address)
      e = { ...(e as Record<string, unknown>), ...(previous !== undefined ? { previous } : {}) }
    }
  } catch (error) {
    return Promise.reject(error)
  }
  if (method.raisesItself) {
    try {
      return Promise.resolve(method.run(e, { call, session, report, dispatcher }))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  return dispatcher
    .dispatch(
      `${call.noun}.${call.method}`,
      e,
      async arrived => ({ value: await method.run(arrived, { call, session, report, dispatcher }) }) as OpResult,
      {
        context: call.context,
        scope: call.scope,
        ...(call.signal ? { signal: call.signal } : {}),
        accepts: result => isOpResult(result, method.accepts),
      },
    )
    .then(result => {
      const settled = result as OpResult
      if (typeof settled.deny === 'string') {
        const error = new Error(settled.deny)
        error.name = 'DeniedError'
        throw error
      }
      return settled.value
    })
}
