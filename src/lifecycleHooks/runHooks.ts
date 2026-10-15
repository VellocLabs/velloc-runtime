/**
 * Hook executor: runs matchers in parallel with per-hook timeouts and a combined
 * abort signal; aggregates `blocked` and `errors` (in completion order). Each
 * type runs through an injected runner; a type without one is skipped as
 * `not_implemented`.
 */

import type { WorkingState } from '../runtime/RuntimeTypes'
import { fillPromptArgs } from '../utils/promptArgs'
import { holdsHostPlaceholder } from '../browser/bridge/hostPlaceholders'
import { buildHookInput } from './hookInput'
import type { HookCommandRunner } from './hookCommandRunner'
import type { HookPromptRunner } from './hookPromptRunner'
import type { HookAgentRunner } from './hookAgentRunner'
import { ENV_NAME, type HookHttpRunner } from './hookHttpRunner'
import {
  hookJsonToDecision,
  readHookReply,
  type PermissionRequestDecision,
} from './hookOutput'
import {
  detachInProcessHook,
  detachTransientHook,
  type TransientHookView,
  type SessionFunctionHookMatcher,
  inProcessHooksFor,
  transientHooksFor,
} from './sessionScopedHooks'
import type {
  AgentHook,
  AnyHook,
  ShellHookSpec,
  InProcessHookSpec,
  HookCommand,
  LifecycleEventName,
  HttpHook,
  PromptHook,
} from './hookTypes'

export type HookOutcome =
  | {
      status: 'pass'
      /** Context the hook asked to inject into the conversation for the
       *  model to read (the hook JSON's `hookSpecificOutput.additionalContext`, plus
       *  exit-0 stdout for context events like UserPromptSubmit). */
      additionalContext?: string
      /** User-facing note the hook emitted (the hook JSON's `systemMessage`). */
      systemMessage?: string
      /** A `PermissionRequest` hook's decision (the hook JSON's
       *  `hookSpecificOutput.decision`). */
      permissionRequest?: PermissionRequestDecision
    }
  | { status: 'block'; error: string }
  | { status: 'error'; error: string }
  | { status: 'timeout'; error: string }
  | { status: 'aborted' }
  /** Non-blocking failure — a command hook's "other non-zero exit"
   *  outcome — surfaced as a warning, does NOT block the operation. */
  | { status: 'non_blocking_error'; error: string }
  | { status: 'not_implemented'; hookType: HookCommand['type'] }

export type SingleHookResult = {
  hook: AnyHook
  outcome: HookOutcome
  /** Wall-clock duration in ms — useful for telemetry / tests, no
   *  semantic effect. */
  durationMs: number
}

export type HookBatchVerdict = {
  /** True if any hook returned `status: 'block'` or `'error'` or
   *  `'timeout'`. The integration site should refuse to continue when
   *  this is true. `aborted` does not block — that means the caller's
   *  signal fired, which is its own concern. */
  blocked: boolean
  /** Error messages from the blocking hooks, in completion order. */
  errors: string[]
  /** Non-blocking failure messages (command hooks that exited non-zero but
   *  not with the blocking code 2). Informational; do not block. */
  warnings: string[]
  /** Context strings hooks asked to inject into the conversation, in
   *  completion order. Collected from the hook JSON's
   *  `hookSpecificOutput.additionalContext` (plus exit-0 stdout for the
   *  context events). The integration site appends these to the
   *  conversation as a synthetic user message so the model reads them. */
  additionalContext: string[]
  /** User-facing notes hooks emitted (the hook JSON's `systemMessage`),
   *  in completion order. Surfaced alongside the injected context. */
  systemMessages: string[]
  /** The `PermissionRequest` decision the hooks settled on: the last one in
   *  result order (the classic hooks fold "last write wins"). */
  permissionRequest?: PermissionRequestDecision
  /** All hook results, including non-blocking passes — exposed for
   *  tests and telemetry. */
  results: SingleHookResult[]
}

const DEFAULT_HOOK_TIMEOUT_MS = 5_000

type WorkingStateWriter = (updater: (prev: WorkingState) => WorkingState) => void

