import { describe, expect, it } from 'vitest'
import { createTranslate, type Locale } from '../browser/webview/i18n/translate'
import {
  classifyToolGroupWork,
  describeToolGroupWork,
  emptyToolGroupWorkTally,
  type ToolGroupWorkTally,
} from '../utils/toolGroupSummary'

function tally(
  counts: Partial<Record<keyof ToolGroupWorkTally, [number, number?]>>,
): ToolGroupWorkTally {
  const out = emptyToolGroupWorkTally()
  for (const [kind, [total, failed = 0]] of Object.entries(counts)) {
    out[kind as keyof ToolGroupWorkTally] = { total, failed }
  }
  return out
}

function sentence(
  counts: Parameters<typeof tally>[0],
  locale: Locale = 'en',
): string {
  return describeToolGroupWork(tally(counts), createTranslate(locale), locale)
}

describe('classifyToolGroupWork', () => {
  it('sorts every tool into exactly one kind of work', () => {
    expect(classifyToolGroupWork('Bash')).toBe('command')
    expect(classifyToolGroupWork('PowerShell')).toBe('command')
    expect(classifyToolGroupWork('SuperShell')).toBe('command')
    expect(classifyToolGroupWork('Read')).toBe('read')
    expect(classifyToolGroupWork('Edit')).toBe('edited')
    expect(classifyToolGroupWork('Write')).toBe('edited')
    expect(classifyToolGroupWork('Delete')).toBe('deleted')
    expect(classifyToolGroupWork('Grep')).toBe('other')
    expect(classifyToolGroupWork('mcp__server__anything')).toBe('other')
    expect(classifyToolGroupWork(undefined)).toBe('other')
  })
})

describe('describeToolGroupWork', () => {
  it('reads as one sentence, failures in parentheses after their kind', () => {
    expect(sentence({ command: [48, 2], read: [2] })).toBe(
      'Ran 48 commands (2 failed), read 2 files',
    )
  })

  it('names a single call with an article instead of a number', () => {
    expect(sentence({ command: [1] })).toBe('Ran a command')
    expect(sentence({ read: [1] })).toBe('Read a file')
    expect(sentence({ edited: [1] })).toBe('Edited a file')
    expect(sentence({ deleted: [1] })).toBe('Deleted a file')
    expect(sentence({ other: [1] })).toBe('Used a tool')
    expect(sentence({ command: [1, 1], read: [1] })).toBe(
      'Ran a command (1 failed), read a file',
    )
    expect(sentence({ command: [2], other: [1] })).toBe('Ran 2 commands, used a tool')
  })

  it('names every kind in a fixed order and skips a kind with no calls', () => {
    expect(
      sentence({ other: [4], deleted: [2], edited: [3, 1], read: [5], command: [2] }),
    ).toBe(
      'Ran 2 commands, read 5 files, edited 3 files (1 failed), deleted 2 files, used 4 tools',
    )
    expect(sentence({ edited: [2], other: [3, 3] })).toBe(
      'Edited 2 files, used 3 tools (3 failed)',
    )
  })

  it('is empty when the group holds no calls', () => {
    expect(sentence({})).toBe('')
  })

  it('keeps singular and plural apart in the inflecting locales', () => {
    expect(sentence({ command: [1], read: [2, 1] }, 'de')).toBe(
      'Einen Befehl ausgeführt, 2 Dateien gelesen (1 fehlgeschlagen)',
    )
    expect(sentence({ command: [2], read: [1] }, 'fr')).toBe(
      '2 commandes exécutées, un fichier lu',
    )
    expect(sentence({ command: [1], other: [2] }, 'es')).toBe(
      'Un comando ejecutado, 2 herramientas usadas',
    )
    expect(sentence({ other: [1] }, 'es')).toBe('Una herramienta usada')
    expect(sentence({ read: [1] }, 'de')).toBe('Eine Datei gelesen')
  })

  it('keeps the number for a single call where the language has no article', () => {
    expect(sentence({ command: [1] }, 'zh')).toBe('运行了 1 条命令')
    expect(sentence({ read: [1] }, 'ja')).toBe('ファイルを 1 件読み取り')
    expect(sentence({ other: [1] }, 'ko')).toBe('도구 1개 사용')
  })

  it('uses each locale’s own punctuation', () => {
    expect(sentence({ command: [48, 2], read: [2] }, 'zh')).toBe(
      '运行了 48 条命令（2 个失败），读取了 2 个文件',
    )
    expect(sentence({ command: [48, 2], read: [2] }, 'ja')).toBe(
      'コマンドを 48 件実行（2 件が失敗）、ファイルを 2 件読み取り',
    )
    expect(sentence({ command: [48, 2], read: [2] }, 'ko')).toBe(
      '명령어 48개 실행(2개 실패), 파일 2개 읽음',
    )
  })
})
