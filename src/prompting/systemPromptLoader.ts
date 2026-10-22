import { getProductName } from '../branding/productName'
import type { ToolContractList } from '../toolkit/toolContract'
import { fetchPromptTemplate, PromptUnavailableError } from './systemPromptFetcher'
import type { SystemPromptVariant } from './systemPromptLoader.types'
import { sessionGuidanceChunk } from './systemPromptSessionGuidance'
import { getEnabledToolNames } from './systemPromptToolSection'
import { getVisibleSkillCatalogs } from '../toolkit/run/skillCatalogs'
import { renderMcpServerSections, type McpServerPromptEntry } from './mcpServerSections'
import { getHolderProse, getTemplate } from './templateRegistry'
import {
  renderPromptSection,
  type PromptSectionName,
} from './sections/promptSectionRenderer'
import type { PromptProfile } from './promptProfile'

export type { SystemPromptVariant } from './systemPromptLoader.types'
export { PromptUnavailableError } from './systemPromptFetcher'

// Renders the two shared prompt sections (`promptSectionRenderer.ts`; tests
// inject a stand-in): `system-prompt-tools` inline into its slot, and
// `using-your-tools` for `{{TOOL_CATALOG}}` on the fetch+split fallback only.
export type PromptSectionRenderer = (params: {
  name: PromptSectionName
  enabledToolNames: string[]
}) => { text: string }

export type SelectSystemPromptParams = {
  tools: ToolContractList
  /** The connected MCP servers with instructions, for `$mcp_servers`. */
  mcpServers?: ReadonlyArray<McpServerPromptEntry>
  /**
   * Per-session agent-template type (the `src/template/<type>/` folder, e.g.
   * `chat`). When set AND a manifest exists, the prompt is composed from
   * that template's `## prompt` skeleton (fine-grained per-holder elements)
   * instead of fetching + splitting the monolithic `system_prompt.md`.
   * Absent ⇒ the legacy fetch+split path (also used for the flash variants
   * in v1). See `templateRegistry.ts`.
   */
  templateType?: string
  /**
   * Deferral-aware **visible** tool names (the deferral-filtered set used
   * for `tools[]`). When provided, the holder-emitting loader gates the
   * tool-catalog holder on THIS set instead of all `tools`, so a
   * deferred-and-inactive skill's catalog prose is hidden until the skill
   * activates. Absent ⇒ gate on all `tools`
   * (today's behavior).
   */
  visibleToolNames?: string[]
  /**
   * Provider id from the active model config — e.g. 'anthropic', 'openai',
   * 'glm', 'qwen'. Selects only the FLASH prompt variant; holder prose never
   * keys on it (see `promptProfile`).
   */
  providerId?: string
  /**
   * The prompt profile this turn renders with — resolved per turn from the
   * session's current model by `engine/systemPromptSources.ts`
   * (`resolvePromptProfile`). `'lean'` picks a holder's `<name>-lean.md`
   * where one exists; `'standard'` / absent renders the base files. There is
   * no cache between this value and the prose, so a mid-session model switch
   * renders the other profile on its next turn.
   */
  promptProfile?: PromptProfile
  /** New per-turn flag: pick a shorter prompt for low-latency runs. */
  flashMode?: boolean
  /**
   * Renderer for the `{{system-prompt-tools}}` slot and the `{{TOOL_CATALOG}}`
   * block. Absent ⇒ the runtime's own `renderPromptSection`; a test passes a
   * stand-in to observe the calls or substitute the text.
   */
  promptSectionRenderer?: PromptSectionRenderer
}

const TOOL_CATALOG_PLACEHOLDER = '{{TOOL_CATALOG}}'
const SYSTEM_PROMPT_TOOLS_PLACEHOLDER = '{{system-prompt-tools}}'
const AGENT_NAME_PLACEHOLDER = '{{AGENT_NAME}}'

/**
 * Pick the prompt variant; pure. One full prompt (`system_prompt`). Known
 * limitation: the flash pick is keyed on `providerId === 'anthropic'`, not the
 * profile, so a relayed `custom-anthropic` session gets the other flash prompt.
 */
export function selectSystemPromptVariant(
  p: SelectSystemPromptParams,
): SystemPromptVariant {
  if (p.flashMode) {
    return p.providerId === 'anthropic'
      ? 'system_prompt_anthropic_flash'
      : 'system_prompt_flash'
  }
  return 'system_prompt'
}

function renderSection(
  name: PromptSectionName,
  activeToolIds: string[],
  renderer: PromptSectionRenderer | undefined,
): string {
  return (renderer ?? renderPromptSection)({ name, enabledToolNames: activeToolIds }).text
}

