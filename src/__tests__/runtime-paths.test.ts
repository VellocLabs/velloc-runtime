import { describe, expect, it } from 'vitest'
import {
  basenameRuntimePath,
  dirnameRuntimePath,
  extnameRuntimePath,
  isAbsoluteRuntimePath,
  joinRuntimePath,
  pathCompareKey,
  relativeRuntimePath,
  resolveRuntimePath,
} from '../utils/runtimePaths'

describe('runtimePaths', () => {
  it('normalizes and resolves posix paths', () => {
    expect(isAbsoluteRuntimePath('/workspace/demo')).toBe(true)
    expect(resolveRuntimePath('/workspace/demo', '../skills/./SKILL.md')).toBe(
      '/workspace/skills/SKILL.md',
    )
    expect(joinRuntimePath('/workspace/demo', '.velloc', 'skills')).toBe(
      '/workspace/demo/.velloc/skills',
    )
    expect(dirnameRuntimePath('/workspace/demo/.velloc/skills/SKILL.md')).toBe(
      '/workspace/demo/.velloc/skills',
    )
    expect(basenameRuntimePath('/workspace/demo/.velloc/skills/SKILL.md')).toBe(
      'SKILL.md',
    )
    expect(extnameRuntimePath('/workspace/demo/.velloc/skills/SKILL.md')).toBe(
      '.md',
    )
    expect(
      relativeRuntimePath(
        '/workspace/demo',
        '/workspace/demo/.velloc/skills/SKILL.md',
      ),
    ).toBe('.velloc/skills/SKILL.md')
  })

  it('normalizes and resolves windows paths', () => {
    expect(isAbsoluteRuntimePath('C:\\workspace\\demo')).toBe(true)
    expect(
      resolveRuntimePath('C:\\workspace\\demo', '..\\skills\\.\\SKILL.md'),
    ).toBe('C:\\workspace\\skills\\SKILL.md')
    expect(
      joinRuntimePath('C:\\workspace\\demo', '.velloc', 'skills'),
    ).toBe('C:\\workspace\\demo\\.velloc\\skills')
    expect(
      dirnameRuntimePath('C:\\workspace\\demo\\.velloc\\skills\\SKILL.md'),
    ).toBe('C:\\workspace\\demo\\.velloc\\skills')
    expect(
      basenameRuntimePath('C:\\workspace\\demo\\.velloc\\skills\\SKILL.md'),
    ).toBe('SKILL.md')
    expect(
      extnameRuntimePath('C:\\workspace\\demo\\.velloc\\skills\\SKILL.md'),
    ).toBe('.md')
    expect(
      relativeRuntimePath(
        'C:\\workspace\\demo',
        'C:\\workspace\\demo\\.velloc\\skills\\SKILL.md',
      ),
    ).toBe('.velloc\\skills\\SKILL.md')
  })

  it('returns the destination path when roots differ', () => {
    expect(
      relativeRuntimePath('/workspace/demo', 'C:\\workspace\\demo\\file.txt'),
    ).toBe('C:\\workspace\\demo\\file.txt')
  })
})

describe('pathCompareKey', () => {
  it('makes spellings of one path compare equal: separators, trailing slash, drive-letter case', () => {
    expect(pathCompareKey('D:\\repo\\pkg\\')).toBe(pathCompareKey('d:/repo/pkg'))
    expect(pathCompareKey('/home/u/p/')).toBe('/home/u/p')
    expect(pathCompareKey('/home/u/p//')).toBe('/home/u/p')
  })

  it('keeps a lone root, and the case of everything past the drive letter', () => {
    expect(pathCompareKey('/')).toBe('/')
    expect(pathCompareKey('C:\\Users\\Me')).toBe('c:/Users/Me')
    expect(pathCompareKey('/Home/U')).not.toBe(pathCompareKey('/home/u'))
  })
})
