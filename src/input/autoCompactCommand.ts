// `/autocompact [size|auto]` — show or set the active model's auto-compact
// window. The value is saved per model in the user settings file
// (`modelSettings.<modelId>.autoCompactWindow`) through the runtime's
// auto-compact reader, so the trigger and the composer figure pick it up on
// the next read. See context/compaction/windowSettings.ts for resolution.

import type { ProcessUserInputResult } from '../runtime/interfaces/UserInputPipeline'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { SystemMessagePart } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { createLocalizedSystemMessage } from '../messages/messageFactories'
import { foldTriggerTokens } from '../context/compaction/triggerThreshold'
import {
  modelSettingsKey,
  parseAutoCompactWindowInput,
  type AutoCompactChoice,
} from '../context/compaction/windowSettings'
import { providerModelName } from '../config/nexusModelConfig/providerModelPool'
import { compactCount } from '../utils/humanize/compactCount'
import { BLOCK, key, text } from './systemMessageParts'

export async function runAutoCompactCommand(
  args: string,
  rawInput: string,
  runtimeConfig: RuntimeConfig,
  context: ToolCallContext,
): Promise<ProcessUserInputResult> {
  const reply = (...parts: SystemMessagePart[]): ProcessUserInputResult => ({
    messages: [createLocalizedSystemMessage(runtimeConfig, parts)],
    shouldQuery: false,
    resultText: rawInput,
  })

  const selected = context.options.mainLoopModel
  if (!selected || selected === 'inherit') return reply(key('slash.out.autoCompactNoModel'))
  const providerId = context.options.mainLoopProviderId
  // The concrete model (a picker entry like `<family>@latest` resolves to the
  // model it names): the window is that model's.
  const modelId = modelSettingsKey(selected, providerId)!
  // Model names are shown as the catalog spells them, never translated.
  const model = (providerId && providerModelName(providerId, modelId)) || modelId
  const windows = context.options.autoCompactWindows
  if (!windows) return reply(key('slash.out.autoCompactNoSettings'))

  // The most a window can be: the model's own threshold (its context window
  // less the summary reserve and headroom). A window is where compaction
  // fires, as is, up to that.
  const modelLimit = foldTriggerTokens(modelId, providerId)
  const capped = (window: number): SystemMessagePart[] =>
    window > modelLimit
      ? [text(BLOCK), key('slash.out.autoCompactCapped', {
          model,
          limit: compactCount(modelLimit),
        })]
      : []

  const describe = (choice: AutoCompactChoice): SystemMessagePart[] => {
    const parts: SystemMessagePart[] = choice.windowTokens === undefined
      ? [key('slash.out.autoCompactStatusAuto', {
          model,
          threshold: compactCount(modelLimit),
        })]
      : [
          key('slash.out.autoCompactStatusFixed', {
            model,
            window: compactCount(choice.windowTokens),
          }),
          ...capped(choice.windowTokens),
        ]
    return choice.enabled
      ? parts
      : [...parts, text(BLOCK), key('slash.out.autoCompactOff')]
  }

  const input = args.trim()
  if (!input) {
    const choice = await windows.resolve(modelId, providerId)
    return reply(...describe(choice), text(BLOCK), key('slash.out.autoCompactUsage'))
  }

  const parsed = parseAutoCompactWindowInput(input)
  if (parsed.kind === 'invalid') {
    return reply(key('slash.out.autoCompactInvalid', { input }))
  }
  if (!windows.canSave) return reply(key('slash.out.autoCompactNoSettings'))

  const wanted = parsed.kind === 'auto' ? 'auto' : parsed.tokens
  let choice: AutoCompactChoice
  try {
    choice = await windows.saveForModel(modelId, providerId, wanted)
  } catch (error) {
    return reply(key('slash.out.autoCompactSaveFailed', {
      error: error instanceof Error ? error.message : String(error),
    }))
  }

  const parts: SystemMessagePart[] = [
    wanted === 'auto'
      ? key('slash.out.autoCompactSetAuto', { model })
      : key('slash.out.autoCompactSetFixed', { model, window: compactCount(wanted) }),
  ]
  if (wanted !== 'auto' && choice.windowTokens === wanted) parts.push(...capped(wanted))
  // A higher-precedence file (project / local) still decides the window.
  const effective = choice.windowTokens ?? 'auto'
  if (effective !== wanted && choice.windowTokens !== undefined) {
    parts.push(text(BLOCK), key('slash.out.autoCompactShadowed', {
      window: compactCount(choice.windowTokens),
    }))
  }
  if (!choice.enabled) parts.push(text(BLOCK), key('slash.out.autoCompactOff'))
  return reply(...parts)
}