/**
 * The system prompt as finished sections, each the literal text the model
 * sees; the host joins them with a blank line. Each manifest type owns its
 * `# Tools` holder; only the flash fallback renders the shared catalog block.
 * `{{AGENT_NAME}}` and `{{system-prompt-tools}}` are substituted here.
 */
export type SystemPromptHolderPart = string

/**
 * One prompt section as the loader builds it. `name` is the holder / section
 * it came from (`system`, `base.pre`, `using-your-tools`, `skill.a2ui.catalog`,
 * …), absent for literal template lines and the session-guidance block. The
 * name is for tests and diagnostics only — it never goes on the wire.
 */
export type PromptChunk = { name?: string; text: string }

// `{{IF_TOOL:<ToolName>}}` — a LINE gate in holder prose. The line is kept
// (marker stripped, every other byte intact) when `<ToolName>` is in the
// turn's visible tool set, and dropped whole — newline included — when it is
// not. It exists for a bullet that names one tool inside a section that must
// otherwise stay: a tool can be absent for THIS turn only (the per-model todo
// gate, utils/todoTools.ts), and prose telling the model to use a tool whose
// schema it was not sent is worse than no prose. Written at the very start of
// the line so stripping it restores the ungated text byte for byte.
const IF_TOOL_LINE = /^\{\{IF_TOOL:([A-Za-z0-9_]+)\}\}(.*(?:\r?\n|$))/gm

export function applyToolLineGates(
  text: string,
  visibleToolNames: ReadonlySet<string>,
): string {
  if (!text.includes('{{IF_TOOL:')) return text
  const gated = text.replace(IF_TOOL_LINE, (_line, toolName: string, rest: string) =>
    visibleToolNames.has(toolName) ? rest : '',
  )
  // Holder prose arrives trimmed, so a dropped LAST line would leave the
  // newline that preceded it dangling.
  return text.endsWith('\n') ? gated : gated.replace(/\r?\n$/, '')
}

/** The system prompt as the finished sections the host receives. */
export async function loadSystemPromptHolders(
  p: SelectSystemPromptParams,
): Promise<SystemPromptHolderPart[]> {
  return (await loadSystemPromptSections(p)).map(section => section.text)
}