export type ExecuteHooksParams = {
  /** Hook event being fired (e.g. `'PreToolUse'`). */
  event: LifecycleEventName
  /** Subject the matcher string filters against. For `PreToolUse` /
   *  `PostToolUse` this is the tool name. */
  subject: string
  /** Session id used to read registered hooks from `WorkingState`. */
  sessionId: string
  /** WorkingState snapshot — caller passes `getAppState()` once so the
   *  executor reads a stable view. */
  appState: WorkingState
  /** Set-AppState handle, used to remove `once: true` hooks after they
   *  fire. Optional because read-only callers (telemetry, dry-run)
   *  may want to inspect without mutating. */
  setAppState?: WorkingStateWriter
  /** Combined abort signal — fires when the parent operation is
   *  cancelled. Each hook gets a chained signal that also fires on
   *  its individual timeout. */
  signal?: AbortSignal
  /** Shell runner used to execute `command` hooks. When absent (e.g. a
   *  runtime with no Bash capability, or a unit test), command hooks are
   *  left unexecuted (`not_implemented`). */
  commandRunner?: HookCommandRunner
  /** Model runner used to execute `prompt` hooks (a one-shot fast-model
   *  eval). When absent, prompt hooks are left unexecuted
   *  (`not_implemented`), same graceful degradation as `commandRunner`. */
  promptRunner?: HookPromptRunner
  /** Sub-agent runner used to execute `agent` hooks (a forked multi-turn
   *  verifier). When absent, agent hooks are left unexecuted
   *  (`not_implemented`), same graceful degradation as `promptRunner`. */
  agentRunner?: HookAgentRunner
  /** Request runner used to execute `http` hooks (a POST of the hook input
   *  through the bridge's `network.httpRequest`). When absent, http hooks
   *  are left unexecuted (`not_implemented`), same as the other runners. */
  httpRunner?: HookHttpRunner
  /** Context used to build the JSON written to a command hook's stdin and
   *  the `CLAUDE_*` env vars. */
  hookInput?: {
    cwd?: string
    projectRoot?: string
    transcriptPath?: string
    permissionMode?: string
    toolInput?: unknown
    toolResponse?: unknown
    toolUseId?: string
    prompt?: string
    stopHookActive?: boolean
    /** `agent_type` of `SessionStart` / `SubagentStart`. */
    agentType?: string
    /** `model` of `SessionStart`. */
    model?: string
    /** `message` / `title` of `Notification`. */
    message?: string
    title?: string
    /** `error_details` / `last_assistant_message` of `StopFailure`. */
    errorDetails?: string
    finalReplyText?: string
    /** `permission_suggestions` of `PermissionRequest`. */
    alwaysAllowOffers?: unknown[]
    /** `custom_instructions` of `PreCompact`. */
    foldGuidance?: string | null
    /** `compact_summary` of `PostCompact`. */
    compactSummary?: string
  }
}

/**
 * Does `matcher` apply to `subject`? Empty / `"*"` matches all; names or a
 * `|` list match exactly; anything else is a regex (invalid → no match). Tool
 * names are not normalized.
 */
export function matchesMatcher(matcher: string | undefined, subject: string): boolean {
  if (!matcher || matcher === '*') return true
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
    if (matcher.includes('|')) {
      return matcher
        .split('|')
        .map(part => part.trim())
        .includes(subject)
    }
    return matcher === subject
  }
  try {
    return new RegExp(matcher).test(subject)
  } catch {
    return false
  }
}

/**
 * For which events does a successful (exit 0) command hook's plain stdout
 * become additional context for the model? Stdout on
 * `UserPromptSubmit` / `SessionStart` is injected as context, whereas for
 * other events (e.g. `PostToolUse`) exit-0 stdout is transcript-only. The
 * structured `additionalContext` JSON field works for every event regardless.
 */
function stdoutIsContext(event: LifecycleEventName): boolean {
  return event === 'UserPromptSubmit' || event === 'SessionStart'
}

function timeoutOf(hook: AnyHook): number {
  if (typeof hook.timeout === 'number' && hook.timeout > 0) {
    // Hook command timeouts are documented in seconds on the persistable
    // shapes (`ShellHookSpec.timeout`, etc.), to match settings.json
    // authoring. Function hooks keep ms because they're set programmatically
    // and the SDK-level callers expect ms there.
    return hook.type === 'function' ? hook.timeout : hook.timeout * 1000
  }
  return DEFAULT_HOOK_TIMEOUT_MS
}

function chainAbortSignal(parent: AbortSignal | undefined, child: AbortController): void {
  if (!parent) return
  if (parent.aborted) {
    child.abort(parent.reason)
    return
  }
  parent.addEventListener('abort', () => child.abort(parent.reason), { once: true })
}

async function runInProcessHook(
  hook: InProcessHookSpec,
  signal: AbortSignal,
): Promise<HookOutcome> {
  try {
    const result = await Promise.resolve(hook.callback(signal))
    if (signal.aborted) {
      // Callback resolved but the abort fired during execution; surface as
      // timeout/aborted depending on the signal reason so the integration
      // site can distinguish.
      const reason = signal.reason
      if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
        return { status: 'timeout', error: `${hook.errorMessage} (timed out)` }
      }
      return { status: 'aborted' }
    }
    if (result === false) {
      return { status: 'block', error: hook.errorMessage }
    }
    return { status: 'pass' }
  } catch (e) {
    if (signal.aborted) {
      const reason = signal.reason
      if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
        return { status: 'timeout', error: `${hook.errorMessage} (timed out)` }
      }
      return { status: 'aborted' }
    }
    const message = e instanceof Error ? e.message : String(e)
    return { status: 'error', error: `${hook.errorMessage} (${message})` }
  }
}

