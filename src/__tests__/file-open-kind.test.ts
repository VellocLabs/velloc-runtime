import { describe, expect, it } from 'vitest'

import { fileOpenKind, localFileUrl } from '../utils/fileOpenKind'

describe('fileOpenKind', () => {
  it('opens listed source, prose, config and build files as text', () => {
    for (const path of [
      'src/main.ts', 'README.md', 'C:\\work\\notes.TXT', 'pkg/config.yaml', 'index.html', 'logo.svg',
      'Makefile', 'Dockerfile', 'LICENSE', '.gitignore', '.env.local', 'BUILD.gn', 'data.csv',
    ]) {
      expect(fileOpenKind(path), path).toBe('text')
    }
  })

  it('opens video, audio, images and PDF as media, in any case', () => {
    for (const path of ['C:/clips/demo.mp4', 'a/b/Song.MP3', 'shot.webp', 'D:\\docs\\report.pdf', 'x.MOV']) {
      expect(fileOpenKind(path), path).toBe('media')
    }
  })

  it('leaves every unlisted file unsupported, never read', () => {
    for (const path of [
      'archive.zip', 'setup.exe', 'lib.dll', 'model.bin', 'disk.iso', 'db.sqlite', 'blob',
      'clips/mp4', '.mp4', 'trailing.', 'notes.docx',
    ]) {
      expect(fileOpenKind(path), path).toBe('unsupported')
    }
  })
})

describe('localFileUrl', () => {
  it('turns a local drive or POSIX path into an encoded file URL', () => {
    expect(localFileUrl('C:\\clips\\demo.mp4')).toBe('file:///C:/clips/demo.mp4')
    expect(localFileUrl('d:/a b/#1 song.mp3')).toBe('file:///D:/a%20b/%231%20song.mp3')
    expect(localFileUrl('/home/me/clip.webm')).toBe('file:///home/me/clip.webm')
  })

  it('refuses relative, climbing, network and device paths', () => {
    expect(localFileUrl('clips/demo.mp4')).toBeNull()
    expect(localFileUrl('C:\\clips\\..\\demo.mp4')).toBeNull()
    expect(localFileUrl('\\\\host\\share\\demo.mp4')).toBeNull()
    expect(localFileUrl('//host/share/demo.mp4')).toBeNull()
    expect(localFileUrl('\\\\?\\C:\\demo.mp4')).toBeNull()
  })
})
