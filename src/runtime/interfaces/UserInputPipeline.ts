import type { ContentBlockParam, Message, UserRow } from '../RuntimeTypes'
import type { ToolCallContext } from '../../toolkit/toolCallContext'

export type ProcessUserInputParams = {
  input: string | Array<ContentBlockParam>
  rawTyped?: string
  mode?: string
  context: ToolCallContext
  messages?: Message[]
  uuid?: string
  querySource?: string
  isMeta?: boolean
  /** Stamped onto the created user message — see `UserMessage.origin`. */
  origin?: UserRow['origin']
  literalText?: boolean
  fromHostBridge?: boolean
  noContextScan?: boolean
}

export type ProcessUserInputResult = {
  messages: Message[]
  shouldQuery: boolean
  permittedTools?: string[]
  providerId?: string
  model?: string
  effort?: string
  resultText?: string
  nextInput?: string
  chainNextSubmit?: boolean
  /**
   * Action the orchestrator runs after emitting `messages`, instead of a model
   * turn (implies `shouldQuery: false`): `'clear'` (message not persisted),
   * `'compact'` (with `compactInstructions`), `'reload-plugins'`,
   * `'open-settings'` (`settingsSection`), `'rename'` (`renameTitle`, applied
   * before the confirmation is recorded).
   */
  action?: 'clear' | 'compact' | 'reload-plugins' | 'open-settings' | 'rename'
  compactInstructions?: string
  /** New session title for the `'rename'` action. */
  renameTitle?: string
  /** New enabled-plugin allowlist for the `'reload-plugins'` action. */
  enabledPlugins?: string[]
  /** Settings section to open for the `'open-settings'` action (e.g. 'mcp').
   *  A `NexusSettingsSection` value, kept loosely typed here to avoid a
   *  runtime→browser layering dependency. */
  settingsSection?: string
}

export interface UserInputPipeline {
  processUserInput(
    params: ProcessUserInputParams,
  ): Promise<ProcessUserInputResult>
}
