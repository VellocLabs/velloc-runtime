/**
 * Hook types and validators: the 27 lifecycle events (named as the `.claude/`
 * settings format names them), the persistable `command` / `prompt` / `http` /
 * `agent` hooks plus in-memory `function` hooks, and the `HookMatcher` /
 * `HookTableByEvent` shapes.
 */

import { z } from 'zod'

export const LIFECYCLE_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

export type LifecycleEventName = (typeof LIFECYCLE_EVENT_NAMES)[number]

const HOOK_EVENT_SET: ReadonlySet<LifecycleEventName> = new Set(LIFECYCLE_EVENT_NAMES)

export function isLifecycleEventName(value: unknown): value is LifecycleEventName {
  return typeof value === 'string' && HOOK_EVENT_SET.has(value as LifecycleEventName)
}

/** Shell command hook — invokes a subprocess. */
export type ShellHookSpec = {
  type: 'command'
  command: string
  if?: string
  shell?: 'bash' | 'powershell' | 'pwsh' | 'sh' | 'zsh'
  timeout?: number
  statusMessage?: string
  once?: boolean
  async?: boolean
  asyncRewake?: boolean
}

/** LLM prompt hook — evaluates a prompt template. */
export type PromptHook = {
  type: 'prompt'
  prompt: string
  if?: string
  timeout?: number
  model?: string
  statusMessage?: string
  once?: boolean
}

/** HTTP POST hook — wire-level webhook. */
export type HttpHook = {
  type: 'http'
  url: string
  if?: string
  timeout?: number
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  statusMessage?: string
  once?: boolean
}

/** Agentic verifier hook — runs a sub-agent. */
export type AgentHook = {
  type: 'agent'
  prompt: string
  if?: string
  timeout?: number
  model?: string
  statusMessage?: string
  once?: boolean
}

/** Persistable hook command — appears in settings.json / skill frontmatter. */
export type HookCommand = ShellHookSpec | PromptHook | HttpHook | AgentHook

/**
 * Function hook — TS callback registered programmatically at runtime.
 * Never persisted, never written to settings.json. Used by SDK
 * consumers that want to inject a check without going through one of
 * the external command types.
 */
export type InProcessHookFn = (
  signal?: AbortSignal,
) => boolean | Promise<boolean>

export type InProcessHookSpec = {
  type: 'function'
  id?: string
  timeout?: number
  callback: InProcessHookFn
  errorMessage: string
  statusMessage?: string
}

export type AnyHook = HookCommand | InProcessHookSpec

/** Bundle of hooks that share a matcher string. */
export type HookMatcher = {
  /** String pattern matched against the hook event's subject (e.g. tool
   *  name `"Bash"` for PreToolUse). Empty/undefined means match-all. */
  matcher?: string
  hooks: HookCommand[]
}

/** Hooks settings — keyed by event, each entry an array of matchers. */
export type HookTableByEvent = Partial<Record<LifecycleEventName, HookMatcher[]>>

// ---- Validators ----------------------------------------------------------
//
// Each `parseX(value: unknown): X | null` returns the narrowed value or
// null. Callers log + drop invalid entries rather than throwing — the
// goal is "accept settings.json and skill frontmatter with one bad
// entry without nuking everything else."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Per-hook zod schemas, one per persistable hook type. Every optional
// field carries `.catch(undefined)`: an individually-invalid optional value is
// coerced to undefined (and then dropped) rather than failing the whole hook —
// this preserves the old `pick*` leniency ("keep a hook that has one bad
// optional field"). Required fields (`command`/`prompt`/`url`) have no catch,
// so a missing/invalid one fails the hook → null, exactly as before.

// The shell enum carries every shell NexusShellService can run a hook in:
// bash, powershell, pwsh, sh and zsh.
const SHELL_VALUES = ['bash', 'powershell', 'pwsh', 'sh', 'zsh'] as const

const TimeoutSchema = z.number().positive().optional().catch(undefined)
const IfSchema = z.string().optional().catch(undefined)
const StatusMessageSchema = z.string().optional().catch(undefined)
const OnceSchema = z.boolean().optional().catch(undefined)

