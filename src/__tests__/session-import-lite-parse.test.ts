import { describe, expect, it } from 'vitest'

import * as lite from '../sessionImport/sources/claude-code/parseLite'
import { promptToTitle } from '../sessionImport/core/sessionTitle'
import {
  firstStringValue,
  lastStringValue,
} from '../sessionImport/sources/claude-code/jsonlFields'
import type { ImportLiteItem, ImportSessionLiteRow } from '../sessionImport/protocol'

// Spec for the quick list pass over a session file's head and tail slices.
// Titles resolve customTitle > aiTitle > lastPrompt > summary > first prompt,
// without ever parsing the whole file.

const api = lite as unknown as Record<string, (...args: unknown[]) => unknown>
const idFromFile = (p: string) => api.sessionUuidFromFileName!(p) as string | null
const textBlocks = (c: unknown) => api.userTextBlocks!(c) as string[]
const firstPrompt = (head: string) => api.firstPromptInHead!(head) as string
const title = (head: string, tail: string) => api.titleFromSlices!(head, tail) as string | null
const rows = (items: ImportLiteItem[]) => api.listSessionRows!(items) as ImportSessionLiteRow[]

const UUID = '3f2a6c1e-9b4d-4e8a-8c1d-0a1b2c3d4e5f'
const FILE = `/p/${UUID}.jsonl`
const line = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', message: { role: 'user', content }, ...extra })
const userLine = (text: string, extra: Record<string, unknown> = {}) =>
  user([{ type: 'text', text }], {
    uuid: 'u1',
    parentUuid: null,
    sessionId: UUID,
    cwd: 'D:\\project\\app',
    timestamp: '2026-08-01T10:00:00.000Z',
    ...extra,
  })
const row = (head: string, tail = head, path = FILE) =>
  rows([{ path, head, tail, size: 9, mtimeMs: 3 }])[0]!

describe('jsonlFields', () => {
  it('finds the first and the last string field, honouring escapes', () => {
    const text = `{"customTitle":"a \\"quoted\\" one"}\n{"customTitle":"second"}\n`
    expect(firstStringValue(text, 'customTitle')).toBe('a "quoted" one')
    expect(lastStringValue(text, 'customTitle')).toBe('second')
    expect(firstStringValue(text, 'missing')).toBeUndefined()
  })
})

describe('session id from file name', () => {
  it('accepts only <uuid>.jsonl basenames, on either separator, lower-cased', () => {
    expect(idFromFile(`C:\\Users\\me\\.claude\\projects\\D--app\\${UUID}.jsonl`)).toBe(UUID)
    expect(idFromFile(`/home/me/.claude/projects/-home-me-app/${UUID.toUpperCase()}.jsonl`)).toBe(UUID)
    expect(idFromFile('/x/notes.jsonl')).toBeNull()
    expect(idFromFile(`/x/${UUID}.json`)).toBeNull()
  })
})

describe('user text blocks', () => {
  it('returns a string content whole, and only string text of text blocks', () => {
    expect(textBlocks('str')).toEqual(['str'])
    expect(textBlocks('')).toEqual([''])
    expect(
      textBlocks([
        { type: 'text', text: 'a' },
        { type: 'image' },
        { type: 'text', text: 'b' },
        { type: 'text' },
        { type: 'text', text: 5 },
        { text: 'notype' },
        { type: 'TEXT', text: 'up' },
        'raw',
        null,
      ]),
    ).toEqual(['a', 'b'])
    for (const c of [{ text: 'x' }, null, 5, [{ type: 'tool_result', content: 'r' }]]) {
      expect(textBlocks(c)).toEqual([])
    }
  })
})

