import type { ServerLink, Message } from '../RuntimeTypes'
import type { ToolContractList } from '../../toolkit/toolContract'
import type { McpServerPromptEntry } from '../../prompting/mcpServerSections'

export type FetchSystemPromptPartsParams = {
  tools: ToolContractList
  /** The connected MCP servers with instructions, for the `$mcp_servers` section. */
  mcpServers?: ReadonlyArray<McpServerPromptEntry>
  /**
   * Deferral-aware visible tool names (deferral-filtered set). Forwarded to
   * the holder-emitting loader so the tool-catalog holder is gated on the
   * visible set (a deferred-inactive skill's catalog prose hides
   * until activation). Optional; absent ⇒ gate on all `tools`.
   */
  visibleToolNames?: string[]
  mainLoopModel: string
  extraWorkspaceRoots: string[]
  /** The environment block's `Git repository` line; omitted while unknown. */
  gitRepository?: boolean
  mcpClients: ServerLink[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  mutableMessages?: readonly Message[]
  cwd: string
  /**
   * Provider id of the active model — feeds into prompt-variant selection.
   * Optional so existing callers default to the non-Anthropic / generic
   * branch (no behavior change).
   */
  providerId?: string
  /**
   * Per-turn flag for the lower-latency flash prompt variant. Distinct
   * from `appState.fastMode` (UI session toggle) — wire those together at
   * the AskParams construction site if/when product wants them coupled.
   */
  flashMode?: boolean
  /**
   * Per-session agent-template type (the `src/template/<type>/` folder, e.g.
   * `chat`). Forwarded to `loadSystemPromptHolders`; when a manifest exists
   * for the default variant the prompt is composed from it. Absent ⇒ the
   * legacy fetch+split path.
   */
  templateType?: string
}

/**
 * A system-prompt array element: one finished section of literal text. The
 * host joins the sections with a blank line and resolves nothing.
 */
export type SystemPromptPart = string

/** One section of `defaultSystemPrompt` with the name it came from (the
 *  holder, `env_info`, `memory`, …), absent for a literal template line —
 *  what a mod's `prompt.compose` finds a section by (F-25). */
export type SystemPromptNamedPart = { name?: string; text: string }

export type SystemPromptParts = {
  defaultSystemPrompt: SystemPromptPart[]
  userContext: Record<string, string>
  systemContext: Record<string, string>
  /** `defaultSystemPrompt`, section by section, with each one's name. A
   *  provider that answers none leaves the sections unnamed. */
  sections?: SystemPromptNamedPart[]
}

export interface PromptContextProvider {
  gatherSystemPromptSources(
    params: FetchSystemPromptPartsParams,
  ): Promise<SystemPromptParts>
}
