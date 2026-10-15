

import type { QueryRuntimeDeps } from '../../runtime/interfaces/QueryRuntimeDeps'
import type {
  BridgeModelContentPart,
  BridgeModelInputMessage,
  BridgeModelToolDefinition,
} from '../../browser/bridge/browserBridgeProtocol'

import { NEXUS_MODEL_CONFIG } from '../../config/nexusModelConfig'

import { isToolWithheldForModel } from '../../utils/todoTools'
import { modelSupportsStrictTools } from '../../utils/strictTools'
import {
  resolveToolByName,
  type ToolArgsJsonShape,
  type ToolContractList,
} from '../../toolkit/toolContract'
import { emptyPermissionRuleSet } from '../../toolkit/permissionVerdict'

import {
  augmentedAppStateForDeferral,
  deferralKeyFromContext,
  shouldHideToolFromModel,
} from '../../toolkit/run/deferredTools'

import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_USER,
  ROLE_TOOL,
  ROLE_USER,
  PART_TEXT,
  PART_IMAGE,
  PART_DOCUMENT,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  LEGACY_PART_TOOL_USE,
  LEGACY_PART_TOOL_RESULT,
  TOOL_DEF_FUNCTION,
} from '../../runtime/VercelModelConstants'
import { PLAN_OFF_TOOL_ID } from '../../toolkit/builtin/planExit'
import { shouldTraceModelRequests } from './modelTrace'
function cloneToolInputSchema(schema: ToolArgsJsonShape): ToolArgsJsonShape {
  if (typeof structuredClone === 'function') {
    return structuredClone(schema)
  }

  return JSON.parse(JSON.stringify(schema)) as ToolArgsJsonShape
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function normalizeToolName(name: string, tools: ToolContractList): string {
  return resolveToolByName(tools, name)?.name ?? name
}

/**
 * `allowImageParts: false` downgrades image/document parts to text placeholders for a text-only active
 * model. Resolved on the wire, never by rewriting the stored transcript.
 */
type SerializeMessagesForBridgeOptions = {
  allowImageParts?: boolean
}

const IMAGE_OMITTED_PLACEHOLDER =
  '[image omitted: the selected model does not support image input]'
const DOCUMENT_OMITTED_PLACEHOLDER =
  '[document omitted: the selected model does not support document input]'

/** An image/document part as its text placeholder; anything else as-is. */
function omitMediaPart(part: unknown): unknown {
  const type = asRecord(part)?.type
  if (type === PART_IMAGE) {
    return { type: PART_TEXT, text: IMAGE_OMITTED_PLACEHOLDER }
  }
  if (type === PART_DOCUMENT) {
    return { type: PART_TEXT, text: DOCUMENT_OMITTED_PLACEHOLDER }
  }
  return part
}

function normalizeMessageContentPartForBridge(
  part: unknown,
  tools: ToolContractList,
  options?: SerializeMessagesForBridgeOptions,
): BridgeModelContentPart {
  const record = asRecord(part)
  if (!record || typeof record.type !== 'string') {
    return typeof part === 'string'
      ? { type: PART_TEXT, text: part }
      : { type: PART_TEXT, text: String(part ?? '') }
  }

  switch (record.type) {
    case PART_IMAGE:
    case PART_DOCUMENT: {
      if (options?.allowImageParts === false) {
        return omitMediaPart(record) as BridgeModelContentPart
      }
      // Capable model (the default): pass through untouched, exactly as the
      // pre-gate `default` branch did.
      return record as BridgeModelContentPart
    }
    case PART_TOOL_CALL:
    case LEGACY_PART_TOOL_USE: {
      if (record.type === LEGACY_PART_TOOL_USE) {
        console.warn('[nexus] Legacy tool_use format detected in outbound message — migrate to tool-call')
      }
      const toolCallId =
        typeof record.toolCallId === 'string'
          ? record.toolCallId
          : typeof record.id === 'string'
            ? record.id
            : undefined
      const rawToolName =
        typeof record.toolName === 'string'
          ? record.toolName
          : typeof record.name === 'string'
            ? record.name
            : undefined
      const args =
        record.args !== undefined
          ? record.args
          : record.input

      // Wire-shape contract: `args` stays the raw object; do NOT JSON.stringify it. Verify every
      // provider's outbound translator before changing this.
      return {
        type: PART_TOOL_CALL,
        ...(toolCallId ? { toolCallId } : {}),
        ...(rawToolName
          ? { toolName: normalizeToolName(rawToolName, tools) }
          : {}),
        ...(args !== undefined ? { args } : {}),
      }
    }

    case PART_TOOL_RESULT_CANONICAL:
    case LEGACY_PART_TOOL_RESULT: {
      if (record.type === LEGACY_PART_TOOL_RESULT) {
        console.warn('[nexus] Legacy tool_result format detected in outbound message — migrate to tool-result')
      }
      const toolCallId =
        typeof record.toolCallId === 'string'
          ? record.toolCallId
          : typeof record.tool_use_id === 'string'
            ? record.tool_use_id
            : undefined
      const rawToolName =
        typeof record.toolName === 'string'
          ? record.toolName
          : typeof record.tool_name === 'string'
            ? record.tool_name
            : typeof record.name === 'string'
              ? record.name
              : undefined
      const result =
        record.result !== undefined
          ? record.result
          : record.content
      const isError = record.isError === true || record.is_error === true
      // A text-only model cannot take media inside a tool result either (a
      // paged PDF Read or an image Read returns JPEGs; the OpenAI translators
      // lift them onto a user message the provider then rejects). Same
      // placeholders as the top-level gate, in place — the part stays inside
      // `result` (see the placement contract in
      // parallel-tool-results-merge.test.ts).
      const wireResult =
        options?.allowImageParts === false && Array.isArray(result)
          ? result.map(item => omitMediaPart(item))
          : result

      return {
        type: PART_TOOL_RESULT_CANONICAL,
        ...(toolCallId ? { toolCallId } : {}),
        ...(rawToolName
          ? { toolName: normalizeToolName(rawToolName, tools) }
          : {}),
        ...(wireResult !== undefined ? { result: wireResult } : {}),
        ...(isError ? { isError: true } : {}),
      }
    }

    default:
      return record as BridgeModelContentPart
  }
}

function isCanonicalToolResultOnlyContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(part => asRecord(part)?.type === PART_TOOL_RESULT_CANONICAL)
  )
}