/** Expand `${VAR}` literals in a hook command for the exported vars
 *  (CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT), via split/join. */
function expandHookVars(command: string, env: Record<string, string>): string {
  let out = command
  for (const [key, value] of Object.entries(env)) {
    out = out.split(`\${${key}}`).join(value)
  }
  return out
}

async function executeCommandHook(
  hook: ShellHookSpec,
  params: ExecuteHooksParams,
  skillRoot: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HookOutcome> {
  const runner = params.commandRunner
  if (!runner) {
    return { status: 'not_implemented', hookType: 'command' }
  }

  const ctx = params.hookInput ?? {}
  const projectDir = ctx.projectRoot ?? ctx.cwd
  const env: Record<string, string> = {}
  if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir
  if (skillRoot) env.CLAUDE_PLUGIN_ROOT = skillRoot

  const hookInput = buildHookInput({
    event: params.event,
    sessionId: params.sessionId,
    cwd: ctx.cwd ?? projectDir ?? '.',
    transcriptPath: ctx.transcriptPath,
    permissionMode: ctx.permissionMode,
    toolName: params.subject || undefined,
    toolInput: ctx.toolInput,
    toolResponse: ctx.toolResponse,
    toolUseId: ctx.toolUseId,
    prompt: ctx.prompt,
    stopHookActive: ctx.stopHookActive,
    agentType: ctx.agentType,
    model: ctx.model,
    message: ctx.message,
    title: ctx.title,
    errorDetails: ctx.errorDetails,
    finalReplyText: ctx.finalReplyText,
    alwaysAllowOffers: ctx.alwaysAllowOffers,
    foldGuidance: ctx.foldGuidance,
    compactSummary: ctx.compactSummary,
  })
  const stdin = `${JSON.stringify(hookInput)}\n`

  let result
  try {
    result = await runner({
      // Expand `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` literals in
      // the command. The vars are also exported into the
      // env, but literal expansion lets a hook use them where the shell
      // wouldn't expand a variable (e.g. as a bare path prefix).
      command: expandHookVars(hook.command, env),
      shell: hook.shell,
      stdin,
      env,
      timeoutMs,
    })
  } catch (e) {
    if (signal.aborted) {
      const reason = signal.reason
      if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
        return { status: 'timeout', error: `Hook command timed out: ${hook.command}` }
      }
      return { status: 'aborted' }
    }
    // Infrastructure failure (unsupported shell, bridge error). Non-blocking
    // so a misconfigured hook can't wedge the model.
    const message = e instanceof Error ? e.message : String(e)
    return { status: 'non_blocking_error', error: `[${hook.command}] ${message}` }
  }

  if (signal.aborted) {
    const reason = signal.reason
    if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
      return { status: 'timeout', error: `Hook command timed out: ${hook.command}` }
    }
    return { status: 'aborted' }
  }

  // Structured JSON decision takes precedence over the exit code.
  const json = readHookReply(result.stdout)
  if (json) {
    const decision = hookJsonToDecision(json)
    if (decision.kind === 'block') {
      return { status: 'block', error: decision.reason }
    }
    // Carry the hook's injected context / user note onto the pass outcome
    // so `fireLifecycleEvent` can aggregate and the integration site can feed it
    // into the conversation (additionalContext / systemMessage).
    return {
      status: 'pass',
      additionalContext: decision.additionalContext,
      systemMessage: decision.systemMessage,
      ...(decision.permissionRequest ? { permissionRequest: decision.permissionRequest } : {}),
    }
  }

  // Exit-code protocol.
  if (result.exitCode === 0) {
    // For UserPromptSubmit / SessionStart, plain stdout on success is
    // additional context; for other events it's
    // transcript-only and we pass with no injected context.
    const text = result.stdout.trim()
    if (text && stdoutIsContext(params.event)) {
      return { status: 'pass', additionalContext: text }
    }
    return { status: 'pass' }
  }
  if (result.exitCode === 2) {
    const text = result.stdout.trim() || 'No output'
    return { status: 'block', error: `[${hook.command}]: ${text}` }
  }
  return {
    status: 'non_blocking_error',
    error: `[${hook.command}] exited ${result.exitCode}: ${result.stdout.trim()}`,
  }
}

