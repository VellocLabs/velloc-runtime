import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'

/**
 * The last assistant message's stitched text from a forked sub-agent's
 * messages; tool calls are ignored.
 */
export function extractFinalAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || (m as { type?: string }).type !== 'assistant') continue
    const assistant = m as ModelReplyRow
    // The canonical shape carries text blocks at `message.content`
    // (`AssistantMessage.message.content` in RuntimeTypes). Fall back to a
    // top-level `content` array for any provider/test shape that puts the
    // blocks there instead.
    const inner = (assistant as { message?: { content?: unknown } }).message?.content
    const blocks = Array.isArray(inner)
      ? inner
      : Array.isArray((assistant as { content?: unknown }).content)
        ? ((assistant as { content?: unknown }).content as unknown[])
        : null
    if (blocks) {
      const texts: string[] = []
      for (const b of blocks) {
        const block = b as { type?: string; text?: string }
        if (block?.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        }
      }
      if (texts.length > 0) {
        return texts.join('\n')
      }
    }
    // Some Message shapes carry a top-level `text`. Fall back to it.
    const top = (assistant as { text?: unknown }).text
    if (typeof top === 'string' && top.length > 0) {
      return top
    }
  }
  return '(Agent fork produced no assistant text. The fork may have timed out or aborted before responding.)'
}
