import { describe, expect, it } from 'vitest'
import {
  createQuotePrefix,
  isQuotableText,
  quoteOfMetadata,
  splitQuotePrefix,
  withQuotePrefix,
} from '../browser/webview/replyQuote'
import { convertUserContentWithAttachments } from '../browser/webview/assistantUiAdapterContent'
import { buildPromptFromAppendMessage } from '../browser/webview/assistantUiAdapter'
import type { AppendMessage } from '@assistant-ui/react'

// Reply puts selected transcript text in the composer as a quote; the prompt
// carries it ahead of the person's words, and a stored row reads it back.

describe('quote prefix', () => {
  it('prefixes every line and closes with a blank line', () => {
    expect(createQuotePrefix('one\ntwo')).toBe('> one\n> two\n\n')
    expect(createQuotePrefix('  spaced  \r\nnext\r\n')).toBe('> spaced\n> next\n\n')
    expect(createQuotePrefix('a\n\nb')).toBe('> a\n>\n> b\n\n')
  })

  it('carries nothing for a blank quote', () => {
    expect(createQuotePrefix('   ')).toBe('')
    expect(withQuotePrefix('hello', '  ')).toBe('hello')
    expect(withQuotePrefix('hello', undefined)).toBe('hello')
    expect(isQuotableText(' \n ')).toBe(false)
  })

  it('goes ahead of the text, or stands alone without a trailing blank line', () => {
    expect(withQuotePrefix('why?', 'claim')).toBe('> claim\n\nwhy?')
    expect(withQuotePrefix('', 'claim')).toBe('> claim')
  })

  it('round-trips through the split', () => {
    const sent = withQuotePrefix('why?', 'first\nsecond')
    expect(splitQuotePrefix(sent)).toEqual({ quote: 'first\nsecond', text: 'why?' })
    expect(splitQuotePrefix(withQuotePrefix('', 'alone'))).toEqual({ quote: 'alone', text: '' })
    expect(splitQuotePrefix('> a\n>\n> b\n\nrest')).toEqual({ quote: 'a\n\nb', text: 'rest' })
  })

  it('is no quote when the run is not closed by a blank line, or the text does not start with one', () => {
    expect(splitQuotePrefix('> a\nnot blank')).toEqual({ quote: null, text: '> a\nnot blank' })
    expect(splitQuotePrefix('hello\n> a\n\nb')).toEqual({ quote: null, text: 'hello\n> a\n\nb' })
    expect(splitQuotePrefix('>\n\nb')).toEqual({ quote: null, text: '>\n\nb' })
    expect(splitQuotePrefix('plain')).toEqual({ quote: null, text: 'plain' })
  })

  it('reads the quote a composer send carries, and nothing else', () => {
    expect(quoteOfMetadata({ custom: { quote: { text: 'q', messageId: 'm' } } })).toBe('q')
    expect(quoteOfMetadata({ custom: { quote: { text: '  ', messageId: 'm' } } })).toBeUndefined()
    expect(quoteOfMetadata({ custom: {} })).toBeUndefined()
    expect(quoteOfMetadata(undefined)).toBeUndefined()
  })
})

describe('the prompt and the row', () => {
  const appendMessage = (text: string, quote?: string): AppendMessage =>
    ({
      role: 'user',
      content: [{ type: 'text', text }],
      attachments: [],
      parentId: null,
      sourceId: null,
      runConfig: {},
      ...(quote === undefined ? {} : { metadata: { custom: { quote: { text: quote, messageId: 'src' } } } }),
    }) as unknown as AppendMessage

  it('sends the quote ahead of the words, and no quote when none was set', async () => {
    expect(await buildPromptFromAppendMessage(appendMessage('why?', 'claim'), async () => null)).toBe(
      '> claim\n\nwhy?',
    )
    expect(await buildPromptFromAppendMessage(appendMessage('why?'), async () => null)).toBe('why?')
  })

  it('reads a stored row back into its quote and its words', () => {
    expect(convertUserContentWithAttachments('> claim\n\nwhy?')).toEqual({
      content: 'why?',
      attachments: [],
      quote: 'claim',
    })
    expect(convertUserContentWithAttachments('why?')).toEqual({ content: 'why?', attachments: [] })
  })

  it('reads the quote off the text block of a content-array row', () => {
    const row = convertUserContentWithAttachments([
      { type: 'image', image: 'AA==', mimeType: 'image/png' },
      { type: 'text', text: '> claim\n\nwhy?' },
    ])
    expect(row.quote).toBe('claim')
    const text = (row.content as Array<{ type: string; text?: string }>).find(part => part.type === 'text')
    expect(text?.text).toBe('why?')
  })
})