/**
 * Reject a hook whose url is malformed up front, rather than letting it sit
 * dormant and fail noisily at execution time. A url counts as well-formed
 * when `new URL()` accepts it.
 */
function isParsableUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

const BashCommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  if: IfSchema,
  shell: z.enum(SHELL_VALUES).optional().catch(undefined),
  timeout: TimeoutSchema,
  statusMessage: StatusMessageSchema,
  once: OnceSchema,
  async: z.boolean().optional().catch(undefined),
  asyncRewake: z.boolean().optional().catch(undefined),
})

const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string(),
  if: IfSchema,
  timeout: TimeoutSchema,
  model: z.string().optional().catch(undefined),
  statusMessage: StatusMessageSchema,
  once: OnceSchema,
})

const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().refine(isParsableUrl),
  if: IfSchema,
  timeout: TimeoutSchema,
  headers: z.record(z.string(), z.string()).optional().catch(undefined),
  allowedEnvVars: z.array(z.string()).optional().catch(undefined),
  statusMessage: StatusMessageSchema,
  once: OnceSchema,
})

const AgentHookSchema = z.object({
  type: z.literal('agent'),
  prompt: z.string(),
  if: IfSchema,
  timeout: TimeoutSchema,
  model: z.string().optional().catch(undefined),
  statusMessage: StatusMessageSchema,
  once: OnceSchema,
})

const hookSpecSchema = z.discriminatedUnion('type', [
  BashCommandHookSchema,
  PromptHookSchema,
  HttpHookSchema,
  AgentHookSchema,
])

const HookMatcherFrameSchema = z.object({
  matcher: z.string().optional().catch(undefined),
  hooks: z.array(z.unknown()),
})

/**
 * Drop `undefined`-valued keys so a hook parsed with caught-invalid optional
 * fields is byte-identical to the old hand-rolled output (no `key: undefined`
 * residue) — keeps `toStrictEqual` callers and persisted JSON clean.
 */
function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as T
}

export function parseHookCommand(value: unknown): HookCommand | null {
  const result = hookSpecSchema.safeParse(value)
  if (!result.success) {
    return null
  }
  return dropUndefined(result.data) as HookCommand
}

export function parseHookMatcher(value: unknown): HookMatcher | null {
  const frame = HookMatcherFrameSchema.safeParse(value)
  if (!frame.success) {
    return null
  }
  const hooks: HookCommand[] = []
  for (const entry of frame.data.hooks) {
    const parsed = parseHookCommand(entry)
    if (parsed) {
      hooks.push(parsed)
    }
  }
  if (hooks.length === 0) {
    return null
  }
  return frame.data.matcher !== undefined
    ? { matcher: frame.data.matcher, hooks }
    : { hooks }
}

export function parseHooksSettings(value: unknown): HookTableByEvent | null {
  if (!isRecord(value)) {
    return null
  }
  const settings: HookTableByEvent = {}
  let acceptedAny = false
  for (const [key, raw] of Object.entries(value)) {
    if (!isLifecycleEventName(key)) {
      continue
    }
    if (!Array.isArray(raw)) {
      continue
    }
    const matchers: HookMatcher[] = []
    for (const entry of raw) {
      const parsed = parseHookMatcher(entry)
      if (parsed) {
        matchers.push(parsed)
      }
    }
    if (matchers.length > 0) {
      settings[key] = matchers
      acceptedAny = true
    }
  }
  return acceptedAny ? settings : null
}

/**
 * Deep equality for two hooks — used by `detachTransientHook` so an exact
 * de-registration of a previously-added hook lands on the right entry
 * without forcing callers to track opaque ids. Function hooks are
 * compared by id only (the callback closures are reference-unique).
 */
export function sameHookSpec(left: AnyHook, right: AnyHook): boolean {
  if (left.type !== right.type) {
    return false
  }
  if (left.type === 'function' && right.type === 'function') {
    return Boolean(left.id && right.id && left.id === right.id)
  }
  // Persistable hooks: deep value equality via JSON serialization. Sufficient
  // because all persistable shapes contain only primitives, arrays of
  // primitives, and plain records.
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}
