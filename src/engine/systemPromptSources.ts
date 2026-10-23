import type {
  FetchSystemPromptPartsParams,
  PromptContextProvider,
  SystemPromptNamedPart,
  SystemPromptPart,
  SystemPromptParts,
} from '../runtime/interfaces/PromptContextProvider'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ToolContractList } from '../toolkit/toolContract'
import { loadSystemPromptSections } from '../prompting/systemPromptLoader'
import { resolvePromptProfile } from '../prompting/promptProfile'
import { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import {
  buildBrowserSystemContext,
  type BuildBrowserSystemContextParams,
} from '../browser/context/buildBrowserSystemContext'
import {
  buildBrowserUserContext,
  type BuildBrowserUserContextParams,
} from '../browser/context/buildBrowserUserContext'
import {
  MSG_TYPE_ASSISTANT,
  isAssistantMessage,
} from '../runtime/VercelModelConstants'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { formatLocalISODate } from '../utils/dateFormat'
import { resolveModelId } from '../config/nexusModelConfig/modelEntryResolution'
import { buildEnvironmentInfo } from '../utils/environmentInfo'

export type BrowserPromptContextProviderOptions = {
  hostBridge: BrowserHostBridge
  /**
   * Clock source consulted exactly once at construction to capture the
   * session-start date that lives in the cached `userContext`. Required
   * so the cached system prefix stays byte-stable across turns even when
   * the wall clock crosses midnight (rollover is handled by the lazy
   * `date_change` attachment instead).
   */
  runtimeConfig: RuntimeConfig
}

async function buildDefaultSystemPrompt(
  params: FetchSystemPromptPartsParams,
): Promise<SystemPromptNamedPart[]> {
  // The prompt profile is resolved once per turn from this turn's provider and EFFECTIVE model (after a
  // skill's `model:`). `'inherit'` matches no catalog row and resolves to `standard`.
  const promptProfile = resolvePromptProfile({
    providerId: params.providerId,
    modelId: params.mainLoopModel,
  })

  const loaderParams = {
    tools: params.tools,
    mcpServers: params.mcpServers,
    mcpServerFailures: params.mcpServerFailures,
    visibleToolNames: params.visibleToolNames,
    providerId: params.providerId,
    promptProfile,
    flashMode: params.flashMode,
    templateType: params.templateType,
  }

  // customSystemPrompt short-circuits before any network fetch — overrides
  // never trigger the system_prompts/<variant>.md request. Otherwise the
  // loader returns the finished sections the host joins verbatim.
  // Each section keeps its name (the holder it came from) for a mod's
  // `prompt.compose` (F-25); the host still joins the texts verbatim.
  const basePrompt: SystemPromptNamedPart[] =
    params.customSystemPrompt !== undefined
      ? [{ name: 'custom_system_prompt', text: params.customSystemPrompt }]
      : await loadSystemPromptSections(loaderParams)

  if (params.appendSystemPrompt) {
    return [...basePrompt, { name: 'append_system_prompt', text: params.appendSystemPrompt }]
  }

  return basePrompt
}

export async function gatherSystemPromptSources(
  params: FetchSystemPromptPartsParams,
  options: {
    promptContextProvider?: PromptContextProvider
    hostBridge?: BrowserHostBridge
    /**
     * Frozen-at-session-bootstrap local ISO date (YYYY-MM-DD). Required when
     * resolving via `hostBridge` directly (no provider) — passed straight to
     * `buildBrowserUserContext` so the cached system prefix carries today's
     * date once instead of being recomputed per call.
     */
    sessionStartDate?: string
  } = {},
): Promise<SystemPromptParts> {
  if (options.promptContextProvider) {
    return options.promptContextProvider.gatherSystemPromptSources(params)
  }

  if (!options.hostBridge) {
    throw new Error(
      'fetchSystemPromptParts requires a promptContextProvider or hostBridge in chromium-runtime.',
    )
  }

  if (options.sessionStartDate === undefined) {
    throw new Error(
      'fetchSystemPromptParts requires sessionStartDate when invoked with hostBridge directly.',
    )
  }

  const [snapshot, basePrompt] = await Promise.all([
    options.hostBridge.getBrowserContextSnapshot({
      includeDomSnapshot: true,
      includeAccessibilitySnapshot: true,
    }),
    buildDefaultSystemPrompt(params),
  ])

  // # Environment block, injected into the system prompt. Appended AFTER the
  // base prompt so path-using tool descriptions (Read/Write/Edit/Bash)
  // see the cwd + platform context before the model decides which path
  // shape to construct. Host platform/osVersion/shell come from the
  // `fs.systemInfo` bridge route (base::SysInfo on the C++ side),
  // propagated through `BrowserSessionState` by `BrowserHostBridge`.
  // No JS-side fallback: if the host omits a field, the builder omits
  // the corresponding line.
  const envBlock = buildEnvironmentInfo({
    cwd: params.cwd,
    extraWorkspaceRoots: params.extraWorkspaceRoots,
    gitRepository: params.gitRepository,
    platform: snapshot.session.platform,
    osVersion: snapshot.session.osVersion,
    shell: snapshot.session.shell,
    // A model ENTRY (`claude-haiku-*@latest`) is a virtual id; the model is
    // told the concrete one it resolves to.
    mainLoopModel: resolveModelId(params.providerId, params.mainLoopModel),
  })

  const sections = envBlock !== null ? [...basePrompt, { name: 'env_info', text: envBlock }] : basePrompt
  const defaultSystemPrompt: SystemPromptPart[] = sections.map(section => section.text)

  return {
    defaultSystemPrompt,
    sections,
    userContext: buildBrowserUserContext({
      snapshot,
      sessionStartDate: options.sessionStartDate,
    }),
    systemContext: buildBrowserSystemContext({
      snapshot,
      mcpClients: params.mcpClients,
    }),
  }
}

export type BuildSideQuestionFallbackParamsOptions = {
  tools: ToolContractList
  messages: Message[]
  callContext: ToolCallContext
  promptOverride?: string
  promptSuffix?: string
  /** Forwarded into the prompt-variant selector — see FetchSystemPromptPartsParams. */
  providerId?: string
  flashMode?: boolean
}

export async function sideQuestionFallbackInput(
  params: BuildSideQuestionFallbackParamsOptions,
  options: {
    promptContextProvider?: PromptContextProvider
    hostBridge?: BrowserHostBridge
  } = {},
): Promise<{
  systemPrompt: SystemPromptPart[]
  userContext: Record<string, string>
  systemContext: Record<string, string>
  callContext: ToolCallContext
  forkSeedRows: Message[]
}> {
  const mainLoopModel = params.callContext.options.mainLoopModel
  const appState = params.callContext.readAppState()
  const additionalWorkingDirectories =
    appState.permissionRules.extraWorkspaceRoots instanceof Map
      ? Array.from(
          appState.permissionRules.extraWorkspaceRoots.keys(),
        )
      : []

  const { defaultSystemPrompt, userContext, systemContext } =
    await gatherSystemPromptSources(
      {
        tools: params.tools,
        mainLoopModel,
        extraWorkspaceRoots: additionalWorkingDirectories,
        mcpClients: params.callContext.options.mcpClients,
        customSystemPrompt: params.promptOverride,
        cwd: '.',
        providerId: params.providerId,
        flashMode: params.flashMode,
      },
      options,
    )

  const systemPrompt =
    params.promptOverride !== undefined
      ? [params.promptOverride, ...(params.promptSuffix ? [params.promptSuffix] : [])]
      : [...defaultSystemPrompt, ...(params.promptSuffix ? [params.promptSuffix] : [])]

  const last = params.messages.at(-1)
  const forkContextMessages =
    last !== undefined &&
    isAssistantMessage(last) &&
    typeof last.message === 'object' &&
    last.message !== null &&
    (last.message as Record<string, unknown>).stop_reason === null
      ? params.messages.slice(0, -1)
      : params.messages

  return {
    systemPrompt,
    userContext,
    systemContext,
    callContext: {
      ...params.callContext,
      messages: forkContextMessages,
    },
    forkSeedRows: forkContextMessages,
  }
}

export class BrowserPromptContextProvider implements PromptContextProvider {
  private readonly hostBridge: BrowserHostBridge
  // Captured ONCE at construction so the cached system prefix is byte-stable
  // across turns. Date rollover past midnight is handled by the lazy
  // `date_change` attachment in `attachments.ts`, which appends to the
  // conversation tail without invalidating this prefix.
  private readonly sessionStartDate: string

  constructor(options: BrowserPromptContextProviderOptions) {
    this.hostBridge = options.hostBridge
    this.sessionStartDate = formatLocalISODate(new Date(options.runtimeConfig.now()))
  }

  async gatherSystemPromptSources(
    params: FetchSystemPromptPartsParams,
  ): Promise<SystemPromptParts> {
    return gatherSystemPromptSources(params, {
      hostBridge: this.hostBridge,
      sessionStartDate: this.sessionStartDate,
    })
  }
}

export {
  buildBrowserSystemContext,
  buildBrowserUserContext,
}

export type {
  BuildBrowserSystemContextParams,
  BuildBrowserUserContextParams,
}