// Prompt-hook system prompt: the model must answer with a tiny JSON verdict.
const HOOK_PROMPT_SYSTEM_PROMPT = [
  `You are evaluating a hook in Nexus.

Your response must be a JSON object matching one of the following schemas:
1. If the condition is met, return: {"ok": true}
2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}`,
]

/** Best-effort JSON parse — tolerates a model that wraps the verdict in prose
 *  or a code fence by extracting the first `{...}` object. */
function parseHookVerdict(text: string): { ok: boolean; reason?: string } | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  let parsed = tryParse(text.trim())
  if (parsed === undefined) {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) parsed = tryParse(match[0])
  }
  if (!parsed || typeof parsed !== 'object') return null
  const ok = (parsed as { ok?: unknown }).ok
  if (typeof ok !== 'boolean') return null
  const reason = (parsed as { reason?: unknown }).reason
  return { ok, reason: typeof reason === 'string' ? reason : undefined }
}

/**
 * Execute a `prompt` hook by running a one-shot fast-model evaluation: build
 * the hook-input JSON, substitute it into
 * the hook's prompt (`$ARGUMENTS`), ask the model for a `{ok, reason}` verdict,
 * and map `ok: false` → block. Without a runner (no model dispatch — tests /
 * mock host) it falls back to `not_implemented`.
 */
async function executePromptHook(
  hook: PromptHook,
  params: ExecuteHooksParams,
  signal: AbortSignal,
): Promise<HookOutcome> {
  const runner = params.promptRunner
  if (!runner) {
    return { status: 'not_implemented', hookType: 'prompt' }
  }

  const ctx = params.hookInput ?? {}
  const hookInput = buildHookInput({
    event: params.event,
    sessionId: params.sessionId,
    cwd: ctx.cwd ?? ctx.projectRoot ?? '.',
    transcriptPath: ctx.transcriptPath,
    permissionMode: ctx.permissionMode,
    toolName: params.subject || undefined,
    toolInput: ctx.toolInput,
    toolResponse: ctx.toolResponse,
    toolUseId: ctx.toolUseId,
    prompt: ctx.prompt,
    stopHookActive: ctx.stopHookActive,
    agentType: ctx.agentType,
    model: ctx.model,
    message: ctx.message,
    title: ctx.title,
    errorDetails: ctx.errorDetails,
    finalReplyText: ctx.finalReplyText,
    alwaysAllowOffers: ctx.alwaysAllowOffers,
    foldGuidance: ctx.foldGuidance,
    compactSummary: ctx.compactSummary,
  })
  // The hook input JSON fills `$ARGUMENTS`, or is appended when the prompt
  // has no placeholder.
  const userPrompt = fillPromptArgs(hook.prompt, JSON.stringify(hookInput))

  let text: string
  try {
    text = await runner({
      prompt: userPrompt,
      systemPrompt: HOOK_PROMPT_SYSTEM_PROMPT,
      model: hook.model,
      signal,
    })
  } catch (e) {
    if (signal.aborted) {
      const reason = signal.reason
      if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
        return { status: 'timeout', error: 'Prompt hook timed out' }
      }
      return { status: 'aborted' }
    }
    const message = e instanceof Error ? e.message : String(e)
    return { status: 'non_blocking_error', error: `[prompt hook] ${message}` }
  }

  if (signal.aborted) {
    const reason = signal.reason
    if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
      return { status: 'timeout', error: 'Prompt hook timed out' }
    }
    return { status: 'aborted' }
  }

  const verdict = parseHookVerdict(text)
  if (!verdict) {
    return {
      status: 'non_blocking_error',
      error: `[prompt hook] invalid model verdict: ${text.trim().slice(0, 200)}`,
    }
  }
  if (!verdict.ok) {
    return {
      status: 'block',
      error: `Prompt hook condition was not met: ${verdict.reason ?? 'no reason given'}`,
    }
  }
  return { status: 'pass' }
}

// Agent-hook verifier system prompt: a multi-turn agent inspects the codebase /
// conversation, then returns a tiny JSON verdict. Nexus parses the verdict
// from the fork's final text (there is no structured-output tool), so the contract is spelled out
// the same way `prompt` hooks ask for it.
const HOOK_AGENT_SYSTEM_PROMPT = `You are verifying a hook condition in Nexus. Use the available tools to inspect the codebase and conversation as needed to decide whether the condition is met. Be efficient — use as few steps as possible.

When done, respond with ONLY a JSON object matching one of:
1. If the condition is met: {"ok": true}
2. If the condition is not met: {"ok": false, "reason": "why it is not met"}`

