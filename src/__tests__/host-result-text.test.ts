/**
 * The text a host tool's result or error reads as (`toolkit/builtin/host/resultText.ts` owns every sentence):
 * every error code a host action declares in its `.api.json`, and every `invalid_args` reason, renders to a
 * sentence (skipped without the sibling C++ checkout); the longer sentences are pinned by SHA-256 digest.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  composeShellBody,
  describeActorError,
  fileSizeLabel,
  READ_UNCHANGED_NOTE,
  renderHostErrorText,
  renderHostResult,
} from '../toolkit/builtin/host/resultText'

function digest(value: unknown): string {
  return createHash('sha256').update(String(value)).digest('hex')
}

function findDeclarationsDir(): string | null {
  // One level up from the main checkout, four from a worktree — walk.
  let dir = join(__dirname, '..', '..')
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(
      dir, 'src', 'custom_browser', 'browser', 'nexus', 'api', 'declarations',
    )
    if (existsSync(candidate)) return candidate
    dir = join(dir, '..')
  }
  return null
}

type DeclaredError = { code: string; params?: string[] }

const FAMILY_TOOL: Record<string, (action: string) => string> = {
  files: action => action[0].toUpperCase() + action.slice(1),
  exec: action => (action === 'powerShell' ? 'PowerShell' : 'Bash'),
  browser: action => `Browser${action[0].toUpperCase()}${action.slice(1)}`,
}

// Codes whose sentence depends on `reason`; they are covered reason by reason.
const REASON_KEYED = new Set(['invalid_args', 'download_failed'])

// A value for each declared parameter, so a sentence that interpolates one
// has something to show.
function sampleParams(code: string, names: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const name of names) {
    if (name === 'reason' || name === 'phase' || name === 'kind') continue
    params[name] = /(_bytes|_tokens|tokens|count|max|index|tab|_id|state|code|position)$/.test(name)
      ? 3
      : 'sample'
  }
  if (code.endsWith('_failed') || code.endsWith('_timeout')) {
    // A shell failure carries the run's streams; the others a detail line.
    params.detail ??= 'sample'
  }
  return params
}

describe('host error codes all have text', () => {
  const declarationsDir = findDeclarationsDir()

  it('every code an action declares renders to a sentence', () => {
    if (!declarationsDir) {
      console.warn('[host-result-text] no sibling src/custom_browser checkout — skipped')
      return
    }
    const missing: string[] = []
    let checked = 0
    for (const family of Object.keys(FAMILY_TOOL)) {
      const dir = join(declarationsDir, family)
      for (const file of readdirSync(dir).filter(f => f.endsWith('.api.json'))) {
        const decl = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
          name: string
          errors?: DeclaredError[]
        }
        const tool = FAMILY_TOOL[family](decl.name)
        for (const error of decl.errors ?? []) {
          if (REASON_KEYED.has(error.code)) continue
          checked += 1
          const text = renderHostErrorText(tool, error.code, sampleParams(error.code, error.params ?? []))
          if (!text) missing.push(`${family}/${decl.name}: ${error.code}`)
        }
      }
    }
    expect(checked).toBeGreaterThan(50)
    expect(missing).toEqual([])
  })

  it('a dropped host call says nothing ran, on every family', () => {
    for (const tool of ['Read', 'Bash', 'BrowserClick']) {
      expect(renderHostErrorText(tool, 'tool_dropped', { reason: 'discarded' })).toMatch(
        /^INTERNAL HOST ERROR: this tool call was dispatched but its result was discarded .* Do NOT claim success\./,
      )
      expect(renderHostErrorText(tool, 'tool_dropped', { reason: 'overwritten' })).toMatch(
        /^INTERNAL HOST ERROR: this tool call was overwritten by another before it could resolve/,
      )
    }
  })

  it('every download_failed reason the host sends has a sentence', () => {
    const reasons = ['manager_unavailable', 'downloads_dir', 'not_started', 'manager_shutdown', 'interrupted', 'removed']
    expect(reasons.filter(reason => !renderHostErrorText('BrowserDownload', 'download_failed', { reason }))).toEqual([])
    expect(renderHostErrorText('BrowserDownload', 'download_failed', { reason: 'interrupted', reason_code: 20 })).toBe(
      'the download was interrupted (reason code 20).',
    )
  })

  it('every invalid_args reason the host sends has a sentence', () => {
    const files = ['file_path_not_absolute', 'unc_path', 'same_strings', 'pattern_required', 'pattern_empty', 'no_cwd', 'output_mode']
    const exec = ['command_empty', 'cwd_not_absolute', 'no_cwd']
    const browser = [
      'download_mode', 'invalid_url', 'code_required', 'different_tabs', 'scroll_direction',
      'seek_time_required', 'media_action', 'fields_empty', 'too_many_fields', 'field_index_missing',
      'field_action_missing', 'field_action_invalid', 'field_value_required', 'field_tab_mismatch',
      'submit_tab_mismatch',
    ]
    const missing = [
      ...files.filter(reason => !renderHostErrorText('Grep', 'invalid_args', { reason })),
      ...exec.filter(reason => !renderHostErrorText('Bash', 'invalid_args', { reason })),
      ...browser.filter(reason => !renderHostErrorText('BrowserClick', 'invalid_args', { reason })),
    ]
    expect(missing).toEqual([])
  })

  it('a code the table does not know renders as nothing, so the caller shows the code', () => {
    expect(renderHostErrorText('Read', 'no_such_code', {})).toBeUndefined()
    expect(renderHostErrorText('BrowserClick', 'no_such_code', {})).toBeUndefined()
  })
})

describe('host error sentences', () => {
  it('a media-service failure shows the service sentence, whatever its code', () => {
    const pages = 'This PDF has 12 pages, which is too many to read at once. Use the pages parameter to read specific page ranges (maximum 20 pages per request).'
    expect(renderHostErrorText('Read', 'pdf_too_many_pages', { path: 'a.pdf', source: 'media', detail: pages })).toBe(pages)
    expect(renderHostErrorText('Read', 'invalid_pdf', { path: 'a.pdf', source: 'media', detail: 'PDF file is corrupted or invalid.' })).toBe(
      'PDF file is corrupted or invalid.',
    )
    // Codes the files family also uses keep the service's sentence, not the files one.
    expect(renderHostErrorText('Read', 'file_too_large', { path: 'a.pdf', source: 'media', detail: 'PDF file exceeds maximum allowed size for Read.' })).toBe(
      'PDF file exceeds maximum allowed size for Read.',
    )
    expect(renderHostErrorText('Read', 'read_failed', { path: 'a.png', source: 'media', detail: 'failed to read image file' })).toBe(
      'failed to read image file',
    )
    expect(renderHostErrorText('Read', 'pdf_render_failed', { path: 'a.pdf', source: 'media' })).toBe('failed to read media')
  })

  it('files family', () => {
    // Edit of an unread file and Write over an unread one say different things.
    expect(renderHostErrorText('Edit', 'file_not_read', {})).toBe('This file has not been read in this conversation. Read it, then write.')
    expect(renderHostErrorText('Write', 'file_not_read', { phase: 'write' })).toBe(
      'File must be fully read before editing. A partial read (using offset/limit) does not count, read the entire file first, then retry the edit.',
    )
    expect(renderHostErrorText('Edit', 'file_not_read', { phase: 'partial', offset: '10', limit: '20' })).toBe(
      'Only part of this file was read (offset 10, limit 20). Read it without offset and limit, then edit.',
    )
    expect(renderHostErrorText('Edit', 'no_match', { old_string: 'foo' })).toBe(
      'old_string was not found in the file.\nString: foo',
    )
    expect(digest(renderHostErrorText('Edit', 'ambiguous_match', { count: 2, old_string: 'x' }))).toBe(
      'a0aaff613ff7b44c583a379358340ece44f644419ca4f42d81644c680f1f1c16',
    )
    expect(renderHostErrorText('Read', 'file_not_found', { cwd: 'C:\\w' })).toBe(
      'File does not exist. Current working directory: C:\\w.',
    )
    const tooLarge = renderHostErrorText('Read', 'file_too_large', { size_bytes: 300 * 1024, limit_bytes: 256 * 1024 })
    expect(tooLarge).toMatch(/^File content \(300KB\) exceeds maximum allowed size \(256KB\)\. /)
    expect(digest(tooLarge)).toBe('06803fa0022ab1e8f338f6a6022d12cc1aee2d35ea54925775c5d92270e6111f')
    const tooManyTokens = renderHostErrorText('Read', 'max_file_read_token_exceeded', { tokens: 30000, max_tokens: 25000 })
    expect(tooManyTokens).toMatch(/^File content \(30000 tokens\) exceeds maximum allowed tokens \(25000\)\. /)
    expect(digest(tooManyTokens)).toBe('64d6e17ab0716a8871d547f81c054913110fdb906b2e3ed9c11d423a5b574bb7')
    expect(renderHostErrorText('Grep', 'invalid_args', { reason: 'output_mode', value: 'lines' })).toBe(
      "output_mode must be 'content', 'files_with_matches', or 'count'; got 'lines'",
    )
    // A service failure: the tool's own code, the runner's sentence (+ the
    // install hint), and the service's code as data the text ignores.
    expect(
      renderHostErrorText('Glob', 'glob_failed', {
        detail: 'rg is not installed.',
        install_hint: 'winget install BurntSushi.ripgrep.MSVC',
        service_code: 'BINARY_NOT_FOUND',
      }),
    ).toBe('rg is not installed.\n\nwinget install BurntSushi.ripgrep.MSVC')
    expect(
      renderHostErrorText('Grep', 'grep_failed', { detail: 'the search directory does not exist', service_code: 'INVALID_CWD' }),
    ).toBe('the search directory does not exist')
    expect(renderHostErrorText('Grep', 'grep_failed', {})).toBeUndefined()
  })

  it('exec family', () => {
    expect(renderHostErrorText('Bash', 'invalid_args', { reason: 'no_cwd' })).toBe(
      'session cwd is not set. Push a cwd via setAgentLoopSettings before running shell commands.',
    )
    expect(
      renderHostErrorText('Bash', 'bash_failed', { stdout: '', stderr: 'boom', exit_code: 2, timed_out: false }),
    ).toBe('Command exited with code 2.\nboom')
    expect(renderHostErrorText('PowerShell', 'powershell_failed', { detail: 'pwsh missing', install_hint: 'Install it.' })).toBe(
      'pwsh missing\n\nInstall it.',
    )
    // The shell service's own code never becomes the error code; it is data.
    expect(
      renderHostErrorText('Bash', 'bash_failed', { detail: 'bash is not available', service_code: 'BINARY_NOT_FOUND' }),
    ).toBe('bash is not available')
    expect(
      renderHostErrorText('Bash', 'hook_exec_failed', { detail: 'cwd is gone', service_code: 'INVALID_CWD' }),
    ).toBe('cwd is gone')
  })

  it('browser family', () => {
    expect(renderHostErrorText('BrowserClick', 'index_not_found', { tool: 'BrowserClick', index: 7, tab_id: 3 })).toBe(
      "BrowserClick: index 7 in tab 3 not in this session's registry. Run a screenshot or read_page to observe the page first.",
    )
    expect(renderHostErrorText('BrowserClick', 'tool_action_timeout', { action: 'click' })).toBe(
      'click: exceeded per-action wall-clock budget',
    )
    expect(renderHostErrorText('BrowserClick', 'task_missing', { action: 'click', phase: 'actor' })).toBe(
      'click: actor task no longer exists',
    )
    expect(renderHostErrorText('BrowserDownload', 'invalid_args', { reason: 'download_mode' })).toBe(
      'BrowserDownload needs EXACTLY ONE of `index` (click an element to trigger a download) or `url` (download a direct URL).',
    )
  })
})

describe('host result text', () => {
  it('Read notices and media', () => {
    expect(renderHostResult('Read', { notice: { kind: 'unchanged' } })).toBe(READ_UNCHANGED_NOTE)
    const short = renderHostResult('Read', { notice: { kind: 'short', offset: 50, total_lines: 12 } })
    expect(short).toMatch(/fewer than the requested offset 50\.<\/system-reminder>$/)
    expect(digest(short)).toBe('99d4140cff3511075e13f384739f0deffef3f0e3e8f92b6cf0ea134cf3530a01')
    expect(renderHostResult('Read', { media: { kind: 'notebook', path: 'a.ipynb', cells: 4 }, content_parts: [] })).toEqual({
      message: 'Notebook read: a.ipynb (4 cells)',
      content_parts: [],
    })
    const plain = { content: '1\tx', total_lines: 1 }
    expect(renderHostResult('Read', plain)).toBe(plain)
  })

  it('Write and Edit outcomes', () => {
    expect(renderHostResult('Write', { outcome: 'created', path: 'a.txt', bytes: 5 })).toEqual({
      message: 'File created successfully at: a.txt. Wrote 5 bytes.',
    })
    expect(renderHostResult('Write', { outcome: 'updated', path: 'a.txt', bytes: 5, original_file: 'old' })).toEqual({
      message: 'The file a.txt has been updated successfully. Wrote 5 bytes.',
      original_file: 'old',
    })
    expect(renderHostResult('Edit', { outcome: 'updated', path: 'a.txt' })).toEqual({
      message: 'The file a.txt has been updated successfully.',
    })
    expect(renderHostResult('Edit', { outcome: 'updated_all', path: 'a.txt' })).toEqual({
      message: 'The file a.txt has been updated. All occurrences were successfully replaced.',
    })
  })

  it('Glob and Grep', () => {
    expect(renderHostResult('Glob', { files: [] })).toBe('No files found')
    expect(renderHostResult('Glob', { files: ['a', 'b'], truncated: true })).toBe(
      'a\nb\n(Results are truncated. Consider using a more specific pattern or increasing the limit.)',
    )
    expect(renderHostResult('Grep', { mode: 'content', lines: ['a:1:x'], truncated: true, limit: 250, offset: 0 })).toBe(
      'a:1:x\n\n[Showing results with pagination = limit: 250]',
    )
    expect(renderHostResult('Grep', { mode: 'count', lines: ['a:2'], total_matches: 2, file_count: 1 })).toBe(
      'a:2\n\nFound 2 total occurrences across 1 file.',
    )
    expect(renderHostResult('Grep', { mode: 'files', files: ['a', 'b'], truncated: true, limit: 2, offset: 4 })).toBe(
      'Found 2 files limit: 2, offset: 4\na\nb',
    )
  })

  it('the shell body', () => {
    expect(composeShellBody({ stdout: '', stderr: '', exit_code: 0 })).toBe('(no output)')
    expect(composeShellBody({ stdout: 'out', stderr: '', exit_code: 0, timed_out: true })).toBe(
      'Command timed out.\nout',
    )
    expect(composeShellBody({ stdout: 'out', stderr: 'err', exit_code: 1, truncated: true })).toBe(
      'Command exited with code 1.\nout\nerr\n[output truncated — re-run with a narrower scope to capture more]',
    )
    expect(composeShellBody({ stdout: '', stderr: '', exit_code: 1, interpretation: 'no_matches' })).toBe(
      'Command exited with code 1.\nNo matches found',
    )
    expect(renderHostResult('Bash', { stdout: 'hi', stderr: '', exit_code: 0 })).toBe('hi')
  })

  it('browser results: actor codes, download notes, evaluate exceptions', () => {
    expect(describeActorError('click', 18)).toBe(
      'actor_error_18: the target index is no longer in the DOM (stale index — re-observe and use indexes from the latest observation)',
    )
    expect(describeActorError('click', 999)).toBe('actor_error_999')
    expect(describeActorError('scroll_to', 20)).toMatch(
      /^actor_error_20: scroll_to: the element is in the DOM but cannot be scrolled into view/,
    )
    expect(renderHostResult('BrowserClick', { ok: false, action: 'click', error_code: 29 })).toEqual({
      ok: false,
      action: 'click',
      error_code: 29,
      result: 'actor_error_29: the tool executor is busy with another action — wait briefly and retry',
    })
    expect(renderHostResult('BrowserDownload', { ok: true, path: 'p', notice: 'in_progress' })).toMatchObject({
      note: expect.stringMatching(/^the file is still downloading in the background\. Do NOT re-issue BrowserDownload/),
    })
    expect(renderHostResult('BrowserEvaluate', { exception: { line: 1 } })).toEqual({
      exception: { line: 1 },
      error: 'uncaught exception',
    })
  })

  it('file sizes read the way the host spelled them', () => {
    expect(fileSizeLabel(512)).toBe('512 bytes')
    expect(fileSizeLabel(1536)).toBe('1.5KB')
    expect(fileSizeLabel(2 * 1024 * 1024)).toBe('2MB')
    expect(fileSizeLabel(1.25 * 1024 * 1024 * 1024)).toBe('1.3GB')
  })
})
