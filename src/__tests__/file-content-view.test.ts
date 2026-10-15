import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  coerceFileText,
  fileBaseName,
  middleTruncate,
  PathLabel,
  toNumberedLines,
} from '../components/assistant-ui/file-content-view'
import { baseName } from '../utils/paths'
import { buildEditDiffTarget } from '../components/assistant-ui/edit-tool-diff'
import { ReadToolView } from '../components/assistant-ui/read-tool-view'
import { sanitizeMessageForPersistence } from '../utils/toolCallDetails'
import type { Message } from '../runtime/RuntimeTypes'

// Backs the inline Read card + the right-panel Files/Diff views. The pure
// helpers carry the risk (line-number parsing, diff-target assembly, the slim
// `file_path` preview that lets the Edit card title render before its lazy
// detail loads); the components are thin.

describe('middleTruncate', () => {
  // 1 unit per character keeps the assertions arithmetic-simple.
  const byChar = (s: string) => s.length

  it('returns the text unchanged when it already fits', () => {
    expect(middleTruncate('a/b/c.ts', 100, byChar)).toBe('a/b/c.ts')
    expect(middleTruncate('short', 5, byChar)).toBe('short')
  })

  it('keeps the FIRST and LAST parts with the ellipsis in the middle', () => {
    const path = 'D:/work/repo/src/browser/child_process.h'
    const out = middleTruncate(path, 20, byChar)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out).toContain('…')
    // First + last characters of the path survive; the middle is dropped.
    expect(out.startsWith('D:/')).toBe(true)
    expect(out.endsWith('process.h')).toBe(true)
  })

  it('degrades to just the ellipsis when there is no room', () => {
    expect(middleTruncate('anything', 0.5, byChar)).toBe('…')
  })
})

describe('PathLabel', () => {
  it('renders the whole path in ONE element (no seam); truncation is measured', () => {
    const html = renderToStaticMarkup(
      createElement(PathLabel, { path: 'D:\\a\\b\\c\\foo.ts' }),
    )
    // Server render (no measurement) shows the full path in a single truncating
    // element — not two flex items — so a link underline stays continuous.
    expect(html).toContain('truncate')
    expect(html).toContain('D:\\a\\b\\c\\foo.ts')
    expect(html).not.toContain('shrink-0')
    expect(html).not.toContain('<bdi>')
  })
})

describe('toNumberedLines', () => {
  it('detects and parses a cat -n (tab) prefix from the hosted Read result', () => {
    const rows = toNumberedLines('1\tfirst\n2\tsecond\n3\tthird')
    expect(rows).toEqual([
      { num: 1, text: 'first' },
      { num: 2, text: 'second' },
      { num: 3, text: 'third' },
    ])
  })

  it('honours a non-1 starting line number in the cat -n prefix', () => {
    const rows = toNumberedLines('33\talpha\n34\tbeta')
    expect(rows[0]).toEqual({ num: 33, text: 'alpha' })
    expect(rows[1]).toEqual({ num: 34, text: 'beta' })
  })

  it('synthesizes line numbers for raw content (Files panel, numbered:false)', () => {
    const rows = toNumberedLines('one\ntwo', { numbered: false, startLine: 1 })
    expect(rows).toEqual([
      { num: 1, text: 'one' },
      { num: 2, text: 'two' },
    ])
  })

  it('drops a single trailing newline (no phantom final blank row)', () => {
    expect(toNumberedLines('a\nb\n', { numbered: false })).toHaveLength(2)
  })

  it('returns no rows for empty content', () => {
    expect(toNumberedLines('', { numbered: false })).toEqual([])
  })
})

describe('coerceFileText', () => {
  it('passes strings through', () => {
    expect(coerceFileText('hello')).toBe('hello')
  })
  it('unwraps a { text } shape and text parts', () => {
    expect(coerceFileText({ text: 'body' })).toBe('body')
    expect(coerceFileText([{ text: 'a' }, { text: 'b' }])).toBe('ab')
  })
  it('falls back to JSON for unknown objects and empty for nullish', () => {
    expect(coerceFileText(null)).toBe('')
    expect(coerceFileText({ n: 1 })).toContain('"n": 1')
  })
})

