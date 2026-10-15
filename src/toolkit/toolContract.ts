/**
 * The tool contract: what a tool provides to be offered and run, `declareTool`,
 * and lookup by name. Imports are type-only so tools never pull a value
 * dependency back through it.
 */
import type { AgentProfile, Message } from '../runtime/RuntimeTypes'
import type { PageFingerprint } from '../engine/loop/agentLoopState'
import type { FileChangeDiff } from '../utils/fileChangeHunks'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { ToolCallContext } from './toolCallContext'
import type {
  PermissionDecider,
  PermissionRuleSet,
  ToolPermissionResult,
} from './permissionVerdict'

/** A JSON schema for a tool's arguments; the top level is always an object. */
export type ToolArgsJsonShape = {
  [key: string]: unknown
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
}

/** The answer of a tool's own argument check. */
export type InputCheck =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

/**
 * Loop-guard data a browser tool reports with its result. Every field is
 * optional; a missing one turns the matching guard off for that call.
 */
export type AgentToolMeta = {
  /** One short hash per counted action of a batch (waits and navigation
   *  are not counted). */
  actionHashes?: string[]
  /** The page state after the call, compared across calls for stagnation. */
  pageFingerprint?: PageFingerprint
  /** The URL after the call. */
  postUrl?: string
  /** The focused element after the call; null when nothing has focus. */
  postFocusTargetId?: string | null
  /** The batch ended a multi-action sequence. */
  terminatesSequence?: boolean
}

/** What a tool's `call` resolves to. */
export type ToolOutcome<T> = {
  data: T
  /** Rows to add to the transcript after the tool result. */
  extraRows?: Message[]
  /** Applied to the context of the calls that follow, in call order. */
  contextPatch?: (context: ToolCallContext) => ToolCallContext
  agentMeta?: AgentToolMeta
  /** A file diff for the UI only; never part of what the model reads. */
  uiEditDiff?: FileChangeDiff
  /**
   * The call failed but still returns a normal body. The result block is
   * flagged as an error (`isError` is the provider's error flag) while
   * the body is kept, instead of the bare message a thrown error produces.
   */
  isError?: boolean
}

/** Receives progress updates while a tool runs. */
export type ToolCallStepUpdate<P = unknown> = (progress: P) => void

export type ToolContractList = readonly ToolContract[]

export type ToolContract<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
  P = unknown,
> = {
  readonly name: string
  /** Other names the tool also answers to. */
  aliases?: string[]
  /** A short phrase the tool search ranks against. */
  discoveryHint?: string
  call(
    args: Input,
    context: ToolCallContext,
    canUseTool: PermissionDecider,
    invokingRow: Message,
    onProgress?: ToolCallStepUpdate<P>,
  ): Promise<ToolOutcome<Output>>
  description(
    input: Input,
    options: {
      isNonInteractiveSession: boolean
      permissionRules: PermissionRuleSet
      tools: ToolContractList
      /** The agents the tool may describe (optional for direct callers). */
      agents?: AgentProfile[]
      /** The calling runtime, for descriptions that depend on per-runtime
       *  state such as the deferred-tool registry. */
      runtimeConfig?: RuntimeConfig
      /** The session's extensions, for descriptions that list what the
       *  model may call. */
      mods?: ToolCallContext['options']['mods']
    },
  ): Promise<string> | string
  /** A runtime validator for the arguments (`safeParse`). */
  readonly argsShape?: unknown
  /** The argument schema sent to the model. */
  readonly argsSchema?: ToolArgsJsonShape
  /** A schema variant usable in a provider's strict mode; used instead of
   *  `argsSchema` when the model supports strict tools. */
  readonly inputJSONSchemaStrict?: ToolArgsJsonShape
  /** Example argument objects sent with the definition where the provider
   *  accepts them. */
  readonly inputExamples?: ReadonlyArray<Record<string, unknown>>
  /** May run alongside other parallel-safe calls of the same step. */
  parallelSafe(input: Input): boolean
  /** Offered to the model at all right now. */
  offeredNow(): boolean
  /** Only reads; never changes files, pages or other state. */
  readsOnly(input: Input): boolean
  /** Needs the user's answer before it can produce a result. */
  haltsForUser?(): boolean
  /** Comes from an MCP server. */
  fromMcpServer?: boolean
  /** The skill group the tool belongs to; while that group is deferred and
   *  not active, the tool's schema is withheld and calls are refused. */
  readonly skill?: string
  /** The MCP server and tool name, for tools from an MCP server. */
  mcpInfo?: { serverName: string; toolName: string }
  readonly strict?: boolean
  /** The tool's own argument check, run before any permission step. */
  checkInput?(
    input: Input,
    context: ToolCallContext,
  ): Promise<InputCheck>
  /** The tool's own permission opinion, consulted by the verdict pipeline. */
  selfVerdict(
    input: Input,
    context: ToolCallContext,
  ): Promise<ToolPermissionResult>
}