function splitToolResultsFromUserContent(
  message: BridgeModelInputMessage,
): BridgeModelInputMessage[] | null {
  const nestedMessage = asRecord(message.message)
  const rawRole =
    typeof nestedMessage?.role === 'string'
      ? nestedMessage.role
      : typeof message.role === 'string'
        ? message.role
        : message.type === MSG_TYPE_SYSTEM ||
            message.type === MSG_TYPE_USER ||
            message.type === MSG_TYPE_ASSISTANT ||
            message.type === ROLE_TOOL
          ? message.type
          : undefined
  const rawContent =
    nestedMessage && 'content' in nestedMessage
      ? nestedMessage.content
      : typeof message.message === 'string'
        ? message.message
        : 'content' in message
          ? message.content
          : undefined

  if (rawRole !== ROLE_USER || !Array.isArray(rawContent)) {
    return null
  }

  const toolResultParts = rawContent.filter(
    part => asRecord(part)?.type === PART_TOOL_RESULT_CANONICAL,
  )
  if (toolResultParts.length === 0 || toolResultParts.length === rawContent.length) {
    return null
  }

  const nonToolResultParts = rawContent.filter(
    part => asRecord(part)?.type !== PART_TOOL_RESULT_CANONICAL,
  )
  return [
    {
      role: ROLE_TOOL,
      content: toolResultParts as BridgeModelContentPart[],
    },
    ...(nonToolResultParts.length > 0
      ? [
          {
            role: ROLE_USER,
            content: nonToolResultParts as BridgeModelContentPart[],
          },
        ]
      : []),
  ]
}

