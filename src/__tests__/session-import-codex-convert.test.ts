import { describe, expect, it } from 'vitest'

import { convert } from '../sessionImport/sources/codex/convert'
import { parseLite } from '../sessionImport/sources/codex/parseLite'
import { ImportConvertError } from '../sessionImport/protocol'
import { CUSTOM_TITLE_TYPE } from '../runtime/VercelModelConstants'

// Codex rollouts are the current "wrapped" era: every line is
// `{ timestamp, type, payload }`. The transcript is the `response_item` lines;
// `event_msg` is a redundant UI-duplicate stream and must be ignored. These
// tests pin the Codex→Velloc mapping in F-8.

type Rec = Record<string, unknown>

const UUID = '019ad758-01c9-7690-80ec-8a7533104d31'
const PATH = `C:\\Users\\me\\.codex\\sessions\\2026\\01\\01\\rollout-2026-01-01T00-00-00-${UUID}.jsonl`
const NOW = Date.UTC(2026, 0, 2, 0, 0, 0)
const CWD = 'D:\\project\\app'
const TS = '2026-01-01T00:00:00.000Z'

function wrapped(type: string, payload: Rec): string {
  return JSON.stringify({ timestamp: TS, type, payload })
}
function bytes(lines: string[]): ArrayBuffer {
  return new TextEncoder().encode(lines.join('\n') + '\n').buffer as ArrayBuffer
}
function fullRollout(): string[] {
  return [
    wrapped('session_meta', { id: UUID, cwd: CWD, timestamp: TS }),
    wrapped('turn_context', { model: 'gpt-5.1-codex' }),
    // synthetic IDE/context preamble → kept but marked isMeta
    wrapped('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>D:\\project\\app</cwd>\n</environment_context>' }],
    }),
    // developer/permission preamble → dropped
    wrapped('response_item', {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'You are Codex, be careful.' }],
    }),
    // the real user prompt
    wrapped('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'List the files' }],
    }),
    // reasoning (summary only)
    wrapped('response_item', {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '**Plan**\n\nI will list them.' }],
      content: null,
    }),
    // assistant text
    wrapped('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: "I'll list the files." }],
    }),
    // tool call (arguments is a JSON-encoded string)
    wrapped('response_item', {
      type: 'function_call',
      name: 'shell',
      arguments: JSON.stringify({ command: ['ls'] }),
      call_id: 'call_1',
    }),
    // tool output (shell result is itself JSON with an exit_code)
    wrapped('response_item', {
      type: 'function_call_output',
      call_id: 'call_1',
      output: JSON.stringify({ output: 'a.txt\nb.txt', metadata: { exit_code: 0 } }),
    }),
    // redundant derived UI event — MUST NOT be converted (would double the turn)
    wrapped('event_msg', { type: 'agent_message', message: 'DUPLICATE_ASSISTANT_TEXT' }),
  ]
}

