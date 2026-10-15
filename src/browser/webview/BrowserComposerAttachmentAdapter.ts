import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from '@assistant-ui/react'
import {
  INLINE_IMAGE_MIME_TYPES,
  isInlineImageMime,
  readFileAsDataUrl,
} from '../../utils/images/inlineImage'
import { randomUuid } from '../../utils/randomUuid'

const SUPPORTED_ATTACHMENT_ACCEPT_PARTS = [
  // Inline image types (see utils/images/inlineImage.ts). Listed first so the
  // file picker offers images alongside text/PDF; clipboard paste and drag of
  // images also flow through here once `accept` advertises them.
  ...INLINE_IMAGE_MIME_TYPES,
  'text/*',
  'application/pdf',
  // Files Read can use, matched by extension because the OS often reports
  // no MIME type (or a wrong one: `.ts` is video/mp2t). assistant-ui takes a
  // name without a dot whole as its "extension", which is how `Dockerfile`
  // and `Makefile` match; a dotfile's extension is its name (`.gitignore`).
  '.bash',
  '.bat',
  '.c',
  '.cc',
  '.cfg',
  '.cjs',
  '.clj',
  '.cmd',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.cts',
  '.dart',
  '.diff',
  '.dockerfile',
  '.dockerignore',
  '.editorconfig',
  '.env',
  '.erl',
  '.ex',
  '.exs',
  '.fish',
  '.gitattributes',
  '.gitignore',
  '.go',
  '.gradle',
  '.graphql',
  '.h',
  '.hpp',
  '.hs',
  '.html',
  '.ini',
  '.ipynb',
  '.java',
  '.js',
  '.json',
  '.jsonc',
  '.jsonl',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.log',
  '.lua',
  '.makefile',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.patch',
  '.php',
  '.pl',
  '.properties',
  '.proto',
  '.ps1',
  '.psm1',
  '.py',
  '.r',
  '.rb',
  '.rs',
  '.rst',
  '.sass',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.svg',
  '.swift',
  '.tex',
  '.tf',
  '.toml',
  '.ts',
  '.tsv',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zig',
  '.zsh',
] as const

export const BROWSER_COMPOSER_ATTACHMENT_ACCEPT =
  SUPPORTED_ATTACHMENT_ACCEPT_PARTS.join(',')

/**
 * The accept list with every image MIME type removed — advertised instead
 * of the full list while the active model has `supportsImageInput: false`,
 * so file pickers stop offering images at the source. (`.svg` stays: SVGs
 * are not in `INLINE_IMAGE_MIME_TYPES` and ride the `@"path"` file
 * route, not the inline-image branch.)
 */
