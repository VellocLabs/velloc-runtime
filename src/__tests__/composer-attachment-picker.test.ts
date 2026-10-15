// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import {
  ComposerAddAttachment,
  ComposerAttachments,
  ComposerAttachmentPickerProvider,
  type ComposerAttachmentPicker,
} from '../components/assistant-ui/attachment'
import {
  BrowserComposerAttachmentAdapter,
  BROWSER_COMPOSER_ATTACHMENT_ACCEPT,
  BROWSER_COMPOSER_ATTACHMENT_ACCEPT_NO_IMAGES,
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS,
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES,
  inferAttachmentMimeType,
  pathBytesToAttachmentFile,
} from '../browser/webview/BrowserComposerAttachmentAdapter'
import type { ScopeMode } from '../browser/runtimeProtocol'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { advertsForScope, queryFor } from './_helpers/capabilityQuery'

// Attachment chips read their label through i18n; stub it to echo the key.
vi.mock('../browser/webview/i18n', () => ({
  useT: () => (key: string) => key,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Regression guard for the composer attachment UI, which the guest `<webview>`
 * broke: its `<input type=file>` can't raise a native chooser and OS drops
 * never reach the small composer dropzone. The fix routes the paperclip through
 * the host bridge (`ui.pickAttachmentFiles`) and makes the whole conversation
 * pane a dropzone. These tests fail against the pre-fix tree (the old paperclip
 * had no host-picker path; there was no whole-pane dropzone).
 */

type HarnessProps = {
  pick?: ComposerAttachmentPicker | null
  /** Render the whole-pane dropzone OUTSIDE ComposerPrimitive.Root, exactly as
   *  Thread wraps the viewport — verifies it still resolves the thread composer. */
  paneDropzone?: boolean
  /** The connection's grant; omitted = no capability provider (the desktop tree). */
  capabilities?: CapabilityQuery
}

function Harness({ pick = null, paneDropzone = false, capabilities }: HarnessProps) {
  const adapter = new BrowserComposerAttachmentAdapter()
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: (m) => m,
    isRunning: false,
    onNew: async () => {},
    adapters: { attachments: adapter },
  })

  const composer = createElement(
    ComposerPrimitive.Root,
    null,
    createElement(ComposerAttachments),
    createElement(ComposerPrimitive.Input as never, {}),
    createElement(
      ComposerAttachmentPickerProvider,
      { value: pick },
      createElement(ComposerAddAttachment),
    ),
  )

  // When testing the pane dropzone, wrap the composer in a dropzone placed at
  // runtime-root scope (no ComposerPrimitive.Root ancestor) — the same relative
  // position Thread uses for its whole-pane dropzone.
  const tree = paneDropzone
    ? createElement(
        ComposerPrimitive.AttachmentDropzone as never,
        { asChild: true } as never,
        createElement('div', { 'data-testid': 'pane' }, composer),
      )
    : composer

  const app = createElement(AssistantRuntimeProvider, { runtime }, tree)
  return capabilities
    ? createElement(RuntimeCapabilitiesContext.Provider, { value: capabilities }, app)
    : app
}

describe('pathBytesToAttachmentFile / extension helpers', () => {
  it('infers image + pdf MIME types and leaves others empty', () => {
    expect(inferAttachmentMimeType('shot.PNG')).toBe('image/png')
    expect(inferAttachmentMimeType('a.jpeg')).toBe('image/jpeg')
    expect(inferAttachmentMimeType('doc.pdf')).toBe('application/pdf')
    expect(inferAttachmentMimeType('notes.ts')).toBe('')
    expect(inferAttachmentMimeType('noext')).toBe('')
  })

  it('builds a File with the basename + inferred type from a host path + bytes', () => {
    const bytes = new TextEncoder().encode('hello')
    const file = pathBytesToAttachmentFile('C:\\Users\\me\\photo.png', bytes)
    expect(file.name).toBe('photo.png')
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(5)

    const posix = pathBytesToAttachmentFile('/tmp/notes.txt', bytes)
    expect(posix.name).toBe('notes.txt')
  })

  it('exposes image + accept-list extensions for the native dialog filter', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'ts', 'md']) {
      expect(BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS).toContain(ext)
    }
    // No leading dots — the C++ side strips them but the list should be clean.
    expect(
      BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS.some((e) => e.startsWith('.')),
    ).toBe(false)
  })

  it('exposes an image-free extension variant for text-only native-dialog picks', () => {
    // Every image extension is withheld…
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
      expect(BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES).not.toContain(ext)
    }
    // …and nothing ELSE changes (same list, same order, images dropped).
    expect(BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES).toEqual(
      BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS.filter(
        (e) => !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e),
      ),
    )
    // The non-image routes keep working on text-only models.
    for (const ext of ['pdf', 'ts', 'md']) {
      expect(BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES).toContain(ext)
    }
  })
})