describe('codex convert — identity, meta, project binding', () => {
  it('keeps the thread id, binds the cwd as a code session, titles by first real prompt', () => {
    const result = convert({ path: PATH, bytes: bytes(fullRollout()), now: NOW })
    expect(result.source).toBe('codex')
    expect(result.sessionId).toBe(UUID)
    expect(result.projectRoot).toBe(CWD)
    expect(result.meta.sessionId).toBe(UUID)
    expect(result.meta.updatedAt).toBe(NOW)
    expect(result.meta.metadata).toMatchObject({
      templateType: 'code',
      projectRoot: CWD,
      importedFrom: { source: 'codex', path: PATH, importedAt: NOW },
    })
    // synthetic <environment_context> and developer preamble are skipped for
    // the title → the first real prompt wins.
    expect(result.meta.customTitle).toBe('List the files')
    expect(
      result.entries.some(e => (e as { type: string }).type === CUSTOM_TITLE_TYPE),
    ).toBe(true)
  })

  it('ignores the redundant event_msg stream (no doubled assistant turn)', () => {
    const result = convert({ path: PATH, bytes: bytes(fullRollout()), now: NOW })
    expect(JSON.stringify(result.entries)).not.toContain('DUPLICATE_ASSISTANT_TEXT')
  })

  it('drops the developer preamble entirely', () => {
    const result = convert({ path: PATH, bytes: bytes(fullRollout()), now: NOW })
    expect(JSON.stringify(result.entries)).not.toContain('be careful')
  })

  it('maps function_call + output to a canonical tool-call/result with a merged sidecar', () => {
    const result = convert({ path: PATH, bytes: bytes(fullRollout()), now: NOW })
    expect(result.toolDetails).toHaveLength(1)
    expect(result.toolDetails[0]).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'shell',
    })
    // args (parsed from the JSON-string) + unwrapped shell output both present.
    expect(JSON.stringify(result.toolDetails[0]!.args)).toContain('ls')
    expect(String(result.toolDetails[0]!.result)).toContain('a.txt')
  })

  it('keeps the assistant text and reasoning in the transcript', () => {
    const result = convert({ path: PATH, bytes: bytes(fullRollout()), now: NOW })
    const flat = JSON.stringify(result.entries)
    expect(flat).toContain("I'll list the files.")
    expect(flat).toContain('I will list them.') // reasoning → thinking part
    expect(flat).toContain('thinking')
  })

  it('flags a non-zero shell exit_code as an error result', () => {
    const lines = [
      wrapped('session_meta', { id: UUID, cwd: CWD, timestamp: TS }),
      wrapped('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'run it' }],
      }),
      wrapped('response_item', {
        type: 'function_call',
        name: 'shell',
        arguments: '{}',
        call_id: 'c2',
      }),
      wrapped('response_item', {
        type: 'function_call_output',
        call_id: 'c2',
        output: JSON.stringify({ output: 'boom', metadata: { exit_code: 1 } }),
      }),
    ]
    const result = convert({ path: PATH, bytes: bytes(lines), now: NOW })
    expect(result.toolDetails[0]).toMatchObject({ toolCallId: 'c2', isError: true })
  })

  it('throws when the rollout has no working directory', () => {
    const lines = [
      wrapped('session_meta', { id: UUID, timestamp: TS }),
      wrapped('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      }),
    ]
    expect(() => convert({ path: PATH, bytes: bytes(lines), now: NOW })).toThrow(
      ImportConvertError,
    )
  })

  it('throws on an empty rollout', () => {
    expect(() =>
      convert({ path: PATH, bytes: bytes([]), now: NOW }),
    ).toThrow(ImportConvertError)
  })
})

describe('codex parseLite', () => {
  it('reads sessionId, projectPath, createdAt and a first-prompt title from the head', () => {
    const head = [
      wrapped('session_meta', { id: UUID, cwd: CWD, timestamp: TS }),
      wrapped('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context></environment_context>' }],
      }),
      wrapped('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Refactor the parser' }],
      }),
    ].join('\n')
    const rows = parseLite([
      { path: PATH, head, tail: '', size: head.length, mtimeMs: 123 },
    ])
    expect(rows[0]).toMatchObject({
      source: 'codex',
      sessionId: UUID,
      projectPath: CWD,
      createdAt: TS,
      title: 'Refactor the parser',
      importable: true,
    })
  })

  it('marks a rollout with no cwd not importable', () => {
    const head = wrapped('session_meta', { id: UUID, timestamp: TS })
    const rows = parseLite([
      { path: PATH, head, tail: '', size: head.length, mtimeMs: 1 },
    ])
    expect(rows[0]!.importable).toBe(false)
    expect(rows[0]!.projectPath).toBeNull()
  })

  it('derives the session id from a rollout filename AND the bare <uuid>.jsonl form', () => {
    // The rollout filename (enumeration + read path).
    expect(
      parseLite([{ path: PATH, head: '', tail: '', size: 0, mtimeMs: 1 }])[0]!
        .sessionId,
    ).toBe(UUID)
    // The bare `<uuid>.jsonl` the bridge write-path validates a converted
    // result's id against (`sessionIdFor(`${sessionId}.jsonl`)`) — without this
    // the import fails post-convert with "Not a session id for this source".
    expect(
      parseLite([
        { path: `C:\\x\\${UUID}.jsonl`, head: '', tail: '', size: 0, mtimeMs: 1 },
      ])[0]!.sessionId,
    ).toBe(UUID)
  })
})