export const BROWSER_COMPOSER_ATTACHMENT_ACCEPT_NO_IMAGES =
  SUPPORTED_ATTACHMENT_ACCEPT_PARTS.filter(
    part => !(INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(part),
  ).join(',')

const PICTURE_SUFFIXES = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const

const IMAGE_EXTENSION_SET: ReadonlySet<string> = new Set(PICTURE_SUFFIXES)

/**
 * File extensions (no leading dot) the native attachment picker
 * (`ui.pickAttachmentFiles`) should offer as a filter group. Derived from the
 * same accept list assistant-ui validates against — the explicit `.xxx`
 * entries plus the supported image extensions and `pdf`. The native dialog
 * always keeps an "All files" option, so this is a UX hint, not a hard gate.
 */
export const BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS: readonly string[] =
  Array.from(
    new Set<string>([
      ...PICTURE_SUFFIXES,
      'pdf',
      ...SUPPORTED_ATTACHMENT_ACCEPT_PARTS.filter(part =>
        part.startsWith('.'),
      ).map(part => part.slice(1)),
    ]),
  )

/**
 * The extension list without images, for the native picker on a text-only model. Advisory
 * only: the hard gate stays in `add()`.
 */
export const BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS_NO_IMAGES: readonly string[] =
  BROWSER_COMPOSER_ATTACHMENT_EXTENSIONS.filter(
    ext => !IMAGE_EXTENSION_SET.has(ext),
  )

// Best-effort MIME by extension. Only the types that change attachment HANDLING
// need to be exact: images must carry an `image/*` type so `getAttachmentType`
// tags them `'image'` (→ inline base64 block); PDFs are detected by extension
// too but tagging the type keeps `getAttachmentType` consistent. Everything
// else is a `'file'` regardless of type, so an empty type is fine (the send
// pipeline uploads it + references it by `@"path"`).
const EXTENSION_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

/** Infer a content type from a file name's extension; '' when unknown. */
export function inferAttachmentMimeType(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return ''
  return EXTENSION_MIME_TYPES[fileName.slice(dot + 1).toLowerCase()] ?? ''
}

/**
 * Build a composer `File` from a host-picked absolute path + its bytes (read
 * via the fs bridge). The display name is the path's basename (the upload
 * pipeline sanitizes when it writes the file to disk); the type is inferred so
 * images flow through the inline-image branch.
 */
export function pathBytesToAttachmentFile(
  path: string,
  bytes: Uint8Array,
): File {
  const base = path.split(/[\\/]/).at(-1) || path
  const type = inferAttachmentMimeType(base)
  // Copy into a fresh ArrayBuffer-backed slice so the DOM File constructor
  // accepts it: the fs bridge's Uint8Array is typed over `ArrayBufferLike`
  // (potentially a SharedArrayBuffer), which isn't a valid `BlobPart`.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return new File([buffer], base, type ? { type } : undefined)
}

function createAttachmentId(): string {
  return randomUuid()
}

function isPdfAttachment(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === 'application/pdf'
    || file.name.toLowerCase().endsWith('.pdf')
}

function getAttachmentType(
  file: Pick<File, 'name' | 'type'>,
): PendingAttachment['type'] {
  if (isInlineImageMime(file.type)) {
    return 'image'
  }
  return isPdfAttachment(file) ? 'document' : 'file'
}

export function createQuotedAttachmentPrefix(paths: readonly string[]): string {
  if (paths.length === 0) {
    return ''
  }

  return `${paths.map(path => `@"${path.replace(/"/g, '_')}"`).join(' ')} `
}

export type BrowserComposerAttachmentAdapterOptions = {
  /**
   * Live probe for the ACTIVE model's image-input capability (the adapter
   * is constructed once per thread while the selection changes underneath
   * it, so this is a callback rather than a boolean). Absent or returning
   * anything but `false` ⇒ images allowed — mirrors the catalog default.
   */
  supportsImageInput?: () => boolean
}

export class BrowserComposerAttachmentAdapter implements AttachmentAdapter {
  private readonly options: BrowserComposerAttachmentAdapterOptions

  public constructor(options: BrowserComposerAttachmentAdapterOptions = {}) {
    this.options = options
  }

  private allowsImages(): boolean {
    return this.options.supportsImageInput?.() !== false
  }

  /**
   * Getter so assistant-ui's file pickers see the CURRENT capability every
   * time they open — image types are withheld while the active model is
   * text-only.
   */
  public get accept(): string {
    return this.allowsImages()
      ? BROWSER_COMPOSER_ATTACHMENT_ACCEPT
      : BROWSER_COMPOSER_ATTACHMENT_ACCEPT_NO_IMAGES
  }

  public async add(state: { file: File }): Promise<PendingAttachment> {
    const type = getAttachmentType(state.file)
    // Final chokepoint for EVERY ingress (paperclip, built-in <input>,
    // paste, both dropzones): an image file is rejected here when the
    // active model is text-only, whatever path it arrived by. Both
    // assistant-ui call sites catch and log, so a throw is safe.
    if (type === 'image' && !this.allowsImages()) {
      throw new Error(
        `Image attachments are not supported by the current model: ${state.file.name}`,
      )
    }
    return {
      id: createAttachmentId(),
      type,
      name: state.file.name,
      contentType: state.file.type || undefined,
      file: state.file,
      status: {
        type: 'requires-action',
        reason: 'composer-send',
      },
    }
  }

  public async remove(): Promise<void> {}

  public async send(
    attachment: PendingAttachment,
  ): Promise<CompleteAttachment> {
    // Image attachments render as an inline thumbnail in the sent bubble; the
    // actual wire bytes are derived from `.file` in
    // `buildPromptFromAppendMessage`, so this content is display-only.
    if (attachment.type === 'image' && attachment.file instanceof File) {
      const image = await readFileAsDataUrl(attachment.file)
      return {
        ...attachment,
        status: { type: 'complete' },
        content: [{ type: 'image', image }],
      }
    }

    return {
      ...attachment,
      status: {
        type: 'complete',
      },
      content: [
        {
          type: 'text',
          text: attachment.name,
        },
      ],
    }
  }
}