export async function loadSystemPromptSections(
  p: SelectSystemPromptParams,
): Promise<PromptChunk[]> {
  const variant = selectSystemPromptVariant(p)

  const enabledToolNameSet = getEnabledToolNames(p.tools)
  const enabledToolNames = Array.from(enabledToolNameSet)
  const sessionGuidance = sessionGuidanceChunk(enabledToolNameSet)

  // Gate the catalog (and the cross-cutting browser prose below) on the
  // deferral-aware VISIBLE set when provided, so a deferred-and-inactive
  // skill's catalog prose is hidden until activation — consistent with its
  // schemas being absent from tools[]. Absent ⇒ gate on all `tools`.
  const catalogEnabledToolNames = p.visibleToolNames ?? enabledToolNames

  // The cross-cutting `{{system-prompt-tools}}` prose (system-prompt-tools.md)
  // is entirely BROWSER guidance (Act→Verify; the per-tool required-fields
  // cheatsheet). It belongs to the browser skill, so it must DEFER with it:
  // render + inline it only when a browser tool is in the visible set. Else a
  // deferred-inactive browser skill would strand its cheatsheet mid-`doing_tasks`
  // while its catalog section + schemas are correctly hidden. (Hosted browser
  // tools are named `Browser*`; `Done` never appears without them, so the
  // prefix is a sound "browser is active" probe.)
  const browserVisible = catalogEnabledToolNames.some(n => n.startsWith('Browser'))
  const systemPromptTools = browserVisible
    ? renderSection('system-prompt-tools', catalogEnabledToolNames, p.promptSectionRenderer)
    : ''

  // Inline placeholder substitution (same order as the legacy path):
  // {{AGENT_NAME}} → product name, {{system-prompt-tools}} → rendered prose.
  const lineGateToolNames = new Set(catalogEnabledToolNames)
  const substitute = (text: string): string =>
    applyToolLineGates(text, lineGateToolNames)
      .split(AGENT_NAME_PLACEHOLDER)
      .join(getProductName())
      .split(SYSTEM_PROMPT_TOOLS_PLACEHOLDER)
      .join(systemPromptTools)

  // JS skill catalogs (a2ui): a skill with no C++ tool-catalog section emits a
  // `## <Skill> tools` section right after the `# Tools` block,
  // gated on the catalog-visible set so it activation-defers with its skill.
  const skillCatalogHolders: PromptChunk[] = getVisibleSkillCatalogs(
    new Set(catalogEnabledToolNames),
  ).map(({ holderName, content }) => ({ name: holderName, text: content }))

  // The connected MCP servers' own instructions, rendered whether or not
  // their tools are loaded: the section is how the model learns when to load them.
  const mcpServersChunk = renderMcpServerSections(p.mcpServers ?? [])

  // ── Manifest path (per-session agent template) ──────────────────────
  // When a template type is given AND a manifest exists, compose the prompt
  // from its `## prompt` skeleton (fine-grained per-holder elements). The
  // FLASH variants are shorter, distinct prompts with no manifest, so they
  // fall through to the fetch+split path below.
  const template = p.templateType ? getTemplate(p.templateType) : undefined
  if (template && variant === 'system_prompt') {
    const parts: PromptChunk[] = []
    for (const el of template.prompt) {
      if (el.kind === 'holder') {
        // Each type owns its `# Tools` block as
        // `<type>_using_your_tools` prose, resolved through the ordinary
        // `getHolderProse` path below. Only the fetch+split fallback further
        // down (flash variants, no manifest) renders the shared catalog block.
        // A `!name @lean` / `!name @standard` line belongs to ONE profile
        // (no profile on the turn ⇒ standard, as in `getHolderProse`).
        if (el.profile !== undefined && el.profile !== (p.promptProfile ?? 'standard')) {
          continue
        }
        // Profile-aware: under the LEAN profile a `<name>-lean.md` variant
        // (e.g. the lean `code_*-lean.md` files) wins over the
        // base file; the STANDARD profile gets the base prose. A variant with
        // NO base file resolves only under its profile and is simply absent
        // otherwise. The profile is the caller's per-turn resolution — never
        // derived from `providerId` here. A `!name =<profile>` PIN overrides
        // it for this holder only: the line is still emitted under whatever
        // profile the gate admits, but always with the pinned rendering.
        const prose = getHolderProse(el.name, {
          type: p.templateType,
          profile: el.render ?? p.promptProfile,
        })
        // No prose file for this holder under this profile → no section.
        if (prose !== undefined) parts.push({ name: el.name, text: substitute(prose) })
      } else if (el.kind === 'dynamic') {
        if (el.name === 'skill_catalogs') {
          parts.push(...skillCatalogHolders)
        } else if (el.name === 'mcp_servers') {
          if (mcpServersChunk) parts.push(mcpServersChunk)
        } else if (el.name === 'session_guidance') {
          if (sessionGuidance) parts.push({ text: sessionGuidance })
        }
        // `environment` / `memory` are positioned + filled downstream
        // (queryContext / QueryEngine) in v1 — skipped here.
      } else {
        parts.push({ text: el.text }) // literal line, verbatim
      }
    }
    return parts
  }

  // ── Fetch + split path (flash/thinking variants, or no template) ────
  const rawTemplate = await fetchPromptTemplate(variant)
  const withSysTools = substitute(rawTemplate)

  // The `{{TOOL_CATALOG}}` block for the visible tool set. Empty (dropped)
  // when no tool family it covers is visible.
  const catalogText = renderSection(
    'using-your-tools',
    catalogEnabledToolNames,
    p.promptSectionRenderer,
  )
  const catalogParts: PromptChunk[] = catalogText
    ? [{ name: 'using-your-tools', text: catalogText }]
    : []

  const idx = withSysTools.indexOf(TOOL_CATALOG_PLACEHOLDER)
  if (idx < 0) {
    const trimmed = withSysTools.replace(/\s+$/, '')
    const parts: PromptChunk[] = [
      { name: 'base.full', text: trimmed },
      ...catalogParts,
      ...skillCatalogHolders,
      ...(mcpServersChunk ? [mcpServersChunk] : []),
    ]
    return sessionGuidance ? [...parts, { text: sessionGuidance }] : parts
  }

  const before = withSysTools.slice(0, idx).replace(/\s+$/, '')
  const after = withSysTools
    .slice(idx + TOOL_CATALOG_PLACEHOLDER.length)
    .replace(/^\s+/, '')
  const afterWithGuidance = sessionGuidance
    ? after
      ? `${sessionGuidance}\n\n${after}`
      : sessionGuidance
    : after

  const parts: PromptChunk[] = []
  if (before) parts.push({ name: 'base.pre', text: before })
  parts.push(...catalogParts)
  parts.push(...skillCatalogHolders)
  if (mcpServersChunk) parts.push(mcpServersChunk)
  if (afterWithGuidance) parts.push({ name: 'base.post', text: afterWithGuidance })
  return parts
}
