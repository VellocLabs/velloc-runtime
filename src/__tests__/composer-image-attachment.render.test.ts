// @vitest-environment happy-dom
/**
 * A pending image attachment in the composer renders as a thumbnail of the
 * image, with a remove button; other files keep the name chip (F-22).
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
    expect(thumb.getAttribute('alt')).toBe('shot.png')
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

  it('keeps the name chip for a non-image file', async () => {
    const { create } = stubObjectUrls()
    render(createElement(Harness))
    const doc = new File(['hello'], 'notes.md', { type: 'text/markdown' })
    await pasteFiles(screen.getByTestId('composer-input'), [doc])

    await waitFor(() => expect(screen.getByText('notes.md')).toBeTruthy())
    expect(screen.queryByTestId('composer-image-attachment')).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })
})