/**
 * Execute an `agent` hook by running a forked multi-turn verifier sub-agent.
 * It substitutes the hook-input JSON into the
 * hook's prompt (`$ARGUMENTS`), run a sub-agent under a verifier system prompt
 * that can use tools, and map its `{ok, reason}` verdict → block on `ok: false`.
 * Without a runner (no fork dispatch — tests / mock host) it falls back to
 * `not_implemented`, the same graceful degradation as `prompt`/`command` hooks.
 */
async function executeAgentHook(
  hook: AgentHook,
  params: ExecuteHooksParams,
  signal: AbortSignal,
): Promise<HookOutcome> {
  const runner = params.agentRunner
  if (!runner) {
    return { status: 'not_implemented', hookType: 'agent' }
  }

  const ctx = params.hookInput ?? {}
  const hookInput = buildHookInput({
    event: params.event,
    sessionId: params.sessionId,
    cwd: ctx.cwd ?? ctx.projectRoot ?? '.',
    transcriptPath: ctx.transcriptPath,
    permissionMode: ctx.permissionMode,
    toolName: params.subject || undefined,
    toolInput: ctx.toolInput,
    toolResponse: ctx.toolResponse,
    toolUseId: ctx.toolUseId,
    prompt: ctx.prompt,
    stopHookActive: ctx.stopHookActive,
    agentType: ctx.agentType,
    model: ctx.model,
    message: ctx.message,
    title: ctx.title,
    errorDetails: ctx.errorDetails,
    finalReplyText: ctx.finalReplyText,
    alwaysAllowOffers: ctx.alwaysAllowOffers,
    foldGuidance: ctx.foldGuidance,
    compactSummary: ctx.compactSummary,
  })
  const userPrompt = fillPromptArgs(hook.prompt, JSON.stringify(hookInput))

  let text: string
  try {
    text = await runner({
      prompt: userPrompt,
      systemPrompt: HOOK_AGENT_SYSTEM_PROMPT,
      model: hook.model,
      signal,
    })
  } catch (e) {
    if (signal.aborted) {
      const reason = signal.reason
      if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
        return { status: 'timeout', error: 'Agent hook timed out' }
      }
      return { status: 'aborted' }
    }
    const message = e instanceof Error ? e.message : String(e)
    return { status: 'non_blocking_error', error: `[agent hook] ${message}` }
  }

  if (signal.aborted) {
    const reason = signal.reason
    if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
      return { status: 'timeout', error: 'Agent hook timed out' }
    }
    return { status: 'aborted' }
  }

  const verdict = parseHookVerdict(text)
  if (!verdict) {
    // No parseable verdict (verifier finished without emitting JSON). We
    // surface it as a non-blocking error so it's visible without wedging the operation.
    return {
      status: 'non_blocking_error',
      error: `[agent hook] no verdict: ${text.trim().slice(0, 200)}`,
    }
  }
  if (!verdict.ok) {
    return {
      status: 'block',
      error: `Agent hook condition was not met: ${verdict.reason ?? 'no reason given'}`,
    }
  }
  return { status: 'pass' }
}

/** CR, LF and NUL stripped, so an env value
 *  cannot inject a second header. */
function scrubHeaderText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\x00]/g, '')
}

const ENV_REFERENCE = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g

/** The names a header value references, as `$NAME` / `${NAME}`. */
function envReferencesOf(value: string): string[] {
  return [...value.matchAll(ENV_REFERENCE)].map(match => (match[1] ?? match[2])!)
}

/** A reference to a listed name is its value, any
 *  other reference is ''; the result sanitized. */
function expandListedVars(
  value: string,
  allowed: ReadonlySet<string>,
  env: Readonly<Record<string, string>>,
): string {
  return scrubHeaderText(
    value.replace(ENV_REFERENCE, (_, braced: string | undefined, unbraced: string | undefined) => {
      const name = (braced ?? unbraced)!
      return allowed.has(name) ? (env[name] ?? '') : ''
    }),
  )
}

function timedOutOrAborted(signal: AbortSignal, url: string): HookOutcome {
  const reason = signal.reason
  if (reason instanceof Error && reason.name === 'TimeoutAbortError') {
    return { status: 'timeout', error: `HTTP hook timed out: ${url}` }
  }
  return { status: 'aborted' }
}

/** Settle with `promise`, or with an abort as soon as `signal` fires: the
 *  bridge request cannot be torn down once sent, the hook is released. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Execute an `http` hook: POST the input JSON. Headers get `$NAME` / `${NAME}`
 * for `allowedEnvVars` names only (others ''), CR / LF / NUL stripped. Non-2xx,
 * a request error or a non-object body is non-blocking; an empty body passes;
 * the JSON decides like command stdout.
 */
