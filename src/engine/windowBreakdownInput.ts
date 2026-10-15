/**
 * Gathers what `breakdownWindow` measures for one session (F-25): the prompt and tool
 * definitions the next request would send, the instruction files, and the live window's rows.
 * Renders without the mods' prompt hooks; stores nothing.
 */
import type { Message } from '../runtime/RuntimeTypes'
import { isAssistantMessage, isAttachmentMessage } from '../runtime/VercelModelConstants'
import { foldTriggerTokens } from '../context/compaction/triggerThreshold'
import { estimateMessageChars } from './tokenCounts'
import { serializeToolsForModel } from './turn/bridgeSerialization'
import { assemblePrompt, instructionFilesOf } from './promptAssembly'
import { breakdownWindow, type ResponseCounts, type WindowBreakdown, type WindowBreakdownInput } from '../mods/windowBreakdown'
import type { SessionLedger } from './sessionLedger'

const MEMORY_SECTION = 'memory'
const INSTRUCTION_CONTEXT_KEY = 'instructionText'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** The rows from the last compaction on. */
export function liveWindowRows(rows: readonly Message[]): readonly Message[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as { type?: unknown; subtype?: unknown }
    if (row.type === 'system' && row.subtype === 'compact_boundary') return rows.slice(i)
  }
  return rows
}

/** A skill-listing note's text and the names it lists, or undefined. */
function skillListingOf(row: Message): { text: string; names: string[] } | undefined {
  if (!isAttachmentMessage(row)) return undefined
  const attachment = (row as { attachment?: unknown }).attachment
  if (!isRecord(attachment) || attachment.type !== 'skill_listing' || typeof attachment.content !== 'string') return undefined
  const names = Array.isArray(attachment.skillNames) ? attachment.skillNames.filter((name): name is string => typeof name === 'string') : []
  return { text: attachment.content, names }
}

function responseCountsOf(row: Message): ResponseCounts | undefined {
  if (!isAssistantMessage(row)) return undefined
  const message = (row as { message?: unknown }).message
  const usage = isRecord(message) && isRecord(message.usage) ? message.usage : undefined
  if (!usage || typeof usage.input_tokens !== 'number') return undefined
  return {
    input_tokens: count(usage.input_tokens),
    output_tokens: count(usage.output_tokens),
    cache_read_input_tokens: count(usage.cache_read_input_tokens),
    cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
  }
}

/** The live window's skill listings, the size of its other rows, and the last charged response. */
export function measureLiveRows(rows: readonly Message[]): Pick<WindowBreakdownInput, 'skillListings' | 'messageChars' | 'charged'> {
  const live = liveWindowRows(rows)
  const skillListings: WindowBreakdownInput['skillListings'][number][] = []
  let messageChars = 0
  let charged: WindowBreakdownInput['charged']
  for (const row of live) {
    const listing = skillListingOf(row)
    if (listing) {
      skillListings.push(listing)
      continue
    }
    const chars = estimateMessageChars(row)
    messageChars += chars
    const counts = responseCountsOf(row)
    if (counts) charged = { counts, tailChars: 0 }
    else if (charged) charged.tailChars += chars
  }
  return { skillListings, messageChars, ...(charged ? { charged } : {}) }
}

/** The session's window by category, for `$.session.usage({ breakdown })`. */
export async function measureSessionWindow(
  ledger: SessionLedger,
  args: { model: string; window: number; columns?: number },
): Promise<WindowBreakdown> {
  const { config } = ledger
  const { model, window } = args
  const providerId = config.userSpecifiedProviderId
  const [prompt, files, definitions] = await Promise.all([
    assemblePrompt(ledger, model, ledger.rows, providerId, { withMods: false }),
    instructionFilesOf(ledger),
    serializeToolsForModel({ callContext: ledger.callContext(model), providerId }),
  ])

  const sections = prompt.sections ?? prompt.defaultSystemPrompt.map(text => ({ text }))
  let systemChars = 0
  let memorySectionChars = 0
  for (const section of sections) {
    if ('name' in section && section.name === MEMORY_SECTION) memorySectionChars += section.text.length
    else systemChars += section.text.length
  }
  for (const [key, text] of Object.entries(prompt.userContext ?? {})) {
    if (key !== INSTRUCTION_CONTEXT_KEY && typeof text === 'string') systemChars += text.length
  }

  const servers = new Map(config.tools.map(tool => [tool.name, tool.mcpInfo?.serverName]))
  const tools = definitions.map(definition => {
    const server = servers.get(definition.name)
    const chars = definition.name.length + (definition.description ?? '').length + JSON.stringify(definition.parameters ?? {}).length
    return { name: definition.name, chars, ...(server !== undefined ? { server } : {}) }
  })

  const choice = config.queryRuntimeDeps?.autoCompactWindows?.current(model, providerId) ?? { enabled: true }
  return breakdownWindow({
    model,
    window,
    systemChars,
    tools,
    memoryFiles: files.map(file => ({ path: file.path, type: file.type, chars: file.content.length })),
    memorySectionChars,
    ...measureLiveRows(ledger.rows),
    compaction: {
      enabled: choice.enabled,
      threshold: foldTriggerTokens(model, providerId, choice.windowTokens),
    },
    ...(args.columns !== undefined ? { columns: args.columns } : {}),
  })
}
