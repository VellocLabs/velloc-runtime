/**
 * The note sent to the model beside a composer image: where the original is
 * on disk and, when the sent copy was scaled down, how to map coordinates
 * back. The transcript hides these lines, so the recogniser must accept
 * every shape the writer produces and nothing a user would type.
 */

import { describe, expect, it } from 'vitest'
import { imageSourceNote, isImageSourceNoteText } from '../utils/images/imageSourceNote'

const PATH = 'C:\\ws\\.velloc\\uploads\\s1\\abcd1234-shot.png'
const size = (ow: number, oh: number, dw: number, dh: number) => ({
  sourceWidth: ow,
  sourceHeight: oh,
  sentWidth: dw,
  sentHeight: dh,
})

describe('image source note', () => {
  it('has nothing to say without a path unless the image was scaled', () => {
    expect(imageSourceNote(undefined)).toBeNull()
    expect(imageSourceNote(size(800, 600, 800, 600))).toBeNull()
    expect(imageSourceNote(size(0, 600, 0, 600))).toBeNull()
  })

  it('names the path alone when the size is unknown, invalid or unchanged', () => {
    for (const dims of [undefined, size(0, 0, 0, 0), size(800, 600, 0, 600), size(800, 600, -5, 600), size(800, 600, 800, 600)]) {
      const note = imageSourceNote(dims, PATH)
      expect(note).toContain(PATH)
      expect(note).not.toMatch(/\d+x\d+/)
      expect(note).toMatch(/^\[Image:? source: /)
      expect(note!.endsWith(`${PATH}]`)).toBe(true)
      expect(isImageSourceNoteText(note!)).toBe(true)
    }
  })

  it('gives both sizes and the two-decimal scale factor when scaled down', () => {
    for (const path of [PATH, undefined]) {
      const note = imageSourceNote(size(3000, 2000, 1024, 683), path)!
      expect(note).toContain('3000x2000')
      expect(note).toContain('1024x683')
      expect(note).toContain('2.93')
      expect(note.includes(PATH)).toBe(path !== undefined)
      expect(note).not.toContain('\n')
      expect(isImageSourceNoteText(note)).toBe(true)
    }
  })

  it('uses the width ratio for the scale factor', () => {
    expect(imageSourceNote(size(4000, 3000, 2000, 1000))).toContain('2.00')
    expect(imageSourceNote(size(1000, 3000, 1000, 1500))).toContain('1.00')
  })

  it('treats a height-only change as a resize', () => {
    expect(imageSourceNote(size(1000, 3000, 1000, 1500))).toContain('1000x1500')
  })

  it('recognises several notes on separate lines, ignoring blank lines', () => {
    const a = imageSourceNote(undefined, PATH)!
    const b = imageSourceNote(size(4000, 3000, 2000, 1500), PATH)!
    const c = imageSourceNote(size(4000, 3000, 2000, 1500))!
    expect(isImageSourceNoteText([a, b, c].join('\n'))).toBe(true)
    expect(isImageSourceNoteText(`${a}\n\n${c}\n`)).toBe(true)
  })

  it('accepts a path containing brackets, commas or semicolons', () => {
    const odd = 'C:\\a, b; [c]\\shot.png'
    expect(isImageSourceNoteText(imageSourceNote(undefined, odd)!)).toBe(true)
    expect(isImageSourceNoteText(imageSourceNote(size(4000, 3000, 2000, 1500), odd)!)).toBe(true)
  })

  it('rejects user text, mixed blocks and empty input', () => {
    const a = imageSourceNote(undefined, PATH)!
    expect(isImageSourceNoteText('what is in this screenshot?')).toBe(false)
    expect(isImageSourceNoteText(`${a}\nand what about this?`)).toBe(false)
    expect(isImageSourceNoteText('[Image: ]')).toBe(false)
    expect(isImageSourceNoteText('[Image]')).toBe(false)
    expect(isImageSourceNoteText('')).toBe(false)
    expect(isImageSourceNoteText('\n\n')).toBe(false)
    expect(isImageSourceNoteText(` ${a}`)).toBe(false)
  })
})
