/**
 * The user-input pipeline entry point: route a submitted prompt to slash
 * dispatch or to the normal attachment-expansion path.
 *
 * Only the routing lives here; command handling is delegated to
 * `dispatchCommandInput` in `runSlashCommand.ts`.
 */

import type { ToolCallContext } from '../toolkit/toolCallContext'
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
  UserInputPipeline,
} from '../runtime/interfaces/UserInputPipeline'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { ContentBlockParam, Message } from '../runtime/RuntimeTypes'
import { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import { collectInitialAttachmentMessages } from '../messages/contextAttachments'
import { makeUserRow } from '../messages/messageFactories'
import type { PluginScan } from '../pluginHost/pluginModel'
import { dispatchCommandInput } from './runSlashCommand'

export type BrowserUserInputPipelineOptions = {
  hostBridge: BrowserHostBridge
  runtimeConfig: RuntimeConfig
  supportedSlashCommands?: readonly string[]
  /** Result of plugin discovery at runtime bootstrap, surfaced by the
   *  `/plugins` command. Omitted when no plugins were loaded. */
  pluginLoadResult?: PluginScan
  /** Discover the plugins on disk again, for `/plugins enable` of a plugin
   *  copied in after this session loaded. */
  rescanPlugins?: () => Promise<PluginScan>
  /** Bridge-resolved user home (`~`) for `/plugin` + `/marketplace` path
   *  resolution. The worker env (`HOME`/`USERPROFILE`) is empty in production,
   *  so the env-based resolver throws; the runtime resolves the real home via
   *  the `fs.userHome` bridge and threads it here. */
  settingsHomeDir?: string
  /** Bridge-backed `fetch` for `/marketplace` + `/plugin install` GitHub
   *  tarball fetches. A direct `globalThis.fetch` from the SharedWorker is
   *  CSP-blocked ("Failed to fetch"); the runtime threads a `network.httpGet`
   *  adapter here. Omitted in mock-host / test contexts (falls back to
   *  `globalThis.fetch`). */
  marketplaceFetch?: typeof fetch
}

export type SubmitContext = ToolCallContext

export type SubmitOutcome = ProcessUserInputResult

// Concatenate the text of a multimodal content-block array so `@"path"`
// file mentions inside it can be expanded the same way a plain-string prompt
// is. Image (and any other non-text) blocks contribute nothing.
function extractAttachmentMentionText(
  input: ReadonlyArray<ContentBlockParam>,
): string {
  return input
    .map(block => {
      const record =
        block && typeof block === 'object'
          ? (block as { type?: unknown; text?: unknown })
          : null
      return record?.type === 'text' && typeof record.text === 'string'
        ? record.text
        : ''
    })
    .filter(text => text.length > 0)
    .join('\n')
}

export async function processUserInput(
  params: ProcessUserInputParams,
  options: {
    userInputPipeline?: UserInputPipeline
    hostBridge?: BrowserHostBridge
    runtimeConfig?: RuntimeConfig
    supportedSlashCommands?: readonly string[]
    pluginLoadResult?: PluginScan
    rescanPlugins?: () => Promise<PluginScan>
    settingsHomeDir?: string
    marketplaceFetch?: typeof fetch
  } = {},
): Promise<ProcessUserInputResult> {
  if (options.userInputPipeline) {
    return options.userInputPipeline.processUserInput(params)
  }

  if (!options.hostBridge || !options.runtimeConfig) {
    throw new Error(
      'processUserInput requires a userInputPipeline or both hostBridge and runtimeConfig in chromium-runtime.',
    )
  }

  if (
    typeof params.input === 'string' &&
    !params.literalText &&
    params.input.trim().startsWith('/')
  ) {
    const slashResult = await dispatchCommandInput(params, {
      hostBridge: options.hostBridge,
      runtimeConfig: options.runtimeConfig,
      supportedSlashCommands: options.supportedSlashCommands,
      pluginLoadResult: options.pluginLoadResult,
      rescanPlugins: options.rescanPlugins,
      settingsHomeDir: options.settingsHomeDir,
      marketplaceFetch: options.marketplaceFetch,
    })

    // Echo the typed slash command as its own visible user message (deduped against
    // the optimistic bubble via params.uuid), ahead of the command output.
    const userEcho = makeUserRow(
      options.runtimeConfig,
      params.input,
      params.uuid,
    )
    return {
      ...slashResult,
      messages: [userEcho, ...slashResult.messages],
    }
  }

  const messages: Message[] = []

  if (!params.noContextScan) {
    // `@"path"` file mentions are expanded into attachment messages here.
    // For a plain string this is the typed prompt. For a multimodal array
    // (composer image send — see assistantUiAdapter.ts
    // buildPromptFromAppendMessage), any co-attached non-image file rides as
    // an `@"path"` mention inside the array's text block, so pull that text
    // out and run the same expansion. Image blocks carry no mentions; an
    // image-only send yields empty text and skips the no-op scan.
    const attachmentInput =
      typeof params.input === 'string'
        ? params.input
        : extractAttachmentMentionText(params.input)
    if (typeof params.input === 'string' || attachmentInput.length > 0) {
      messages.push(
        ...(await collectInitialAttachmentMessages({
          input: attachmentInput,
          context: params.context,
          runtimeConfig: options.runtimeConfig,
          hostBridge: options.hostBridge,
        })),
      )
    }
  }

  messages.push(
    makeUserRow(
      options.runtimeConfig,
      params.input,
      params.uuid,
      params.isMeta,
      params.origin,
    ),
  )

  return {
    messages,
    shouldQuery: true,
    resultText:
      typeof params.input === 'string'
        ? params.input
        : '[browser-content-block-input]',
  }
}

export class BrowserUserInputPipeline implements UserInputPipeline {
  private readonly hostBridge: BrowserHostBridge
  private readonly runtimeConfig: RuntimeConfig
  private readonly supportedSlashCommands?: readonly string[]
  private pluginLoadResult?: PluginScan
  private readonly rescanPlugins?: () => Promise<PluginScan>
  private readonly settingsHomeDir?: string
  private readonly marketplaceFetch?: typeof fetch

  constructor(options: BrowserUserInputPipelineOptions) {
    this.hostBridge = options.hostBridge
    this.runtimeConfig = options.runtimeConfig
    this.supportedSlashCommands = options.supportedSlashCommands
    this.pluginLoadResult = options.pluginLoadResult
    this.rescanPlugins = options.rescanPlugins
    this.settingsHomeDir = options.settingsHomeDir
    this.marketplaceFetch = options.marketplaceFetch
  }

  /** Refresh the plugin snapshot shown by `/plugins` after a live reload. */
  updatePluginLoadResult(result: PluginScan): void {
    this.pluginLoadResult = result
  }

  async processUserInput(
    params: ProcessUserInputParams,
  ): Promise<ProcessUserInputResult> {
    return processUserInput(params, {
      hostBridge: this.hostBridge,
      runtimeConfig: this.runtimeConfig,
      supportedSlashCommands: this.supportedSlashCommands,
      pluginLoadResult: this.pluginLoadResult,
      rescanPlugins: this.rescanPlugins,
      settingsHomeDir: this.settingsHomeDir,
      marketplaceFetch: this.marketplaceFetch,
    })
  }
}
