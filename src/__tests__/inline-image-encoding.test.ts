/**
 * Inline images: how a composer or tool-result image becomes the base64 content part sent to the model, and when
 * it is resized or re-encoded. Node has no image decoder, canvas or FileReader, so this file installs small fakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeAttachmentImage,
  encodeImageFile,
  INLINE_IMAGE_MIME_TYPES,
  isImageLikeAttachment,
  isInlineImageMime,
  readFileAsDataUrl,
  shrinkToolResultImage,
  toRenderableImageUrl,
} from '../utils/images/inlineImage'

const RAW_BUDGET = 3.75 * 1024 * 1024

interface EncodeCall {
  width: number
  height: number
  type: string
  quality: number | undefined
}

let encodes: EncodeCall[] = []
let closed = 0
let decodeSize: { width: number; height: number } | Error = { width: 800, height: 600 }
let decodeCalls = 0
/** Byte size the fake canvas gives an encode. Default: tiny. */
let encodedSize: (call: EncodeCall) => number = () => 16

function installFakes(): void {
  vi.stubGlobal('createImageBitmap', async () => {
    decodeCalls++
    if (decodeSize instanceof Error) throw decodeSize
    return { ...decodeSize, close: () => closed++ }
  })
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext(): { drawImage: () => void } {
        return { drawImage: () => {} }
      }
      async convertToBlob(opts: { type: string; quality?: number }): Promise<Blob> {
        const call = { width: this.width, height: this.height, type: opts.type, quality: opts.quality }
        encodes.push(call)
        return new Blob([new Uint8Array(encodedSize(call))], { type: opts.type })
      }
    },
  )
  vi.stubGlobal(
    'FileReader',
    class {
      result: string | null = null
      error: Error | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(blob: Blob): void {
        void blob.arrayBuffer().then(buf => {
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`
          this.onload?.()
        })
      }
    },
  )
}

beforeEach(() => {
  encodes = []
  closed = 0
  decodeCalls = 0
  decodeSize = { width: 800, height: 600 }
  encodedSize = () => 16
  installFakes()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function file(bytes: number[] | number, type: string, name = 'img'): File {
  const data = typeof bytes === 'number' ? new Uint8Array(bytes) : new Uint8Array(bytes)
  return new File([data], name, { type })
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')

describe('inline image media types', () => {
  it('lists exactly png, jpeg, gif and webp', () => {
    expect([...INLINE_IMAGE_MIME_TYPES].sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ])
  })

  it('accepts those types in any case and nothing else', () => {
    expect(isInlineImageMime('image/png')).toBe(true)
    expect(isInlineImageMime('IMAGE/JPEG')).toBe(true)
    expect(isInlineImageMime('image/svg+xml')).toBe(false)
    expect(isInlineImageMime('image/bmp')).toBe(false)
    expect(isInlineImageMime('text/plain')).toBe(false)
    expect(isInlineImageMime('')).toBe(false)
    expect(isInlineImageMime(undefined)).toBe(false)
    expect(isInlineImageMime(null)).toBe(false)
  })

  it('treats an attachment as an image by its kind or its content type', () => {
    expect(isImageLikeAttachment({ type: 'image' })).toBe(true)
    expect(isImageLikeAttachment({ type: 'image', contentType: 'image/svg+xml' })).toBe(true)
    expect(isImageLikeAttachment({ type: 'file', contentType: 'image/webp' })).toBe(true)
    expect(isImageLikeAttachment({ type: 'file', contentType: 'image/svg+xml' })).toBe(false)
    expect(isImageLikeAttachment({ type: 'document', contentType: 'application/pdf' })).toBe(false)
    expect(isImageLikeAttachment({})).toBe(false)
  })
})

describe('renderable image URLs', () => {
  it('wraps raw base64 as a data URL, defaulting to png', () => {
    expect(toRenderableImageUrl({ image: 'QUJD', mimeType: 'image/jpeg' })).toBe(
      'data:image/jpeg;base64,QUJD',
    )
    expect(toRenderableImageUrl({ image: 'QUJD' })).toBe('data:image/png;base64,QUJD')
    expect(toRenderableImageUrl({ image: 'QUJD', mimeType: '' })).toBe('data:image/png;base64,QUJD')
  })

  it('passes data:, http: and https: values through', () => {
    for (const image of ['data:image/gif;base64,R0lG', 'http://x/a.png', 'https://x/a.png']) {
      expect(toRenderableImageUrl({ image, mimeType: 'image/jpeg' })).toBe(image)
    }
  })

  it('reads a file as a data URL for the composer thumbnail', async () => {
    expect(await readFileAsDataUrl(file([1, 2, 3], 'image/png'))).toBe(
      `data:image/png;base64,${b64([1, 2, 3])}`,
    )
  })
})

describe('encoding a composer image', () => {
  it('sends a supported image inside both limits untouched', async () => {
    decodeSize = { width: 2000, height: 2000 }
    const result = await encodeImageFile(file([9, 8, 7], 'image/webp'))
    expect(result.part).toEqual({
      type: 'image',
      image: b64([9, 8, 7]),
      mimeType: 'image/webp',
      url: `data:image/webp;base64,${b64([9, 8, 7])}`,
    })
    expect(Object.values(result.sizing ?? {})).toEqual([2000, 2000, 2000, 2000])
    expect(encodes).toEqual([])
    expect(closed).toBe(1)
  })

  it('reports the measured size of an untouched image', async () => {
    decodeSize = { width: 640, height: 480 }
    const { sizing } = await encodeImageFile(file([1], 'image/png'))
    expect(sizing).toEqual({
      sourceWidth: 640,
      sourceHeight: 480,
      sentWidth: 640,
      sentHeight: 480,
    })
  })

  it('passes the bytes through when the image cannot be decoded', async () => {
    decodeSize = new Error('bad image')
    const jpeg = await encodeImageFile(file([1, 2], 'image/jpeg'))
    expect(jpeg).toEqual({
      part: {
        type: 'image',
        image: b64([1, 2]),
        mimeType: 'image/jpeg',
        url: `data:image/jpeg;base64,${b64([1, 2])}`,
      },
    })
    expect(jpeg.sizing).toBeUndefined()
    // An unsupported or missing type is labelled png.
    expect((await encodeImageFile(file([1, 2], 'image/bmp'))).part.mimeType).toBe('image/png')
    expect((await encodeImageFile(file([1, 2], ''))).part.mimeType).toBe('image/png')
    expect(encodes).toEqual([])
  })

  it('re-encodes a decodable unsupported type as png even when small', async () => {
    const { part, sizing } = await encodeImageFile(file([1], 'image/bmp'))
    expect(part.mimeType).toBe('image/png')
    expect(part.url).toBe(`data:image/png;base64,${part.image}`)
    expect(encodes).toEqual([{ width: 800, height: 600, type: 'image/png', quality: undefined }])
    expect(sizing).toEqual({ sourceWidth: 800, sourceHeight: 600, sentWidth: 800, sentHeight: 600 })
  })

  it('treats a file with no type as png', async () => {
    decodeSize = { width: 3000, height: 1500 }
    const { part } = await encodeImageFile(file([1], ''))
    expect(part.mimeType).toBe('image/png')
    expect(encodes).toEqual([{ width: 2000, height: 1000, type: 'image/png', quality: undefined }])
  })

  it('scales a wide png down to 2000 wide, keeping it png', async () => {
    decodeSize = { width: 4000, height: 3000 }
    const { part, sizing } = await encodeImageFile(file([1], 'image/png'))
    expect(part.mimeType).toBe('image/png')
    expect(encodes).toEqual([{ width: 2000, height: 1500, type: 'image/png', quality: undefined }])
    expect(sizing).toEqual({ sourceWidth: 4000, sourceHeight: 3000, sentWidth: 2000, sentHeight: 1500 })
    expect(closed).toBe(1)
  })

  it('scales a tall jpeg down to 2000 high as jpeg at quality 0.8', async () => {
    decodeSize = { width: 3000, height: 4000 }
    const { part, sizing } = await encodeImageFile(file([1], 'image/jpeg'))
    expect(part.mimeType).toBe('image/jpeg')
    expect(encodes).toEqual([{ width: 1500, height: 2000, type: 'image/jpeg', quality: 0.8 }])
    expect(sizing?.sentWidth).toBe(1500)
  })

  it('applies the width cap, then the height cap, rounding each', async () => {
    decodeSize = { width: 3001, height: 1000 }
    await encodeImageFile(file([1], 'image/webp'))
    expect(encodes[0]).toMatchObject({ width: 2000, height: 666 })

    encodes = []
    decodeSize = { width: 2500, height: 6000 }
    await encodeImageFile(file([1], 'image/webp'))
    // width pass: 2000 x 4800; height pass: 833 x 2000
    expect(encodes[0]).toMatchObject({ width: 833, height: 2000 })
  })

  it('re-encodes an in-bounds image whose file is over the raw budget', async () => {
    decodeSize = { width: 1000, height: 1000 }
    const { part } = await encodeImageFile(file(RAW_BUDGET + 1, 'image/gif'))
    expect(part.mimeType).toBe('image/jpeg')
    expect(encodes).toEqual([{ width: 1000, height: 1000, type: 'image/jpeg', quality: 0.8 }])
  })

  it('keeps a file exactly at the raw budget untouched', async () => {
    decodeSize = { width: 1000, height: 1000 }
    const { part } = await encodeImageFile(file(RAW_BUDGET, 'image/png'))
    expect(part.mimeType).toBe('image/png')
    expect(encodes).toEqual([])
  })

  it('falls from png to the jpeg quality steps until one fits', async () => {
    decodeSize = { width: 4000, height: 4000 }
    encodedSize = call => (call.type === 'image/jpeg' && call.quality === 0.4 ? RAW_BUDGET : RAW_BUDGET + 1)
    const { part, sizing } = await encodeImageFile(file([1], 'image/png'))
    expect(part.mimeType).toBe('image/jpeg')
    expect(encodes.map(c => [c.type, c.quality])).toEqual([
      ['image/png', undefined],
      ['image/jpeg', 0.8],
      ['image/jpeg', 0.6],
      ['image/jpeg', 0.4],
    ])
    expect(sizing?.sentWidth).toBe(2000)
  })

  it('shrinks to 1000 wide at quality 0.2 when no quality step fits', async () => {
    decodeSize = { width: 4000, height: 3000 }
    encodedSize = call => (call.width === 1000 ? 5 : RAW_BUDGET + 1)
    const { part, sizing } = await encodeImageFile(file([1], 'image/jpeg'))
    expect(part.mimeType).toBe('image/jpeg')
    expect(encodes.map(c => [c.width, c.height, c.type, c.quality])).toEqual([
      [2000, 1500, 'image/jpeg', 0.8],
      [2000, 1500, 'image/jpeg', 0.6],
      [2000, 1500, 'image/jpeg', 0.4],
      [2000, 1500, 'image/jpeg', 0.2],
      [1000, 750, 'image/jpeg', 0.2],
    ])
    expect(sizing).toEqual({ sourceWidth: 4000, sourceHeight: 3000, sentWidth: 1000, sentHeight: 750 })
  })

  it('sends the last-resort encode even if it is still over budget', async () => {
    decodeSize = { width: 4000, height: 3000 }
    encodedSize = () => RAW_BUDGET + 1
    const { part } = await encodeImageFile(file([1], 'image/webp'))
    expect(part.mimeType).toBe('image/jpeg')
    expect(encodes).toHaveLength(5)
  })

  it('keeps a narrow image narrow in the last-resort pass', async () => {
    decodeSize = { width: 600, height: 1800 }
    encodedSize = () => RAW_BUDGET + 1
    const { sizing } = await encodeImageFile(file(RAW_BUDGET + 1, 'image/jpeg'))
    expect(encodes.at(-1)).toMatchObject({ width: 600, height: 1800, quality: 0.2 })
    expect(sizing?.sentWidth).toBe(600)
  })

  it('resizes a zero-width decode rather than passing it through', async () => {
    decodeSize = { width: 0, height: 10 }
    await encodeImageFile(file([1], 'image/png'))
    expect(encodes.length).toBeGreaterThan(0)
  })

  it('reads an attachment\'s file, and gives null when there is none', async () => {
    const result = await encodeAttachmentImage({ file: file([4, 5], 'image/png') })
    expect(result?.part.image).toBe(b64([4, 5]))
    expect(await encodeAttachmentImage({})).toBeNull()
    expect(await encodeAttachmentImage({ file: 'nope' as unknown as File })).toBeNull()
  })
})

describe('shrinking a tool-result image', () => {
  const big = (n = 120_000) => Buffer.from(new Uint8Array(Math.ceil((n * 3) / 4))).toString('base64')

  it('keeps the original when there is no decoder', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    expect(await shrinkToolResultImage(big(), 'image/png')).toBeNull()
  })

  it('does not decode a payload under 100,000 base64 characters', async () => {
    decodeSize = { width: 4000, height: 4000 }
    expect(await shrinkToolResultImage('A'.repeat(99_996), 'image/png')).toBeNull()
    expect(decodeCalls).toBe(0)
  })

  it('leaves gif alone without decoding it', async () => {
    decodeSize = { width: 4000, height: 4000 }
    expect(await shrinkToolResultImage(big(), 'image/gif')).toBeNull()
    expect(decodeCalls).toBe(0)
  })

  it('keeps the original when the base64 is malformed or will not decode', async () => {
    expect(await shrinkToolResultImage('!'.repeat(120_000), 'image/png')).toBeNull()
    expect(decodeCalls).toBe(0)
    decodeSize = new Error('nope')
    expect(await shrinkToolResultImage(big(), 'image/png')).toBeNull()
  })

  it('keeps an image whose long edge is at most 1024', async () => {
    decodeSize = { width: 1024, height: 700 }
    expect(await shrinkToolResultImage(big(), 'image/jpeg')).toBeNull()
    decodeSize = { width: 300, height: 1024 }
    expect(await shrinkToolResultImage(big(), 'image/jpeg')).toBeNull()
    expect(encodes).toEqual([])
    expect(closed).toBe(2)
  })

  it('scales the long edge to 1024 and keeps png as png', async () => {
    decodeSize = { width: 1600, height: 1020 }
    const result = await shrinkToolResultImage(big(), 'image/png')
    expect(encodes).toEqual([{ width: 1024, height: 653, type: 'image/png', quality: undefined }])
    expect(result).toEqual({ image: Buffer.from(new Uint8Array(16)).toString('base64'), mimeType: 'image/png' })
    expect(closed).toBe(1)
  })

  it('scales a tall jpeg by its height', async () => {
    decodeSize = { width: 900, height: 3000 }
    const result = await shrinkToolResultImage(big(), 'image/jpeg')
    expect(encodes).toEqual([{ width: 307, height: 1024, type: 'image/jpeg', quality: 0.8 }])
    expect(result?.mimeType).toBe('image/jpeg')
  })

  it('re-encodes an unsupported type as png', async () => {
    decodeSize = { width: 2048, height: 2048 }
    const result = await shrinkToolResultImage(big(), 'image/bmp')
    expect(result?.mimeType).toBe('image/png')
  })

  it('keeps the original when the re-encode is not smaller', async () => {
    decodeSize = { width: 2048, height: 2048 }
    const original = big()
    encodedSize = () => Math.ceil((original.length * 3) / 4)
    expect(await shrinkToolResultImage(original, 'image/png')).toBeNull()
    expect(closed).toBe(1)
  })

  it('keeps the original when encoding throws', async () => {
    decodeSize = { width: 2048, height: 2048 }
    encodedSize = () => {
      throw new Error('encoder died')
    }
    expect(await shrinkToolResultImage(big(), 'image/png')).toBeNull()
    expect(closed).toBe(1)
  })
})