// ── declaring a tool ────────────────────────────────────────────────────────

/** Members a declaration may omit; `declareTool` supplies them. */
type OptionalWhenDeclared = 'offeredNow' | 'parallelSafe' | 'readsOnly' | 'selfVerdict'

/** A tool as written by its author: the contract with the defaulted members
 *  optional. */
export type ToolDeclaration<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
  P = unknown,
> = Omit<ToolContract<Input, Output, P>, OptionalWhenDeclared> &
  Partial<Pick<ToolContract<Input, Output, P>, OptionalWhenDeclared>>

// A tool that states nothing is offered, runs alone, counts as a writer and
// raises no objection of its own (the arguments go through unchanged).
const fallbackMembers = {
  offeredNow: (): boolean => true,
  parallelSafe: (_args?: unknown): boolean => false,
  readsOnly: (_args?: unknown): boolean => false,
  selfVerdict: (
    args: Record<string, unknown>,
    _context?: ToolCallContext,
  ): Promise<ToolPermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: args }),
}

type FallbackMembers = typeof fallbackMembers

type FilledMember<D, K extends OptionalWhenDeclared> = K extends keyof D
  ? undefined extends D[K]
    ? Exclude<D[K], undefined> | FallbackMembers[K]
    : D[K]
  : FallbackMembers[K]

type DeclaredContract<D> = Omit<D, OptionalWhenDeclared> & {
  [K in OptionalWhenDeclared]-?: FilledMember<D, K>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDeclaration = ToolDeclaration<any, any, any>

/** Turns a declaration into a full contract by adding every member it left
 *  out. Members the declaration states are kept as they are. */
export function declareTool<D extends AnyToolDeclaration>(declaration: D): DeclaredContract<D> {
  const contract: Record<string, unknown> = { ...declaration }
  for (const member of Object.keys(fallbackMembers) as OptionalWhenDeclared[]) {
    if (!(member in contract)) contract[member] = fallbackMembers[member]
  }
  return contract as DeclaredContract<D>
}

// ── finding tools ───────────────────────────────────────────────────────────

/** True when `wanted` is the tool's name or one of its aliases. */
export function toolAnswersTo(
  tool: { name: string; aliases?: string[] },
  wanted: string,
): boolean {
  if (tool.name === wanted) return true
  return tool.aliases !== undefined && tool.aliases.includes(wanted)
}

/** The first tool in the list that answers to `wanted`. */
export function resolveToolByName(
  tools: ToolContractList,
  wanted: string,
): ToolContract | undefined {
  for (const tool of tools) {
    if (toolAnswersTo(tool, wanted)) return tool
  }
  return undefined
}

/**
 * Removes the tools a blanket deny rule names, so the model is never offered
 * them. A blanket rule is a bare tool name, `Name()` or `Name(*)`; a rule with
 * content only denies some calls and is left to the call-time gate.
 * `mcp__<server>` also covers every tool of that server.
 */
export function dropDeniedTools<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], ruleSet: PermissionRuleSet): T[] {
  const blanket = new Set<string>()
  for (const rules of Object.values(ruleSet.denyRuleBook)) {
    for (const rule of rules ?? []) {
      const open = rule.indexOf('(')
      if (open === -1) blanket.add(rule)
      else if (rule.endsWith(')') && ['', '*'].includes(rule.slice(open + 1, -1))) {
        blanket.add(rule.slice(0, open))
      }
    }
  }
  if (blanket.size === 0) return [...tools]
  return tools.filter(tool => {
    if (blanket.has(tool.name)) return false
    const server = tool.mcpInfo?.serverName
    return !(server !== undefined && tool.name.startsWith('mcp__') && blanket.has(`mcp__${server}`))
  })
}