async function executeHttpHook(
  hook: HttpHook,
  params: ExecuteHooksParams,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HookOutcome> {
  const runner = params.httpRunner
  if (!runner) {
    return { status: 'not_implemented', hookType: 'http' }
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (hook.headers) {
      const allowed = new Set((hook.allowedEnvVars ?? []).filter(name => ENV_NAME.test(name)))
      const wanted = [
        ...new Set(Object.values(hook.headers).flatMap(envReferencesOf).filter(name => allowed.has(name))),
      ]
      const env = wanted.length > 0 ? await untilAborted(runner.readEnv(wanted), signal) : {}
      for (const [name, value] of Object.entries(hook.headers)) {
        headers[name] = expandListedVars(value, allowed, env)
      }
    }
    const placeholder = Object.entries(headers).find(([, value]) => holdsHostPlaceholder(value))
    if (placeholder) {
      return {
        status: 'non_blocking_error',
        error: `HTTP hook ${hook.url}: header ${placeholder[0]} holds a host placeholder, which a hook cannot send`,
      }
    }

    const ctx = params.hookInput ?? {}
    const hookInput = buildHookInput({
      event: params.event,
      sessionId: params.sessionId,
      cwd: ctx.cwd ?? ctx.projectRoot ?? '.',
      transcriptPath: ctx.transcriptPath,
      permissionMode: ctx.permissionMode,
      toolName: params.subject || undefined,
      toolInput: ctx.toolInput,
      toolResponse: ctx.toolResponse,
      toolUseId: ctx.toolUseId,
      prompt: ctx.prompt,
      stopHookActive: ctx.stopHookActive,
      agentType: ctx.agentType,
      model: ctx.model,
      message: ctx.message,
      title: ctx.title,
      errorDetails: ctx.errorDetails,
      finalReplyText: ctx.finalReplyText,
      alwaysAllowOffers: ctx.alwaysAllowOffers,
      foldGuidance: ctx.foldGuidance,
      compactSummary: ctx.compactSummary,
    })

    const response = await untilAborted(
      runner.post({ url: hook.url, body: JSON.stringify(hookInput), headers, timeoutMs, signal }),
      signal,
    )
    if (response.status < 200 || response.status > 299) {
      return { status: 'non_blocking_error', error: `HTTP ${response.status} from ${hook.url}` }
    }
    const body = response.body.trim()
    if (body === '') return { status: 'pass' }
    const json = readHookReply(body)
    if (!json) {
      const shown = body.length > 200 ? `${body.slice(0, 200)}…` : body
      return {
        status: 'non_blocking_error',
        error: `HTTP hook must return JSON, but got non-JSON response body: ${shown}`,
      }
    }
    const decision = hookJsonToDecision(json)
    if (decision.kind === 'block') {
      return { status: 'block', error: decision.reason }
    }
    return {
      status: 'pass',
      additionalContext: decision.additionalContext,
      systemMessage: decision.systemMessage,
      ...(decision.permissionRequest ? { permissionRequest: decision.permissionRequest } : {}),
    }
  } catch (e) {
    if (signal.aborted) return timedOutOrAborted(signal, hook.url)
    const message = e instanceof Error ? e.message : String(e)
    return { status: 'non_blocking_error', error: `HTTP hook ${hook.url}: ${message}` }
  }
}

async function executeOne(
  entry: { hook: AnyHook; skillRoot?: string },
  params: ExecuteHooksParams,
): Promise<SingleHookResult> {
  const { hook, skillRoot } = entry
  const start = Date.now()
  const controller = new AbortController()
  chainAbortSignal(params.signal, controller)

  const timeoutMs = timeoutOf(hook)
  const timer = setTimeout(() => {
    const timeoutError = new Error(`Hook timed out after ${timeoutMs}ms`)
    timeoutError.name = 'TimeoutAbortError'
    controller.abort(timeoutError)
  }, timeoutMs)

  try {
    let outcome: HookOutcome
    switch (hook.type) {
      case 'function':
        outcome = await runInProcessHook(hook, controller.signal)
        break
      case 'command':
        outcome = await executeCommandHook(
          hook,
          params,
          skillRoot,
          timeoutMs,
          controller.signal,
        )
        break
      case 'prompt':
        outcome = await executePromptHook(hook, params, controller.signal)
        break
      case 'agent':
        outcome = await executeAgentHook(hook, params, controller.signal)
        break
      case 'http':
        outcome = await executeHttpHook(hook, params, timeoutMs, controller.signal)
        break
      default:
        // Exhaustiveness fallback. `hook` is `never` here when the union
        // is exhaustive; if a future type is added the compiler flags it.
        ((_: never) => _)(hook)
        outcome = {
          status: 'error',
          error: 'Unknown hook type',
        }
    }
    return { hook, outcome, durationMs: Date.now() - start }
  } finally {
    clearTimeout(timer)
  }
}

function isBlockingOutcome(outcome: HookOutcome): boolean {
  return (
    outcome.status === 'block' ||
    outcome.status === 'error' ||
    outcome.status === 'timeout'
  )
}

function blockReasonOf(outcome: HookOutcome): string | null {
  if (outcome.status === 'block') return outcome.error
  if (outcome.status === 'error') return outcome.error
  if (outcome.status === 'timeout') return outcome.error
  return null
}

type MatchingHookEntry = { hook: AnyHook; skillRoot?: string }

function collectMatchingHooks(
  appState: WorkingState,
  sessionId: string,
  event: LifecycleEventName,
  subject: string,
): MatchingHookEntry[] {
  const commandMatchers: TransientHookView[] =
    transientHooksFor(appState, sessionId, event).get(event) ?? []
  const functionMatchers: SessionFunctionHookMatcher[] =
    inProcessHooksFor(appState, sessionId, event).get(event) ?? []

  const entries: MatchingHookEntry[] = []
  for (const m of commandMatchers) {
    if (!matchesMatcher(m.matcher, subject)) continue
    for (const hook of m.hooks) entries.push({ hook, skillRoot: m.skillRoot })
  }
  for (const m of functionMatchers) {
    if (!matchesMatcher(m.matcher, subject)) continue
    for (const hook of m.hooks) entries.push({ hook, skillRoot: m.skillRoot })
  }
  return entries
}

/**
 * Fire every registered hook whose matcher applies to `subject`,
 * aggregate their outcomes, and return them.
 *
 * Hooks run concurrently. Each one has its own timeout window — a hung
 * hook doesn't keep the others waiting. The shared `signal` (if any)
 * aborts the whole batch.
 */
export async function fireLifecycleEvent(
  params: ExecuteHooksParams,
): Promise<HookBatchVerdict> {
  const entries = collectMatchingHooks(
    params.appState,
    params.sessionId,
    params.event,
    params.subject,
  )
  if (entries.length === 0) {
    return {
      blocked: false,
      errors: [],
      warnings: [],
      additionalContext: [],
      systemMessages: [],
      results: [],
    }
  }

  const results = await Promise.all(entries.map(entry => executeOne(entry, params)))

  // Honor `once: true` — remove the persistable hook from the registry
  // after it fired, regardless of outcome: `once` is "run this hook exactly one time" not "only
  // remove on success." Function hooks don't have `once` in their type
  // — they're SDK-level callbacks the consumer manages itself.
  if (params.setAppState) {
    for (const { hook } of results) {
      if (hook.type !== 'function' && 'once' in hook && hook.once) {
        detachTransientHook(params.setAppState, params.sessionId, params.event, hook)
      }
    }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const additionalContext: string[] = []
  const systemMessages: string[] = []
  let permissionRequest: PermissionRequestDecision | undefined
  let blocked = false
  for (const r of results) {
    if (isBlockingOutcome(r.outcome)) {
      blocked = true
      const err = blockReasonOf(r.outcome)
      if (err) errors.push(err)
    } else if (r.outcome.status === 'non_blocking_error') {
      warnings.push(r.outcome.error)
    } else if (r.outcome.status === 'pass') {
      if (r.outcome.additionalContext) {
        additionalContext.push(r.outcome.additionalContext)
      }
      if (r.outcome.systemMessage) {
        systemMessages.push(r.outcome.systemMessage)
      }
      if (r.outcome.permissionRequest) permissionRequest = r.outcome.permissionRequest
    }
  }

  return {
    blocked,
    errors,
    warnings,
    additionalContext,
    systemMessages,
    ...(permissionRequest ? { permissionRequest } : {}),
    results,
  }
}

/** Convenience wrapper for the common case: `PreToolUse` against a tool. */
export async function fireBeforeToolCall(params: {
  toolName: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'PreToolUse',
    subject: params.toolName,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** Convenience wrapper for `PostToolUse` — fires after a tool's `call`
 *  returns. Side effects already happened; the hook can complain but
 *  cannot un-run the tool. */
export async function fireAfterToolCall(params: {
  toolName: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'PostToolUse',
    subject: params.toolName,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** Convenience wrapper for `Stop` — fires at end-of-turn. The
 *  `subject` slot has no natural value for Stop (it's not tool-scoped),
 *  so we pass an empty string which match-all matchers correctly
 *  accept and other matchers reject. */
export async function fireTurnEnd(params: {
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'Stop',
    subject: '',
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `PostToolUseFailure` — fires when `tool.call` threw. Subject is
 *  the tool name so matchers can target specific tools just like
 *  `PostToolUse`. The hook outcome is informational at this point;
 *  the error already happened. */
export async function executePostToolFailureHooks(params: {
  toolName: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'PostToolUseFailure',
    subject: params.toolName,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `PreCompact` — fires before a compaction runs the summarizer.
 *  Blocking lets a hook abort compaction (e.g. a policy that disallows
 *  summarization in certain workspaces). Subject is the trigger
 *  (`'auto'` / `'manual'`), so a matcher can pick one. */
export async function fireBeforeFold(params: {
  reason: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'PreCompact',
    subject: params.reason,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `PostCompact` — fires after a compaction completes successfully.
 *  Blocking outcome is informational; the summary already replaced
 *  the conversation. */
export async function fireAfterFold(params: {
  reason: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'PostCompact',
    subject: params.reason,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `UserPromptSubmit` — fires once at the top of each query loop
 *  invocation, before the model sees the new user prompt. Subject is
 *  empty (the prompt text would force matchers into substring/regex
 *  territory we don't support yet), so only match-all matchers fire.
 *  A blocked outcome causes the query loop to refuse the prompt with
 *  a synthetic assistant response — the model never runs that turn. */
export async function firePromptSubmitted(params: {
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'UserPromptSubmit',
    subject: '',
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `SessionStart` — fires when a session begins a conversation: its first
 *  model turn (`startup` / `resume`), the turn after a `/clear`, and right
 *  after a compaction (`compact`). A hook can inject context via its output
 *  (`additionalContext`); the caller (`lifecycleHooks/sessionLifecycleHooks.ts`)
 *  adds it as a meta user message. The matcher subject is the `source`. */
export async function fireSessionOpened(params: {
  source: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'SessionStart',
    subject: params.source,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `SessionEnd` — fires once when a session is torn down. Subject is the
 *  end `reason` so matchers can target specific shutdowns. Must run BEFORE
 *  the session's hooks are cleared. Informational (the turn is over). */
export async function fireSessionClosed(params: {
  reason: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'SessionEnd',
    subject: params.reason,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `Notification` — fires when the agent emits a notification (idle,
 *  needs-input, turn-end). Subject is the notification type. Fire-and-forget
 *  at the notifier; a blocking outcome is ignored (notifications don't gate
 *  the loop). */
export async function fireAlertRaised(params: {
  notificationType: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'Notification',
    subject: params.notificationType,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `StopFailure` — fires in place of `Stop` when an API error ended the
 *  turn. Subject is the error type.
 *  Fire-and-forget at the query loop; the outcome is ignored. */
export async function fireTurnFailed(params: {
  error: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'StopFailure',
    subject: params.error,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `PermissionRequest` — fires when a tool call asks for permission: beside
 *  the dialog, or in its place where no dialog can be shown. Subject is the
 *  tool name. A hook answers with `hookSpecificOutput.decision`
 *  (`permissionRequest` on the aggregate); a hook that gives none leaves the
 *  ask to the person (or the headless auto-deny). */
export async function fireApprovalAsked(params: {
  toolName: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'PermissionRequest',
    subject: params.toolName,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `SubagentStart` — fires when a forked sub-agent begins. Subject is the
 *  agent id. A hook can inject context into the fork via `additionalContext`.
 *  Blocking outcome is informational. */
export async function fireChildAgentStarted(params: {
  agentId: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'SubagentStart',
    subject: params.agentId,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

/** `SubagentStop` — fires at a fork's turn-end in place of `Stop`
 *  (`runTurnEndHooks` in `engine/turn/turnDependencies.ts`, for a context with an `agentId`).
 *  Subject is the agent id. A blocking outcome feeds back into the fork's
 *  loop, as `Stop` does into the main agent's. */
export async function executeSubagentStopHooks(params: {
  agentId: string
  sessionId: string
  appState: WorkingState
  setAppState?: WorkingStateWriter
  signal?: AbortSignal
  commandRunner?: HookCommandRunner
  promptRunner?: HookPromptRunner
  agentRunner?: HookAgentRunner
  httpRunner?: HookHttpRunner
  hookInput?: ExecuteHooksParams['hookInput']
}): Promise<HookBatchVerdict> {
  return fireLifecycleEvent({
    event: 'SubagentStop',
    subject: params.agentId,
    sessionId: params.sessionId,
    appState: params.appState,
    setAppState: params.setAppState,
    signal: params.signal,
    commandRunner: params.commandRunner,
    promptRunner: params.promptRunner,
    agentRunner: params.agentRunner,
    httpRunner: params.httpRunner,
    hookInput: params.hookInput,
  })
}

// Re-export detachInProcessHook so callers that consume the executor
// module don't have to also import from sessionHooks just to clean up
// after a once-fired function hook by id.
export { detachInProcessHook }
