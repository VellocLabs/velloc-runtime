/**
 * Registers the built-in wire-format codecs. Imported for its side effect by
 * the model transport (engine/turn/turnDependencies.ts); a new format is one codec file plus
 * one line here.
 */
import { anthropicMessagesDriver } from './anthropicMessagesDriver'
import { geminiDriver } from './geminiDriver'
import { ollamaChatDriver } from './ollamaChatDriver'
import { openaiChatDriver } from './openaiChatDriver'
import { openaiResponsesDriver } from './openaiResponsesDriver'
import { registerProviderDriver } from './driverRegistry'

registerProviderDriver(openaiChatDriver)
registerProviderDriver(openaiResponsesDriver)
registerProviderDriver(anthropicMessagesDriver)
registerProviderDriver(geminiDriver)
registerProviderDriver(ollamaChatDriver)
