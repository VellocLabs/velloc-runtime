// @vitest-environment happy-dom
/**
 * Large pastes become a "Pasted text" attachment (F-22, the ChatGPT look):
 * the threshold helper, the paste interceptor, the composer card with its
 * "Show in text field" revert, and the upload-prefix parse that lets a
 * reloaded user bubble show cards instead of raw `.velloc/uploads` paths.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import { I18nProvider } from '../browser/webview/i18n'
import { BrowserComposerAttachmentAdapter } from '../browser/webview/BrowserComposerAttachmentAdapter'
import {
  PASTED_TEXT_MAX_CHARS,
  PASTED_TEXT_MAX_LINES,
  countPastedTextLines,
  interceptLargeTextPaste,
  isPastedTextAttachmentName,
  mergePastedTextIntoDraft,
  nextPastedTextFileName,
  pastedTextPreview,
  shouldConvertPasteToAttachment,
  splitUploadedAttachmentPrefix,
} from '../browser/webview/pastedTextAttachment'
import { convertUserContentWithAttachments } from '../browser/webview/assistantUiAdapterContent'
import { ComposerModelCapabilitiesProvider } from '../components/assistant-ui/attachment'
import { Composer } from '../components/assistant-ui/thread'
import { TooltipProvider } from '../components/ui/tooltip'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const lines = (n: number, eol = '\n') =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join(eol)

describe('shouldConvertPasteToAttachment', () => {
  it('converts past 2,000 characters, not at exactly 2,000', () => {
    expect(PASTED_TEXT_MAX_CHARS).toBe(2000)
    expect(shouldConvertPasteToAttachment('x'.repeat(2000))).toBe(false)
    expect(shouldConvertPasteToAttachment('x'.repeat(2001))).toBe(true)
  })

  it('converts past 30 lines, not at exactly 30', () => {
    expect(PASTED_TEXT_MAX_LINES).toBe(30)
    expect(shouldConvertPasteToAttachment(lines(30))).toBe(false)
    expect(shouldConvertPasteToAttachment(lines(31))).toBe(true)
    // A trailing newline does not add a line.
    expect(shouldConvertPasteToAttachment(`${lines(30)}\n`)).toBe(false)
  })

  it('counts CRLF as one line break, for lines and for characters', () => {
    expect(countPastedTextLines(lines(31, '\r\n'))).toBe(31)
    expect(shouldConvertPasteToAttachment(lines(30, '\r\n'))).toBe(false)
    expect(shouldConvertPasteToAttachment(lines(31, '\r\n'))).toBe(true)
    // 20 lines of 99 chars: 1,999 characters with LF, 2,018 raw with CRLF —
    // the same paste must not convert just because of its line endings.
    const row = 'y'.repeat(99)
    const crlf = Array.from({ length: 20 }, () => row).join('\r\n')
    expect(crlf.length).toBeGreaterThan(2000)
    expect(shouldConvertPasteToAttachment(crlf)).toBe(false)
  })
})

describe('pasted-text naming and helpers', () => {
  it('numbers pastes per draft, one past the highest present', () => {
    expect(nextPastedTextFileName([])).toBe('pasted-text-1.txt')
    expect(
      nextPastedTextFileName(['spec.pdf', 'pasted-text-1.txt', 'pasted-text-3.txt']),
    ).toBe('pasted-text-4.txt')
    expect(isPastedTextAttachmentName('pasted-text-12.txt')).toBe(true)
    expect(isPastedTextAttachmentName('my-pasted-text-1.txt')).toBe(false)
  })

  it('previews the first non-blank line', () => {
    expect(pastedTextPreview('\n\n  hello world  \nsecond')).toBe('hello world')
    expect(pastedTextPreview('z'.repeat(80), 10)).toBe(`${'z'.repeat(10)}…`)
  })

  it('merges the paste back after the draft on a new line', () => {
    expect(mergePastedTextIntoDraft('', 'P')).toBe('P')
    expect(mergePastedTextIntoDraft('draft', 'P')).toBe('draft\nP')
    expect(mergePastedTextIntoDraft('draft\n', 'P')).toBe('draft\nP')
  })
})

describe('interceptLargeTextPaste', () => {
  const makeEvent = (text: string, files: File[] = []) => ({
    clipboardData: {
      files,
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
    preventDefault: vi.fn(),
  })
  const makeComposer = (names: string[] = []) => ({
    getState: () => ({ attachments: names.map((name) => ({ name })) }),
    addAttachment: vi.fn(async (_file: File) => {}),
  })

  it('turns a large plain-text paste into a text/plain attachment', async () => {
    const text = lines(40)
    const event = makeEvent(text)
    const composer = makeComposer(['pasted-text-1.txt'])
    expect(interceptLargeTextPaste(event, composer)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    const file = composer.addAttachment.mock.calls[0]?.[0] as File
    expect(file.name).toBe('pasted-text-2.txt')
    expect(file.type).toBe('text/plain')
    expect(await file.text()).toBe(text)
  })

  it('leaves a small paste to the textarea', () => {
    const event = makeEvent('short')
    const composer = makeComposer()
    expect(interceptLargeTextPaste(event, composer)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(composer.addAttachment).not.toHaveBeenCalled()
  })

  it('leaves a clipboard carrying files to assistant-ui', () => {
    const event = makeEvent(lines(40), [new File(['x'], 'shot.png', { type: 'image/png' })])
    const composer = makeComposer()
    expect(interceptLargeTextPaste(event, composer)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(composer.addAttachment).not.toHaveBeenCalled()
  })
})

describe('splitUploadedAttachmentPrefix / convertUserContentWithAttachments', () => {
  it('lifts an upload mention into an attachment and keeps the text', () => {
    const prompt = '@"/workspace/.velloc/uploads/s/abcd1234-pasted-text-1.txt" hello'
    const result = convertUserContentWithAttachments(prompt)
    expect(result.content).toBe('hello')
    expect(result.attachments).toEqual([
      expect.objectContaining({
        name: 'pasted-text-1.txt',
        type: 'file',
        status: { type: 'complete' },
      }),
    ])
  })

  it('reads a Windows run of several uploads, and an attachment-only prompt', () => {
    const prompt =
      '@"C:\\proj\\.velloc\\uploads\\667bdf83\\0a1b2c3d-spec.pdf" @"C:\\proj\\.velloc\\uploads\\667bdf83\\deadbeef-notes.md"'
    const result = convertUserContentWithAttachments(prompt)
    expect(result.content).toBe('')
    expect(result.attachments.map((a) => [a.name, a.type])).toEqual([
      ['spec.pdf', 'document'],
      ['notes.md', 'file'],
    ])
  })

  it('leaves a user-typed @file mention as text', () => {
    const prompt = '@"src/foo.ts" explain this'
    expect(convertUserContentWithAttachments(prompt)).toEqual({
      content: prompt,
      attachments: [],
    })
    // …and stops at the first non-upload mention of a mixed run.
    const mixed = '@"/w/.velloc/uploads/s/abcd1234-a.txt" @"src/foo.ts" hi'
    expect(splitUploadedAttachmentPrefix(mixed)).toEqual({
      attachments: [{ path: '/w/.velloc/uploads/s/abcd1234-a.txt', name: 'a.txt' }],
      text: '@"src/foo.ts" hi',
    })
  })

  it('leaves a prompt with no prefix unchanged', () => {
    expect(convertUserContentWithAttachments('just words')).toEqual({
      content: 'just words',
      attachments: [],
    })
  })

  it('strips the prefix from the text block of an image-bearing prompt', () => {
    const result = convertUserContentWithAttachments([
      { type: 'image', image: 'aGk=', mimeType: 'image/png' },
      { type: 'text', text: '@"/w/.velloc/uploads/s/abcd1234-log.txt" look' },
    ])
    expect(result.attachments.map((a) => a.name)).toEqual(['log.txt'])
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'image' }),
      { type: 'text', text: 'look' },
    ])
  })
})

describe('Composer paste → "Pasted text" card', () => {
  function Harness({ supportsImageInput }: { supportsImageInput: boolean }) {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      convertMessage: (m) => m,
      isRunning: false,
      onNew: async () => {},
      adapters: {
        attachments: new BrowserComposerAttachmentAdapter({
          supportsImageInput: () => supportsImageInput,
        }),
      },
    })
    return createElement(
      TooltipProvider,
      null,
      createElement(
        I18nProvider,
        { locale: 'en' as const },
        createElement(
          AssistantRuntimeProvider,
          { runtime },
          createElement(
            ComposerModelCapabilitiesProvider,
            { value: { supportsImageInput } },
            createElement(Composer),
          ),
        ),
      ),
    )
  }

  const paste = (input: HTMLElement, text: string) => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? text : ''),
      },
    })
    fireEvent(input, event)
    return event
  }

  it('adds a card, leaves the input alone, and reverts on "Show in text field" (text-only model)', async () => {
    render(createElement(Harness, { supportsImageInput: false }))
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'draft' } })

    const text = `First line of the paste\n${lines(41)}`
    const event = paste(input, text)
    expect(event.defaultPrevented).toBe(true)

    const card = await screen.findByTestId('composer-pasted-text')
    await waitFor(() =>
      expect(card.getAttribute('aria-label')).toBe('Pasted text · 42 lines'),
    )
    expect(card.textContent).toContain('First line of the paste')
    expect(input.value).toBe('draft')

    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-pasted-text-show'))
    })
    await waitFor(() =>
      expect(screen.queryByTestId('composer-pasted-text')).toBeNull(),
    )
    expect(input.value).toBe(`draft\n${text}`)
  })

  it('does not intercept a small paste', () => {
    render(createElement(Harness, { supportsImageInput: true }))
    const input = screen.getByTestId('composer-input')
    const event = paste(input, 'a short snippet')
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByTestId('composer-pasted-text')).toBeNull()
  })
})