describe('ComposerAddAttachment — host picker path', () => {
  it('clicking the paperclip calls the host picker and adds each File', async () => {
    const file = new File(['hi'], 'report.txt', { type: 'text/plain' })
    const pick = vi.fn<ComposerAttachmentPicker>().mockResolvedValue([file])
    render(createElement(Harness, { pick }))

    fireEvent.click(screen.getByLabelText('attachment.add'))

    await waitFor(() => expect(pick).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('report.txt')).toBeTruthy())
  })

  it('falls back to the built-in <input> button when no host picker is wired', () => {
    render(createElement(Harness, { pick: null }))
    // The button still renders + is enabled (assistant-ui <input> fallback);
    // it must NOT be the disabled stub the bug produced.
    const btn = screen.getByLabelText('attachment.add') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })
})

/**
 * The host picker is a host route (`ui.pickAttachmentFiles`, `full`). A scoped
 * connection used to get it anyway: the paperclip asked the host, the runtime
 * refused, and nothing opened. Now such a connection gets assistant-ui's
 * built-in `<input type=file>`, so a remote client in a plain browser tab uses
 * its own file chooser. The grants come from the real scope tables.
 */
describe('ComposerAddAttachment — the host picker follows the grant', () => {
  /** Record `<input>.click()` instead of running it (happy-dom has no chooser). */
  function recordInputClicks(): HTMLInputElement[] {
    const clicked: HTMLInputElement[] = []
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      clicked.push(this)
    })
    return clicked
  }

  it('uses the host picker for a full grant', async () => {
    const pick = vi.fn<ComposerAttachmentPicker>().mockResolvedValue([])
    const clicked = recordInputClicks()
    render(
      createElement(Harness, { pick, capabilities: queryFor(advertsForScope('full')) }),
    )

    fireEvent.click(screen.getByLabelText('attachment.add'))

    await waitFor(() => expect(pick).toHaveBeenCalledTimes(1))
    expect(clicked).toEqual([])
  })

  it.each<ScopeMode>(['manager', 'control', 'observe'])(
    'opens the client\'s own file chooser for a %s grant, never the host picker',
    async mode => {
      const pick = vi.fn<ComposerAttachmentPicker>().mockResolvedValue([])
      const clicked = recordInputClicks()
      render(
        createElement(Harness, { pick, capabilities: queryFor(advertsForScope(mode)) }),
      )

      fireEvent.click(screen.getByLabelText('attachment.add'))

      expect(clicked).toHaveLength(1)
      const input = clicked[0]!
      expect(input.type).toBe('file')
      expect(pick).not.toHaveBeenCalled()

      // The user picks a file in their own browser: it lands as a chip.
      const file = new File(['hi'], 'remote-notes.txt', { type: 'text/plain' })
      Object.defineProperty(input, 'files', { value: [file] })
      fireEvent.change(input)
      await waitFor(() => expect(screen.getByText('remote-notes.txt')).toBeTruthy())
    },
  )
})