describe('fileBaseName', () => {
  it('returns the final segment for posix and windows paths', () => {
    expect(fileBaseName('/repo/src/foo.ts')).toBe('foo.ts')
    expect(fileBaseName('D:\\project\\bar.spec.ts')).toBe('bar.spec.ts')
    expect(fileBaseName('/repo/dir/')).toBe('dir')
  })

  it('is the shared @/utils/paths baseName (single implementation, no re-divergence)', () => {
    // Regression: fileBaseName and toolLabels' baseName were byte-identical
    // copies. Both now alias the shared helper — assert the SAME reference so a
    // future inlined copy that drifts fails this test.
    expect(fileBaseName).toBe(baseName)
  })
})

describe('buildEditDiffTarget', () => {
  it('prefers the host editDiff (file-relative hunks + counts) over args', () => {
    const editDiff = {
      filePath: 'real.ts',
      patchHunks: [
        { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [' a', '+b'] },
      ],
      fileWasCreated: false,
      plusLines: 5,
      minusLines: 2,
    }
    const target = buildEditDiffTarget(
      { file_path: 'ignored.ts', old_string: 'x', new_string: 'y' },
      editDiff,
    )
    expect(target).not.toBeNull()
    if (target?.kind !== 'file') throw new Error('expected a file diff target')
    expect(target.filePath).toBe('real.ts')
    expect(target.plusLines).toBe(5)
    expect(target.minusLines).toBe(2)
    expect(target.hunks).toBe(editDiff.patchHunks)
  })

  it('falls back to a snippet patch computed from args when no editDiff', () => {
    const target = buildEditDiffTarget({
      file_path: 'f.ts',
      old_string: 'a\nb\nc\n',
      new_string: 'a\nB\nc\n',
    })
    if (target?.kind !== 'file') throw new Error('expected a file diff target')
    expect(target.filePath).toBe('f.ts')
    expect(target.plusLines).toBe(1)
    expect(target.minusLines).toBe(1)
    expect(target.hunks.length).toBeGreaterThan(0)
  })

  it('returns null when there is no file path to open', () => {
    expect(buildEditDiffTarget({ old_string: 'a', new_string: 'b' })).toBeNull()
    expect(buildEditDiffTarget(undefined)).toBeNull()
  })
})

// A minimal assistant message carrying one tool-call part.
function assistantToolCall(name: string, args: unknown): Message {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool-call', name, args }] },
  } as unknown as Message
}

function sanitizedArgs(message: Message): Record<string, unknown> | undefined {
  const content = (message as unknown as {
    message: { content: Array<{ args?: unknown }> }
  }).message.content
  return content[0]?.args as Record<string, unknown> | undefined
}

function sanitizedResult(message: Message): unknown {
  const content = (message as unknown as {
    message: { content: Array<{ result?: unknown }> }
  }).message.content
  return content[0]?.result
}

function userToolResult(name: string, result: unknown): Message {
  return {
    type: 'user',
    toolCallDetailRef: { toolCallId: 'tool-1', toolName: name },
    message: {
      content: [{ type: 'tool-result', toolCallId: 'tool-1', result }],
    },
  } as unknown as Message
}

