import { describe, expect, it } from 'vitest'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { Message, ModelReplyRow, UserRow } from '../runtime/RuntimeTypes'
import type { ToolOutcome } from '../toolkit/toolContract'
import {
  serializeToolResult,
  toolOutcomeMessage,
  toolResultContent,
} from '../toolkit/run/toolResultShaping'
import {
  getToolCallDetailsFromMessage,
  hydrateMessageToolPayloads,
  sanitizeMessageForPersistence,
  type BrowserToolCallDetailRecord,
} from '../utils/toolCallDetails'

// A tool result reloaded from its detail record (F-26) reaches the model in
// the shape the live call sent: images as image parts, never as base64 text.

const IMAGE_B64 = 'iVBORw0KGgo' + 'A'.repeat(4096)

const MODEL_REPLY = { uuid: 'reply-1' } as unknown as ModelReplyRow
const DEPS = { uuid: () => 'row-1' } as unknown as QueryRuntimeDeps

type ResultPart = { type: string; text?: string; image?: string; mimeType?: string }

async function liveRow(toolName: string, data: unknown): Promise<Message> {
  const outcome = { data } as ToolOutcome<unknown>
  return toolOutcomeMessage({
    content: await toolResultContent(outcome),
    toolUseResultText: serializeToolResult(outcome),
    callRef: 'call-1',
    modelReply: MODEL_REPLY,
    deps: DEPS,
    toolName,
    toolArgs: {},
    toolResultData: data,
  })
}

function reloaded(live: Message): Message {
  const details = new Map<string, BrowserToolCallDetailRecord>()
  for (const record of getToolCallDetailsFromMessage(live)) {
    details.set(record.toolCallId, record)
  }
  return hydrateMessageToolPayloads(sanitizeMessageForPersistence(live), details)
}

function resultOf(message: Message): unknown {
  const part = (message as UserRow).message.content[0] as { result?: unknown }
  return part.result
}

function textOf(result: unknown): string {
  if (typeof result === 'string') return result
  return (result as ResultPart[])
    .filter(part => part.type === 'text')
    .map(part => part.text ?? '')
    .join('\n')
}

describe('tool result reload hydration', () => {
  it('restores a Read image as an image part, as the live call sent it', async () => {
    const data = {
      message: 'Media file read: D:/shots/frame.jpg',
      media_path: 'D:/shots/frame.jpg',
      content_parts: [
        { type: 'text', text: 'Image file read: D:/shots/frame.jpg' },
        { type: 'image', image: IMAGE_B64, mimeType: 'image/jpeg' },
      ],
    }
    const live = await liveRow('Read', data)
    const back = reloaded(live)

    expect(resultOf(sanitizeMessageForPersistence(live))).toBeUndefined()
    expect(resultOf(back)).toEqual(resultOf(live))
    const parts = resultOf(back) as ResultPart[]
    expect(parts.map(part => part.type)).toEqual(['text', 'image'])
    expect(parts[1]).toMatchObject({ image: IMAGE_B64, mimeType: 'image/jpeg' })
    expect(textOf(resultOf(back))).not.toContain(IMAGE_B64)
    expect((back as { toolUseResult?: unknown }).toolUseResult).toBe(data.message)
  })

  it('restores a browser screenshot as text without bytes plus an image part', async () => {
    const data = {
      ok: true,
      action: 'screenshot',
      observation: {
        tabs: [
          {
            tab_id: 2,
            title: 'Review',
            screenshot: { mime: 'image/png', data_base64: IMAGE_B64, width: 1024, height: 958 },
          },
        ],
      },
    }
    const live = await liveRow('BrowserScreenshot', data)
    const back = reloaded(live)

    expect(resultOf(back)).toEqual(resultOf(live))
    const parts = resultOf(back) as ResultPart[]
    expect(parts.map(part => part.type)).toEqual(['text', 'image'])
    expect(parts[1]).toMatchObject({ image: IMAGE_B64, mimeType: 'image/png' })
    expect(parts[0].text).toContain('"delivered_as_image":true')
    expect(textOf(resultOf(back))).not.toContain(IMAGE_B64)
  })

  it('keeps a text result as the same string', async () => {
    const live = await liveRow('Bash', 'exit 0\nhello')
    const back = reloaded(live)

    expect(resultOf(back)).toBe('exit 0\nhello')
    expect((back as { toolUseResult?: unknown }).toolUseResult).toBe('exit 0\nhello')
  })

  it('keeps a structured result as the text the live call sent', async () => {
    const data = { matches: ['a.ts', 'b.ts'], truncated: false }
    const live = await liveRow('Glob', data)
    const back = reloaded(live)

    expect(resultOf(back)).toBe(JSON.stringify(data))
    expect(resultOf(back)).toEqual(resultOf(live))
  })
})
