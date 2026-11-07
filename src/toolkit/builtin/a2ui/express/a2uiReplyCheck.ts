// Checks the `<a2ui>` blocks of a reply that ends a turn (F-1). A block that
// does not compile against the Velloc catalog is reported back to the model, so
// it writes a corrected block in the same turn. The compiler loads only when a
// reply holds a block.

import type { Message } from '../../../../runtime/RuntimeTypes'
import { blockSurfaceIds, hasA2uiBlock, splitA2uiText } from './a2uiBlocks'

export type A2uiBlockFailure = {
  index: number
  surfaceIds: string[]
  message: string
  /** The block's line the error names, and its text from the error's column, when the error names one. */
  at?: { line: number; text: string; from?: string }
}

const ERROR_POSITION = /\bline (\d+)(?::(\d+))?/i
const EXCERPT_LENGTH = 40

// The compiler counts lines from 1 and columns from 0, in the block's body.
function errorPosition(body: string, message: string): A2uiBlockFailure['at'] {
  const match = ERROR_POSITION.exec(message)
  if (!match) return undefined
  const line = Number(match[1])
  const text = body.split('\n')[line - 1]?.replace(/\r$/, '')
  if (text === undefined) return undefined
  const column = match[2] === undefined ? undefined : Number(match[2])
  const from = column === undefined || column >= text.length ? undefined : text.slice(column, column + EXCERPT_LENGTH)
  return from === undefined ? { line, text } : { line, text, from }
}

function messageTexts(message: Message): string[] {
  if (message.type !== 'assistant') return []
  const content = (message.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content.flatMap(part => {
    const record = part as { type?: unknown; text?: unknown }
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  })
}

function closedBlocks(messages: readonly Message[]): string[] {
  return messages
    .flatMap(messageTexts)
    .filter(hasA2uiBlock)
    .flatMap(text => splitA2uiText(text))
    .flatMap(segment => (segment.kind === 'block' && segment.closed ? [segment.body] : []))
}

/**
 * The blocks of `reply` that cannot be drawn. `history` holds the earlier
 * messages, whose blocks made the surfaces the reply may update.
 */
export async function findA2uiBlockFailures(
  history: readonly Message[],
  reply: readonly Message[],
): Promise<A2uiBlockFailure[]> {
  const texts = reply.flatMap(messageTexts).filter(hasA2uiBlock)
  if (texts.length === 0) return []
  const { getRuntimeA2uiCompiler } = await import('./a2uiRuntimeCompiler')
  const compiler = await getRuntimeA2uiCompiler()
  const state = compiler.createState()
  for (const body of closedBlocks(history)) compiler.compile(body, state)
  const failures: A2uiBlockFailure[] = []
  let index = 0
  for (const segment of texts.flatMap(text => splitA2uiText(text))) {
    if (segment.kind !== 'block') continue
    index += 1
    const surfaceIds = blockSurfaceIds(segment.body).targets
    if (!segment.closed) {
      failures.push({ index, surfaceIds, message: 'The block has no closing </a2ui> tag.' })
      continue
    }
    const result = compiler.compile(segment.body, state)
    if (result.ok) continue
    const at = errorPosition(segment.body, result.message)
    failures.push(at ? { index, surfaceIds, message: result.message, at } : { index, surfaceIds, message: result.message })
  }
  return failures
}

/** The note that asks the model to correct the failed blocks. */
export function describeA2uiBlockFailures(failures: readonly A2uiBlockFailure[]): string {
  const lines = failures.flatMap(({ index, surfaceIds, message, at }) => {
    const where = surfaceIds.length ? ` (surface ${surfaceIds.map(id => `"${id}"`).join(', ')})` : ''
    const entry = [`- Block ${index}${where}: ${message}`]
    if (at) entry.push(`  Line ${at.line} of that block is: ${at.text}`)
    if (at?.from !== undefined) entry.push(`  The error is where this text starts: ${at.from}`)
    return entry
  })
  return [
    'The user could not see these A2UI interfaces from your last reply, because they did not compile:',
    ...lines,
    'The statements before the error may already be applied; sending the whole corrected block again is safe. Write each failed block again in full, corrected. Your other text is already shown, so do not repeat it; add at most one short sentence.',
  ].join('\n')
}

/** The runtime's turn-end check: one meta note when the closing reply has blocks that do not compile. */
export function createA2uiTurnEndCheck(
  makeNote: (text: string) => Message,
): (params: { messages: Message[]; assistantMessages: Message[] }) => Promise<Message[]> {
  return async ({ messages, assistantMessages }) => {
    const replyIds = new Set(assistantMessages.map(message => message.uuid))
    const history = messages.filter(message => !message.uuid || !replyIds.has(message.uuid))
    const failures = await findA2uiBlockFailures(history, assistantMessages)
    return failures.length ? [makeNote(describeA2uiBlockFailures(failures))] : []
  }
}
