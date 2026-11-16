import { describe, expect, it } from 'vitest'
import { isTextAttachmentFile } from '../browser/webview/BrowserComposerAttachmentAdapter'
import {
  textAttachmentBadge,
  textPreviewLines,
} from '../browser/webview/textAttachmentPreview'

describe('isTextAttachmentFile', () => {
  it('accepts text MIME types and accepted text suffixes', () => {
    expect(isTextAttachmentFile({ name: 'a.bin', type: 'text/plain' })).toBe(true)
    expect(isTextAttachmentFile({ name: 'notes.MD', type: '' })).toBe(true)
    expect(isTextAttachmentFile({ name: 'x.ts', type: 'video/mp2t' })).toBe(true)
    expect(isTextAttachmentFile({ name: 'Dockerfile', type: '' })).toBe(true)
    expect(isTextAttachmentFile({ name: '.gitignore', type: '' })).toBe(true)
  })

  it('rejects images, PDFs and unknown binaries', () => {
    expect(isTextAttachmentFile({ name: 'a.png', type: 'image/png' })).toBe(false)
    expect(isTextAttachmentFile({ name: 'r.pdf', type: '' })).toBe(false)
    expect(isTextAttachmentFile({ name: 'app.exe', type: '' })).toBe(false)
    expect(isTextAttachmentFile({ name: 'archive.zip', type: 'application/zip' })).toBe(false)
  })
})

describe('textPreviewLines', () => {
  it('normalizes line ends and tabs, drops leading blank lines, caps count and width', () => {
    const text = `\n  \n\tone\r\ntwo\rthree\n${'x'.repeat(100)}\n5\n6\n7\n8\n9`
    const lines = textPreviewLines(text)!
    expect(lines).toHaveLength(8)
    expect(lines.slice(0, 3)).toEqual(['  one', 'two', 'three'])
    expect(lines[3]).toHaveLength(80)
  })

  it('reports a binary head as null', () => {
    expect(textPreviewLines('PK\u0003\u0004\u0000')).toBeNull()
  })
})

describe('textAttachmentBadge', () => {
  it('upper-cases the extension, cut to four characters', () => {
    expect(textAttachmentBadge('notes.md')).toBe('MD')
    expect(textAttachmentBadge('Main.java')).toBe('JAVA')
    expect(textAttachmentBadge('style.scss.backup')).toBe('BACK')
  })

  it('is empty for no extension or a dotfile', () => {
    expect(textAttachmentBadge('Dockerfile')).toBe('')
    expect(textAttachmentBadge('.gitignore')).toBe('')
    expect(textAttachmentBadge('trailing.')).toBe('')
  })
})
