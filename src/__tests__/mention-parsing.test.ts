import { describe, expect, it } from 'vitest'

import { findMentionedPaths, toMentionTarget } from '../messages/mentionParsing'

describe('findMentionedPaths', () => {
  it.each([
    ['see @a.ts and @"my file.md" ok', ['my file.md', 'a.ts']],
    ['@x.ts @x.ts', ['x.ts']],
    ['email a@b.com', []],
    ['x@y.ts', []],
    ['(@paren.ts)', []],
    ['@"q" @"q', ['q']],
    ['@dir/', ['dir']],
    ['@src/a.ts#L10-20', ['src/a.ts#L10-20']],
  ])('%s', (input, expected) => {
    expect(findMentionedPaths(input)).toEqual(expected)
  })
})

describe('toMentionTarget', () => {
  it.each([
    ['src/a.ts#L10-20', { filename: 'src/a.ts', lineStart: 10, lineEnd: 20 }],
    ['a.ts#L5', { filename: 'a.ts', lineStart: 5, lineEnd: 5 }],
    ['a.md#heading', { filename: 'a.md' }],
    ['a.ts#L', { filename: 'a.ts' }],
    ['a.ts#L3-1', { filename: 'a.ts', lineStart: 3, lineEnd: 1 }],
    ['D:\\src\\C#\\app\\a.ts#L3', { filename: 'D:\\src\\C#\\app\\a.ts', lineStart: 3, lineEnd: 3 }],
    ['C#/x.ts', { filename: 'C#/x.ts' }],
    ['#L3', { filename: '#L3' }],
    ['a#b#c', { filename: 'a#b#c' }],
    ['a b.ts#L2-4', { filename: 'a b.ts', lineStart: 2, lineEnd: 4 }],
  ])('%s', (mention, expected) => {
    expect(toMentionTarget(mention)).toEqual(expected)
  })
})