describe('first prompt in head', () => {
  it('collapses newlines, caps at 200 chars, and renders bash input', () => {
    const capped = promptToTitle('x'.repeat(250))
    expect(capped && 'title' in capped && capped.title.length).toBe(201)
    expect(firstPrompt(user('a\nb'))).toBe('a b')
    expect(firstPrompt(user('<bash-input>ls -la</bash-input>'))).toBe('! ls -la')
  })

  it('skips tool results, meta lines, compact summaries and auto-generated tags', () => {
    const head =
      user([{ type: 'tool_result', tool_use_id: 't' }]) +
      userLine('<system-reminder>noise</system-reminder>', { isMeta: true }) +
      userLine('summary of earlier work', { isCompactSummary: true }) +
      userLine('<ide_opened_file>x</ide_opened_file>') +
      userLine('Fix the flaky login test')
    expect(firstPrompt(head)).toBe('Fix the flaky login test')
  })

  it('skips any line carrying a tool_result string value, but not prose mentioning it', () => {
    expect(firstPrompt(user([{ type: 'text', text: 'has text' }, { type: 'tool_result' }]) + user('next'))).toBe('next')
    expect(firstPrompt(user('flagged', { kind: 'tool_result' }) + user('ok'))).toBe('ok')
    expect(firstPrompt(user('mentions "tool_result" in text') + user('z'))).toBe('mentions "tool_result" in text')
  })

  it('treats only a literal true as a meta flag', () => {
    expect(firstPrompt(user('mf', { isMeta: false }))).toBe('mf')
    expect(firstPrompt(user('ms', { isMeta: 'true' }) + user('ok'))).toBe('ms')
  })

  it('falls back to the first slash-command name when nothing else qualifies', () => {
    expect(firstPrompt(userLine('<command-name>/compact</command-name>'))).toBe('/compact')
    expect(firstPrompt(user('<command-name>/a</command-name>') + user('<command-name>/b</command-name>'))).toBe('/a')
    expect(firstPrompt(user('<command-name>/a</command-name>') + user('prompt'))).toBe('prompt')
  })

  it('reads string and block content, the first usable block winning', () => {
    expect(firstPrompt(user('hello string'))).toBe('hello string')
    expect(
      firstPrompt(user([{ type: 'text', text: '<ide_selection>s</ide_selection>' }, { type: 'text', text: 'second block' }])),
    ).toBe('second block')
    expect(firstPrompt(user('') + user('   ') + user('real'))).toBe('real')
    expect(firstPrompt(line({ type: 'user', message: { content: 'norole' } }))).toBe('norole')
    expect(firstPrompt('{"type": "user", "message": {"content": "spaced"}}\n')).toBe('spaced')
  })

  it('ignores non-user, malformed, blank and partial lines', () => {
    expect(firstPrompt(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'no' }] } }) + user('yes'))).toBe('yes')
    expect(firstPrompt(line({ type: 'user' }) + user('after'))).toBe('after')
    expect(firstPrompt('not json\n' + user('g'))).toBe('g')
    expect(firstPrompt(line({ message: { role: 'user', content: 'nt' } }) + user('typed'))).toBe('typed')
    expect(firstPrompt(line({ type: 'user', message: 'notobj' }) + user('ok'))).toBe('ok')
    expect(firstPrompt('[1,2]\nnull\n' + user('ok'))).toBe('ok')
    expect(firstPrompt('\n\n' + user('bl'))).toBe('bl')
    expect(firstPrompt('   ' + user('ls'))).toBe('ls')
    expect(firstPrompt(user('crlf').replace('\n', '\r\n'))).toBe('crlf')
    expect(firstPrompt(userLine('First prompt') + '{"type":"user","mess')).toBe('First prompt')
    expect(firstPrompt('')).toBe('')
  })
})

