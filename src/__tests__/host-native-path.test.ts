import { describe, it, expect } from 'vitest'
import {
  nativizeForHost,
  shellPathToWindows,
  windowsPathToShell,
} from '../utils/hostPathForm'

// Behaviour pinned for the path-form conversions used at the JS -> C++ host
// boundary. "Shell form" is the Git Bash / MSYS spelling of a Windows path
// (`/c/Users/me`, `/cygdrive/c/...`, `//server/share`).

describe('shellPathToWindows', () => {
  it('turns a /<drive>/... path into a drive-letter path', () => {
    expect(shellPathToWindows('/c/shift')).toBe('C:\\shift')
    expect(shellPathToWindows('/d/project/nexus')).toBe('D:\\project\\nexus')
    expect(shellPathToWindows('/C/x')).toBe('C:\\x')
  })

  it('maps a bare drive (with or without trailing slash) to the drive root', () => {
    expect(shellPathToWindows('/c')).toBe('C:\\')
    expect(shellPathToWindows('/c/')).toBe('C:\\')
  })

  it('understands the /cygdrive/<drive> spelling', () => {
    expect(shellPathToWindows('/cygdrive/c/Users/foo')).toBe('C:\\Users\\foo')
    expect(shellPathToWindows('/cygdrive/d')).toBe('D:\\')
    expect(shellPathToWindows('/cygdrive/D/')).toBe('D:\\')
  })

  it('only treats a single letter after /cygdrive/ as a drive', () => {
    expect(shellPathToWindows('/cygdrive/cc')).toBe('\\cygdrive\\cc')
    expect(shellPathToWindows('/cygdrive')).toBe('\\cygdrive')
  })

  it('only treats an ASCII letter as a drive', () => {
    expect(shellPathToWindows('/1/x')).toBe('\\1\\x')
    expect(shellPathToWindows('/@/x')).toBe('\\@\\x')
    expect(shellPathToWindows('/\u0130/x')).toBe('\\\u0130\\x')
    expect(nativizeForHost('//\u0130/x', 'C:\\w')).toBe('\\\\\u0130\\x')
  })

  it('turns a //server/share path into a UNC path', () => {
    expect(shellPathToWindows('//server/share')).toBe('\\\\server\\share')
    expect(shellPathToWindows('//')).toBe('\\\\')
  })

  it('only flips separators for anything else', () => {
    expect(shellPathToWindows('relative/path')).toBe('relative\\path')
    expect(shellPathToWindows('/ab/x')).toBe('\\ab\\x')
    expect(shellPathToWindows('/')).toBe('\\')
    expect(shellPathToWindows('C:/x')).toBe('C:\\x')
    expect(shellPathToWindows('')).toBe('')
  })

  it('does not read /mnt/<drive> as a drive (result stays non-absolute)', () => {
    expect(shellPathToWindows('/mnt/c/shift')).toBe('\\mnt\\c\\shift')
  })
})

describe('windowsPathToShell', () => {
  it('turns a drive-letter path into /<lower-case drive>/...', () => {
    expect(windowsPathToShell('C:\\Users\\foo')).toBe('/c/Users/foo')
    expect(windowsPathToShell('C:/Users/foo')).toBe('/c/Users/foo')
    expect(windowsPathToShell('c:\\x')).toBe('/c/x')
    expect(windowsPathToShell('D:\\a/b')).toBe('/d/a/b')
    expect(windowsPathToShell('E:\\')).toBe('/e/')
  })

  it('needs a separator after the colon to see a drive', () => {
    expect(windowsPathToShell('D:')).toBe('D:')
    expect(windowsPathToShell('D:foo\\bar')).toBe('D:foo/bar')
  })

  it('turns a UNC path into //server/share', () => {
    expect(windowsPathToShell('\\\\server\\share')).toBe('//server/share')
    expect(windowsPathToShell('\\\\?\\C:\\x')).toBe('//?/C:/x')
  })

  it('only flips separators for anything else', () => {
    expect(windowsPathToShell('relative\\path')).toBe('relative/path')
    expect(windowsPathToShell('/already/posix')).toBe('/already/posix')
    expect(windowsPathToShell('')).toBe('')
  })

  it('round-trips a drive path', () => {
    expect(shellPathToWindows(windowsPathToShell('C:\\a\\b'))).toBe('C:\\a\\b')
    expect(shellPathToWindows(windowsPathToShell('\\\\srv\\sh\\x'))).toBe(
      '\\\\srv\\sh\\x',
    )
  })
})

describe('nativizeForHost', () => {
  const WIN = 'C:\\Users\\me\\project'
  const WIN_FWD = 'c:/Users/me/project'
  const WIN_UNC = '\\\\server\\share\\project'
  const POSIX = '/home/me/project'

  it('converts shell-form absolute paths on a Windows host', () => {
    expect(nativizeForHost('/c/shift', WIN)).toBe('C:\\shift')
    expect(nativizeForHost('/cygdrive/d/proj', WIN)).toBe('D:\\proj')
    expect(nativizeForHost('//srv/sh', WIN)).toBe('\\\\srv\\sh')
    expect(nativizeForHost('/', WIN)).toBe('\\')
    expect(nativizeForHost('//', WIN)).toBe('\\\\')
  })

  it('reads a doubled leading slash before a single drive letter as the drive form', () => {
    expect(nativizeForHost('//c/shift', WIN)).toBe('C:\\shift')
    expect(nativizeForHost('///c', WIN)).toBe('C:\\')
    expect(nativizeForHost('////c/x', WIN)).toBe('C:\\x')
    // A real multi-character server name stays a UNC share.
    expect(nativizeForHost('//server/share', WIN)).toBe('\\\\server\\share')
    expect(nativizeForHost('//cygdrive/c/x', WIN)).toBe('\\\\cygdrive\\c\\x')
  })

  it('leaves /mnt/<drive> non-absolute so the host rejects it', () => {
    expect(nativizeForHost('/mnt/c/shift', WIN)).toBe('\\mnt\\c\\shift')
  })

  it('recognises a Windows host from forward-slash or UNC session paths', () => {
    expect(nativizeForHost('/c/shift', WIN_FWD)).toBe('C:\\shift')
    expect(nativizeForHost('/c/shift', WIN_UNC)).toBe('C:\\shift')
  })

  it('leaves values that are already native untouched', () => {
    expect(nativizeForHost('C:/shift', WIN)).toBe('C:/shift')
    expect(nativizeForHost('C:\\shift', WIN)).toBe('C:\\shift')
    expect(nativizeForHost('c:/shift', WIN)).toBe('c:/shift')
    expect(nativizeForHost('\\\\srv\\sh', WIN)).toBe('\\\\srv\\sh')
  })

  it('leaves relative or unrecognised values untouched', () => {
    expect(nativizeForHost('relative/x', WIN)).toBe('relative/x')
    expect(nativizeForHost('\\single', WIN)).toBe('\\single')
    expect(nativizeForHost('D:', WIN)).toBe('D:')
  })

  it('never touches anything on a non-Windows host', () => {
    expect(nativizeForHost('/c/shift', POSIX)).toBe('/c/shift')
    expect(nativizeForHost('/home/me/x', POSIX)).toBe('/home/me/x')
    expect(nativizeForHost('/c/shift', '')).toBe('/c/shift')
    expect(nativizeForHost('/c/shift', 'C:')).toBe('/c/shift')
  })

  it('returns an empty value unchanged', () => {
    expect(nativizeForHost('', WIN)).toBe('')
  })
})