function serializeMessageForBridge(
  message: BridgeModelInputMessage,
  tools: ToolContractList,
  options?: SerializeMessagesForBridgeOptions,
): BridgeModelInputMessage | null {
  const nestedMessage = asRecord(message.message)
  const rawRole =
    typeof nestedMessage?.role === 'string'
      ? nestedMessage.role
      : typeof message.role === 'string'
        ? message.role
        : message.type === MSG_TYPE_SYSTEM ||
            message.type === MSG_TYPE_USER ||
            message.type === MSG_TYPE_ASSISTANT ||
            message.type === ROLE_TOOL
          ? message.type
          : undefined
  const rawContent =
    nestedMessage && 'content' in nestedMessage
      ? nestedMessage.content
      : typeof message.message === 'string'
        ? message.message
        : 'content' in message
          ? message.content
          : undefined

  if (!rawRole || rawContent === undefined || rawContent === null) {
    return null
  }

  const content =
    Array.isArray(rawContent)
      ? rawContent.map(part =>
          normalizeMessageContentPartForBridge(part, tools, options),
        )
      : typeof rawContent === 'string'
        ? rawContent
        : null
  if (content === null) {
    return null
  }
  const role =
    rawRole === ROLE_USER && isCanonicalToolResultOnlyContent(content)
      ? ROLE_TOOL
      : rawRole

  return {
    role,
    content,
  }
}

export function serializeMessagesForBridge(
  messages: readonly BridgeModelInputMessage[],
  tools: ToolContractList,
  options?: SerializeMessagesForBridgeOptions,
): BridgeModelInputMessage[] {
  const out: BridgeModelInputMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const split = splitToolResultsFromUserContent(msg)
    if (split) {
      for (const splitMsg of split) {
        const serialized = serializeMessageForBridge(splitMsg, tools, options)
        if (serialized !== null) {
          out.push(serialized)
        }
      }
      continue
    }
    const serialized = serializeMessageForBridge(msg, tools, options)
    if (serialized === null) {
      if (shouldTraceModelRequests()) {
        // Diagnostic: surface dropped messages so the overlay's JSON
        // tab (and `console.warn` in DevTools) can show that the wire
        // payload is shorter than the in-memory transcript. Most often
        // the cause is a malformed message (no role, or `content` that
        // isn't an array/string). Gated on the trace flag so a
        // production build with the switch off pays nothing here.
        console.warn(
          '[nexus] serializeMessagesForBridge dropped message',
          {
            index: i,
            total: messages.length,
            type: (msg as { type?: unknown }).type,
            role:
              (msg as { role?: unknown }).role
              ?? (asRecord((msg as { message?: unknown }).message)?.role),
          },
        )
      }
      continue
    }
    out.push(serialized)
  }
  return out
}

export function normalizeAssistantContentPartFromBridge(
  part: unknown,
  tools: ToolContractList,
): Record<string, unknown> {
  const record = asRecord(part)
  if (!record || typeof record.type !== 'string') {
    return typeof part === 'string'
      ? { type: PART_TEXT, text: part }
      : { type: PART_TEXT, text: String(part ?? '') }
  }

  switch (record.type) {
    case PART_TOOL_CALL:
    case LEGACY_PART_TOOL_USE: {
      const toolCallId =
        typeof record.toolCallId === 'string'
          ? record.toolCallId
          : typeof record.id === 'string'
            ? record.id
            : undefined
      const rawToolName =
        typeof record.toolName === 'string'
          ? record.toolName
          : typeof record.name === 'string'
            ? record.name
            : undefined
      const args =
        record.args !== undefined
          ? record.args
          : record.input

      return {
        type: PART_TOOL_CALL,
        ...(toolCallId ? { toolCallId } : {}),
        ...(rawToolName ? { toolName: normalizeToolName(rawToolName, tools) } : {}),
        ...(args !== undefined ? { args } : {}),
      }
    }

    default:
      return record
  }
}

export function normalizeAssistantContentBlocksFromBridge(
  content: readonly unknown[],
  tools: ToolContractList,
): Array<Record<string, unknown>> {
  return content.map(part => normalizeAssistantContentPartFromBridge(part, tools))
}

