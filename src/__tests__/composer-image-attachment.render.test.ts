// @vitest-environment happy-dom
/**
 * Pending attachments in the composer render as thumbnails: an image as the
 * image itself, a text file as its first lines with an extension badge; each
 * has a remove button, and other files keep the name chip (F-22).
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
import { ComposerModelCapabilitiesProvider } from '../components/assistant-ui/attachment'
import { Composer } from '../components/assistant-ui/thread'
import { TooltipProvider } from '../components/ui/tooltip'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Harness() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: (m) => m,
    isRunning: false,
    onNew: async () => {},
    adapters: { attachments: new BrowserComposerAttachmentAdapter() },
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
          { value: { supportsImageInput: true } },
          createElement(Composer),
        ),
      ),
    ),
  )
}

const pasteFiles = async (input: HTMLElement, files: File[]) => {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.assign(event, {
    clipboardData: { files, getData: () => '' },
  })
  await act(async () => {
    fireEvent(input, event)
  })
}

const stubObjectUrls = () => {
  let n = 0
  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation(() => `blob:thumb-${++n}`)
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { create, revoke }
}

describe('Composer image attachment thumbnail', () => {
  it('shows a pasted image as a thumbnail of that image', async () => {
    const { create } = stubObjectUrls()
    render(createElement(Harness))
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', {
      type: 'image/png',
    })
    await pasteFiles(screen.getByTestId('composer-input'), [image])

    const card = await screen.findByTestId('composer-image-attachment')
    expect(card.getAttribute('aria-label')).toBe('shot.png')
    const thumb = await screen.findByTestId('composer-image-attachment-thumbnail')
    expect(create).toHaveBeenCalledWith(image)
    expect(thumb.getAttribute('src')).toBe('blob:thumb-1')
    expect(thumb.getAttribute('alt')).toBe('')
    expect(card.querySelector('[aria-label="Remove attachment"]')).not.toBeNull()
  })

  it('removes the attachment and releases the thumbnail URL', async () => {
    const { revoke } = stubObjectUrls()
    render(createElement(Harness))
    const image = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })
    await pasteFiles(screen.getByTestId('composer-input'), [image])
    await screen.findByTestId('composer-image-attachment-thumbnail')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
    })
    await waitFor(() =>
      expect(screen.queryByTestId('composer-image-attachment')).toBeNull(),
    )
    expect(revoke).toHaveBeenCalledWith('blob:thumb-1')
  })

  it('recreates the thumbnail URL when the slot takes another image', async () => {
    const { create, revoke } = stubObjectUrls()
    render(createElement(Harness))
    const first = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const second = new File([new Uint8Array([2])], 'b.png', { type: 'image/png' })
    await pasteFiles(screen.getByTestId('composer-input'), [first, second])

    const thumbs = await screen.findAllByTestId(
      'composer-image-attachment-thumbnail',
    )
    expect(thumbs.map((el) => el.getAttribute('src'))).toEqual([
      'blob:thumb-1',
      'blob:thumb-2',
    ])

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Remove attachment' })[0])
    })
    await waitFor(() =>
      expect(screen.getAllByTestId('composer-image-attachment')).toHaveLength(1),
    )

    expect(revoke).toHaveBeenCalledWith('blob:thumb-2')
    expect(
      screen.getByTestId('composer-image-attachment').getAttribute('aria-label'),
    ).toBe('b.png')
    const remaining = screen.getByTestId('composer-image-attachment-thumbnail')
    expect(remaining.getAttribute('src')).toBe('blob:thumb-3')
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('keeps the name chip for a PDF', async () => {
    const { create } = stubObjectUrls()
    render(createElement(Harness))
    const pdf = new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' })
    await pasteFiles(screen.getByTestId('composer-input'), [pdf])

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy())
    expect(screen.queryByTestId('composer-image-attachment')).toBeNull()
    expect(screen.queryByTestId('composer-text-attachment')).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('Composer text file preview', () => {
  it('shows a text file as its first lines, badge and name', async () => {
    render(createElement(Harness))
    const doc = new File(['\n# Notes\r\n- fix paste\n\tindented\n'], 'notes.md', {
      type: 'text/markdown',
    })
    await pasteFiles(screen.getByTestId('composer-input'), [doc])

    const card = await screen.findByTestId('composer-text-attachment')
    expect(card.getAttribute('aria-label')).toBe('notes.md')
    const preview = screen.getByTestId('composer-text-attachment-preview')
    await waitFor(() => expect(preview.textContent).toContain('# Notes'))
    const rows = Array.from(preview.children).map((row) => row.textContent)
    expect(rows.slice(0, 3)).toEqual(['# Notes', '- fix paste', '  indented'])
    expect(card.textContent).toContain('MD')
    expect(card.textContent).toContain('notes.md')
    expect(card.querySelector('[aria-label="Remove attachment"]')).not.toBeNull()
  })

  it('previews a typeless source file matched by extension', async () => {
    render(createElement(Harness))
    const src = new File(['export const x = 1\n'], 'x.ts')
    await pasteFiles(screen.getByTestId('composer-input'), [src])

    const preview = await screen.findByTestId('composer-text-attachment-preview')
    await waitFor(() => expect(preview.textContent).toContain('export const x = 1'))
    expect(screen.getByTestId('composer-text-attachment').textContent).toContain('TS')
  })

  it('removes a text file card', async () => {
    render(createElement(Harness))
    await pasteFiles(screen.getByTestId('composer-input'), [
      new File(['hello'], 'a.txt', { type: 'text/plain' }),
    ])
    await screen.findByTestId('composer-text-attachment')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
    })
    await waitFor(() =>
      expect(screen.queryByTestId('composer-text-attachment')).toBeNull(),
    )
  })

  it('falls back to the name chip when the head is binary', async () => {
    render(createElement(Harness))
    await pasteFiles(screen.getByTestId('composer-input'), [
      new File(['ab\u0000cd'], 'blob.txt', { type: 'text/plain' }),
    ])
    await waitFor(() =>
      expect(screen.queryByTestId('composer-text-attachment')).toBeNull(),
    )
    expect(screen.getByText('blob.txt')).toBeTruthy()
  })

  it('previews a UTF-16 file saved with a byte-order mark', async () => {
    render(createElement(Harness))
    const wide = new Uint8Array([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0x4e, 0x00, 0x6f, 0x00, 0x74, 0x00, 0x65, 0x00, 0x73, 0x00])
    await pasteFiles(screen.getByTestId('composer-input'), [
      new File([wide], 'wide.txt', { type: 'text/plain' }),
    ])

    const preview = await screen.findByTestId('composer-text-attachment-preview')
    expect(preview.textContent).toContain('# Notes')
  })

  it('reads only the first 2 KB of a long file', async () => {
    render(createElement(Harness))
    const body = '# Title\n' + 'x'.repeat(2100)
    await pasteFiles(screen.getByTestId('composer-input'), [
      new File([body + '\u0000binary tail'], 'long.txt', { type: 'text/plain' }),
    ])

    const preview = await screen.findByTestId('composer-text-attachment-preview')
    expect(preview.textContent).toContain('# Title')
  })
})