describe('sanitizeMessageForPersistence — file_path and background-shell previews', () => {
  it('keeps just file_path for Edit (heavy old/new strings dropped)', () => {
    const out = sanitizeMessageForPersistence(
      assistantToolCall('Edit', {
        file_path: '/repo/a.ts',
        old_string: 'big old text',
        new_string: 'big new text',
        replace_all: false,
      }),
    )
    expect(sanitizedArgs(out)).toEqual({ file_path: '/repo/a.ts' })
  })

  it('keeps file_path for Read too', () => {
    const out = sanitizeMessageForPersistence(
      assistantToolCall('Read', { file_path: '/repo/b.ts', offset: 10 }),
    )
    expect(sanitizedArgs(out)).toEqual({ file_path: '/repo/b.ts' })
  })

  it('keeps file_path for Write too (heavy `content` dropped to the sidecar)', () => {
    // Regression: Write was absent from the file_path preview, so its args were
    // stripped WHOLE — the card fell back to a bare "Write" with no filename.
    const out = sanitizeMessageForPersistence(
      assistantToolCall('Write', {
        file_path: '/repo/new.ts',
        content: 'x'.repeat(5000),
      }),
    )
    expect(sanitizedArgs(out)).toEqual({ file_path: '/repo/new.ts' })
  })

  it('keeps only description for SuperEdit (the JS code never rides the transcript)', () => {
    // The whole point of the Super Edit card: `code` loads lazily in the
    // drawer detail, NEVER in the conversation. The slim preview carries only
    // the short label.
    const out = sanitizeMessageForPersistence(
      assistantToolCall('SuperEdit', {
        code: 'for (const f of files) await workspace.removeEntry(f)',
        description: 'Delete temp files',
        timeoutSec: 60,
      }),
    )
    expect(sanitizedArgs(out)).toEqual({ description: 'Delete temp files' })
  })

  it('strips SuperEdit args entirely when there is no description', () => {
    const out = sanitizeMessageForPersistence(
      assistantToolCall('SuperEdit', { code: 'return 1' }),
    )
    expect(sanitizedArgs(out)).toBeUndefined()
  })

  it('keeps the command/run flag for background shell launches so jump UI can render before lazy detail loads', () => {
    const bash = sanitizeMessageForPersistence(
      assistantToolCall('Bash', {
        command: 'npm test',
        run_in_background: true,
        timeout: 600000,
      }),
    )
    expect(sanitizedArgs(bash)).toEqual({
      command: 'npm test',
      run_in_background: true,
    })

    const powershell = sanitizeMessageForPersistence(
      assistantToolCall('PowerShell', {
        command: 'Write-Output ok',
        run_in_background: true,
        timeout: 600000,
      }),
    )
    expect(sanitizedArgs(powershell)).toEqual({
      command: 'Write-Output ok',
      run_in_background: true,
    })
  })
  it('keeps the command for FOREGROUND shells too (the "Bash: <cmd>" row label)', () => {
    // Regression (beta "bare tool name" report): foreground shell args were
    // stripped whole, so every persisted Bash/PowerShell row degraded to a
    // bare "Bash". The label is exactly as arg-dependent as Read's filename.
    const out = sanitizeMessageForPersistence(
      assistantToolCall('Bash', { command: 'npm test', description: 'run tests' }),
    )
    expect(sanitizedArgs(out)).toEqual({ command: 'npm test' })
  })

  it('keeps the label fields for Grep/Glob (pattern + path) — Search rows', () => {
    const grep = sanitizeMessageForPersistence(
      assistantToolCall('Grep', {
        pattern: 'TODO',
        path: '/repo/src',
        output_mode: 'content',
      }),
    )
    expect(sanitizedArgs(grep)).toEqual({ pattern: 'TODO', path: '/repo/src' })

    const glob = sanitizeMessageForPersistence(
      assistantToolCall('Glob', { pattern: '**/*.ts' }),
    )
    expect(sanitizedArgs(glob)).toEqual({ pattern: '**/*.ts' })
  })

  it('keeps the single label field for WebSearch/WebFetch/ToolSearch/NotebookEdit', () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['WebSearch', { query: 'chromium sqlite', allowed_domains: ['x'] }, { query: 'chromium sqlite' }],
      ['WebFetch', { url: 'https://a.dev/b', prompt: 'p'.repeat(500) }, { url: 'https://a.dev/b' }],
      ['ToolSearch', { query: 'select:Read', max_results: 5 }, { query: 'select:Read' }],
      ['NotebookEdit', { notebook_path: '/n/b.ipynb', new_source: 'x'.repeat(999) }, { notebook_path: '/n/b.ipynb' }],
    ]
    for (const [name, args, want] of cases) {
      const out = sanitizeMessageForPersistence(assistantToolCall(name, args))
      expect(sanitizedArgs(out), name).toEqual(want)
    }
  })

  it('keeps only description for SuperShell — code and inputs go to the sidecar', () => {
    const out = sanitizeMessageForPersistence(
      assistantToolCall('SuperShell', {
        description: 'Typecheck and test',
        code: 'await bash("npx tsc --noEmit")'.repeat(50),
        inputs: { body: 'x'.repeat(5_000) },
      }),
    )
    expect(sanitizedArgs(out)).toEqual({ description: 'Typecheck and test' })
  })

  it('keeps path for WorkspaceDiff (the "WorkspaceDiff <file>" row label)', () => {
    const withPath = sanitizeMessageForPersistence(
      assistantToolCall('WorkspaceDiff', { path: 'src/a.ts' }),
    )
    expect(sanitizedArgs(withPath)).toEqual({ path: 'src/a.ts' })
    // A path-less (whole-workspace) call legitimately has nothing to keep.
    const bare = sanitizeMessageForPersistence(
      assistantToolCall('WorkspaceDiff', {}),
    )
    expect(sanitizedArgs(bare)).toBeUndefined()
  })

  // Regression: the execution path stamps `toolCallDetailRef` on EVERY tool
  // result row, but inline tools (TodoWrite, Agent, AskUserQuestion) never get
  // a sidecar record — the ref pointed at a detail file that did not exist.
  it('drops the detail ref on inline-tool result rows (no sidecar exists for them)', () => {
    for (const name of ['TodoWrite', 'Agent', 'AskUserQuestion']) {
      const out = sanitizeMessageForPersistence(userToolResult(name, 'ok'))
      expect((out as { toolCallDetailRef?: unknown }).toolCallDetailRef).toBeUndefined()
      // The inline payload itself is untouched.
      expect(sanitizedResult(out)).toBe('ok')
    }
  })

  it('keeps the detail ref on lazy-detail result rows', () => {
    const out = sanitizeMessageForPersistence(userToolResult('Grep', 'hit'))
    expect((out as { toolCallDetailRef?: unknown }).toolCallDetailRef).toEqual({
      toolCallId: 'tool-1',
      toolName: 'Grep',
    })
    expect(sanitizedResult(out)).toBeUndefined()
  })

  it('keeps only the running shell id/status for background shell results', () => {
    const out = sanitizeMessageForPersistence(
      userToolResult('PowerShell', {
        shell_id: 'bg_123',
        status: 'running',
        stdout: 'large output that must stay in sidecar',
      }),
    )
    expect(sanitizedResult(out)).toEqual({ shell_id: 'bg_123', status: 'running' })
  })

  it('keeps auto-background shell handoff results as running background previews', () => {
    const nativeOut = sanitizeMessageForPersistence(
      userToolResult('PowerShell', {
        background_shell_id: 'bg_456',
        message: 'moved to the background',
      }),
    )
    expect(sanitizedResult(nativeOut)).toEqual({
      shell_id: 'bg_456',
      status: 'running',
    })

    const textOut = sanitizeMessageForPersistence(
      userToolResult(
        'PowerShell',
        'Command exceeded its foreground timeout and was moved to the background (shell_id=bg_789).',
      ),
    )
    expect(sanitizedResult(textOut)).toEqual({
      shell_id: 'bg_789',
      status: 'running',
    })
  })

  it('recognizes the real host handoff shape (task_id + "with ID:" message)', () => {
    // `buildBackgroundShellRunningResult` emits `task_id` (not `shell_id`) with a
    // "…moved to the background with ID: bg_…" message. Regression guard: the
    // recognizer must flip this to a running background preview so the inline
    // card shows the handoff chrome, not a raw JSON result.
    const objOut = sanitizeMessageForPersistence(
      userToolResult('Bash', {
        task_id: 'bg_abc',
        status: 'running',
        output_file: '/tmp/bg_abc.log',
        message:
          'Command exceeded its foreground timeout and was moved to the background with ID: bg_abc. It is still running.',
      }),
    )
    expect(sanitizedResult(objOut)).toEqual({
      shell_id: 'bg_abc',
      status: 'running',
    })

    const proseOut = sanitizeMessageForPersistence(
      userToolResult(
        'Bash',
        'Command running in background with ID: bg_999. You will be notified when it completes.',
      ),
    )
    expect(sanitizedResult(proseOut)).toEqual({
      shell_id: 'bg_999',
      status: 'running',
    })
  })

  it('still strips normal shell results entirely', () => {
    const out = sanitizeMessageForPersistence(
      userToolResult('PowerShell', {
        stdout: 'normal result',
        status: 'completed',
      }),
    )
    expect(sanitizedResult(out)).toBeUndefined()
  })
})

describe('ReadToolView render', () => {
  it('renders the path header and line-numbered content', () => {
    const html = renderToStaticMarkup(
      createElement(ReadToolView, {
        args: { file_path: '/repo/a.ts' },
        result: '1\tconst x = 1\n2\tconst y = 2',
      }),
    )
    expect(html).toContain('/repo/a.ts')
    expect(html).toContain('const x = 1')
    expect(html).toContain('const y = 2')
    expect(html).toContain('data-slot="file-content-view"')
  })

  it('scroll-caps the inline view at ~20 rows', () => {
    const result = Array.from({ length: 25 }, (_, i) => `${i + 1}\tline ${i + 1}`).join(
      '\n',
    )
    const html = renderToStaticMarkup(
      createElement(ReadToolView, { args: { file_path: '/big.ts' }, result }),
    )
    // 20 rows, each one code line tall — the `--nx-code-leading` token —
    // plus the view's `py-1` and border, so 20 rows fit with no scrollbar at
    // every Text size step.
    expect(html).toContain('max-height:calc(20 * var(--nx-code-leading) + 0.5rem + 2px)')
  })
})
