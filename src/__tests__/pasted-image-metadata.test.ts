import type { AppendMessage, CompleteAttachment } from '@assistant-ui/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPromptFromAppendMessage } from '../browser/webview/assistantUiAdapter'
import { convertUserContentWithAttachments } from '../browser/webview/assistantUiAdapterContent'
import { imageSourceNote } from '../utils/images/imageSourceNote'

// A composer image is sent with a note naming the uploaded original's path
// and, when the sent copy was scaled down, the scale factor. The bubble does
// not show that note.

const UPLOAD = 'C:\\ws\\.velloc\\uploads\\s1\\abcd1234-shot.png'

describe('imageSourceNote wording', () => {
  const same = { sourceWidth: 800, sourceHeight: 600, sentWidth: 800, sentHeight: 600 }
  const shrunk = { sourceWidth: 4000, sourceHeight: 3000, sentWidth: 2000, sentHeight: 1500 }
  const scaling =
    'scaled down from 4000x3000 to 2000x1500 for sending, so multiply coordinates read from this copy by 2.00 to locate them in the original'

  it('names the source of an image sent at full size, measured or not', () => {
    expect(imageSourceNote(same, UPLOAD)).toBe(`[Image source: ${UPLOAD}]`)
    expect(imageSourceNote(undefined, UPLOAD)).toBe(`[Image source: ${UPLOAD}]`)
  })

  it('adds the scaling when the sent copy was scaled down', () => {
    expect(imageSourceNote(shrunk, UPLOAD)).toBe(`[Image source: ${UPLOAD}; ${scaling}]`)
    expect(imageSourceNote(shrunk)).toBe(`[Image ${scaling}]`)
  })

  it('says nothing without a path or a resize', () => {
    expect(imageSourceNote(undefined)).toBeNull()
    expect(imageSourceNote(same)).toBeNull()
  })
})

describe('buildPromptFromAppendMessage — composer images', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Node has neither decoder; stub the two the fast path uses so an 800x600
  // PNG passes through unresized, as it does in the browser.
  function stubImageDecoding(): void {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 800, height: 600, close: () => {} }))
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = null
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        readAsDataURL(): void {
          this.result = 'data:image/png;base64,iVBORw0KGgo='
          queueMicrotask(() => this.onload?.())
        }
      },
    )
  }

  function imageMessage(text: string): AppendMessage {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    return {
      parentId: null,
      sourceId: null,
      startRun: true,
      runConfig: undefined,
      role: 'user',
      content: text ? [{ type: 'text', text }] : [],
      attachments: [
        {
          id: 'img-1',
          type: 'image',
          name: 'shot.png',
          contentType: 'image/png',
          file,
          content: [],
          status: { type: 'complete' },
        } as CompleteAttachment,
      ],
    } as unknown as AppendMessage
  }

  it('uploads the original and tells the model where it is, after the user\'s text', async () => {
    stubImageDecoding()
    const upload = vi.fn(async (_attachment: CompleteAttachment) => UPLOAD)
    const prompt = await buildPromptFromAppendMessage(imageMessage('what is this?'), upload)

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ id: 'img-1' })
    expect(prompt).toEqual([
      expect.objectContaining({ type: 'image', mimeType: 'image/png', image: 'iVBORw0KGgo=' }),
      { type: 'text', text: 'what is this?' },
      { type: 'text', text: `[Image source: ${UPLOAD}]` },
    ])
  })

  it('still sends the image when the upload fails — only the path line is lost', async () => {
    stubImageDecoding()
    const prompt = await buildPromptFromAppendMessage(imageMessage('what is this?'), async () => {
      throw new Error('fsx down')
    })
    expect(prompt).toEqual([
      expect.objectContaining({ type: 'image' }),
      { type: 'text', text: 'what is this?' },
    ])
  })

  it('carries the metadata on an image-only send', async () => {
    stubImageDecoding()
    const prompt = await buildPromptFromAppendMessage(imageMessage(''), async () => UPLOAD)
    expect(prompt).toEqual([
      expect.objectContaining({ type: 'image' }),
      { type: 'text', text: `[Image source: ${UPLOAD}]` },
    ])
  })
})

describe('user bubble rendering hides the metadata block', () => {
  it('shows the image and the user\'s text, not the image source note', () => {
    const { content } = convertUserContentWithAttachments([
      { type: 'image', image: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'text', text: 'what is this?' },
      { type: 'text', text: `[Image source: ${UPLOAD}]` },
    ])
    expect(content).toEqual([
      { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'text', text: 'what is this?' },
    ])
  })

  it('renders an image-only send as just the image', () => {
    const { content } = convertUserContentWithAttachments([
      { type: 'image', image: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'text', text: `[Image source: ${UPLOAD}]` },
    ])
    expect(content).toEqual([{ type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' }])
  })
})
