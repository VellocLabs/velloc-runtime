/**
 * Renders the system prompt and the ambient context for one model: the
 * provider's sections, then the memory (or instruction-persistence) section
 * and the scratchpad section, the instruction files as user context, and
 * finally the extensions' `prompt.section` → `prompt.compose` →
 * `prompt.context` chain over the result.
 */
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
import type {
  SystemPromptNamedPart,
  SystemPromptParts,
} from '../runtime/interfaces/PromptContextProvider'
import { buildMemorySystemPrompt } from '../memory/memoryPrompt'
import { getTemplate, templateWriteToolName } from '../prompting/templateRegistry'
import { getScratchpadDirectoryPath, resolveSessionStorageBase } from '../utils/conversationStoragePaths'
import {
  formatMemoryFilesForPrompt,
  gatherInstructionDocs,
  instructionPersistenceFallbackPrompt,
} from '../memory/instructionFiles'
import { gatherSystemPromptSources } from './systemPromptSources'
import { resolvePromptProfile } from '../prompting/promptProfile'
import { composeSectionsOf, instructionKindOf, memoryTypeOf } from '../mods/promptEvents'
import { isToolWithheldForModel } from '../utils/todoTools'
import { augmentedAppStateForDeferral, shouldHideToolFromModel } from '../toolkit/run/deferredTools'
import { PLAN_OFF_TOOL_ID } from '../toolkit/builtin/planExit'
import type { SessionLedger } from './sessionLedger'

/** How a render differs from the turn's own. */
export type PromptRenderChoice = {
  /** False: skip the extensions' prompt hooks (the caller raises its own). */
  withMods?: boolean
  /** Restrict the tool catalog to these names. */
  onlyTools?: readonly string[]
}

type InstructionFile = Awaited<ReturnType<typeof gatherInstructionDocs>>[number]

/** The tools the model sees on this render: plan exit only in plan mode,
 *  none the model withholds, none still deferred. The request's tool list
 *  applies the same filter. */
export function visibleToolNames(
  ledger: SessionLedger,
  model: string,
  rows: readonly Message[],
  providerId: string | undefined,
  appState: WorkingState = ledger.config.readAppState(),
): string[] {
  const { config } = ledger
  return config.tools
    .filter(tool => {
      if (tool.name === PLAN_OFF_TOOL_ID && appState.permissionRules.mode !== 'plan') return false
      if (isToolWithheldForModel(tool.name, model, providerId)) return false
      return !shouldHideToolFromModel(
        tool,
        augmentedAppStateForDeferral({
          readAppState: () => appState,
          messages: rows,
          options: { tools: config.tools, runtimeConfig: config.runtimeConfig },
        }),
        config.runtimeConfig,
      )
    })
    .map(tool => tool.name)
}

/** The section that points the model at its per-session scratch directory;
 *  null when the directory cannot be resolved. */
export function scratchpadSection(ledger: SessionLedger): string | null {
  const { config } = ledger
  const base = resolveSessionStorageBase({
    storageBase: config.sessionStorageBase,
    homeDir: config.homeDir,
    projectRoot: config.projectRoot,
  })
  if (!base) return null
  const sessionId = ledger.sessionId()
  if (!sessionId) return null
  return [
    '',
    '# Scratchpad',
    '',
    'This session has its own scratchpad directory for temporary and intermediate files:',
    '',
    `\`${getScratchpadDirectoryPath(base, sessionId)}\``,
    '',
    'Put drafts, intermediate analysis output and throwaway files there. You can read and write files in it freely, with no permission prompts. Do NOT use ad-hoc system temp locations (such as /tmp); always prefer the scratchpad.',
  ].join('\n')
}

/** The memory section and the instruction files, loaded side by side. */
function loadMemory(ledger: SessionLedger): Promise<[string | null, InstructionFile[]]> {
  const { config } = ledger
  return Promise.all([
    buildMemorySystemPrompt({
      cwd: config.cwd,
      fs: config.fsOperations,
      projectRoot: config.projectRoot,
      homeDir: config.homeDir,
      memorySettings: config.memorySettings,
      runtimeConfig: config.runtimeConfig,
      // The section explains how to save a memory, so it names the write
      // tool this session type registers.
      writeToolName: templateWriteToolName(getTemplate(config.templateType ?? '')?.config),
    }),
    instructionFilesOf(ledger),
  ]) as Promise<[string | null, InstructionFile[]]>
}

/** The instruction files a render of this session loads. */
export function instructionFilesOf(ledger: SessionLedger): Promise<InstructionFile[]> {
  const { config } = ledger
  return gatherInstructionDocs({
    cwd: config.cwd,
    fs: config.fsOperations,
    projectRoot: config.projectRoot,
    homeDir: config.homeDir,
    memorySettings: config.memorySettings,
    // An untrusted child reads its instructions from inside its boundary.
    readRoot: config.untrustedReadRoot,
    runtimeConfig: config.runtimeConfig,
  }) as Promise<InstructionFile[]>
}