describe('title from head and tail', () => {
  it('prefers customTitle, then aiTitle, then lastPrompt, then summary, then first prompt', () => {
    const head = userLine('First prompt')
    expect(title(head, '')).toBe('First prompt')
    expect(title(head, line({ type: 'summary', summary: 'Sum' }))).toBe('Sum')
    expect(title(head, line({ type: 'summary', summary: 'Sum' }) + line({ type: 'last-prompt', lastPrompt: 'Last' }))).toBe('Last')
    expect(title(head, line({ type: 'ai-title', aiTitle: 'AI' }) + line({ type: 'last-prompt', lastPrompt: 'Last' }))).toBe('AI')
    expect(title(head + line({ type: 'custom-title', customTitle: 'Mine' }), line({ type: 'ai-title', aiTitle: 'AI' }))).toBe('Mine')
    expect(title('', '')).toBeNull()
  })

  it('takes the latest custom/ai title across both slices; lastPrompt and summary from the tail only', () => {
    const head = user('x')
    expect(title(head, line({ customTitle: 'one' }) + line({ customTitle: 'two' }))).toBe('two')
    expect(title(head + line({ customTitle: 'h' }), line({ customTitle: 't' }))).toBe('t')
    expect(title(head + line({ customTitle: 'h1' }) + line({ customTitle: 'h2' }), head)).toBe('h2')
    expect(title(head + line({ aiTitle: 'h' }), line({ aiTitle: 't' }))).toBe('t')
    expect(title(head + line({ aiTitle: 'ha' }), head)).toBe('ha')
    expect(title(head, line({ aiTitle: 't1' }) + line({ aiTitle: 't2' }))).toBe('t2')
    expect(title(head + line({ summary: 'hs' }), head)).toBe('x')
    expect(title(head + line({ lastPrompt: 'hl' }), head)).toBe('x')
    expect(title(head, line({ lastPrompt: 'l1' }) + line({ lastPrompt: 'l2' }))).toBe('l2')
    expect(title(head, line({ summary: 's1' }) + line({ summary: 's2' }))).toBe('s2')
    expect(title(head, line({ customTitle: '' }))).toBe('x')
    expect(title(head, line({ customTitle: 'a\nb' }))).toBe('a\nb')
    expect(title('', user('tail prompt'))).toBeNull()
  })
})

describe('session rows', () => {
  it('builds a row per item: id from the filename, cwd, createdAt, importable', () => {
    const head = userLine('Fix it')
    expect(rows([{ path: FILE, head, tail: head, size: head.length, mtimeMs: 5 }])).toEqual([
      {
        source: expect.any(String),
        path: FILE,
        sessionId: UUID,
        title: 'Fix it',
        projectPath: 'D:\\project\\app',
        createdAt: '2026-08-01T10:00:00.000Z',
        mtimeMs: 5,
        size: head.length,
        importable: true,
      },
    ])
    expect(rows([])).toEqual([])
  })

  it('falls back to the recorded sessionId, then to the path, for a non-uuid file name', () => {
    expect(row(user('x', { cwd: '/c', sessionId: 'abc' }), '', '/p/foo.jsonl').sessionId).toBe('abc')
    expect(row(user('x', { cwd: '/c' }), '', '/p/foo.jsonl').sessionId).toBe('/p/foo.jsonl')
  })

  it('reads cwd and timestamp from their first occurrence in the head only', () => {
    expect(row(user('x') + user('y', { cwd: '/later', timestamp: 'T2' }))).toMatchObject({ projectPath: '/later', createdAt: 'T2' })
    expect(row(line({ type: 'summary', timestamp: 'T0' }) + user('x', { cwd: '/c', timestamp: 'T1' })).createdAt).toBe('T0')
    expect(row(user('x'), user('y', { cwd: '/tail', timestamp: 'T9' }))).toMatchObject({
      projectPath: null,
      createdAt: null,
      importable: false,
    })
    expect(row(user('x', { cwd: '' }))).toMatchObject({ projectPath: '', importable: true })
  })

  it('marks a file not importable when its first line is a sidechain or no cwd is recorded', () => {
    expect(row(userLine('agent work', { isSidechain: true })).importable).toBe(false)
    expect(row(user('x', { cwd: '/c', isSidechain: true }).replace('\n', '\r\n')).importable).toBe(false)
    expect(row(user('x', { cwd: '/c', isSidechain: false })).importable).toBe(true)
    expect(row(user('x', { cwd: '/c' }) + user('y', { isSidechain: true })).importable).toBe(true)
    expect(row(line({ summary: 's' }) + user('x', { cwd: '/c', isSidechain: true })).importable).toBe(true)
    expect(row(user('x', { cwd: '/c' }), user('y', { isSidechain: true })).importable).toBe(true)
    expect(row(line({ type: 'summary', summary: 'only metadata' }))).toMatchObject({ importable: false, title: 'only metadata' })
    expect(row('', '')).toMatchObject({ title: null, projectPath: null, createdAt: null, importable: false, size: 9, mtimeMs: 3 })
  })
})
