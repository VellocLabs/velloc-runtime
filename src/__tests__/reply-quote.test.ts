import { describe, expect, it } from 'vitest'
import {
  passagesOfMetadata,
  quotedPromptLabel,
  splitQuotedPrompt,
  splitQuotePrefix,
} from '../browser/webview/replyQuote'
import { convertUserContentWithAttachments } from '../browser/webview/assistantUiAdapterContent'
import { buildPromptFromAppendMessage } from '../browser/webview/assistantUiAdapter'
import type { AppendMessage } from '@assistant-ui/react'

// The composer's quote cards ride the prompt ahead of the person's words, and a
// stored row reads them back; a single leading `> ` block still reads as one quote.

describe('quotes read off a prompt', () => {
  it('reads a single leading > block closed by a blank line', () => {
    expect(splitQuotePrefix('> first\n> second\n\nwhy?')).toEqual({ quote: 'first\nsecond', text: 'why?' })
    expect(splitQuotePrefix('> alone')).toEqual({ quote: 'alone', text: '' })
    expect(splitQuotePrefix('> a\n>\n> b\n\nrest')).toEqual({ quote: 'a\n\nb', text: 'rest' })
  })

  it('is no quote when the run is not closed by a blank line, or the text does not start with one', () => {
    expect(splitQuotePrefix('> a\nnot blank')).toEqual({ quote: null, text: '> a\nnot blank' })
    expect(splitQuotePrefix('hello\n> a\n\nb')).toEqual({ quote: null, text: 'hello\n> a\n\nb' })
    expect(splitQuotePrefix('>\n\nb')).toEqual({ quote: null, text: '>\n\nb' })
    expect(splitQuotePrefix('plain')).toEqual({ quote: null, text: 'plain' })
  })

  it('labels a prompt by its words, else its first quote, never the markers', () => {
    expect(quotedPromptLabel('[Quoted context 1]\n> a\n\n[User message]\nwhy?')).toBe('why?')
    expect(quotedPromptLabel('[Quoted context 1]\n> first  card\n\n[Quoted context 2]\n> b')).toBe('first card')
    expect(quotedPromptLabel('plain words')).toBe('plain words')
  })

  it('prefers the numbered passage form, then the single block', () => {
    expect(splitQuotedPrompt('[Quoted context 1]\n> a\n\n[Quoted context 2]\n> b\n\n[User message]\nwhy?')).toEqual({
      quotes: ['a', 'b'],
      text: 'why?',
    })
    expect(splitQuotedPrompt('> claim\n\nwhy?')).toEqual({ quotes: ['claim'], text: 'why?' })
    expect(splitQuotedPrompt('why?')).toEqual({ quotes: [], text: 'why?' })
  })

  it('reads the passages a composer send carries, and nothing else', () => {
    expect(passagesOfMetadata({ custom: { passages: ['a', '  ', 3, 'b'] } })).toEqual(['a', 'b'])
    expect(passagesOfMetadata({ custom: {} })).toEqual([])
    expect(passagesOfMetadata(undefined)).toEqual([])
  })
})

describe('the prompt and the row', () => {
  const appendMessage = (text: string, passages?: string[]): AppendMessage =>
    ({
      role: 'user',
      content: text ? [{ type: 'text', text }] : [],
      attachments: [],
      parentId: null,
      sourceId: null,
      runConfig: {},
      ...(passages === undefined ? {} : { metadata: { custom: { passages } } }),
    }) as unknown as AppendMessage

  it('sends the cards ahead of the words, in order, and plain words when there are none', async () => {
    expect(await buildPromptFromAppendMessage(appendMessage('why?', ['one\ntwo', 'three']), async () => null)).toBe(
      '[Quoted context 1]\n> one\n> two\n\n[Quoted context 2]\n> three\n\n[User message]\nwhy?',
    )
    expect(await buildPromptFromAppendMessage(appendMessage('why?'), async () => null)).toBe('why?')
  })

  it('sends cards alone when there are no words', async () => {
    expect(await buildPromptFromAppendMessage(appendMessage('', ['claim']), async () => null)).toBe(
      '[Quoted context 1]\n> claim',
    )
  })

  it('reads a stored row back into its quotes and its words', () => {
    expect(convertUserContentWithAttachments('[Quoted context 1]\n> claim\n\n[User message]\nwhy?')).toEqual({
      content: 'why?',
      attachments: [],
      quotes: ['claim'],
    })
    expect(convertUserContentWithAttachments('> claim\n\nwhy?')).toEqual({
      content: 'why?',
      attachments: [],
      quotes: ['claim'],
    })
    expect(convertUserContentWithAttachments('why?')).toEqual({ content: 'why?', attachments: [] })
  })

  it('reads the quotes off the text block of a content-array row', () => {
    const row = convertUserContentWithAttachments([
      { type: 'image', image: 'AA==', mimeType: 'image/png' },
      { type: 'text', text: '[Quoted context 1]\n> claim\n\n[User message]\nwhy?' },
    ])
    expect(row.quotes).toEqual(['claim'])
    const text = (row.content as Array<{ type: string; text?: string }>).find(part => part.type === 'text')
    expect(text?.text).toBe('why?')
  })
})