describe('whole-pane dropzone', () => {
  it('a drop OUTSIDE the composer (pane scope) still adds the attachment', async () => {
    const { container } = render(
      createElement(Harness, { pick: null, paneDropzone: true }),
    )
    const pane = Array.from(
      container.querySelectorAll('[data-testid="pane"]'),
    ).find((el) => el.tagName === 'DIV') as HTMLElement
    expect(pane, 'pane dropzone div not found').toBeTruthy()

    const file = new File(['x'], 'dropped.md', { type: 'text/markdown' })
    const dataTransfer = { files: [file], items: [], types: ['Files'] }
    fireEvent.dragEnter(pane, { dataTransfer })
    fireEvent.dragOver(pane, { dataTransfer })
    fireEvent.drop(pane, { dataTransfer })

    // The chip rendering anywhere proves the pane dropzone resolved the THREAD
    // composer (it lives outside ComposerPrimitive.Root).
    await waitFor(() => expect(screen.getByText('dropped.md')).toBeTruthy())
  })
  it('accepts the text files Read can use, and still refuses office/archive files', async () => {
    // Dropped through the real runtime: assistant-ui's addAttachment applies
    // `fileMatchesAccept(adapter.accept)` and only logs a refusal, so a file
    // missing from the list vanished without a trace. OS MIME types are often
    // empty (Dockerfile, .ipynb) or wrong (.ts is video/mp2t).
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      createElement(Harness, { pick: null, paneDropzone: true }),
    )
    const pane = Array.from(
      container.querySelectorAll('[data-testid="pane"]'),
    ).find((el) => el.tagName === 'DIV') as HTMLElement

    const accepted = [
      new File(['{}'], 'analysis.ipynb'),
      new File(['FROM node'], 'Dockerfile'),
      new File(['all:'], 'Makefile'),
      new File(['node_modules'], '.gitignore'),
      new File(['A=1'], '.env'),
      new File(['Write-Host'], 'build.ps1'),
      new File(['fun main() {}'], 'Main.kt'),
      new File(['<template/>'], 'App.vue'),
      new File(['let x'], 'main.ts', { type: 'video/mp2t' }),
    ]
    const refused = [
      new File(['PK'], 'report.docx'),
      new File(['PK'], 'bundle.zip'),
    ]
    const dataTransfer = {
      files: [...accepted, ...refused],
      items: [],
      types: ['Files'],
    }
    fireEvent.dragEnter(pane, { dataTransfer })
    fireEvent.dragOver(pane, { dataTransfer })
    fireEvent.drop(pane, { dataTransfer })

    for (const file of accepted) {
      await waitFor(() => expect(screen.getByText(file.name)).toBeTruthy())
    }
    for (const file of refused) {
      expect(screen.queryByText(file.name)).toBeNull()
    }
    expect(errors).toHaveBeenCalledTimes(refused.length)
  })
})

describe('per-model image capability gating (BrowserComposerAttachmentAdapter)', () => {
  const png = new File([new Uint8Array([1, 2, 3])], 'shot.png', {
    type: 'image/png',
  })
  const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' })

  it('advertises the image-free accept list while the model is text-only, live', () => {
    // The capability is a live probe: the same adapter instance must flip
    // when the selection changes underneath it (no rebuild on model switch).
    let allowed = false
    const adapter = new BrowserComposerAttachmentAdapter({
      supportsImageInput: () => allowed,
    })
    expect(adapter.accept).toBe(BROWSER_COMPOSER_ATTACHMENT_ACCEPT_NO_IMAGES)
    expect(adapter.accept).not.toContain('image/')
    allowed = true
    expect(adapter.accept).toBe(BROWSER_COMPOSER_ATTACHMENT_ACCEPT)
  })

  it('rejects image files at add() while non-image files still pass', async () => {
    const adapter = new BrowserComposerAttachmentAdapter({
      supportsImageInput: () => false,
    })
    await expect(adapter.add({ file: png })).rejects.toThrow(
      /not supported by the current model/,
    )
    const pending = await adapter.add({ file: txt })
    expect(pending.type).toBe('file')
  })

  it('treats an SVG as a file, not an inline image, on every model', async () => {
    // image/svg+xml is markup, not a raster the model can be sent inline
    // (createImageBitmap cannot decode it). It rides the @"path" route, so a
    // text-only model takes it too.
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })
    for (const supportsImageInput of [() => true, () => false]) {
      const adapter = new BrowserComposerAttachmentAdapter({ supportsImageInput })
      const pending = await adapter.add({ file: svg })
      expect(pending.type).toBe('file')
    }
  })

  it('takes a PDF on a text-only model (the model is told it cannot read it)', async () => {
    const adapter = new BrowserComposerAttachmentAdapter({
      supportsImageInput: () => false,
    })
    const pdf = new File(['%PDF'], 'receipt.pdf', { type: 'application/pdf' })
    expect((await adapter.add({ file: pdf })).type).toBe('document')
  })

  it('keeps full pre-gate behaviour without options (images allowed)', async () => {
    const adapter = new BrowserComposerAttachmentAdapter()
    expect(adapter.accept).toBe(BROWSER_COMPOSER_ATTACHMENT_ACCEPT)
    const pending = await adapter.add({ file: png })
    expect(pending.type).toBe('image')
  })
})