export function __serializeMessagesForBridgeForTest(
  messages: readonly BridgeModelInputMessage[],
  tools: ToolContractList,
  options?: { allowImageParts?: boolean },
): BridgeModelInputMessage[] {
  return serializeMessagesForBridge(messages, tools, options)
}

/**
 * Every visible tool as a FULL definition — the host resolves nothing. Host
 * (C++ catalog) tools carry the catalog's own description / schemas /
 * examples, forwarded onto the Tool by `buildHostedTool`.
 */
export async function serializeToolsForModel(
  params: Pick<Parameters<QueryRuntimeDeps['callModel']>[0], 'callContext' | 'modelOverride' | 'providerId'>,
): Promise<BridgeModelToolDefinition[]> {
  const permissionContext = {
    ...emptyPermissionRuleSet(),
    ...params.callContext.readAppState().permissionRules,
  }

  // Strict mode per tool only when the (provider, model) has `supportsStrictTools` AND the tool ships a
  // strict schema (`inputJSONSchemaStrict`). Uses `modelOverride` when set (the model on the wire).
  const effectiveModelForStrict =
    params.modelOverride ?? params.callContext.options.mainLoopModel
  const modelStrictEligible = modelSupportsStrictTools(
    effectiveModelForStrict,
    params.providerId,
  )

  // Tool deferral: omit schemas of deferred, not-yet-activated tools. Visibility uses the
  // transcript-augmented appState, the same helper as the dispatch guard, and THIS runtime's
  // deferral registry, so a sibling session cannot change what this one serializes.
  const deferralKey = deferralKeyFromContext(params.callContext)
  const appStateForDeferral = augmentedAppStateForDeferral(params.callContext)
  const visibleTools = params.callContext.options.tools.filter(tool => {
    if (
      tool.name === PLAN_OFF_TOOL_ID &&
      params.callContext.readAppState().permissionRules.mode !== 'plan'
    ) {
      return false
    }
    // Model gate (utils/todoTools.ts): a todo tool is withheld from a model
    // whose catalog row opts out. Same effective model as the strict gate.
    if (isToolWithheldForModel(tool.name, effectiveModelForStrict, params.providerId)) {
      return false
    }
    return !shouldHideToolFromModel(tool, appStateForDeferral, deferralKey)
  })

  return Promise.all(
    visibleTools.map(async tool => {
      const useStrict = modelStrictEligible && !!tool.inputJSONSchemaStrict
      const parameters = cloneToolInputSchema(
        useStrict
          ? (tool.inputJSONSchemaStrict as ToolArgsJsonShape)
          : (tool.argsSchema ?? { type: 'object' }),
      )
      const computed = await tool.description(
          {} as Record<string, unknown>,
          {
            isNonInteractiveSession:
              params.callContext.options.isNonInteractiveSession,
            permissionRules: permissionContext,
            tools: params.callContext.options.tools,
            agents: params.callContext.options.agentDefinitions.enabledAgents,
            // Per-runtime deferral key: ToolSearch's dynamic description
            // renders the deferred-tools catalog against the CALLER's
            // registry, not the last-registered sibling's.
            runtimeConfig: params.callContext.options.runtimeConfig,
            mods: params.callContext.options.mods,
          },
        )
      // `tool.describe` (F-25): the session's mods may rewrite the text the
      // model reads, cached by the runtime for the session.
      const mods = params.callContext.options.mods
      const description =
        mods?.toolDescribe && mods.hasToolDescribeHooks?.() !== false
          ? await mods
              .toolDescribe({ tool: tool.name, description: computed, provider: { plugin: 'engine', tier: 'core' } })
              .catch(() => computed)
          : computed
      const definition: BridgeModelToolDefinition = {
        type: TOOL_DEF_FUNCTION,
        name: tool.name,
        description,
        parameters,
      }
      if (useStrict) {
        definition.strict = true
      }
      // Forward optional canonical example calls. Surfaced on the wire
      // as Anthropic `input_examples`; other providers ignore.
      if (tool.inputExamples && tool.inputExamples.length > 0) {
        definition.inputExamples = tool.inputExamples.map(ex => ({ ...ex }))
      }
      return definition
    }),
  )
}