type Rendered = { sections: SystemPromptNamedPart[]; userContext: Record<string, string> }

/** Runs the extensions' prompt hooks over a render. */
async function runPromptHooks(
  ledger: SessionLedger,
  rendered: Rendered,
  facts: { model: string; providerId: string | undefined; tools: string[]; files: InstructionFile[] },
): Promise<Rendered> {
  const mods = ledger.config.mods!
  const profile = resolvePromptProfile({ providerId: facts.providerId, modelId: facts.model })
  // A Stop does not wait out a hook's time budget.
  const signal = ledger.cancelSource.signal
  let composed = composeSectionsOf(rendered.sections)
  composed = await mods.promptSections!(composed, signal)
  composed = await mods.promptCompose!(
    {
      model: facts.model,
      promptModel: facts.model,
      surfaces: ['desktop'],
      tools: facts.tools,
      outputStyle: null,
      traits: profile === 'lean' ? ['lean'] : [],
    },
    composed,
    signal,
  )
  const sections = composed.map(section => ({ name: section.id, text: section.text }))
  const before = rendered.userContext
  const blocks = Object.entries(before).map(([name, text]) => ({ name, text }))
  const instructionFiles = facts.files.map(file => ({
    path: file.path,
    kind: instructionKindOf(file.type),
    content: file.content,
    ...(file.parent !== undefined ? { parent: file.parent } : {}),
  }))
  const context = await mods.promptContext!({ blocks, instructionFiles }, signal)
  const next: Record<string, string> = Object.fromEntries(context.blocks.map(block => [block.name, block.text]))
  // The file list and the instruction text stay in step: a changed list is
  // rendered again unless a hook already rewrote the text itself.
  if (context.instructionFiles && next.instructionText !== undefined && next.instructionText === before.instructionText) {
    const text = formatMemoryFilesForPrompt(
      context.instructionFiles.map(file => ({
        path: file.path,
        type: memoryTypeOf(file.kind),
        content: file.content,
        ...(file.parent !== undefined ? { parent: file.parent } : {}),
      })),
    )
    if (text) next.instructionText = text
    else delete next.instructionText
  }
  return { sections, userContext: next }
}

/** Renders the prompt for `model` over `rows`, under `providerId`. */
export async function assemblePrompt(
  ledger: SessionLedger,
  model: string,
  rows: readonly Message[] = ledger.rows,
  providerId: string | undefined = ledger.config.userSpecifiedProviderId,
  render: PromptRenderChoice = {},
): Promise<SystemPromptParts> {
  const { config } = ledger
  const appState = config.readAppState()
  const roots = appState.permissionRules.extraWorkspaceRoots
  const tools = visibleToolNames(ledger, model, rows, providerId, appState).filter(
    name => !render.onlyTools || render.onlyTools.includes(name),
  )
  const parts = await gatherSystemPromptSources(
    {
      tools: config.tools,
      visibleToolNames: tools,
      mainLoopModel: model,
      extraWorkspaceRoots: roots instanceof Map ? Array.from(roots.keys()) : [],
      gitRepository: appState.attachmentState?.gitRepository,
      mcpClients: config.mcpClients,
      customSystemPrompt: config.promptOverride,
      appendSystemPrompt: config.promptSuffix,
      mutableMessages: rows,
      cwd: config.cwd,
      providerId,
      flashMode: config.flashMode,
      templateType: config.templateType,
    },
    { promptContextProvider: config.promptContextProvider },
  )
  const [memoryText, files] = await loadMemory(ledger)
  ledger.promptInstructionPaths.clear()
  for (const file of files) ledger.promptInstructionPaths.add(file.path)
  const instructions = formatMemoryFilesForPrompt(files)
  const userContext = instructions ? { ...parts.userContext, instructionText: instructions } : parts.userContext
  // Without the memory section the rules for instruction files still ship.
  const base: SystemPromptNamedPart[] = parts.sections ?? parts.defaultSystemPrompt.map(text => ({ text }))
  const withMemory: SystemPromptNamedPart[] = memoryText
    ? [...base, { name: 'memory', text: memoryText }]
    : [...base, { name: 'instruction_persistence', text: instructionPersistenceFallbackPrompt() }]
  const scratch = scratchpadSection(ledger)
  let rendered: Rendered = {
    sections: scratch ? [...withMemory, { name: 'scratchpad', text: scratch }] : withMemory,
    userContext,
  }
  const mods = config.mods
  if (render.withMods !== false && mods?.hasPromptHooks?.() && mods.promptSections && mods.promptCompose && mods.promptContext) {
    rendered = await runPromptHooks(ledger, rendered, { model, providerId, tools, files })
  }
  return {
    ...parts,
    defaultSystemPrompt: rendered.sections.map(section => section.text),
    sections: rendered.sections,
    userContext: rendered.userContext,
  }
}
